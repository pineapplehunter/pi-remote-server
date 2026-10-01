import { expect, test } from "bun:test";
import { Window, type HTMLTextAreaElement, type HTMLButtonElement } from "happy-dom";
import { escapeHtml, page, selectedSession, sessionList } from "../src/views.ts";
import type { Session } from "../src/registry.ts";

const session: Session = { registration_id: "r1", session_id: "s1", host_id: "laptop", cwd: "/work", name: "Chat", pid: 123, status: "idle", connected_at: 0, last_seen: 0 };

test("all server-rendered metadata is escaped, including attribute-breaking IDs", () => {
  const malicious = `\"><img src=x onerror=alert(1)>&'`;
  expect(escapeHtml(malicious)).toBe("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;");
  const bad = { ...session, name: malicious, session_id: malicious, host_id: malicious, cwd: malicious, registration_id: malicious };
  for (const view of [page([bad], bad), sessionList([bad]), selectedSession(bad)]) {
    const window = new Window();
    window.document.body.innerHTML = view;
    expect(window.document.querySelector("img")).toBeNull();
    expect(window.document.querySelector("[onerror]")).toBeNull();
    window.close();
  }
});

test("actual browser script streams safely, finalizes once, separates parallel activity, and sends exact browser envelope", async () => {
  const window = new Window({ url: "http://localhost:3000" });
  const document = window.document;
  document.write(page([session], session));
  let ws: MockSocket;
  class MockSocket extends window.EventTarget {
    static OPEN = 1;
    readyState = 1;
    sent: object[] = [];
    constructor(_url: string) { super(); ws = this; }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    receive(event: object) { this.dispatchEvent(new window.MessageEvent("message", { data: JSON.stringify({ version: 1, registration_id: "r1", session_id: "s1", ...event }) })); }
  }
  let refreshes = 0;
  Object.defineProperty(window, "WebSocket", { value: MockSocket });
  Object.defineProperty(window, "htmx", { value: { trigger: () => refreshes++ } });
  try {
    window.eval(await Bun.file(new URL("../public/app.js", import.meta.url)).text());
    ws!.dispatchEvent(new window.Event("open"));
    ws!.receive({ type: "sessions.snapshot", sessions: [session] });
    expect(refreshes).toBe(1);
    const malicious = '<img src=x onerror="window.hacked=true">\n<script>alert(1)</script>';
    ws!.receive({ type: "message.delta", delta: "Partial " });
    ws!.receive({ type: "message.delta", delta: malicious });
    expect(document.querySelectorAll(".message")).toHaveLength(1);
    expect(document.querySelector(".message p")!.textContent).toBe("Partial " + malicious);
    expect(document.querySelector("img")).toBeNull();
    ws!.receive({ type: "message.completed", role: "assistant", content: "Authoritative\n" + malicious });
    expect(document.querySelectorAll(".message")).toHaveLength(1);
    expect(document.querySelector(".message p")!.textContent).toBe("Authoritative\n" + malicious);
    expect(document.querySelector(".streaming")).toBeNull();
    ws!.receive({ type: "message.delta", delta: "Next message" });
    ws!.receive({ type: "message.completed", role: "assistant", content: "Next message final" });
    expect(document.querySelectorAll(".message")).toHaveLength(2);
    ws!.receive({ type: "message.completed", role: "user", content: malicious });
    expect(document.querySelector(".user p")!.textContent).toBe(malicious);
    expect(document.querySelector("img")).toBeNull();
    ws!.receive({ type: "activity.started", activity: { kind: "tool", tool_call_id: "c1", tool: "read", args: { path: malicious } } });
    ws!.receive({ type: "activity.started", activity: { kind: "tool", tool_call_id: "c2", tool: "bash", args: { command: "bun test" } } });
    ws!.receive({ type: "activity.completed", activity: { kind: "tool", tool_call_id: "c2", tool: "bash", is_error: true } });
    ws!.receive({ type: "activity.completed", activity: { kind: "tool", tool_call_id: "c1", tool: "read", is_error: false } });
    expect(document.querySelectorAll("#activity li")).toHaveLength(2);
    expect(document.querySelector("#activity .failed")!.textContent).toContain("bun test");
    expect(document.querySelector("#activity .done")!.textContent).toContain(malicious);
    expect(document.querySelectorAll(".message")).toHaveLength(3);
    expect(document.querySelector("img")).toBeNull();
    // Final after a browser-only reconnect still replaces the interrupted draft.
    ws!.receive({ type: "message.delta", delta: "Before connection loss" });
    ws!.dispatchEvent(new window.Event("close"));
    expect(document.querySelector<HTMLButtonElement>("#compose button")!.disabled).toBe(true);
    expect(document.querySelectorAll(".message")).toHaveLength(4);
    ws!.dispatchEvent(new window.Event("open"));
    ws!.receive({ type: "sessions.snapshot", sessions: [session] });
    ws!.receive({ type: "message.completed", role: "assistant", content: "Final after reconnect" });
    expect(document.querySelectorAll(".message")).toHaveLength(4);
    expect(document.querySelector(".message:last-child p")!.textContent).toBe("Final after reconnect");
    ws!.receive({ type: "message.delta", registration_id: "different", delta: "WRONG SESSION" });
    expect(document.body.textContent).not.toContain("WRONG SESSION");
    const text = document.querySelector<HTMLTextAreaElement>("#text")!;
    text.value = "  hello\n";
    document.querySelector("#compose")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(ws!.sent[0]).toMatchObject({ version: 1, type: "message.send", registration_id: "r1", session_id: "s1", text: "  hello\n" });
    expect(text.value).toBe("");
    ws!.receive({ type: "gateway.error", code: "unknown_session", message: "Gone", request_id: (ws!.sent[0] as { request_id: string }).request_id });
    expect(document.getElementById("chat-error")!.textContent).toBe("Gone");
    expect(text.value).toBe("  hello\n");
    ws!.receive({ type: "session.updated", session, reset: true });
    expect(document.querySelectorAll("#activity li")).toHaveLength(0);
    ws!.receive({ type: "session.removed" });
    expect(document.querySelector<HTMLButtonElement>("#compose button")!.disabled).toBe(true);
    expect(document.getElementById("session-status")!.textContent).toBe("offline");
  } finally { await window.happyDOM.close(); }
});
