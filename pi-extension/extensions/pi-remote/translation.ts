import type {
  MessageEndEvent, MessageUpdateEvent, ToolExecutionStartEvent, ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { MAX_TOOL_ARGS_BYTES, VERSION, type JsonValue, type OutgoingMessage } from "./protocol.ts";

/** Hold only a possible token prefix, so a secret split across stream deltas cannot leak. */
export class TextRedactor {
  private pending = "";
  constructor(private readonly token: string) {}
  push(delta: string): string {
    const text = (this.pending + delta).replaceAll(this.token, "[REDACTED]");
    let held = Math.min(this.token.length - 1, text.length);
    while (held > 0 && !text.endsWith(this.token.slice(0, held))) held--;
    this.pending = held ? text.slice(-held) : "";
    return held ? text.slice(0, -held) : text;
  }
  finish(): string {
    const text = this.pending;
    this.pending = "";
    return text;
  }
  reset(): void { this.pending = ""; }
}

export function completed(event: MessageEndEvent, sessionId: string, token: string): OutgoingMessage | undefined {
  const { message } = event;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return { version: VERSION, type: "message.completed", session_id: sessionId,
    role: message.role, content: text.replaceAll(token, "[REDACTED]") };
}

export function textDelta(event: MessageUpdateEvent): string | undefined {
  if (event.message.role !== "assistant" || event.assistantMessageEvent.type !== "text_delta") return undefined;
  return event.assistantMessageEvent.delta;
}

export function toolStarted(event: ToolExecutionStartEvent, sessionId: string, token: string): OutgoingMessage {
  let args: JsonValue = {};
  let omitted = false;
  try {
    const serialized = JSON.stringify(event.args);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_TOOL_ARGS_BYTES || serialized.includes(token)) omitted = true;
    else args = JSON.parse(serialized) as JsonValue;
  } catch { omitted = true; }
  return {
    version: VERSION, type: "activity.started", session_id: sessionId,
    activity: { kind: "tool", tool_call_id: event.toolCallId, tool: event.toolName, args,
      ...(omitted ? { args_omitted: true as const } : {}) },
  };
}

export function toolCompleted(event: ToolExecutionEndEvent, sessionId: string): OutgoingMessage {
  return {
    version: VERSION, type: "activity.completed", session_id: sessionId,
    activity: { kind: "tool", tool_call_id: event.toolCallId, tool: event.toolName, is_error: event.isError },
  };
}
