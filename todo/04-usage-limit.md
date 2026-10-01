---
title: Announce Pi usage-limit errors over WebSocket
created: 2026-10-01 17:18:34
status: completed
finished: 2026-10-01 17:57:36
priority: P1
base: 7ac4434
tag: protocol
---

## Description

User feedback: “Also detect when the usage limit has been reached and anounce that to the websocket too.”

Detect explicit usage/quota exhaustion in failed assistant messages and emit a structured, redacted notification to the gateway/browser. Do not mistake unrelated failures or transient rate limits for exhausted usage. A coordinated Pi/gateway protocol addition is allowed for this requested feature.

## Checklist

- [x] Verify the Pi error payload/hook and classify explicit usage-limit failures.
- [x] Emit/validate/forward a structured notification; redact credentials.
- [x] Display/retain the notification in the unified feed.
- [x] Test positive/negative cases and document compatibility requirements.

## Completion notes

Added error code `usage_limit_reached`, emitted from failed assistant message_end errors with explicit quota/allowance exhaustion. Details are clipped and the extension token redacted. Deduplication resets only on logical agent_settled, not retry agent_start. Positive/negative classifier tests and real Pi SDK synthetic-provider WebSocket reporting pass in the 27-test extension suite; gateway tests verify broadcast/buffer/display. Both packages type-check. Both protocol docs and READMEs explain coordinated upgrades, text-based detection and no account polling/reset prediction. No provider credentials or real quota were used for tests.
