import { describe, expect, test } from "bun:test";
import { MAX_FRAME_BYTES, MAX_TEXT_BYTES, parseAgentMessage, parseBrowserMessage, ProtocolError } from "../src/protocol.ts";
const agent = (message: object) => JSON.stringify({ version: 1, session_id: "s1", ...message });
function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return error instanceof ProtocolError ? error.code : undefined; }
}

describe("agent protocol v1", () => {
  test("all actual extension events", () => {
    for (const message of [
      { type: "session.register", host_id: "laptop", cwd: "/work", name: null, pid: 123 },
      { type: "session.updated", name: "Debug tests" }, { type: "session.updated", name: null },
      { type: "session.unregister", reason: "quit" },
      { type: "session.status", status: "working" }, { type: "session.status", status: "idle" },
      { type: "message.delta", delta: "text" },
      { type: "message.completed", role: "user", content: "hello" },
      { type: "message.completed", role: "assistant", content: "" },
      { type: "activity.started", activity: { kind: "tool", tool_call_id: "c1", tool: "bash", args: { command: "test" } } },
      { type: "activity.started", activity: { kind: "tool", tool_call_id: "c2", tool: "read", args: {}, args_omitted: true } },
      { type: "activity.completed", activity: { kind: "tool", tool_call_id: "c1", tool: "bash", is_error: false } },
      { type: "error", code: "injection_failed", message: "Pi could not accept the user message." },
    ]) expect(String(parseAgentMessage(agent(message)).type)).toBe(message.type);
  });
  test("malformed JSON, binary, unsupported type/version and invalid payloads", () => {
    expect(code(() => parseAgentMessage("{"))).toBe("invalid_json");
    expect(code(() => parseAgentMessage(Buffer.from("{}")))).toBe("invalid_message");
    for (const raw of ["null", "[]", "42"]) expect(code(() => parseAgentMessage(raw))).toBe("invalid_message");
    expect(code(() => parseAgentMessage(agent({ type: "unknown" })))).toBe("unsupported_type");
    expect(code(() => parseAgentMessage(agent({ type: "toString" })))).toBe("unsupported_type");
    expect(code(() => parseAgentMessage(agent({ version: "1", type: "session.status", status: "idle" })))).toBe("unsupported_version");
    expect(code(() => parseAgentMessage(agent({ version: 2, type: "session.status", status: "idle" })))).toBe("unsupported_version");
    for (const message of [
      { type: "session.status", status: "online" }, { type: "session.status", session_id: "", status: "idle" },
      { type: "session.register", host_id: "laptop", cwd: "/", name: null, pid: -1 },
      { type: "message.completed", role: "system", content: "text" },
      { type: "message.delta", delta: {} },
      { type: "activity.completed", activity: { kind: "tool", tool_call_id: "c", tool: "bash", is_error: "false" } },
      { type: "activity.started", activity: { kind: "tool", tool_call_id: "c", tool: "bash", args: "x".repeat(16385) } },
    ]) expect(code(() => parseAgentMessage(agent(message)))).toBe("invalid_message");
    expect(code(() => parseAgentMessage(" ".repeat(MAX_FRAME_BYTES + 1)))).toBe("invalid_message");
  });
  test("ignores unknown properties instead of forwarding raw unvalidated data", () => {
    expect(parseAgentMessage(agent({ type: "message.delta", delta: "hi", secret: "hidden" }))).toEqual({ version: 1, session_id: "s1", type: "message.delta", delta: "hi" });
  });
});

describe("browser protocol", () => {
  const input = { version: 1, type: "message.send", registration_id: "r1", session_id: "s1", text: "  hello\n" };
  test("preserves valid whitespace and enforces decoded UTF-8 size", () => {
    expect(parseBrowserMessage(JSON.stringify(input)).text).toBe("  hello\n");
    expect(parseBrowserMessage(JSON.stringify({ ...input, text: "x".repeat(MAX_TEXT_BYTES) })).text.length).toBe(MAX_TEXT_BYTES);
    expect(code(() => parseBrowserMessage(JSON.stringify({ ...input, text: "é".repeat(MAX_TEXT_BYTES / 2 + 1) })))).toBe("text_too_large");
    expect(code(() => parseBrowserMessage(JSON.stringify({ ...input, text: " \n" })))).toBe("invalid_message");
    expect(code(() => parseBrowserMessage(JSON.stringify({ ...input, registration_id: "" })))).toBe("invalid_message");
    expect(code(() => parseBrowserMessage(JSON.stringify({ ...input, type: "session.create" })))).toBe("unsupported_type");
  });
});
