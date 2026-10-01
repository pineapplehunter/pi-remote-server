---
title: Load vendor browser libraries from a CDN
created: 2026-10-01 17:38:16
status: completed
finished: 2026-10-01 17:57:36
priority: P1
base: 7ac4434
tag: ui
---

## Description

User feedback: “Make marked and other vendor libs be loaded from a CDN.”

Load HTMX, Marked and DOMPurify from pinned CDN URLs with integrity checks. Keep application code local and tests independent of CDN availability. This supersedes earlier local-vendor asset requirements in task 03.

## Checklist

- [x] Replace vendor script URLs, remove vendored browser assets, and allow the CDN in CSP.
- [x] Pin exact versions with verified integrity hashes.
- [x] Test the page/CSP contract and document CDN availability requirements.

## Completion notes

HTMX 2.0.8, Marked 15.0.12 and DOMPurify 3.3.3 load from jsDelivr with SHA-384 SRI/crossorigin=anonymous/defer. All three CDN responses were fetched and their exact hashes verified. Offline tests hash the installed assets and validate page attributes; HTTP tests verify CSP and removed local vendor routes. No vendor JS/license files remain in public/. Application assets remain local; missing CDN/sanitizer libraries fail closed with a visible message. README documents the CDN dependency and absence of fallback.
