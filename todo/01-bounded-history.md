---
title: Bounded in-memory session history
created: 2026-10-01 17:18:34
status: completed
finished: 2026-10-01 17:57:36
priority: P1
base: 7ac4434
tag: feature
---

## Description

Previous request (summarized from compacted context): restore recently received chat/activity when opening or reopening the browser. The user approved a bounded in-memory gateway buffer rather than full Pi history synchronization.

Retain recent output per live registration and restore it on selection/browser reconnect. No database, Pi history retrieval, or offline queue. Buffers disappear on agent disconnect or gateway restart.

## Checklist

- [x] Bound retention by entry count, text length and serialized bytes.
- [x] Restore history and active draft; synchronize with live events without overlap.
- [x] Keep registrations isolated; discard on agent disconnect.
- [x] Test restoration, eviction, reconnection and escaping; document limits.

## Completion notes

Implemented `SessionHistory`: 400 entries / 512 KiB entry JSON, 64 Ki UTF-16 units per text/draft plus marker. HTTP and browser-only WebSocket history restore a materialized unified feed with sequence watermarks. Pi wire shapes remain unchanged by history. Repeated registration resets transient state; disconnect discards the buffer. Bounds/lifecycle, real WebSocket restoration and DOM snapshot-overlap checks pass in the 24-test gateway suite; strict type-check passes. Limits and ephemeral semantics are documented in README.
