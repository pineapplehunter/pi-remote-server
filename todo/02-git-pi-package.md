---
title: Install the Pi package from the repository URL
created: 2026-10-01 17:18:34
status: completed
finished: 2026-10-01 17:57:36
priority: P1
base: 7ac4434
tag: packaging
---

## Description

Previous request (summarized from compacted context): enable using the exact package reference `"https://github.com/pineapplehunter/pi-remote-server@main"` in `settings.json`.

Make the repository root discoverable as a Pi package and supply its runtime dependencies for Git installs. Preserve the standalone/Nix extension output and isolate gateway deployment where practical.

## Checklist

- [x] Add root Pi resource manifest and necessary runtime dependencies.
- [x] Validate Pi root discovery and URL/ref syntax.
- [x] Update locks, packaging checks and installation documentation.

## Completion notes

Root `pi.extensions` points to the bundled extension; root runtime includes patched ws 8.22.0 and optional host-provided Pi peers. Standalone ws/lock and Nix dependency hash updated too. The real Pi SDK discovers one extension from root-package settings. An isolated production-only npm install (without nested node_modules or Pi dependencies) successfully loads it; Pi's parser confirms the exact HTTPS URL and main ref. OCI/extension builds and all-system flake evaluation pass. README documents settings.json, pi install/update and Nix alternatives. Remote Git installation becomes available after this commit is pushed to GitHub; no push was performed.
