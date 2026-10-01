import { expect, test } from "bun:test";
import { SessionHistory, MAX_HISTORY_BYTES, MAX_HISTORY_ITEMS, MAX_HISTORY_TEXT } from "../src/history.ts";
import type { AgentMessage } from "../src/protocol.ts";
import { harness, Client } from "./helpers.ts";
const registration = () => ({ version: 1, type: "session.register", session_id: "s1", host_id: "laptop", cwd: "/work", name: "Test", pid: 123 });
const event = (type: string, fields: object) => ({ version: 1, type, session_id: "s1", ...fields });
const feed = (type: string, fields: object) => ({ version: 1, type, session_id: "s1", ...fields }) as AgentMessage;

test("history bounds records/bytes/text, preserves feed order, and materializes tools", () => {
  const history = new SessionHistory();
  history.record(feed("message.completed", { role: "user", content: "prompt" }));
  history.record(feed("message.delta", { delta: "partial" }));
  history.record(feed("activity.started", { activity: { kind: "tool", tool_call_id: "c", tool: "read", args: { path: "/work/file" } } }));
  history.record(feed("activity.completed", { activity: { kind: "tool", tool_call_id: "c", tool: "read", is_error: false } }));
  history.record(feed("message.completed", { role: "assistant", content: "final" }));
  let snapshot = history.snapshot();
  expect(snapshot.items.map(item => item.kind)).toEqual(["message", "message", "activity"]);
  expect(snapshot.items.at(-1)).toMatchObject({ summary: "read: /work/file", status: "done" });
  expect(snapshot.draft).toBeNull();
  snapshot.items.length = 0;
  expect(history.snapshot().items).toHaveLength(3);
  for (let i = 0; i < MAX_HISTORY_ITEMS + 10; i++) history.record(feed("message.completed", { role: "user", content: String(i) }));
  snapshot = history.snapshot();
  expect(snapshot.items).toHaveLength(MAX_HISTORY_ITEMS);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.items[0]).toMatchObject({ content: "10" });
  for (let i = 0; i < 20; i++) history.record(feed("message.completed", { role: "assistant", content: "💬".repeat(MAX_HISTORY_TEXT) }));
  history.record(feed("message.delta", { delta: "x".repeat(MAX_HISTORY_TEXT * 2) }));
  snapshot = history.snapshot();
  expect(Buffer.byteLength(JSON.stringify(snapshot.items))).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
  expect(snapshot.draft!.content.length).toBeLessThan(MAX_HISTORY_TEXT + 50);
  // Draft plus metadata has its own bounded budget; total remains below 1 MiB.
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(1024 * 1024);
  history.resetTransient();
  expect(history.snapshot().sequence).toBeGreaterThan(snapshot.sequence);
  expect(history.snapshot().draft).toBeNull();
  expect(history.snapshot().items.length).toBeGreaterThan(0);
});

test("WebSocket history restores browser gaps, isolates registrations, and resets on agent disconnect", async () => {
  const h = harness();
  const a = await h.agent();
  const b = await h.browser();
  let reopened: Client | undefined;
  try {
    a.send(registration());
    const id = (await b.take("session.added")).session.registration_id;
    a.send(event("message.completed", { role: "user", content: "earlier" }));
    expect((await b.take("message.completed")).sequence).toBe(1);
    a.send(event("message.delta", { delta: "partial" }));
    await b.take("message.delta");
    a.send(event("activity.started", { activity: { kind: "tool", tool_call_id: "c1", tool: "bash", args: { command: "echo safe" } } }));
    await b.take("activity.started");
    b.socket.close();
    await b.closed;
    a.send(event("message.completed", { role: "assistant", content: "completed while browser closed" }));
    a.send(event("error", { code: "usage_limit_reached", message: "Explicit usage limit reached" }));
    // Agent frames and HTTP go through the same loop; wait until all feed events were captured.
    for (let i = 0; i < 50 && h.registry.sessions.get(id)!.history.snapshot().sequence < 5; i++) await Bun.sleep(2);
    reopened = new Client(`${h.wsBase}/ws`, { Origin: h.base });
    await reopened.opened;
    const sessions = await reopened.take("sessions.snapshot");
    expect(sessions.sessions[0].history).toBeUndefined();
    reopened.send({ version: 1, type: "session.history", registration_id: id, session_id: "s1" });
    const restored = await reopened.take("session.history");
    expect(restored.history.sequence).toBe(5);
    expect(restored.history.draft).toBeNull();
    expect(restored.history.items.map((item: { kind: string }) => item.kind)).toEqual(["message", "message", "activity", "notice"]);
    expect(restored.history.items[1].content).toBe("completed while browser closed");
    const html = await fetch(`${h.base}/ui/sessions/${id}`).then(response => response.text());
    expect(html).toContain("completed while browser closed");
    expect(html).toContain("usage_limit_reached");
    a.send(registration());
    await reopened.take("session.updated");
    reopened.send({ version: 1, type: "session.history", registration_id: id, session_id: "wrong" });
    expect((await reopened.take("gateway.error")).code).toBe("wrong_session");
    reopened.send({ version: 1, type: "session.history", registration_id: id, session_id: "s1" });
    const reset = (await reopened.take("session.history")).history;
    expect(reset.items.map((item: { kind: string }) => item.kind)).toEqual(["message", "message", "notice"]);
    expect(reset.sequence).toBe(6);
    a.socket.close();
    await reopened.take("session.removed");
    expect(h.registry.sessions.size).toBe(0);
    reopened.send({ version: 1, type: "session.history", registration_id: id, session_id: "s1" });
    expect((await reopened.take("gateway.error")).code).toBe("unknown_session");
  } finally { a.socket.close(); b.socket.close(); reopened?.socket.close(); h.stop(); }
});
