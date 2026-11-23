import type {
  MessageEndEvent, MessageUpdateEvent, ToolExecutionStartEvent, ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { MAX_TOOL_ARGS_BYTES, VERSION, type JsonValue, type OutgoingMessage } from "./protocol.ts";

export function completed(event: MessageEndEvent, sessionId: string): OutgoingMessage | undefined {
  const { message } = event;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return { version: VERSION, type: "message.completed", session_id: sessionId,
    role: message.role, content: text };
}

export function textDelta(event: MessageUpdateEvent): string | undefined {
  if (event.message.role !== "assistant" || event.assistantMessageEvent.type !== "text_delta") return undefined;
  return event.assistantMessageEvent.delta;
}

export function toolStarted(event: ToolExecutionStartEvent, sessionId: string): OutgoingMessage {
  let args: JsonValue = {};
  let omitted = false;
  try {
    const serialized = JSON.stringify(event.args);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_TOOL_ARGS_BYTES) omitted = true;
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
