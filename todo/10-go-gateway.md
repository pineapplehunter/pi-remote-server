---
title: Rewrite the gateway in Go
created: 2026-10-16 11:44:00
status: completed
priority: P1
base: 36cf8ea
tag: go-migration
finished: 2026-10-16 12:00:05
---

## Description

User request: “I want the docker image to be smaller. rewrite the server in go. make a implementation paln, make the todo items then implement and commit the changes.”

See [implementation plan](../docs/go-server-plan.md). Current baseline still uses Bun and Zod in `src/`; no changes since baseline. The request remains relevant. Replace only the gateway; retain the JS browser and TS Pi extension.

## Checklist

- [x] Port config, credentials, validated protocol, registry, HTTP/WebSockets and bounded history.
- [x] Embed safe HTML templates and static assets; preserve browser behavior.
- [x] Replace server unit tests and run existing integration/browser compatibility tests against Go.

## Completion notes

Replaced `src/*.ts` with root Go server files and embedded `templates/views.html`/public assets. Protocol ownership, lifecycle, origin/token checks, safe rendering and history bounds are retained. Socket writers have bounded byte/frame queues and ping/pong deadlines; registry operations never wait on network writes.

`go test -race ./...`, `go vet ./...`, static Go build and root TypeScript typecheck passed. All 15 HTTP/WebSocket/browser tests (166 assertions) passed against both a locally built Go server and the actual Nix-built executable. Pi extension source and browser assets are unchanged; its 29 tests/typecheck passed. See [results](../docs/go-server-plan.md#execution-results). Delivered atomically with task 11 so packaging never points to removed TypeScript source.
