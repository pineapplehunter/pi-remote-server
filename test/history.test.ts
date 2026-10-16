import { expect, test } from "bun:test";
import { harness, Client } from "./helpers.ts";
const registration = () => ({ version: 1, type: "session.register", session_id: "s1", host_id: "laptop", cwd: "/work", name: "Test", pid: 123 });
const event = (type: string, fields: object) => ({ version: 1, type, session_id: "s1", ...fields });

test("WebSocket history restores browser gaps, isolates registrations, and resets on agent disconnect", async () => {
  const h = await harness();
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
    // An observer on the same broadcast stream provides an ordering barrier.
    const observer = await h.browser();
    a.send(event("session.status", { status: "idle" }));
    await observer.take("session.status");
    observer.socket.close();
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
    expect(await h.sessions()).toHaveLength(0);
    reopened.send({ version: 1, type: "session.history", registration_id: id, session_id: "s1" });
    expect((await reopened.take("gateway.error")).code).toBe("unknown_session");
  } finally { a.socket.close(); b.socket.close(); reopened?.socket.close(); h.stop(); }
});
