import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { usageLimit } from "../extensions/pi-remote/usage-limit.ts";

const event = (errorMessage: string, role = "assistant", stopReason = "error") => ({ type: "message_end", message: { role, stopReason, errorMessage } }) as MessageEndEvent;
test("explicit usage/quota exhaustion is announced, bounded and token-redacted", () => {
  for (const error of ["You have hit your ChatGPT usage limit (plus plan). Try again later.", '{"code":"usage_limit_reached"}', "You exceeded your current quota", "insufficient_quota", "Weekly limit reached"]) {
    const notice = usageLimit(event(error + " secret-token " + "x".repeat(1000)), "s1", "secret-token");
    assert.equal(notice?.type, "error");
    if (notice?.type === "error") {
      assert.equal(notice.code, "usage_limit_reached");
      assert.ok(notice.message.length < 600);
      assert.ok(!notice.message.includes("secret-token"));
      assert.ok(notice.message.includes("[REDACTED]"));
    }
  }
});
test("throughput limits, other failures, successful responses and non-assistant messages are not quota alerts", () => {
  for (const error of ["429 Too Many Requests", "rate_limit_exceeded: tokens per minute", "Invalid API key", "Could not check usage limit"]) assert.equal(usageLimit(event(error), "s1", "secret-token"), undefined);
  assert.equal(usageLimit(event("usage_limit_reached", "user"), "s1", "secret-token"), undefined);
  assert.equal(usageLimit(event("usage_limit_reached", "assistant", "stop"), "s1", "secret-token"), undefined);
});
