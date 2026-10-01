---
title: Research and improve the chat composer with Ctrl+Enter send
created: 2026-10-01 20:52:24
status: completed
finished: 2026-10-01 22:12:19
priority: P1
base: 81d5665
tag: ui
---

## Description

User feedback: “Also I want a improved version of the chat input. Research other implemenataions of chat ui input and try to copy the design. also let me send the message with Ctrl+Enter.”

Research existing chat composers and adapt their useful visual/interaction patterns to the existing vanilla-JS/CSS interface. Preserve literal text, delivery/error restoration, mobile usability and CDN dependencies. Ctrl+Enter sends; Enter stays a newline. No framework, attachments, model picker or unsupported stop control.

## Checklist

- [x] Inspect/reference existing implementations and record the design rationale.
- [x] Build a comfortable, auto-growing multiline composer with clear send control/hint.
- [x] Ctrl+Enter submits through the existing path without repeat/IME accidental sends.
- [x] Verify resizing, disabled/blank/offline states and error-restored text.

## Completion notes

Design research/implementation rationale: docs/composer-design.md, referencing a shallow LibreChat checkout at f10b1d91f1eee3a2c82d5247bf620351486b7c1b and assistant-ui Composer documentation. Added a rounded multiline field/action row, focus outline, 44px Send target and keyboard hint. Auto-grow/shrink caps at 224px or 30% of viewport, including rejected-send restoration. Ctrl+Enter uses requestSubmit; Enter remains native newline; repeat/composition events are ignored. Parent validation: all 26 gateway and 27 extension tests/type-checks pass. Headless Chromium checks native Ctrl+Enter, Enter newline, send/focus/reset, resizing and 1280px desktop/390px mobile/dark layouts; screenshots reviewed. CDN assets were supplied from the matching installed copies for deterministic browser checks, not fetched during that test. Saved independent reports record both suites/type-checks passing with no source edits. Later worker cancellation is not fresh current-tree evidence; the final delivery-mode checks will revalidate the combined tree.
