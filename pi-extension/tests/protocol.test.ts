import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TEXT_BYTES, parseServerMessage } from "../extensions/pi-remote/protocol.ts";

const valid = { version: 1, type: "message.send", session_id: "pi-session", text: " hello " };
function parse(patch: Record<string, unknown> = {}) { return parseServerMessage(JSON.stringify({ ...valid, ...patch }), "pi-session"); }
function code(raw: string) { const result = parseServerMessage(raw, "pi-session"); assert.equal(result.ok, false); return !result.ok && result.error.code; }

test("valid text is preserved, legacy delivery stays absent, and unknown fields are ignored", () => {
  assert.deepEqual(parse({ extra: true }), { ok: true, message: valid });
  assert.deepEqual(parse({ delivery: "steer" }), { ok: true, message: { ...valid, delivery: "steer" } });
  assert.deepEqual(parse({ delivery: "followUp" }), { ok: true, message: { ...valid, delivery: "followUp" } });
});
test("invalid delivery is rejected without echoing payload", () => {
  for (const delivery of ["Steer", "followup", "", null, 1, {}]) {
    const result = parse({ delivery });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_message");
      assert.equal(JSON.stringify(result).includes(JSON.stringify(delivery)), false);
    }
  }
});
test("malformed JSON and non-objects are safe errors", () => {
  assert.equal(code("{"), "invalid_json");
  for (const raw of ["null", "[]", "42", '"text"']) assert.equal(code(raw), "invalid_message");
});
test("validates version, type, session, and text", () => {
  const cases = [
    [{ version: "1" }, "unsupported_version"], [{ version: 2 }, "unsupported_version"],
    [{ type: "session.kill" }, "unsupported_type"], [{ session_id: 123 }, "invalid_message"],
    [{ session_id: "" }, "invalid_message"], [{ session_id: "other" }, "wrong_session"],
    [{ text: " \n\t" }, "invalid_message"], [{ text: null }, "invalid_message"],
  ] as const;
  for (const [patch, expected] of cases) {
    const result = parse(patch); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, expected);
  }
});
test("size limit counts UTF-8 bytes, not JS characters", () => {
  assert.equal(parse({ text: "a".repeat(MAX_TEXT_BYTES) }).ok, true);
  assert.equal(parse({ text: "é".repeat(MAX_TEXT_BYTES / 2) }).ok, true);
  for (const text of ["a".repeat(MAX_TEXT_BYTES + 1), "é".repeat(MAX_TEXT_BYTES / 2 + 1)]) {
    const result = parse({ text }); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "text_too_large");
  }
});
test("protocol errors never echo incoming payload", () => {
  const result = parse({ type: "secret-token" });
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});
