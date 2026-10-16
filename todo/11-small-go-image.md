---
title: Package and verify the small Go image
created: 2026-10-16 11:44:00
status: in-progress
priority: P1
base: 36cf8ea
tag: go-migration
---

## Description

User request: “I want the docker image to be smaller. rewrite the server in go. make a implementation paln, make the todo items then implement and commit the changes.”

Additional user feedback: “After implementation show me how much of a size difference it made.”

See [implementation plan](../docs/go-server-plan.md). `flake.nix` still packages Bun and npm dependencies at the baseline; the request remains relevant with no intervening packaging changes. Depends on task 10.

## Checklist

- [ ] Replace Bun packaging with a stripped static Go server; retain the Pi-extension output.
- [ ] Update dev shell, manifests/locks, CI and README.
- [ ] Verify Go/browser/extension checks and Nix outputs; compare baseline/new image sizes where possible.
- [ ] Record evidence, complete tasks and commit scoped changes.

## Completion notes

Pending implementation and verification.
