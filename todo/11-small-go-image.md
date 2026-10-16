---
title: Package and verify the small Go image
created: 2026-10-16 11:44:00
status: completed
priority: P1
base: 36cf8ea
tag: go-migration
finished: 2026-10-16 12:00:05
---

## Description

User request: “I want the docker image to be smaller. rewrite the server in go. make a implementation paln, make the todo items then implement and commit the changes.”

Additional user feedback: “After implementation show me how much of a size difference it made.”

See [implementation plan](../docs/go-server-plan.md). `flake.nix` still packages Bun and npm dependencies at the baseline; the request remains relevant with no intervening packaging changes. Depends on task 10.

## Checklist

- [x] Replace Bun packaging with a stripped static Go server; retain the Pi-extension output.
- [x] Update dev shell, manifests/locks, CI and README.
- [x] Verify Go/browser/extension checks and Nix outputs; compare baseline/new image sizes where possible.
- [x] Record evidence, complete tasks and commit scoped changes.

## Completion notes

Nix now builds `.#server` with `buildGoModule`, CGO disabled and stripped symbols, embedding all gateway assets. Removed Bun/CA/npm runtime packaging and Zod from the root manifest/lock; kept `ws` for Pi Git-package installation and preserved the separate `.#pi-extension` output. Dev shell/CI/README now use Go; CI retains Docker smoke checks and adds a 20 MB image ceiling.

Built baseline `36cf8ea` and new images with the same flake lock on linux/amd64. Actual uncompressed layer totals: **127,037,440 → 12,380,160 bytes (121.15 → 11.81 MiB)**, saving **114,657,280 bytes / 109.35 MiB / 90.25%**. Static ELF and image contents checked; actual Nix executable passed all 15 integration/browser tests. Nix flake evaluation across all declared systems and server/image/extension builds passed; Go race/vet and 29 extension tests/typecheck passed.

Full method/evidence and limitations: [implementation results](../docs/go-server-plan.md#execution-results). No local Docker daemon: actual container smoke/publish remains CI. Planning commit `5f0286b`; gateway and packaging implementation committed together to preserve image compatibility.
