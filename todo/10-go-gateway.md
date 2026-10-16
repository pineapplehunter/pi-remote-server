---
title: Rewrite the gateway in Go
created: 2026-10-16 11:44:00
status: in-progress
priority: P1
base: 36cf8ea
tag: go-migration
---

## Description

User request: “I want the docker image to be smaller. rewrite the server in go. make a implementation paln, make the todo items then implement and commit the changes.”

See [implementation plan](../docs/go-server-plan.md). Current baseline still uses Bun and Zod in `src/`; no changes since baseline. The request remains relevant. Replace only the gateway; retain the JS browser and TS Pi extension.

## Checklist

- [ ] Port config, credentials, validated protocol, registry, HTTP/WebSockets and bounded history.
- [ ] Embed safe HTML templates and static assets; preserve browser behavior.
- [ ] Replace server unit tests and run existing integration/browser compatibility tests against Go.

## Completion notes

Pending implementation and verification.
