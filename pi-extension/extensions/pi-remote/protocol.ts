export const VERSION = 1 as const;
export const MAX_TEXT_BYTES = 100 * 1024;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_TOOL_ARGS_BYTES = 16 * 1024;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type AgentStatus = "working" | "idle";
export type ErrorCode =
  | "invalid_json"
  | "invalid_message"
  | "unsupported_version"
  | "unsupported_type"
  | "text_too_large"
  | "wrong_session"
  | "injection_failed";

interface Envelope {
  version: typeof VERSION;
  session_id: string;
}

export interface SendMessage extends Envelope {
  type: "message.send";
  text: string;
}

export type OutgoingMessage = Envelope & (
  | { type: "session.register"; host_id: string; cwd: string; name: string | null; pid: number }
  | { type: "session.updated"; name: string | null }
  | { type: "session.unregister"; reason: ShutdownReason }
  | { type: "session.status"; status: AgentStatus }
  | { type: "message.completed"; role: "user" | "assistant"; content: string }
  | { type: "message.delta"; delta: string }
  | { type: "activity.started"; activity: {
      kind: "tool"; tool_call_id: string; tool: string;
      args: JsonValue; args_omitted?: true;
    } }
  | { type: "activity.completed"; activity: {
      kind: "tool"; tool_call_id: string; tool: string; is_error: boolean;
    } }
  | { type: "error"; code: ErrorCode; message: string }
);

export interface ProtocolError {
  code: ErrorCode;
  message: string;
}
export type ParseResult = { ok: true; message: SendMessage } | { ok: false; error: ProtocolError };

function failure(code: ErrorCode, message: string): ParseResult {
  return { ok: false, error: { code, message } };
}

/** No payload values are included in errors: input is untrusted and may contain secrets. */
export function parseServerMessage(raw: string, currentSessionId: string): ParseResult {
  if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) {
    return failure("invalid_message", "Message exceeds the frame size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return failure("invalid_json", "Expected a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failure("invalid_message", "Expected a JSON object.");
  }
  const message = value as Record<string, unknown>;
  if (message.version !== VERSION) {
    return failure("unsupported_version", "Expected protocol version 1.");
  }
  if (message.type !== "message.send") {
    return failure("unsupported_type", "Only message.send is supported.");
  }
  if (typeof message.session_id !== "string" || !message.session_id) {
    return failure("invalid_message", "session_id must be a non-empty string.");
  }
  if (message.session_id !== currentSessionId) {
    return failure("wrong_session", "Message targets a different active session.");
  }
  if (typeof message.text !== "string" || !message.text.trim()) {
    return failure("invalid_message", "text must be a non-empty string.");
  }
  if (Buffer.byteLength(message.text, "utf8") > MAX_TEXT_BYTES) {
    return failure("text_too_large", "text exceeds 100 KiB UTF-8.");
  }
  return {
    ok: true,
    message: { version: VERSION, type: "message.send", session_id: message.session_id, text: message.text },
  };
}
