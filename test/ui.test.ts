import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { escapeHtml, page, selectedSession, sessionList } from "../src/views.ts";
import { SessionHistory } from "../src/history.ts";
import type { AgentMessage } from "../src/protocol.ts";
import type { Session } from "../src/registry.ts";

const session: Session = { registration_id: "r1", session_id: "s1", host_id: "laptop", cwd: "/work", name: "Chat", pid: 123, status: "idle", connected_at: 0, last_seen: 0 };
const malicious = '<img src=x onerror="window.hacked=true"><script>alert(1)</script>';
const agent = (value: object) => ({ version: 1, session_id: "s1", ...value }) as AgentMessage;

test("server-rendered metadata, history, drafts and activity are escaped", () => {
  const attack = `\"><img src=x onerror=alert(1)>&'`;
  expect(escapeHtml(attack)).toBe("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;");
  const bad = { ...session, name: attack, session_id: attack, host_id: attack, cwd: attack, registration_id: attack };
  const history = new SessionHistory();
  history.record(agent({ type: "message.completed", role: "user", content: attack }));
  history.record(agent({ type: "message.delta", delta: attack }));
  history.record(agent({ type: "activity.started", activity: { kind: "tool", tool_call_id: attack, tool: "read", args: { path: attack } } }));
  for (const view of [page([bad], bad, history.snapshot()), sessionList([bad]), selectedSession(bad, history.snapshot())]) {
    const window = new JSDOM().window;
    window.document.body.innerHTML = view;
    expect(window.document.querySelector("img")).toBeNull();
    expect(window.document.querySelector("[onerror]")).toBeNull();
    window.close();
  }
});

test("vendor CDN URLs are pinned and SRI matches installed assets", async () => {
  const window = new JSDOM(page([])).window;
  try {
    const scripts = window.document.querySelectorAll<HTMLScriptElement>('script[src^="https://cdn.jsdelivr.net/npm/"]');
    expect(scripts).toHaveLength(3);
    for (const script of scripts) {
      const match = /\/npm\/([^@]+)@([^/]+)\/(.+)$/.exec(script.src)!;
      const asset = await Bun.file(new URL(`../node_modules/${match[1]}/${match[3]}`, import.meta.url)).arrayBuffer();
      expect(script.getAttribute("integrity")).toBe(`sha384-${new Bun.CryptoHasher("sha384").update(asset).digest("base64")}`);
      expect(script.crossOrigin).toBe("anonymous");
      expect(script.defer).toBe(true);
    }
  } finally { window.close(); }
});

async function browser(history = new SessionHistory()) {
  const window = new JSDOM(page([session], session, history.snapshot()), { url: "http://localhost:3000", runScripts: "outside-only" }).window;
  Object.defineProperty(window, "TextEncoder", { value: TextEncoder });
  let ws: MockSocket;
  class MockSocket extends window.EventTarget {
    static OPEN = 1;
    readyState = 1;
    sent: Record<string, unknown>[] = [];
    holdHistory = false;
    constructor(_url: string) { super(); ws = this; }
    send(value: string) {
      const message = JSON.parse(value);
      this.sent.push(message);
      if (message.type === "session.history" && !this.holdHistory) this.receive({ type: "session.history", history: history.snapshot() });
    }
    receive(value: Record<string, unknown>, store = true) {
      const event: Record<string, unknown> = { version: 1, registration_id: "r1", session_id: "s1", ...value };
      if (store && event.registration_id === "r1") {
        if (event.type === "session.updated" && event.reset) history.resetTransient();
        const sequence = history.record(event as unknown as AgentMessage);
        if (sequence !== undefined && event.sequence === undefined) event.sequence = sequence;
      }
      this.dispatchEvent(new window.MessageEvent("message", { data: JSON.stringify(event) }));
    }
  }
  Object.defineProperty(window, "WebSocket", { value: MockSocket });
  Object.defineProperty(window, "htmx", { value: { trigger() {} } });
  for (const file of ["../node_modules/marked/lib/marked.umd.js", "../node_modules/dompurify/dist/purify.min.js", "../public/app.js"]) window.eval(await Bun.file(new URL(file, import.meta.url)).text());
  ws!.dispatchEvent(new window.Event("open"));
  ws!.receive({ type: "sessions.snapshot", sessions: [session] });
  return { window, document: window.document, ws: ws!, history };
}

test("Markdown is sanitized; streaming/final messages and parallel tools share one ordered stream", async () => {
  const { window, document, ws } = await browser();
  try {
    ws.receive({ type: "message.delta", delta: "**Partial** " });
    ws.receive({ type: "message.delta", delta: malicious });
    expect(document.querySelectorAll(".message")).toHaveLength(1);
    expect(document.querySelector(".message-body")!.textContent).toBe("**Partial** " + malicious);
    expect(document.querySelector("img")).toBeNull();
    ws.receive({ type: "activity.started", activity: { kind: "tool", tool_call_id: "c1", tool: "read", args: { path: malicious } } });
    ws.receive({ type: "activity.started", activity: { kind: "tool", tool_call_id: "c2", tool: "bash", args: { command: "bun test" } } });
    ws.receive({ type: "message.completed", role: "assistant", content: "**Final**\n\n```ts\n<img>\n```\n\n[bad](javascript:alert(1))\n" + malicious + '<div class="streaming" id="text" data-call-id="c1" hx-get="/ui/empty">raw HTML</div>' });
    expect(document.querySelectorAll(".message")).toHaveLength(1);
    expect(document.querySelector(".message-body strong")!.textContent).toBe("Final");
    expect(document.querySelector("pre code")!.textContent).toContain("<img>");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".message-body script")).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(document.querySelector(".streaming")).toBeNull();
    expect([...document.getElementById("messages")!.children].map(item => item.className)).toEqual(["message assistant", "activity running", "activity running"]);
    ws.receive({ type: "activity.completed", activity: { kind: "tool", tool_call_id: "c2", tool: "bash", is_error: true } });
    ws.receive({ type: "activity.completed", activity: { kind: "tool", tool_call_id: "c1", tool: "read", is_error: false } });
    expect(document.querySelectorAll(".activity")).toHaveLength(2);
    expect(document.querySelector(".activity.failed")!.textContent).toContain("bun test");
    expect(document.querySelector(".activity.done")!.textContent).toContain(malicious);
    ws.receive({ type: "error", code: "usage_limit_reached", message: "Usage limit reached " + malicious });
    expect(document.querySelector(".notice")!.textContent).toContain("Usage limit reached");
    expect(document.querySelector(".notice img")).toBeNull();
    ws.receive({ type: "message.delta", registration_id: "different", delta: "WRONG SESSION" });
    expect(document.body.textContent).not.toContain("WRONG SESSION");
    const text = document.querySelector<HTMLTextAreaElement>("#text")!;
    text.value = "  hello\n";
    document.querySelector("#compose")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    const sent = ws.sent.find(message => message.type === "message.send")!;
    expect(sent).toMatchObject({ registration_id: "r1", session_id: "s1", text: "  hello\n" });
    ws.receive({ type: "gateway.error", message: "Gone", request_id: sent.request_id });
    expect(text.value).toBe("  hello\n");
    ws.receive({ type: "session.removed" });
    expect(document.querySelector<HTMLButtonElement>("#compose button")!.disabled).toBe(true);
  } finally { window.close(); }
});

test("history restores after selection/reconnect and snapshot watermark prevents duplicated live content", async () => {
  const history = new SessionHistory();
  history.record(agent({ type: "message.completed", role: "user", content: "**Earlier**" }));
  history.record(agent({ type: "message.delta", delta: "Draft" }));
  const { window, document, ws } = await browser(history);
  try {
    expect(document.querySelectorAll(".message")).toHaveLength(2);
    expect(document.querySelector(".message-body strong")!.textContent).toBe("Earlier");
    expect(document.querySelector(".streaming .message-body")!.textContent).toBe("Draft");
    ws.holdHistory = true;
    ws.dispatchEvent(new window.Event("close"));
    ws.dispatchEvent(new window.Event("open"));
    ws.receive({ type: "sessions.snapshot", sessions: [session] });
    // Ignore this live event during restore; the subsequent snapshot includes it.
    ws.receive({ type: "message.delta", delta: " plus" });
    ws.receive({ type: "session.history", history: history.snapshot() });
    expect(document.querySelector(".streaming .message-body")!.textContent).toBe("Draft plus");
    ws.receive({ type: "message.delta", sequence: history.snapshot().sequence, delta: " plus" }, false);
    expect(document.querySelector(".streaming .message-body")!.textContent).toBe("Draft plus");
    ws.receive({ type: "message.completed", role: "assistant", content: "**Authoritative**" });
    expect(document.querySelectorAll(".message")).toHaveLength(2);
    expect(document.querySelector(".message:last-child .message-body strong")!.textContent).toBe("Authoritative");
    // An HTMX detail swap initializes the server-rendered draft and requests a fresh snapshot.
    document.getElementById("detail")!.innerHTML = selectedSession(session, history.snapshot());
    ws.holdHistory = false;
    document.dispatchEvent(new window.CustomEvent("htmx:afterSwap", { detail: { target: document.getElementById("detail") } }));
    expect(document.querySelectorAll(".message")).toHaveLength(2);
    expect(document.querySelector(".message:last-child .message-body strong")!.textContent).toBe("Authoritative");
  } finally { window.close(); }
});
