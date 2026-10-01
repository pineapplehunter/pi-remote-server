import { describe, expect, test } from "bun:test";
import { browserMessage } from "../src/browser-ws.ts";
import { Registry, type Socket } from "../src/registry.ts";
import { Client, harness, register } from "./helpers.ts";

const event = (type: string, data: object = {}) => ({ version: 1, type, session_id: "s1", ...data });

describe("real Bun HTTP / WebSocket gateway", () => {
  test("agent upgrade requires bearer header; browser Origin is required", async () => {
    const h = harness("https://pi.example");
    try {
      for (const headers of [new Headers(), new Headers({ Authorization: "Bearer wrong" })]) {
        expect((await fetch(`${h.base}/agent/ws`, { headers })).status).toBe(401);
      }
      expect((await fetch(`${h.base}/agent/ws?token=test-secret`, { headers: { Authorization: "Bearer test-secret" } })).status).toBe(401);
      expect((await fetch(`${h.base}/agent/ws`, { headers: { Authorization: "Bearer test-secret" } })).status).toBe(426);
      expect((await fetch(`${h.base}/ws`)).status).toBe(403);
      expect((await fetch(`${h.base}/ws`, { headers: { Origin: "https://evil" } })).status).toBe(403);
      expect((await fetch(`${h.base}/ws`, { headers: { Origin: "https://pi.example" } })).status).toBe(426);
      const bad = new Client(`${h.wsBase}/agent/ws`, { Authorization: "Bearer wrong" });
      await expect(bad.opened).rejects.toThrow();
      await h.agent();
      await h.browser();
    } finally { h.stop(); }
  });

  test("register/status/name/unregister updates HTML and all browsers", async () => {
    const h = harness();
    try {
      const a = await h.agent(); const b = await h.browser(); const observer = await h.browser();
      register(a, { name: '<img src=x onerror="alert(1)">' });
      const added = await b.take("session.added");
      await observer.take("session.added");
      const id = added.session.registration_id;
      expect(h.registry.hosts.get("laptop")?.size).toBe(1);
      const list = await (await fetch(`${h.base}/ui/sessions`)).text();
      expect(list).toContain("&lt;img"); expect(list).not.toContain("<img"); expect(list).not.toContain("test-secret");
      const detail = await (await fetch(`${h.base}/ui/sessions/${id}`)).text();
      expect(detail).toContain(`data-registration-id="${id}"`);
      expect(detail).not.toContain("<img");
      expect(await (await fetch(`${h.base}/?session=${id}`)).text()).toContain('id="compose"');
      a.send(event("session.status", { status: "working" }));
      expect((await b.take("session.status")).status).toBe("working");
      expect(h.registry.sessions.get(id)?.status).toBe("working");
      a.send(event("session.updated", { name: null }));
      expect((await b.take("session.updated")).session.name).toBeNull();
      register(a);
      expect((await b.take("session.updated")).reset).toBe(true);
      expect(h.registry.sessions.size).toBe(1);
      expect(h.registry.sessions.get(id)?.registration_id).toBe(id);
      a.send(event("session.unregister", { reason: "quit" }));
      expect((await b.take("session.removed")).registration_id).toBe(id);
      expect(h.registry.sessions.size).toBe(0);
      expect((await fetch(`${h.base}/ui/sessions/${id}`)).status).toBe(404);
    } finally { h.stop(); }
  });

  test("routes exact message.send to intended live process despite identical Pi IDs", async () => {
    const h = harness();
    try {
      const a1 = await h.agent(); const a2 = await h.agent(); const a3 = await h.agent("gpu-secret"); const b = await h.browser();
      register(a1); const r1 = (await b.take("session.added")).session.registration_id;
      register(a2, { pid: 456 }); const r2 = (await b.take("session.added")).session.registration_id;
      register(a3, { host_id: "gpu01" }); const r3 = (await b.take("session.added")).session.registration_id;
      expect(new Set([r1, r2, r3]).size).toBe(3);
      expect(h.registry.hosts.get("laptop")?.size).toBe(2);
      b.send({ version: 1, type: "message.send", registration_id: r2, session_id: "s1", text: "  hello\n", request_id: "request1" });
      expect(await a2.take("message.send")).toEqual({ version: 1, type: "message.send", session_id: "s1", text: "  hello\n" });
      expect(a1.events).toHaveLength(0); expect(a3.events).toHaveLength(0);
      a2.send(event("message.delta", { delta: "look " }));
      expect(await b.take("message.delta")).toEqual(event("message.delta", { delta: "look ", registration_id: r2 }));
      a2.send(event("message.completed", { role: "assistant", content: "Final content" }));
      expect((await b.take("message.completed")).content).toBe("Final content");
      a2.send(event("activity.started", { activity: { kind: "tool", tool_call_id: "c1", tool: "bash", args: { command: "bun test" } } }));
      expect((await b.take("activity.started")).activity.args.command).toBe("bun test");
      a2.send(event("activity.completed", { activity: { kind: "tool", tool_call_id: "c1", tool: "bash", is_error: false } }));
      expect((await b.take("activity.completed")).activity.is_error).toBe(false);
      a2.send(event("error", { code: "injection_failed", message: "Could not inject." }));
      expect((await b.take("error")).code).toBe("injection_failed");
      b.send({ version: 1, type: "message.send", registration_id: r1, session_id: "wrong", text: "bad" });
      expect((await b.take("gateway.error")).code).toBe("wrong_session");
      b.send({ version: 1, type: "message.send", registration_id: "gone", session_id: "s1", text: "bad", request_id: "request2" });
      expect(await b.take("gateway.error")).toMatchObject({ code: "unknown_session", request_id: "request2" });
      b.send("{"); expect((await b.take("gateway.error")).code).toBe("invalid_json");
      // Invalid browser messages do not disconnect Pi or poison routing.
      b.send({ version: 1, type: "message.send", registration_id: r3, session_id: "s1", text: "still works" });
      expect((await a3.take("message.send")).text).toBe("still works");
    } finally { h.stop(); }
  });

  test("disconnect removes only that connection; reconnect/register restores without replay", async () => {
    const h = harness();
    try {
      const a = await h.agent(); const other = await h.agent(); const b = await h.browser();
      register(a); const oldId = (await b.take("session.added")).session.registration_id;
      register(other, { pid: 456 }); const otherId = (await b.take("session.added")).session.registration_id;
      a.socket.close(); await a.closed;
      expect((await b.take("session.removed")).registration_id).toBe(oldId);
      expect(h.registry.sessions.has(otherId)).toBe(true);
      b.send({ version: 1, type: "message.send", registration_id: oldId, session_id: "s1", text: "gone" });
      expect((await b.take("gateway.error")).code).toBe("unknown_session");
      const reconnected = await h.agent(); register(reconnected);
      const newId = (await b.take("session.added")).session.registration_id;
      expect(newId).not.toBe(oldId);
      expect(h.registry.sessions.size).toBe(2);
      const observer = await h.browser();
      expect(observer.events.some(event => event.type.startsWith("message."))).toBe(false);
      observer.socket.close(); await observer.closed;
    } finally { h.stop(); }
  });

  test("host mismatch, wrong ownership and malformed agent messages are rejected", async () => {
    const h = harness();
    try {
      const b = await h.browser();
      const wrongHost = await h.agent(); register(wrongHost, { host_id: "gpu01" });
      await wrongHost.closed;
      expect(h.registry.sessions.size).toBe(0);
      const a = await h.agent(); register(a);
      const id = (await b.take("session.added")).session.registration_id;
      const intruder = await h.agent();
      intruder.send(event("session.status", { status: "working" })); await intruder.closed;
      expect(h.registry.sessions.get(id)?.status).toBeNull();
      a.send("{"); await a.closed; await b.take("session.removed");
      expect(h.registry.sessions.size).toBe(0);
      for (const payload of [event("unknown"), event("session.status", { version: 2, status: "idle" }), event("session.status", { session_id: "wrong", status: "idle" })]) {
        const client = await h.agent(); register(client); await b.take("session.added");
        client.send(payload); await client.closed; await b.take("session.removed");
      }
      expect(h.registry.sessions.size).toBe(0);
    } finally { h.stop(); }
  });

  test("binary frames are rejected and oversized agent frames clean up sessions", async () => {
    const h = harness();
    try {
      const b = await h.browser(); const a = await h.agent();
      b.socket.send(Buffer.from("{}"));
      expect((await b.take("gateway.error")).code).toBe("invalid_message");
      register(a); await b.take("session.added");
      a.socket.send(Buffer.from("{}")); await a.closed; await b.take("session.removed");
      const replacement = await h.agent(); register(replacement); await b.take("session.added");
      replacement.send("x".repeat(1024 * 1024 + 1));
      await replacement.closed; await b.take("session.removed");
      expect(h.registry.sessions.size).toBe(0);
      expect((await fetch(h.base)).status).toBe(200);
    } finally { h.stop(); }
  });

  test("static whitelist, server rendered pages, response headers", async () => {
    const h = harness();
    try {
      const response = await fetch(h.base);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toContain("/public/htmx.min.js");
      const js = await fetch(`${h.base}/public/app.js`);
      expect(js.status).toBe(200); expect(js.headers.get("content-type")).toContain("javascript");
      expect((await fetch(`${h.base}/public/htmx.min.js`)).status).toBe(200);
      const favicon = await fetch(`${h.base}/favicon.svg`);
      expect(favicon.status).toBe(200);
      expect(favicon.headers.get("content-type")).toContain("image/svg+xml");
      expect(await favicon.text()).toContain("<svg");
      expect((await fetch(`${h.base}/public/auth.ts`)).status).toBe(404);
      expect((await fetch(`${h.base}/api/credentials`)).status).toBe(404);
      expect((await fetch(h.base, { method: "POST" })).status).toBe(405);
    } finally { h.stop(); }
  });
});

test("stale closed socket returns useful error even before disconnect cleanup", () => {
  const registry = new Registry();
  const agent = { readyState: 3 } as unknown as Socket;
  const replies: object[] = [];
  const browser = { readyState: 1, getBufferedAmount: () => 0, send: (value: string) => { replies.push(JSON.parse(value)); return 1; } } as unknown as Socket;
  registry.connectAgent(agent, "laptop");
  registry.register(agent, "laptop", { version: 1, type: "session.register", session_id: "s1", host_id: "laptop", cwd: "/", name: null, pid: 1 });
  const id = registry.list()[0]!.registration_id;
  browserMessage(registry, browser, JSON.stringify({ version: 1, type: "message.send", registration_id: id, session_id: "s1", text: "test" }));
  expect(replies[0]).toMatchObject({ type: "gateway.error", code: "session_unavailable" });
  expect(registry.sessions.size).toBe(0);
});
