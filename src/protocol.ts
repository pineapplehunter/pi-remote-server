import { z } from "zod";

// Mirrors the supplied extension's protocol.ts / PROTOCOL.md, without Pi dependencies.
export const VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_TEXT_BYTES = 100 * 1024;
export const MAX_TOOL_ARGS_BYTES = 16 * 1024;
const id = z.string().min(1);
const envelope = { version: z.literal(1), session_id: id };
const tool = { kind: z.literal("tool"), tool_call_id: id, tool: id };
const agentSchemas = {
  "session.register": z.object({ ...envelope, type: z.literal("session.register"), host_id: id, cwd: z.string(), name: z.string().nullable(), pid: z.number().int().positive() }),
  "session.updated": z.object({ ...envelope, type: z.literal("session.updated"), name: z.string().nullable() }),
  "session.unregister": z.object({ ...envelope, type: z.literal("session.unregister"), reason: z.enum(["quit", "reload", "new", "resume", "fork"]) }),
  "session.status": z.object({ ...envelope, type: z.literal("session.status"), status: z.enum(["idle", "working"]) }),
  "message.delta": z.object({ ...envelope, type: z.literal("message.delta"), delta: z.string() }),
  "message.completed": z.object({ ...envelope, type: z.literal("message.completed"), role: z.enum(["user", "assistant"]), content: z.string() }),
  "activity.started": z.object({ ...envelope, type: z.literal("activity.started"), activity: z.object({ ...tool, args: z.json(), args_omitted: z.literal(true).optional() }) }),
  "activity.completed": z.object({ ...envelope, type: z.literal("activity.completed"), activity: z.object({ ...tool, is_error: z.boolean() }) }),
  "error": z.object({ ...envelope, type: z.literal("error"), code: z.enum(["invalid_json", "invalid_message", "unsupported_version", "unsupported_type", "text_too_large", "wrong_session", "injection_failed", "usage_limit_reached"]), message: z.string() }),
};
export type AgentMessage = z.infer<(typeof agentSchemas)[keyof typeof agentSchemas]>;

const browserTarget = { version: z.literal(1), registration_id: id, session_id: id, request_id: z.string().min(1).max(128).optional() };
const browserSchema = z.discriminatedUnion("type", [
  z.object({ ...browserTarget, type: z.literal("message.send"), text: z.string().refine(text => text.trim().length > 0) }),
  z.object({ ...browserTarget, type: z.literal("session.history") }),
]);
export type BrowserMessage = z.infer<typeof browserSchema>;
export interface SendMessage { version: 1; type: "message.send"; session_id: string; text: string }

export class ProtocolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function object(raw: string | Buffer): Record<string, unknown> {
  if (typeof raw !== "string") throw new ProtocolError("invalid_message", "Expected a JSON text frame.");
  if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) throw new ProtocolError("invalid_message", "Frame exceeds 1 MiB.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ProtocolError("invalid_json", "Expected JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("invalid_message", "Expected an object.");
  const data = value as Record<string, unknown>;
  if (data.version !== VERSION) throw new ProtocolError("unsupported_version", "Expected protocol version 1.");
  return data;
}

export function parseAgentMessage(raw: string | Buffer): AgentMessage {
  const data = object(raw);
  if (typeof data.type !== "string" || !Object.hasOwn(agentSchemas, data.type)) {
    throw new ProtocolError("unsupported_type", "Unsupported agent message type.");
  }
  let result;
  try { result = agentSchemas[data.type as keyof typeof agentSchemas].safeParse(data); }
  catch { throw new ProtocolError("invalid_message", "Invalid agent message."); }
  if (!result.success) throw new ProtocolError("invalid_message", "Invalid agent message.");
  const message = result.data;
  if (message.type === "activity.started" && Buffer.byteLength(JSON.stringify(message.activity.args)) > MAX_TOOL_ARGS_BYTES) {
    throw new ProtocolError("invalid_message", "Tool arguments exceed 16 KiB.");
  }
  return message;
}

export function parseBrowserMessage(raw: string | Buffer): BrowserMessage {
  const data = object(raw);
  if (data.type !== "message.send" && data.type !== "session.history") throw new ProtocolError("unsupported_type", "Unsupported browser message type.");
  const result = browserSchema.safeParse(data);
  if (!result.success) throw new ProtocolError("invalid_message", "Expected registration_id, session_id and non-blank text.");
  if (result.data.type === "message.send" && Buffer.byteLength(result.data.text) > MAX_TEXT_BYTES) throw new ProtocolError("text_too_large", "Text exceeds 100 KiB UTF-8.");
  return result.data;
}
