---
title: Browser tool-call visibility toggle
created: 2026-10-01 20:52:24
status: completed
finished: 2026-10-01 22:03:50
priority: P1
base: 81d5665
tag: ui
---

## Description

User feedback: “I want the ability to toggle the display of tool calls on the browser side.”

Add an accessible browser-side show/hide control for tool rows. Keep receiving, correlating and buffering tool calls when hidden; preserve conversation/notices and the unified stream. Remember only the display preference locally, not conversation data.

## Checklist

- [x] Toggle existing, live and restored tool rows without changing Pi/gateway protocol.
- [x] Keep preference through session switching and browser reload when storage is available.
- [x] Verify keyboard accessibility and unchanged chat/notice display.

## Completion notes

Implemented a stable-label, aria-pressed header toggle and CSS-only hiding. Tool correlation/buffering continues while hidden; chat and notices remain visible. Only the visibility boolean is stored in localStorage, with in-memory fallback. DOM tests verify buffered/live completion, restored snapshots and view swaps. Headless Chromium verifies native Space activation, live hidden rows and preference across reload. Parent checks: 26 gateway tests and strict type-check pass; the updated OCI image builds. Saved independent validation reports record 26 gateway tests (243 assertions) and 27 extension tests, with both type-checks passing and no source edits. Later worker cancellation does not provide fresh current-tree evidence; final delivery-mode validation will recheck the combined tree.
