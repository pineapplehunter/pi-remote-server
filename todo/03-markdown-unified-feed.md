---
title: Safe Markdown and a unified conversation/activity stream
created: 2026-10-01 17:18:34
status: completed
finished: 2026-10-01 17:57:36
priority: P1
base: 7ac4434
tag: ui
---

## Description

User feedback: “Also make the out put markdown compatible. activities and conversations should live in the same stream. not separate.”

Render finalized chat as sanitized Markdown; preserve incremental text streaming. Place quieter activity items in the same chronological feed, correlated by tool-call ID. History must preserve this order. No frontend bundler or raw model HTML injection.

## Checklist

- [x] Safely render Markdown, including code blocks and links.
- [x] Unify live/historical chat, draft and activities in chronological order.
- [x] Test malicious HTML/links, parallel tools and authoritative finals.
- [x] Document CDN/dependencies and behavior (local-vendor requirement superseded by task 05).

## Completion notes

Finalized messages use Marked plus DOMPurify sanitized DOM fragments; drafts remain incremental text nodes. A single chronological feed contains chat, correlated tool rows and notices; history preserves initial draft/tool positions. Server HTML is escaped. Markdown/code/XSS/unsafe-link and parallel-tool/finalization tests pass with jsdom (Happy DOM is unsuitable for DOMPurify security tests). Vendor files now load from pinned CDN URLs per task 05. README documents rendering limits.
