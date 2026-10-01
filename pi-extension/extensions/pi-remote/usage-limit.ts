import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { OutgoingMessage } from "./protocol.ts";

// A 429/rate_limit_error alone can be a transient throughput limit. Only report
// explicit exhausted allowance/quota wording or provider quota codes.
const exhausted = /\b(?:(?:hit|reached|exceeded|exhausted)[^\n]{0,80}usage limit|usage[ _-]limit(?: has been)?[ _-](?:reached|exceeded|exhausted)|insufficient_quota|quota_exceeded|(?:daily|weekly|monthly) limit (?:reached|exceeded)|(?:exceeded|exhausted) (?:your )?(?:current )?quota|quota (?:has been )?(?:exceeded|exhausted))\b/i;

export function usageLimit(event: MessageEndEvent, sessionId: string, token: string): OutgoingMessage | undefined {
  const message = event.message;
  if (message.role !== "assistant" || message.stopReason !== "error" || !message.errorMessage || !exhausted.test(message.errorMessage)) return undefined;
  const detail = message.errorMessage.replaceAll(token, "[REDACTED]").slice(0, 500);
  return { version: 1, type: "error", session_id: sessionId, code: "usage_limit_reached",
    message: `Pi's usage allowance/quota has been reached. ${detail}` };
}
