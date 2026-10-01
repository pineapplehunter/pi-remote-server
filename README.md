# Pi remote gateway v0.1

Small Bun/TypeScript gateway for the **supplied Pi remote extension**, with server-rendered HTML, local HTMX 2.0.8, plain CSS and one vanilla-JavaScript browser WebSocket. No frontend build, database, browser login, supervisor, shell execution, history or offline queues.

## Start

Use Bun (verified with **1.4.2**). From the project root:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
cp -n agents.example.json agents.json
chmod 600 agents.json
```

**Replace both example tokens before deployment.** Generate a separate token per host:

```sh
bun -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

An exact, valid example `agents.json` (illustrative credentials, not production secrets):

```json
[
  {
    "host_id": "laptop",
    "token": "example-only-replace-with-a-unique-random-secret-for-laptop"
  },
  {
    "host_id": "gpu01",
    "token": "example-only-replace-with-a-different-random-secret-for-gpu01"
  }
]
```

Loopback development:

```sh
export HOST=127.0.0.1
export PORT=3000
export PI_REMOTE_TOKEN_FILE="$PWD/agents.json"
bun src/index.ts
```

Open `http://127.0.0.1:3000`. Configure the existing extension using `/remote-login`: URL `ws://127.0.0.1:3000/agent/ws`, host `laptop`, and its matching token. Start sessions in Pi on the host, not in this UI. Pi's input remains literal text; when working, Pi queues it as a follow-up.

For a TLS proxy using the extension's default domain:

```sh
export HOST=127.0.0.1
export PORT=3000
export PI_REMOTE_TOKEN_FILE=/etc/pi-remote/agents.json
export PUBLIC_ORIGIN=https://pi.s.ihavenojob.work
bun src/index.ts
```

The token file must be readable only by the service account/administrator. `PI_REMOTE_TOKEN_FILE` is required; the process exits nonzero if configuration, file reading, JSON validation, or duplicate checking fails. Credentials load **once at startup**; restart to change them. `HOST` defaults to `127.0.0.1`, `PORT` to `3000`. `PUBLIC_ORIGIN` is optional for direct loopback use, but set it behind a TLS proxy. It must be a single HTTP(S) origin, without path/query/credentials.

The supplied `flake.nix` provides Bun for the gateway and Node.js/npm for the Pi extension's development tools. If Bun is not on your PATH:

```sh
nix develop
bun install --frozen-lockfile
bun test
bun run typecheck
# Then use the same export/start commands above.
```

The gateway's only runtime package dependency is Zod. TypeScript, Bun types, HTMX (vendored into `public/`) and Happy DOM are development dependencies. HTMX and its license are checked in; deployment does not fetch a CDN or run a bundler. Installing production-only packages is possible with `bun install --production --frozen-lockfile`.

## Docker / OCI image

Packaging follows [prometheus-switchbot](https://github.com/pineapplehunter/prometheus-switchbot): Nix `dockerTools.streamLayeredImage`, a default image package, and GitHub Actions publishing to GHCR. No Dockerfile or frontend build is needed. The image contains Bun, CA certificates, the gateway source/static files, and **only production dependencies** installed from `bun.lock`. Credentials, `.env`, tests and the development `node_modules` directory are not copied into it.

### Build and load locally (Linux)

```sh
nix build .#docker
./result | docker load
```

The default `nix build` does the same thing. `result` is an **executable image streamer**, not a tarball. The image is named `pi-remote-server:latest`. Nix image outputs support `x86_64-linux` and `aarch64-linux`; the Darwin development shell remains available, but image building needs a Linux builder.

Verified locally: the x86_64-linux Nix image build succeeds, its Docker archive contains the expected runtime/app/favicon and no credentials or development dependencies, and its packaged Bun/app successfully serve HTTP and route both WebSocket directions. Workflow linting and Compose configuration validation also pass. This sandbox has no Docker daemon, so an actual container run and GHCR publishing have not been executed here; the workflow performs the container smoke test before publishing.

Production dependencies are a fixed-output Nix derivation. After changing dependencies, update `bun.lock`, temporarily replace `outputHash` in `flake.nix` with `pkgs.lib.fakeHash`, build `nix build .#runtime-dependencies`, and replace it with the `got: sha256-...` hash reported by Nix. Dependency installs disable package lifecycle scripts. The dependency store name includes a hash of both manifests to avoid accidentally reusing stale dependencies after a lockfile update.

### Run with Docker

Create `agents.json` as shown above **if you don't already have one**, set real tokens and `chmod 600 agents.json`. The image intentionally has no baked-in credentials and will fail startup unless you set `PI_REMOTE_TOKEN_FILE` and mount its file.

```sh
docker run --detach --name pi-remote \
  --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env PI_REMOTE_TOKEN_FILE=/run/pi-remote/agents.json \
  --env PUBLIC_ORIGIN=https://pi.s.ihavenojob.work \
  --mount "type=bind,src=$PWD/agents.json,dst=/run/pi-remote/agents.json,readonly" \
  pi-remote-server:latest
```

For local testing, use `--env PUBLIC_ORIGIN=http://127.0.0.1:3000` and browse exactly that address. The image overrides `HOST=0.0.0.0` **inside the container** so Docker port forwarding works; the host port is still published only on `127.0.0.1`. Direct non-container startup still defaults to loopback. Port 3000 is exposed as image metadata, not automatically published. The image follows the reference's default root container user; an optional `--user UID:GID` needs read permission on the mounted token file.

Your host reverse proxy can continue to reach `http://127.0.0.1:3000`. Keep Authelia in front of browser routes and `/ws`, and bypass it only for the machine-authenticated `/agent/ws`. Docker does **not** add browser authentication. If the proxy itself runs in another container, put both services on a private Docker network, point it at `http://pi-remote:3000`, and remove host port publishing if it is not needed. Never use an unprotected `0.0.0.0:3000` host publish.

Restart the container after credential changes; replacing/rotating the host file should be followed by recreating the container to refresh the bind mount:

```sh
docker restart pi-remote # For in-place edits to the same mounted file.
# For a replaced file, recreate the container using the same docker run configuration.
```

### Docker Compose

The included `compose.yaml` uses a read-only bind mount, fails rather than creating a missing credential file, and publishes only on host loopback. Its default image URL assumes this project is hosted at `pineapplehunter/pi-remote-server`:

```sh
export PUBLIC_ORIGIN=https://pi.s.ihavenojob.work
docker compose pull
docker compose up -d
```

After rotating the token file:

```sh
docker compose up -d --force-recreate
```

For a locally built image, change the Compose `image` to `pi-remote-server:latest` and run `docker compose up -d --pull never`. For direct loopback testing, leave `PUBLIC_ORIGIN` unset; Compose defaults to `http://127.0.0.1:3000`.

### GitHub Actions / GHCR

[`.github/workflows/upload-oci.yml`](.github/workflows/upload-oci.yml) uses the same SHA-pinned checkout and Nix-install actions as the reference repository:

- Pull requests targeting `main`: install locked dependencies, run gateway and Pi extension tests/type-checks, and build the ready-to-load Pi extension package. No image publishing or GHCR login on pull requests.
- Pushes to `main` (or manual runs on `main`): after tests pass, `nix build`, stream the image into Docker, smoke-test startup/HTTP/favicon/agent authentication with disposable mounted credentials, then publish `latest`.
- The publishing job has `packages: write` and logs in using the built-in `GITHUB_TOKEN`. No additional registry secret is required.
- The target is `ghcr.io/<lowercase GitHub owner/repository>:latest`, derived from `GITHUB_REPOSITORY`. At the assumed repository name this is `ghcr.io/pineapplehunter/pi-remote-server:latest`; adjust Compose if you use a different name.
- Like the reference workflow, `ubuntu-latest` publishes the runner's **linux/amd64** image, not a multi-platform manifest. ARM64 images can be built locally on a Linux ARM64 builder; automatic multi-architecture publishing is not configured.

Once the workflow has successfully published:

```sh
docker pull ghcr.io/pineapplehunter/pi-remote-server:latest
```

Use that image instead of `pi-remote-server:latest` in the Docker run command. GHCR packages may initially be private: set package visibility to public for anonymous pulls, or authenticate Docker with a `read:packages` token for private pulls. Ensure repository Actions may write packages. No image is published merely by adding these files; push them to your GitHub `main` branch to run the workflow.

## Included Pi extension package

The current supplied extension package is copied to [`pi-extension/`](pi-extension/README.md), including its original implementation, npm lockfile, protocol, development mock and tests. Extension source is unchanged. Its commands are `/remote-login`, `/remote-status` and `/remote-rename`; credentials live at `~/.pi/agent/remote.json`, outside this repository and the Nix store. This current version includes bounded input deferral across retry/compaction gaps without changing the v1 message shapes.

It is deliberately a **separate Pi package**, not a resource in the gateway's root `package.json`. Gateway and extension dependencies/testing are isolated, and the extension is not included in the Docker image. Root `bunfig.toml` limits `bun test` to gateway tests; the copied package uses its original Node test runner.

For your NixOS/Home Manager configuration, add this repository as a flake input and replace the old package path with:

```nix
inputs.pi-remote-server.packages.${pkgs.stdenv.hostPlatform.system}.pi-extension
```

Put that output's string path in your existing Pi `packages`/managed `piPackages` list. It contains the package manifest, unchanged TypeScript source and the pinned `ws` runtime dependency from `pi-extension/package-lock.json`. Pi supplies its own APIs; they are not bundled. Use this built output rather than a raw read-only source directory with missing npm dependencies. See the extension README for a full input example.

Local build / one-off loading, from the repository root:

```sh
nix build .#pi-extension
pi --no-extensions -e "$(readlink -f result)"
```

Source development / tests:

```sh
cd pi-extension
npm ci --ignore-scripts
npm run typecheck
npm test
pi --no-extensions -e ./extensions/pi-remote/index.ts
```

Do not load both the old extension and this package at the same time. This repository does not modify your NixOS configuration or introduce a Home Manager module.

Verification: all **25 copied extension tests** pass, including real Pi SDK loading and idle/busy WebSocket input; the extension type-checks and its Nix package builds. Pi's real resource loader also successfully discovers and loads the immutable built package, with only `ws` bundled. The gateway's **20 tests** still pass. The original manifests/lockfile are preserved: `npm audit` currently reports vulnerabilities in the extension's pinned `ws@8.18.3` and a development-only `brace-expansion` dependency. See the extension README's audit warning. These dependencies are not added to the gateway image.

## Architecture and ownership

```text
Browser -- HTTP fragments + /ws --> Bun gateway <-- /agent/ws -- Pi extension
```

- `config.ts` validates environment configuration; `auth.ts` loads the credential file and keeps token digests for bearer lookup.
- `server.ts` handles HTTP, static assets, upgrades and Bun socket lifecycle. `agent-ws.ts` and `browser-ws.ts` are separate protocol handlers.
- `protocol.ts` validates every incoming text frame using Zod. Unknown fields are discarded; unknown types/versions are rejected. Frames are limited to 1 MiB, browser text to 100 KiB decoded UTF-8, and tool args to 16 KiB, matching the supplied protocol.
- `Registry.hosts` maps authenticated host IDs to **sets of sockets**: each Pi runtime opens its own connection, so one host can have several processes.
- `Registry.sessions` maps gateway-generated **`registration_id` UUIDs** to metadata and the exact owning socket. Metadata includes Pi `session_id`, authenticated `host_id`, cwd, name, pid, status, `connected_at` and `last_seen` (epoch milliseconds). `status` is null until the first Pi status arrives; it is otherwise `idle` or `working`. `last_seen` records the last application event, not ping/pong traffic.
- `Registry.browsers` is a set of browser sockets. Each browser receives the live feed for all registrations; there is no per-user filtering in this personal service. The browser only displays events for its selected registration.

**A Pi session ID does not uniquely identify a live process.** Two resumed Pi processes can have the same ID, even on the same host. The browser therefore addresses a live registration UUID, with the original `session_id` as an additional consistency check. Routing never falls back to another registration when one goes away.

Repeated identical registration on a connection is idempotent: update metadata, retain the registration UUID, reset transient browser draft/activity. A changed session ID or pid replaces that connection's old registration. Different connections always get separate UUIDs. Disconnect/unregister removes only that connection's session; reconnect creates a new UUID that must be selected again. A host remains present until its last socket disconnects. Bun ping/pong and idle timeout detect half-open connections; slow clients have bounded buffering and are closed rather than queued indefinitely.

There is **no conversation storage in the gateway**. Completed messages are retained only in the current browser view (up to 200 visible messages and 200 activity entries); changing session or reloading starts an empty feed. Registration resets unfinished drafts and activity. Restarting the gateway empties everything; the supplied extension's reconnect/register behavior rebuilds the registry.

## Authentication and deployment boundary

### Pi machines

Only `Authorization: Bearer <token>` authenticates `/agent/ws`. The file's `host_id` is authoritative, and registration must exactly match it. Tokens and host IDs must be unique. Host ID/token syntax matches the extension's configuration validator. Invalid, missing or malformed headers return HTTP 401. Query strings are rejected outright, even with a valid header. There is no browser-auth fallback, redirect or cookie-based machine authentication.

Credential errors and logs never include bearer tokens, full headers, conversation text, raw input or tool arguments. HTTP has no credential endpoint. Do not configure proxy access/debug logs to record Authorization headers either. As with the extension, this is a trusted conversation feed: arbitrary secrets in Pi text/metadata/tool arguments are not automatically detected by the gateway. The extension redacts its own configured token in the fields described by its protocol.

### Browsers / Authelia

**This server deliberately has no browser authentication.** Every browser-facing request must go through your reverse proxy's Authelia forward-auth check. Protect `/`, `/ui/*`, `/public/*`, `/favicon.svg`, `/api/*` (reserved, currently 404), and **the `/ws` upgrade itself**. Bind the gateway to loopback; do not publish port 3000 directly. All authenticated users of this proxy see all connected hosts/sessions.

`/ws` requires an exact Origin match against `PUBLIC_ORIGIN`, or the direct request origin when unset. Missing, `null`, and foreign origins receive HTTP 403. Forwarded host/proto headers are not trusted for this check. Origin checking is defense-in-depth, **not authentication**.

### Required reverse-proxy behavior

Deploy under the domain root, not a URL subpath. Configure two proxy branches:

1. **Exact `/agent/ws`**: bypass Authelia (machine tokens are checked by Bun); preserve the Authorization header; proxy to `http://127.0.0.1:3000/agent/ws`. Do not redirect this endpoint, and do not strip authentication headers.
2. **All other paths**: require a successful Authelia forward-auth decision **before forwarding**, including WebSocket upgrade requests; send unauthenticated HTTP users to your Authelia portal, but do not accept their WebSocket upgrade. Then proxy to the same Bun listener, preserving the path/query.

On both branches:

- Terminate TLS with a valid certificate: browser HTTPS/WSS and agent WSS.
- Enable HTTP/1.1 upstream proxying and forward `Upgrade` plus `Connection: upgrade` for WebSockets (ordinary HTTP uses a normal connection setting).
- Preserve `Host` and browser `Origin`; don't rewrite Origin to a trusted value.
- Disable WebSocket response buffering; use a read timeout comfortably above Bun's 90-second idle window, e.g. 3600 seconds.
- Send Authelia the original URL/method and browser cookies using the forward-auth configuration appropriate to your installed proxy/Authelia version.
- Keep Bun accessible only to the proxy and local trusted processes.

Forward-auth checks the initial upgrade, not every message on an established socket. Proxy authorization revocation is not continuously rechecked by Bun. Configure proxy connection policies if immediate revocation is required. Browser reconnects rerun forward-auth; if your proxy session expires, revisit the page to log in upstream.

## HTTP routes

All routes use GET; other methods return 405. Dynamic responses are `no-store` and carry a restrictive self-only CSP, no-sniff, and same-origin referrer policy. Live content uses text nodes / `textContent`; all server-rendered metadata is HTML-escaped. HTMX evaluation, injected script tags, inline indicator styles and history caching are disabled.

| Route | Purpose |
| --- | --- |
| `/` | Full server-rendered application shell. Optional `?session=<registration_id>` selects a live registration on page load. |
| `/ui/sessions` | Session-list HTML fragment. |
| `/ui/sessions/:registrationId` | Selected registration's chat/activity/composer HTML fragment; 404 if gone. This is a gateway UUID, **not** an opaque Pi session ID. |
| `/ui/empty` | Empty selected-session fragment / mobile back action. |
| `/public/app.js` | Vanilla browser WebSocket/DOM handling. |
| `/public/style.css` | Mobile-first, light/dark plain CSS. |
| `/favicon.svg` | Original, locally served SVG π favicon. |
| `/public/htmx.min.js` | Vendored HTMX. |
| `/ws` | Browser WebSocket upgrade; Origin validation; upstream browser auth required. |
| `/agent/ws` | Agent WebSocket upgrade; mandatory bearer header. |

Other paths, including `/api/*`, return 404. Static serving is an explicit whitelist; source files, credentials and arbitrary filesystem paths are never exposed.

## Agent WebSocket: `/agent/ws`

The unchanged source contract is copied to [`docs/pi-protocol-v1.md`](docs/pi-protocol-v1.md). Implementation was checked against the supplied extension's `protocol.ts`, `index.ts`, `connection.ts`, `translation.ts`, config and UI helpers. **No extension files were modified.**

Incoming v1 types:

- `session.register`, `session.updated`, `session.unregister`, `session.status`
- `message.delta`, `message.completed` (`user` / `assistant`)
- `activity.started`, `activity.completed`
- `error` (the extension's defined error codes)

Non-registration events must belong to the sending socket's registered Pi session. Invalid JSON/schema/version/type, binary frames, mismatched host or ownership cause a payload-free log, immediate registry cleanup and policy close (1008). Oversized frames can be closed at the WebSocket layer. The extension accepts **only** `message.send`, so the gateway never sends a Pi-incompatible error envelope.

The **only outgoing application shape** is:

```json
{"version":1,"type":"message.send","session_id":"s1","text":"Run the tests"}
```

Text whitespace is preserved. No request ID or gateway registration ID is added to the Pi wire protocol.

## Browser WebSocket: `/ws`

One socket per page. JSON text frames with numeric `version: 1`. There is no browser login protocol and no subscribe/unsubscribe protocol.

### Browser → gateway

```json
{
  "version": 1,
  "type": "message.send",
  "registration_id": "<live gateway UUID>",
  "session_id": "s1",
  "text": "Run the tests",
  "request_id": "<optional client correlation ID>"
}
```

`registration_id` and `session_id` must be non-empty and match the same live registration. `text` must be non-blank and at most 102,400 UTF-8 bytes. `request_id`, when provided, is a non-empty string of at most 128 characters. The gateway forwards to that exact socket using the above Pi `message.send` shape. It never picks an arbitrary process with the same Pi ID. No automatic resend or offline buffering occurs.

### Gateway → browser

| Event | Shape / meaning |
| --- | --- |
| `sessions.snapshot` | `{version:1,type,sessions:[Session,...]}` on every browser connection. Metadata only, no event replay. |
| `session.added` | `{version:1,type,session:Session,reset:true}` for a new live registration. |
| `session.updated` | `{version:1,type,session:Session}` for name/metadata changes; `reset:true` on repeated registration. |
| `session.removed` | `{version:1,type,registration_id,session_id}` on unregister or agent disconnect. |
| `session.status` | Exact Pi status envelope plus `registration_id`. |
| `message.delta`, `message.completed` | Exact validated Pi envelope plus `registration_id`. |
| `activity.started`, `activity.completed` | Exact validated Pi activity envelope plus `registration_id`. |
| `error` | Exact validated Pi error envelope plus `registration_id`; shown as an error, not a chat message. |
| `gateway.error` | `{version:1,type,code,message,request_id?,registration_id?}` for browser validation/routing errors. Correlation fields are included when the send envelope was valid. |

`Session` is the metadata shape described under Architecture; it never includes a socket or token. Gateway errors include `invalid_json`, `invalid_message`, `unsupported_version`, `unsupported_type`, `text_too_large`, `unknown_session`, `wrong_session`, `session_unavailable`, and a generic `routing_failed` fallback. Error text is descriptive, not a stable API; use codes.

Registry events trigger an HTMX refresh of `/ui/sessions`, not a duplicate client-side registry. Selecting a session swaps `/ui/sessions/:registrationId` into the chat pane. Active names/status update without replacing chat. Deltas append to one draft; an assistant final replaces its content and clears the draft reference for the next message. Empty assistant completions are valid. On browser-only disconnect, the draft is marked interrupted and retained so a final received on reconnect can replace it; missing events are not replayed. Agent registration/removal clears transient draft/activity. Activity is correlated by `tool_call_id` to handle parallel calls; only a short tool/path/command summary is shown, never raw results or the complete argument object.

Browser errors are shown instead of silently dropping input. A matched gateway routing error can restore the most recent submitted text when the composer is still empty. The browser displays user messages only on Pi's normal `message.completed` echo, avoiding an extra optimistic copy. A successful socket write is **not** a Pi acceptance acknowledgment.

## Deliberate v1 limitations and interpretation

- **Identity collision is explicitly in the supplied contract**, not an extension bug. Gateway-only registration UUIDs solve live routing; multiple sockets per host are supported. URLs/browser payloads use that ID; Pi envelopes remain unchanged.
- The contract does not define server → agent error frames. This implementation closes invalid agent sockets rather than inventing such frames. The extension may reconnect repeatedly if misconfigured; fix the host/token/version mismatch at the source.
- There are **no message IDs, acceptance ACKs, replay or delivery guarantees**. Identical consecutive finals can be legitimate messages; the gateway does not guess at deduplication. A received final is authoritative for the active draft, but indistinguishable duplicate finals cannot be eliminated reliably. Lost final events across a browser disconnection can leave a draft boundary ambiguous; later finals restore authoritative text, not missing history. Don't automatically retry uncertain input.
- Tool-call-only assistant completions can contain empty content; activity is kept separate. Tool outputs/updates are absent by design.
- Registration says nothing about creation capability. The UI explicitly directs you to start Pi on the host; no creation/termination controls are invented. Only existing extension registration/unregistration lifecycle is supported.
- No multi-user authorization, browser push, Discord integration, Markdown, uploads, persistence, supervisor or cloud deployment automation is implemented.

## Verification and files

```sh
bun test
bun run typecheck
```

Verified: **20 tests pass**, strict TypeScript checking passes, and `bun src/index.ts` starts/serves the shell with a startup-loaded token file (and refuses startup without one). A separate smoke check used the supplied extension's actual `RemoteConnection` and `parseServerMessage` implementations to exchange browser input and assistant events through the gateway successfully; it did not launch a full Pi agent.

Tests cover credential loading/duplicates, required config and origins, every extension event shape, invalid/binary/oversized frames, ownership, status/unregister/reconnect, same-ID processes, exact bidirectional routing, disconnected sockets, safe HTTP/static routes, server escaping and actual browser-script DOM behavior with malicious text and parallel tools. Routing tests open **real local WebSockets** on ephemeral Bun listeners. DOM tests use Happy DOM (not a full phone browser); mobile layout and reverse-proxy/Authelia deployment still need testing in your environment.

Created application files (existing Nix/environment files retained):

```text
.
├── .github/
│   └── workflows/
│       └── upload-oci.yml
├── README.md
├── agents.example.json
├── compose.yaml
├── flake.nix
├── flake.lock
├── bun.lock
├── bunfig.toml
├── pi-extension/
│   ├── README.md
│   ├── PROTOCOL.md
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── extensions/pi-remote/  # Unchanged supplied extension source
│   ├── dev/mock-server.ts
│   └── tests/
├── docs/
│   └── pi-protocol-v1.md
├── package.json
├── public/
│   ├── app.js
│   ├── favicon.svg
│   ├── htmx.LICENSE
│   ├── htmx.min.js
│   └── style.css
├── src/
│   ├── agent-ws.ts
│   ├── auth.ts
│   ├── browser-ws.ts
│   ├── config.ts
│   ├── index.ts
│   ├── protocol.ts
│   ├── registry.ts
│   ├── server.ts
│   └── views.ts
├── test/
│   ├── auth.test.ts
│   ├── helpers.ts
│   ├── protocol.test.ts
│   ├── routing.test.ts
│   └── ui.test.ts
└── tsconfig.json
```

`.gitignore` excludes `node_modules`, local credentials and `.env`; `flake.nix` provides Bun/Node.js for development, Linux OCI image/dependency packages, and a ready-to-load `pi-extension` package. `agents.example.json` is never served. The existing local `agents.json` is not modified or included in the image.
