---
title: Verify the current Pi Pueue queue
created: 2026-10-01 22:11:15
status: completed
finished: 2026-10-01 22:12:19
priority: P1
tag: verification
---

## Description

User feedback: “continue. also test pueue if it is working correctly.”

Smoke-test Pi's current private queue after the earlier workers were canceled. Check real command execution, terminal status, captured output and completion delivery; do not rely on old task IDs or alter the host queue.

## Checklist

- [x] Verify successful execution and a written output artifact.
- [x] Verify stdout/stderr capture and a deliberate nonzero exit status.
- [x] Receive and process both automatic completion notifications.

## Completion notes

The restarted private queue was initially empty. Its task 0 printed `pueue smoke stdout` and `pueue smoke stderr`, wrote `success` to /tmp/pi-pueue-smoke-success.txt, and completed successfully. Task 1 deliberately exited 7; Pueue reported Failed (7) and retained `pueue expected failure`. Both automatic notifications arrived and their logs/artifact were inspected. No project runtime changes were needed.

Fresh independent validation workers also delivered usable reports. A subagent process can complete successfully while its test command fails: the first gateway report explicitly recorded typecheck exit 2 despite the outer job's Success. Inspect the report, not just queue status. The corrected gateway and extension suites subsequently passed, as did the direct combined test job and browser/Nix jobs.

This is a smoke check, not exhaustive scheduler, daemon-restart/persistence or cancellation testing. Default queue concurrency remains 1.
