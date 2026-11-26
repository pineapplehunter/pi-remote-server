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

The gateway repository's `packages.<system>.pi-extension` output is a ready-to-load Pi package with the pinned `ws` runtime dependency included. It does **not** bundle Pi itself, install npm packages at Pi startup, or include credentials. The implementation is based on the supplied Pi package, with explicit usage-limit announcements and an updated `ws` runtime. The Nix output bundles only `ws`; Pi APIs are provided by Pi.

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

Install `ssh-keygen` and the filtered `pi-remote-request-ticket` helper in the agent environment. The host-side ticket service is installed separately and keeps the enrolled host signing key outside Pi.

### Local source installation / development

Requires Node >= 22.19. The SDK integration test runs against Pi 1.6.0.

The Nix extension includes `ws@8.23.0`, but not the Pi SDK test dependencies.

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

## Host-managed endpoint

Configure the enrollment name in the host ticket service. The HTTPS origin is optional, and the enrolled Ed25519 signing key must be available in the host’s SSH agent. On startup and reconnect, the extension calls `pi-remote-request-ticket --ws-url` to discover the corresponding WSS endpoint. No per-agent configuration is read or written. Upgrade the broker and both sandbox allowlists together; restart the broker and launch fresh Pi processes. On every connection attempt it creates a fresh Ed25519 key in a private temporary directory and supplies only the public key to the helper. It presents the returned single-use ticket and signs the socket challenge, then discards the key. Session data is blocked until `auth.ok`. `/remote-status` reports the URL, session, and connection state. The footer dot is green when authenticated, yellow while connecting, dim when offline, and red on a ticket or authentication error.

To stop connecting, disable or remove the extension and restart Pi. Pi's own `/name` also updates the session name while connected.

Treat the server as trusted: remote input becomes normal agent input and can cause Pi to run its tools with your permissions. The extension does not add approvals or automatically redact arbitrary secrets in conversations and tool arguments.

## Usage-limit notifications

Failed assistant `message_end` events with explicit exhausted usage/quota wording or codes emit `error` with `code: "usage_limit_reached"`. Detail is clipped to 500 characters, and repeated failures in one agent run produce only one notice. The gateway broadcasts and buffers the notice in the unified conversation stream.

Bare HTTP 429 / throughput rate limits, unrelated errors and successful text are not treated as exhausted usage. No account quota polling, automatic resend or predicted reset time is provided. Detection relies on provider-reported error text; unfamiliar wording may need an update. Upgrade the gateway together with this extension: older gateways reject the additional v1 error code. The gateway now derives host identity from the authenticated connection rather than the registration payload.

## Development TLS mock

The loopback-only mock exercises one synthetic ticket and verifies a real SSHSIG with the public key bound to it. It does not contact the host service. See `tests/mock.test.ts` for a complete setup. For an existing disposable fixture:

```sh
npm run mock -- --port 8765 --key test-server-key.pem --cert test-server.pem \
  --ticket ticket.txt --pub agent.pub
```

Use private fixture files and a server certificate trusted by the test Node process with an IP SAN for `127.0.0.1`. Restart the mock with a new fixture for a new connection. The mock accepts `/sessions`, `/drop`, and JSON `message.send` input.

## Automated verification

```sh
# From the gateway repository root:
cd pi-extension
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests cover JSON/schema/session/UTF-8 limits, config file permissions, activity translation, ticket and SSHSIG authentication, reconnect/backoff/reset, authentication failures, timer cleanup, lifecycle replacement, and idle/busy remote input. A real Pi SDK integration loads the extension through Pi's loader and executes a synthetic model plus the real bash tool, without provider network requests or user credentials.

Repository evaluation:

```sh
# New Nix-referenced files must be tracked in the Git index first.
nix flake check --no-build --all-systems
```

## Pi API details and limitations

Tested against Pi **1.6.0**. Runtime imports are the current `@earendil-works/*` names, not old aliases.

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
- `ui.ts`: status command, compact footer status.
- `connection.ts`: socket lifecycle, bounded live buffering, reconnects, ping/pong heartbeat.
- `protocol.ts`: strongly typed messages, limits, and parser.
- `translation.ts`: text/stream/tool event translation.
- `usage-limit.ts`: explicit provider allowance exhaustion classification and safe notification.
- `input.ts`: selected-mode user-message injection and bounded deferral across recovery gaps.
- `PROTOCOL.md`: server-side contract.
- `dev/mock-server.ts`: local development server.
- `tests/*.test.ts`: focused tests and real Pi SDK integration.
- `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`: development/package configuration.
