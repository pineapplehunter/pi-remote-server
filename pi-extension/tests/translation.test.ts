import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageEndEvent, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { completed, textDelta, TextRedactor, toolStarted, toolCompleted } from "../extensions/pi-remote/translation.ts";

const token = "private-bearer-token";
test("completed messages omit images/reasoning and preserve text", () => {
  const event = { type: "message_end", message: { role: "assistant", content: [
    { type: "thinking", thinking: "reasoning" }, { type: "text", text: "hello " },
    { type: "toolCall", id: "1", name: "bash", arguments: {} }, { type: "text", text: "world" },
  ] } } as MessageEndEvent;
  assert.deepEqual(completed(event, "id", token), { version: 1, type: "message.completed", session_id: "id", role: "assistant", content: "hello world" });
  assert.equal(completed({ type: "message_end", message: { role: "toolResult" } } as MessageEndEvent, "id", token), undefined);
  const user = { type: "message_end", message: { role: "user", content: [{ type: "image", data: "image" }, { type: "text", text: token }] } } as MessageEndEvent;
  assert.equal(completed(user, "id", token)?.type, "message.completed");
  assert.equal(JSON.stringify(completed(user, "id", token)).includes(token), false);
});
test("only incremental assistant text_delta is extracted", () => {
  const event = { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "cumulative text" }] }, assistantMessageEvent: { type: "text_delta", delta: "delta" } } as MessageUpdateEvent;
  assert.equal(textDelta(event), "delta");
  assert.equal(textDelta({ ...event, assistantMessageEvent: { type: "thinking_delta", delta: "secret reasoning" } } as MessageUpdateEvent), undefined);
});
test("stream redaction catches bearer tokens split across arbitrary deltas", () => {
  for (let split = 0; split <= token.length; split++) {
    const redactor = new TextRedactor(token);
    const output = redactor.push(`hello ${token.slice(0, split)}`) + redactor.push(`${token.slice(split)} world`) + redactor.finish();
    assert.equal(output, "hello [REDACTED] world");
  }
  const redactor = new TextRedactor(token);
  assert.equal(redactor.push("ordinary text"), "ordinary text");
  redactor.push("private-"); redactor.reset(); assert.equal(redactor.finish(), "");
});
test("tool activity bounds arguments and excludes results", () => {
  const start = { type: "tool_execution_start" as const, toolCallId: "call1", toolName: "bash", args: { command: "npm run check" } };
  const message = toolStarted(start, "id", token);
  assert.equal(message.type, "activity.started");
  for (const args of [{ value: "x".repeat(20 * 1024) }, { secret: token }, { big: 1n }]) {
    const output = toolStarted({ ...start, args }, "id", token);
    if (output.type === "activity.started") { assert.equal(output.activity.args_omitted, true); assert.deepEqual(output.activity.args, {}); }
  }
  const end = toolCompleted({ type: "tool_execution_end", toolCallId: "call1", toolName: "bash", isError: true, result: { huge: "result" } }, "id");
  assert.deepEqual(end, { version: 1, type: "activity.completed", session_id: "id", activity: { kind: "tool", tool_call_id: "call1", tool: "bash", is_error: true } });
});
