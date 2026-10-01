# Pi Remote v0.1

An outbound WebSocket bridge between the **current Pi session** and a trusted remote server. Includes a one-character colored `●` footer indicator, UI configuration, reconnects, text messages/streaming, and tool activity. No production gateway, frontend, supervisor, history synchronization, or offline queue.

The wire contract for server developers is [PROTOCOL.md](PROTOCOL.md); exact types and limits are in [protocol.ts](extensions/pi-remote/protocol.ts).

## Install

### Git package in settings.json

Add `"https://github.com/pineapplehunter/pi-remote-server@main"` to `packages` in `~/.pi/agent/settings.json`, preserving other settings:

```json
{"packages":["https://github.com/pineapplehunter/pi-remote-server@main"]}
```

Or run `pi install "https://github.com/pineapplehunter/pi-remote-server@main"`, then restart or `/reload`. The root manifest points to this extension and supplies its `ws` dependency. Use `pi update` to refresh the branch, or pin a commit/tag. Do not load another copy simultaneously. Remote installation requires these changes to be pushed to GitHub.

### This repository / Home Manager

The gateway repository's `packages.<system>.pi-extension` output is a ready-to-load Pi package with the pinned `ws` runtime dependency included. It does **not** bundle Pi itself, install npm packages at Pi startup, or include credentials. The implementation is based on the supplied Pi package, with explicit usage-limit announcements added and `ws` upgraded to 8.22.0. The Nix output bundles only `ws`; Pi APIs are provided by Pi.

From the gateway repository root:

```sh
nix build .#pi-extension
pi install "$(readlink -f result)"
```

For your NixOS/Home Manager configuration, add this repository as a flake input:

```nix
inputs.pi-remote-server = {
  url = "github:pineapplehunter/pi-remote-server";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Then obtain the package in a scope with `inputs` and `pkgs`:

```nix
remotePackage = inputs.pi-remote-server.packages.${pkgs.stdenv.hostPlatform.system}.pi-extension;
```

Add `"${remotePackage}"` to your existing managed Pi package list for `pi`/`pi-work`, replacing the old remote package entry. Apply your normal NixOS/Home Manager configuration, then restart Pi or run `/reload`. Use the **built package output**, not the raw `pi-extension/` source directory in the read-only Nix store: the output includes `node_modules/ws`.

No NixOS module or Home Manager option is introduced by this repository. Preserve your existing settings and package-list management. Do not put `remote.json` or bearer tokens in a Nix expression.

### Local source installation / development

Requires Node >= 22.19 and Pi 0.87.1 or a compatible later API.

**Dependency audit:** `ws` is pinned to patched 8.22.0 in both package manifests. `npm audit` still reports a high-severity development-only `brace-expansion` advisory in Pi's test dependency tree. Those development dependencies are not bundled in the Nix extension output.

```sh
# From the gateway repository root:
cd pi-extension
npm ci --ignore-scripts
pi install "$PWD"
pi
```

During development, load it for one invocation instead of installing:

```sh
# From pi-extension/:
pi -e ./extensions/pi-remote/index.ts
```

Do not load the source copy and the Nix-store copy simultaneously: they have different package identities. For an isolated development invocation that disables automatic extensions/packages while explicitly loading this one:

```sh
# From pi-extension/:
pi --no-extensions -e ./extensions/pi-remote/index.ts
```

## Configure in Pi

Run **`/remote-login`**:

1. Enter a WebSocket URL, or press Enter for `wss://pi.s.ihavenojob.work/agent/ws`.
2. Enter a stable machine ID (e.g. `laptop`), or accept the suggested hostname.
3. Paste the bearer token into the masked input. Existing credentials can keep their saved token.

The address and token are not configured through environment variables. Credentials are saved atomically to **`~/.pi/agent/remote.json`**, mode **0600**, outside the repository and Nix store:

```json
{
  "version": 1,
  "url": "wss://pi.s.ihavenojob.work/agent/ws",
  "host_id": "laptop",
  "token": "<secret>"
}
```

If upgrading from the earlier credential location, move `~/.pi/remote.json` to `~/.pi/agent/remote.json` without overwriting an existing file, or run `/remote-login` again. The old location is no longer read.

The file is plaintext JSON, not encrypted. It is intentionally shared by normal/work Pi profiles. No watcher or cross-process credential synchronization is implemented: `/remote-login` changes this Pi immediately; other running instances pick them up on reload/restart/session replacement. To disconnect, manually remove `~/.pi/agent/remote.json` and run `/reload` (or restart) in each running Pi instance. File deletion alone does not disconnect an existing socket.

- `/name <name>`: use Pi's built-in command to rename the current session. Works offline; forwards `session.updated` when connected.
- `/remote-status`: connection state, server, host ID, session ID, and credential file location—never the token.
- Footer: one `●`, green when connected, yellow while connecting, dim while offline, red on authentication failure. Hidden when unconfigured. Use `/remote-status` for details.
- Missing/invalid configuration: no startup prompt and no network connection. Invalid files produce one safe warning.
- Login failures show the specific credential-free URL/host/token validation error, or a file-write error with a safe filesystem code (e.g. `EACCES`). Server authentication failures appear in the connection indicator after saving, not as configuration validation errors.
- Login uses a custom masked TUI component, so run it in interactive Pi. Configured connections work in interactive, RPC, JSON, and print modes without stdout logging.
- TLS required except `ws://localhost`, `ws://127.0.0.1`, or `ws://[::1]` for development. URL credentials, queries, and fragments are rejected.

Treat the server as trusted: remote input becomes normal agent input and can cause Pi to run its tools with your permissions. The extension does not add approvals. Conversations/tool arguments may contain other secrets; only the configured bearer token is specifically redacted in forwarded text/arguments.

## Usage-limit notifications

Failed assistant `message_end` events with explicit exhausted usage/quota wording or codes emit `error` with `code: "usage_limit_reached"`. The configured token is redacted, detail is clipped to 500 characters, and repeated failures in one agent run produce only one notice. The gateway broadcasts and buffers the notice in the unified conversation stream.

Bare HTTP 429 / throughput rate limits, unrelated errors and successful text are not treated as exhausted usage. No account quota polling, automatic resend or predicted reset time is provided. Detection relies on provider-reported error text; unfamiliar wording may need an update. Upgrade the gateway together with this extension: older gateways reject the additional v1 error code. Other wire shapes remain unchanged.

## Local test with mock server

The mock is **development-only**, binds IPv4 loopback, authenticates a test token, prints event summaries (not conversation/tool payloads), and lets you send JSON from stdin.

Terminal 1:

```sh
# From the gateway repository root:
cd pi-extension
npm ci --ignore-scripts
npm run mock -- --port 8765 --token test
```

Terminal 2:

```sh
# From pi-extension/:
pi --no-extensions -e ./extensions/pi-remote/index.ts
```

Run `/remote-login` and set:

```text
URL:     ws://127.0.0.1:8765/agent/ws
Host ID: laptop
Token:   test
```

If keeping an existing saved token is offered, select **No** and enter `test`. This overwrites your shared development credentials; use `/remote-login` again afterward to restore the real server settings.

The mock should print `session.register` and `session.status ... idle`; Pi should show a **green `●`**.

Send Pi an ordinary prompt asking it to run a simple bash command and explain the output. The mock should show `session.status ... working`, `message.completed ... user`, `message.delta`, `message.completed ... assistant`, and `activity.started`/`activity.completed`, followed by `session.status ... idle` after settlement. Normal model authentication is required for this manual run.

In the mock terminal, enter `/sessions`, copy the ID, then paste:

```json
{"version":1,"type":"message.send","session_id":"PASTE_SESSION_ID","text":"Say hello from the remote client"}
```

Repeat while Pi is working to verify follow-up delivery without interrupting the current run.

Additional checks:

- `/drop` in the mock: Pi reconnects and re-registers after about one second.
- Stop/restart the mock: Pi keeps working locally and reconnects with capped backoff.
- Send a wrong ID: mock reports `error ... wrong_session`, no input is injected.
- Send an unsupported type or version: protocol error, Pi continues.
- `/new`, `/resume`, `/fork`, `/reload` in Pi: old registration unregisters best effort and the active session registers again.
- `/name New session name` in Pi: rename the session and observe `session.updated`.

`/sessions` and `/drop` are mock commands only, not production protocol messages. Node's experimental type-transformation warning is expected for development scripts; Pi loads extension TypeScript through its own jiti loader.

## Automated verification

```sh
# From the gateway repository root:
cd pi-extension
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests cover JSON/schema/session/UTF-8 limits, credential permissions, redaction, masked input, activity translation, reconnect/backoff/reset, detectable auth failures, timer cleanup, lifecycle replacement, and idle/busy remote input. A real Pi SDK integration loads the extension through Pi's loader and executes a synthetic model plus the real bash tool, without provider network requests or user credentials.

Repository evaluation:

```sh
# New Nix-referenced files must be tracked in the Git index first.
nix flake check --no-build --all-systems
```

## Pi API details and limitations

Inspected against installed Pi **0.87.1**, using its docs, declarations, runtime, and official examples. Runtime imports are the current `@earendil-works/*` names, not old aliases.

- The factory only registers handlers/commands. Configuration reads and socket startup happen asynchronously from `session_start`.
- IDs/cwd/name come from `ctx.sessionManager`; names update through `session_info_changed`.
- `session_shutdown.reason` supplies `quit|reload|new|resume|fork`; cleanup is synchronous/idempotent. Unregister can be lost during shutdown.
- `agent_start`/`agent_settled` define working/idle; `agent_end` is deliberately not used to declare idle.
- Streaming uses `assistantMessageEvent.type === "text_delta"` and its incremental `delta`.
- Tool events use `toolCallId`, `toolName`, `args`, and `isError`; results/updates are excluded.
- `pi.sendUserMessage` triggers a normal user turn when idle and supports `deliverAs: "followUp"` while streaming. We always specify follow-up delivery as a safety fallback for local input racing remote input; it does not delay idle input. Expansion is explicitly disabled.
- The extension API returns **void**, not an acceptance promise. Pi handles asynchronous input/provider errors; there is no application ACK. Inputs arriving during automatic retry/compaction gaps are held in a bounded session-local memory queue (32 messages / 1 MiB) until Pi streams again or settles, then delivered through its follow-up API. That queue is cleared on config changes/session replacement and is not an offline event buffer. Pi can still reject idle input during a manually invoked compaction. The server must not infer successful acceptance merely from a WebSocket write; no external retry queue is added.
- Some other extensions can transform/block input or finalized messages. This extension observes messages at its handler order and does not override those extensions.
- `ctx.ui.input` has no password option; token input uses `ctx.ui.custom` with an `Input` editor that never renders plaintext.
- SDK hosts must emit `session_shutdown` before disposing their session if they want extension cleanup. Pi's CLI/reload/session runtime already emits it.

## Files

- `extensions/pi-remote/index.ts`: Pi lifecycle and remote input wiring.
- `config.ts`: isolated configuration access/validation.
- `ui.ts`: commands, masked token entry, compact footer status.
- `connection.ts`: socket lifecycle, bounded live buffering, reconnects, ping/pong heartbeat.
- `protocol.ts`: strongly typed messages, limits, and parser.
- `translation.ts`: text/stream/tool event translation.
- `usage-limit.ts`: explicit provider allowance exhaustion classification and safe notification.
- `input.ts`: follow-up injection and bounded deferral across recovery gaps.
- `PROTOCOL.md`: server-side contract.
- `dev/mock-server.ts`: local development server.
- `tests/*.test.ts`: focused tests and real Pi SDK integration.
- `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`: development/package configuration.
