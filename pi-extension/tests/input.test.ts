import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteInput } from "../extensions/pi-remote/input.ts";
import type { ProtocolError } from "../extensions/pi-remote/protocol.ts";

test("idle/busy inputs use Pi followUp; recovery gaps defer without interrupting", () => {
  const sent: string[] = [];
  let streaming = false;
  const input = new RemoteInput({ sendUserMessage: (text, options) => {
    assert.equal(options?.deliverAs, "followUp"); assert.equal(options.expandPromptTemplates, false);
    sent.push(text as string);
  } }, () => streaming, () => assert.fail("unexpected input error"));
  input.receive("idle", false); assert.deepEqual(sent, ["idle"]);
  input.receive("during recovery", true); input.receive("another follow-up", true);
  assert.deepEqual(sent, ["idle"]);
  input.agentStarted(); assert.deepEqual(sent, ["idle"]);
  streaming = true; input.agentStarted();
  assert.deepEqual(sent, ["idle", "during recovery", "another follow-up"]);
  input.receive("while streaming", true); assert.equal(sent.at(-1), "while streaming");
  streaming = false; input.receive("after recovery", true); input.receive("later", true);
  input.agentSettled(); assert.equal(sent.at(-1), "after recovery");
  streaming = true; input.agentStarted(); assert.equal(sent.at(-1), "later");
});

test("bounded transient queue, synchronous failures, and cleanup", () => {
  const errors: ProtocolError[] = [];
  let calls = 0;
  const input = new RemoteInput({ sendUserMessage: () => { calls++; throw new Error("private failure detail"); } }, () => false, (error) => errors.push(error));
  input.receive("idle", false);
  assert.equal(errors[0]?.code, "injection_failed");
  assert.equal(JSON.stringify(errors).includes("private failure detail"), false);
  for (let i = 0; i < 11; i++) input.receive("x".repeat(100 * 1024), true);
  assert.equal(errors.length, 2, "1 MiB queue limit");
  input.clear(); input.agentSettled(); assert.equal(calls, 1);
});
