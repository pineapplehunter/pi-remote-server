---
title: Browser selection of steer or follow-up delivery
created: 2026-10-01 21:44:44
status: completed
finished: 2026-10-01 22:25:25
priority: P1
base: 81d5665
tag: protocol
---

## Description

User feedback: “Add a option on the browser to choose to send the message as steer or followup.”

Add a labeled composer choice, defaulting to Follow-up. Carry optional `delivery: "steer" | "followUp"` through browser/gateway/Pi messages and honor Pi's sendUserMessage deliverAs semantics. Missing delivery retains existing follow-up behavior; idle messages still start normal turns. Preserve the selected mode through bounded retry/compaction deferral; do not add abort controls, offline queues or automatic resend. Upgrade both gateway and extension; old extensions ignore unknown fields and cannot honor steering.

## Checklist

- [x] Add an accessible browser mode selector used by Send and Ctrl+Enter.
- [x] Validate and forward the optional mode without changing legacy envelopes.
- [x] Apply the selected mode in Pi, including recovery-gap deferral.
- [x] Verify parser/routing/UI and Pi injection behavior with parallel test subagents.
- [x] Document semantics, defaults and coordinated upgrade requirements.

## Completion notes

Added a labeled, 44px native Send as selector, defaulting to Follow-up. Send and Ctrl+Enter pass the selected optional delivery mode through the gateway to Pi's deliverAs API; legacy envelopes remain unchanged and invalid modes fail safely. Recovery/compaction deferral preserves each queued mode and existing text/count bounds. Matched routing errors restore both draft and mode; new views/reloads reset to Follow-up without storing the choice. Documented idle behavior, steering's non-abort semantics and coordinated gateway/extension upgrades.

Fresh independent subagents verified 27 gateway tests (263 assertions) and 29 extension tests, with both strict type-checks passing and no worker source edits. The gateway's first validation exposed a test fixture's widened literal types; adding as const fixed it, and a fresh snapshot passed. Combined checks in the original checkout passed all 56 tests and both type-checks. The newer remote-rename removal remains intact.

Chromium verified actual selected-mode packets reaching the mock agent via Ctrl+Enter (Steer) and button Send (Follow-up), newline input, resizing, reset/defaults, keyboard tool toggle, hidden live calls, reload preference, desktop/mobile/dark layouts and 44px select/Send targets. Reviewed screenshots; no page errors or horizontal overflow. Pinned CDN scripts were fulfilled from matching installed copies for deterministic checks. Nix OCI image and ready-to-load Pi extension builds passed with --no-link. No live provider calls or local Docker runtime smoke test.
