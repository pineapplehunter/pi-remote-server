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

The host issuer and filtered D-Bus integration are provided by `nixos-config`, not by this Pi package. See the [operator runbook](../docs/agent-mtls-operations.md) to enroll the host.

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

Enroll the host per the [operator runbook](../docs/agent-mtls-operations.md), then run **`/remote-login`** and accept `wss://pi-agent.s.ihavenojob.work/agent/ws` or enter your agent endpoint. Only `wss://` and the `/agent/ws` path are accepted; don't include credentials, query parameters, or fragments. Configuration is saved atomically to **`~/.pi/agent/remote.json`**, mode 0600:

```json
{"version":2,"url":"wss://pi-agent.s.ihavenojob.work/agent/ws"}
```

Run setup again to replace an earlier configuration. The file stores no private key or certificate. Each Pi process uses an in-memory key and invokes the installed `pi-remote-issue-certificate` D-Bus helper before dialing. `/remote-status` reports the URL, session, and connection state; if issuance fails, check the host D-Bus service. The footer dot is green when connected, yellow while connecting, dim when offline, and red on an issuance or authentication error.

The file is shared by normal/work Pi profiles. To disconnect, remove it and reload or restart each running Pi process. File deletion alone doesn't disconnect an existing socket. Pi's own `/name` also updates the session name while connected.

Treat the server as trusted: remote input becomes normal agent input and can cause Pi to run its tools with your permissions. The extension does not add approvals or automatically redact arbitrary secrets in conversations and tool arguments.

## Usage-limit notifications

Failed assistant `message_end` events with explicit exhausted usage/quota wording or codes emit `error` with `code: "usage_limit_reached"`. Detail is clipped to 500 characters, and repeated failures in one agent run produce only one notice. The gateway broadcasts and buffers the notice in the unified conversation stream.

Bare HTTP 429 / throughput rate limits, unrelated errors and successful text are not treated as exhausted usage. No account quota polling, automatic resend or predicted reset time is provided. Detection relies on provider-reported error text; unfamiliar wording may need an update. Upgrade the gateway together with this extension: older gateways reject the additional v1 error code. The gateway now derives host identity from the authenticated connection rather than the registration payload.

## Development TLS mock

The loopback-only mock prints event summaries, accepts an explicitly configured test client CA, and can send JSON from stdin:

```sh
npm ci --ignore-scripts
npm run mock -- --port 8765 --key /path/to/test-server-key.pem \
  --cert /path/to/test-server.pem --client-ca /path/to/test-root.pem
```

Use disposable certificates. The server certificate must be trusted by the test Pi's Node process and match the URL (e.g. IP SAN `127.0.0.1`). The Pi client must also have a test issuer for a client chain trusted by the mock. Automated extension tests create temporary TLS fixtures and a test issuer; they do not use deployed credentials. The mock accepts `/sessions`, `/drop`, and JSON `message.send` input.

## Automated verification

```sh
# From the gateway repository root:
cd pi-extension
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests cover JSON/schema/session/UTF-8 limits, config file permissions, activity translation, mTLS, reconnect/backoff/reset, authentication failures, timer cleanup, lifecycle replacement, and idle/busy remote input. A real Pi SDK integration loads the extension through Pi's loader and executes a synthetic model plus the real bash tool, without provider network requests or user credentials.

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
- `agent_start`/`agent_settled` define working/idle; `agent_end` is deliberately not used to declare idle. Recovery-gap deferral keeps the chosen delivery mode per item, drains in order, and clears on config changes/session replacement.
- Streaming uses `assistantMessageEvent.type === "text_delta"` and its incremental `delta`.
- Tool events use `toolCallId`, `toolName`, `args`, and `isError`; results/updates are excluded.
- `pi.sendUserMessage` triggers a normal user turn when idle and supports `deliverAs: "steer"` or `"followUp"` while streaming. The optional server-to-agent `delivery` selection defaults to `followUp`; steering uses Pi's normal semantics and is not an abort request or immediate-response guarantee. Expansion is explicitly disabled.
- The extension API returns **void**, not an acceptance promise. Pi handles asynchronous input/provider errors; there is no application ACK. Inputs arriving during automatic retry/compaction gaps are held with their delivery selection in a bounded session-local memory queue (32 messages / 1 MiB) until Pi streams again or settles, then delivered through the selected mode. That queue is cleared on config changes/session replacement and is not an offline event buffer. Pi can still reject idle input during a manually invoked compaction. The server must not infer successful acceptance merely from a WebSocket write; no external retry queue is added.
- Some other extensions can transform/block input or finalized messages. This extension observes messages at its handler order and does not override those extensions.
- SDK hosts must emit `session_shutdown` before disposing their session if they want extension cleanup. Pi's CLI/reload/session runtime already emits it.

## Files

- `extensions/pi-remote/index.ts`: Pi lifecycle and remote input wiring.
- `config.ts`: isolated configuration access/validation.
- `ui.ts`: commands, endpoint setup, compact footer status.
- `connection.ts`: socket lifecycle, bounded live buffering, reconnects, ping/pong heartbeat.
- `protocol.ts`: strongly typed messages, limits, and parser.
- `translation.ts`: text/stream/tool event translation.
- `usage-limit.ts`: explicit provider allowance exhaustion classification and safe notification.
- `input.ts`: selected-mode user-message injection and bounded deferral across recovery gaps.
- `PROTOCOL.md`: server-side contract.
- `dev/mock-server.ts`: local development server.
- `tests/*.test.ts`: focused tests and real Pi SDK integration.
- `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`: development/package configuration.
