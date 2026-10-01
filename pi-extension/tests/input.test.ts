import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteInput } from "../extensions/pi-remote/input.ts";
import type { ProtocolError } from "../extensions/pi-remote/protocol.ts";

test("defaults to followUp and injects selected modes", () => {
  const sent: { text: string; delivery: string; expand: boolean | undefined }[] = [];
  let streaming = true;
  const input = new RemoteInput({ sendUserMessage: (text, options) => {
    sent.push({ text: text as string, delivery: options?.deliverAs ?? "", expand: options?.expandPromptTemplates });
  } }, () => streaming, () => assert.fail("unexpected input error"));
  input.receive("legacy idle", false);
  input.receive("follow-up", true);
  input.receive("steering", true, "steer");
  assert.deepEqual(sent, [
    { text: "legacy idle", delivery: "followUp", expand: false },
    { text: "follow-up", delivery: "followUp", expand: false },
    { text: "steering", delivery: "steer", expand: false },
  ]);
});

test("recovery deferral preserves mixed modes and settlement drains one item", () => {
  const sent: { text: string; delivery: string }[] = [];
  const errors: ProtocolError[] = [];
  let streaming = false;
  const input = new RemoteInput({ sendUserMessage: (text, options) => {
    sent.push({ text: text as string, delivery: options?.deliverAs ?? "" });
  } }, () => streaming, (error) => errors.push(error));
  input.receive("steer through recovery", true, "steer");
  input.receive("follow-up through recovery", true);
  assert.deepEqual(sent, []);
  input.agentStarted(); assert.deepEqual(sent, []);
  streaming = true; input.agentStarted();
  assert.deepEqual(sent, [
    { text: "steer through recovery", delivery: "steer" },
    { text: "follow-up through recovery", delivery: "followUp" },
  ]);

  streaming = false;
  input.receive("settlement steer", true, "steer");
  input.receive("settlement follow-up", true);
  input.agentSettled();
  assert.deepEqual(sent.at(-1), { text: "settlement steer", delivery: "steer" });
  streaming = true; input.agentStarted();
  assert.deepEqual(sent.at(-1), { text: "settlement follow-up", delivery: "followUp" });
  assert.deepEqual(errors, []);
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
