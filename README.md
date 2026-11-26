# Pi remote gateway

Small Go gateway and TypeScript Pi extension. Server-rendered HTML, build-time Tailwind CSS and one vanilla-JavaScript browser WebSocket. HTMX, Marked and DOMPurify load from pinned jsDelivr URLs with SHA-384 integrity checks. SQLite stores host enrollment and short-lived authentication records. No client-side CSS compiler, built-in session login, supervisor, remote process launching or offline input queues.

## Start

Enter `nix develop` for the pinned build tools, or supply Go **1.25+**, a C compiler (SQLite uses CGO), Make and the standalone Tailwind CSS v4 CLI. The gateway does not require Bun or Node at runtime.

For the live deployment, follow the [SSH ticket setup](docs/agent-ticket-operations.md). To start the browser gateway locally (no certificates needed for the browser listener):

```sh
make build
export PI_REMOTE_TICKET_SOCKET="$PWD/.cache/ticket.sock"
export PI_REMOTE_DB="$PWD/.cache/hosts.sqlite"
.cache/pi-remote-server
```

`make build` generates minified `public/style.css` from `styles/input.css` and the classes in `templates/` and `public/app.js` before Go embeds it. Edit those sources, not the generated file. Run `make css` before using raw `go run`, `go build`, or `go test` commands.

Open `http://127.0.0.1:3000`. It is browser-only; connecting an agent requires an enrolled host and a TLS proxy (or the extension development mock). Start Pi sessions on the host, not in the UI. Browser input remains literal text; busy Pi uses Follow-up by default, with Steer available.

`HOST` defaults to loopback, `PORT` to 3000. Set `PUBLIC_ORIGIN` to the browser URL's origin behind a TLS proxy; it must be one HTTP(S) origin without a path, query or credentials. `PI_REMOTE_TICKET_SOCKET` must be a private Unix socket path; only the trusted proxy should have access.

The gateway uses SQLite, Gorilla WebSocket and OpenSSH signature verification (dependencies pinned in `go.mod`/`go.sum`). HTML templates, application JS/CSS and the favicon are embedded in the binary. Root npm runtime dependency `ws@8.23.0` is only for Pi Git-package installation; the Go server needs no npm install or JS runtime. Pi itself is supplied by the host. Browser library packages are **development-only**, for reproducible offline tests; browser deployment fetches their pinned CDN files. Application JS/CSS and the favicon stay local. If CDN/SRI loading fails, the UI keeps sending disabled and displays a library-loading error; allow `cdn.jsdelivr.net` and reload. There is no local vendor fallback.

## Install the Pi package

Add this entry to `~/.pi/agent/settings.json`, preserving your existing settings/packages:

```json
{
  "packages": [
    "https://github.com/pineapplehunter/pi-remote-server@main"
  ]
}
```

Or run:

```sh
pi install "https://github.com/pineapplehunter/pi-remote-server@main"
```

Restart Pi or `/reload`. The repository root's `pi.extensions` manifest points to `pi-extension/extensions/pi-remote/index.ts`; Pi installs the root runtime dependencies for Git sources. `main` is a moving branch; use a commit/tag instead for reproducibility, and `pi update` to refresh an installed Git source. The change must be pushed to GitHub before remote installs can fetch it.

Tested with Pi **1.6.0**; requires Node >=22.19. Command: `/remote-status`. Use Pi's built-in `/name <name>` to rename sessions. Agents automatically discover the WebSocket URL from the host ticket broker on every connection attempt. The host must provide the `pi-remote-request-ticket` D-Bus helper and `ssh-keygen`. See [`pi-extension/README.md`](pi-extension/README.md) for configuration and API details. Do not load multiple copies of this extension.

### Nix / Home Manager

The separate ready-to-load package remains available:

```nix
inputs.pi-remote-server = {
  url = "github:pineapplehunter/pi-remote-server";
  inputs.nixpkgs.follows = "nixpkgs";
};

# Add this output's string path to your existing Pi package list:
remotePackage = inputs.pi-remote-server.packages.${pkgs.stdenv.hostPlatform.system}.pi-extension;
```

It includes extension TypeScript and pinned `ws`, but not Pi or credentials. Use the **built output**, not a raw read-only source directory without npm dependencies. No Home Manager module is introduced.

```sh
nix build .#pi-extension
pi --no-extensions -e "$(readlink -f result)"
```

Extension development/testing stays isolated:

```sh
cd pi-extension
npm ci --ignore-scripts
npm run typecheck
npm test
pi --no-extensions -e ./extensions/pi-remote/index.ts
```

Both npm packages pin **`ws@8.23.0`**. The Pi SDK and browser test dependencies are not bundled in the Nix extension or the gateway image.

## Conversation, Markdown and history

Chat, assistant drafts, tool activity and Pi notices share **one chronological stream**. Tool rows show short tool/path/command summaries; parallel calls update their own rows by `tool_call_id`. Tool results, thinking and full argument objects are not displayed. Finalized user/assistant text supports Markdown: paragraphs, headings, emphasis, lists, links, tables and fenced code. Drafts stream incrementally as plain text and become Markdown on completion. Marked output is sanitized by DOMPurify before inserting DOM fragments; images, SVG, forms, style/ID/name/class/data attributes and unsafe links are excluded. Server-rendered history/metadata and live notices/activity are escaped or use text nodes.

Use **Tool calls** in the chat header to show/hide activity rows. The browser remembers this display preference across sessions/reloads using localStorage (only the boolean preference, never conversation data). Hiding tools does not stop receiving/updating/buffering them or hide chat/usage-limit notices. If storage is blocked, the toggle still works for the current page.

The composer uses a rounded, auto-growing multiline field and a separate Send action. **Ctrl+Enter sends; Enter inserts a newline.** Repeated keys and active IME composition do not send. Send stays disabled for blank/offline input, but the draft remains editable; busy Pi accepts the selected delivery mode. Successful sends shrink/clear the field; a matched routing error restores its text, delivery mode and height. Height is capped so long drafts scroll inside the input. The design adapts [LibreChat and assistant-ui composer patterns](docs/composer-design.md), without adding React, attachments or unsupported stop controls.

Choose **Send as → Follow-up** (default) to wait for the current run to finish, or **Steer** to redirect the active run at Pi's next steering opportunity. Both Send and Ctrl+Enter use this choice. Either mode starts a normal turn when Pi is idle; steering is not an immediate abort. The choice resets to Follow-up when opening another view/reloading and is not stored. Retry/compaction-gap deferral retains each message's selected mode. **Upgrade gateway and Pi extension together:** older extensions ignore the optional `delivery` field and still use follow-up delivery.

The gateway retains a **bounded, in-memory materialized view per live registration**:

- At most **400 completed chat/activity/notice entries**, with at most **512 KiB serialized entry data**. Oldest entries are evicted first.
- Each message/notice and the active assistant draft is clipped at **64 Ki UTF-16 code units**, with an explicit truncation marker. The draft has a separate bounded budget; the `history` snapshot data remains below 1 MiB (routing metadata excluded).
- No raw tool arguments or delta-event queue are retained. Completed text is authoritative and replaces the active draft in its original stream position.
- Opening/reloading, switching sessions or reconnecting the **browser** restores the recent view and current draft. Gateway-only sequence watermarks prevent snapshot/live overlap. Scrolling up stops automatic scrolling to the bottom.
- Only events received by this gateway are available: **not Pi's full historical conversation**. Buffering continues while browsers are closed, provided Pi remains connected.
- Agent disconnect/unregister/session replacement removes that registration and its buffer. Gateway restart loses everything. Agent reconnect creates a new UUID that must be selected again. Browser pixels already displayed can remain visible offline, but are not durable history.
- Repeating the same registration on its socket preserves completed messages/notices, resets draft/activity, and advances the sequence.

### Usage-limit announcements

The extension observes failed assistant `message_end` events. Explicit exhausted usage/quota wording (e.g. ChatGPT usage limit) or provider codes such as `usage_limit_reached`/`insufficient_quota` emit:

```json
{"version":1,"type":"error","session_id":"s1","code":"usage_limit_reached","message":"Pi's usage allowance/quota has been reached. ..."}
```

The detail is bounded to 500 characters. At most one notice is emitted per agent run, including retries. The gateway forwards it over `/ws` and retains/displays it in the unified stream, even if the browser was closed at the time.

A bare HTTP 429, throughput `rate_limit_exceeded`, other provider failures and successful text discussing limits **are not classified as exhausted usage**. This detects provider-reported failure text, not account telemetry or a predicted reset time; unfamiliar provider wording may need a classifier update. Upgrade **both gateway and extension** for the additional v1 error code; older gateways reject unknown codes. All other Pi wire shapes stay unchanged; history/sequence fields are browser-only.

## Docker / OCI

Packaging follows [prometheus-switchbot](https://github.com/pineapplehunter/prometheus-switchbot): Nix `dockerTools.streamLayeredImage`, an executable image streamer, and GitHub Actions publishing GHCR `latest`. No Dockerfile. The Nix build compiles Tailwind before building the gateway. The image contains a stripped Go executable with embedded templates/static assets and Nix's small standard timezone/MIME/network data dependencies. No Bun/Node, npm dependencies, extension code, source tree, credentials, tests or `.env`. No CA bundle is needed: the gateway makes no outbound TLS requests; browser CDN requests happen in the browser.

```sh
nix build .#docker
./result | docker load
```

The default `nix build` does the same. Image: `pi-remote-server:latest`. Linux x86_64/aarch64 outputs are available; Darwin has a development shell and standalone server package, not a native image output.

Historical measurement before SSH/SQLite authentication: **121.15 MiB (Bun) → 11.81 MiB (Go)** uncompressed. The current image also includes SQLite and its runtime dependencies. See [build evidence and measurement method](docs/go-server-plan.md#measured-image-size).

For local browser-only development with `compose.yaml`:

```sh
docker compose up -d
```

Compose binds the browser port to host loopback only. The agent listener is a Unix socket in the `pi-remote-agent` volume, not a published port. The browser URL is `http://127.0.0.1:3000` unless `PUBLIC_ORIGIN` is set. For the Caddy+Authelia deployment, use the [operator runbook](docs/agent-ticket-operations.md).

[CI](.github/workflows/upload-oci.yml) tests/type-checks Go/browser/extension code and builds the server and Pi extension for pull requests. Main pushes/manual main runs additionally build/load/smoke-test the image and publish `ghcr.io/<lowercase owner/repository>:latest` using `GITHUB_TOKEN` (`packages: write`). The runner publishes linux/amd64, not a multi-platform manifest. GHCR visibility may need to be made public, or private pulls need a `read:packages` login. Nothing is published until the commits are pushed and CI succeeds.

Build the standalone executable with `nix build .#server --no-link`. Go dependencies are pinned by `go.mod`/`go.sum` and `vendorHash` in `go-server.nix`; after dependency changes, run `go mod tidy`, temporarily set `vendorHash = lib.fakeHash`, build `.#server` and replace it with Nix's reported `got: sha256-...`. Root npm manifests/lock affect only extension installation and browser tests, not the gateway image.

## Authentication / reverse proxy

**There is no browser authentication in this server.** Bind it to loopback/private networking and put Authelia forward-auth in front of every browser route **and `/ws` upgrades**. All authenticated users see all connected registrations; no per-user filtering. Origin checking is defense-in-depth, not authentication.

Use two HTTPS hostnames on Caddy:

1. **Browser**: every browser route and `/ws` upgrade stays behind Authelia. The browser listener does not serve `/agent/ws`. Keep Host/Origin intact; `/ws` requires the exact `PUBLIC_ORIGIN` (or direct request origin when unset).
2. **Agent**: Caddy forwards only `/agent/challenge`, `/agent/ticket`, and `/agent/ws` to the ticket-authenticated Unix listener. Go verifies both SSH proofs. Never route this hostname to a legacy mTLS-offload listener.

Browser forward-auth checks upgrades, not every message. Anyone who can access the browser UI can enroll and disable hosts at `/admin/hosts`. Keep proxy and application logs free of credentials or payloads. See the [operator runbook](docs/agent-ticket-operations.md).

## Routing / browser protocol

```text
Browser -- HTTP fragments + /ws --> Go gateway <-- /agent/ws -- Pi extension
```

Each Pi process owns a socket; multiple independent processes may show the same host label. A Pi session ID can collide across processes; the gateway assigns a unique **`registration_id` UUID** and checks its exact owner plus original `session_id`. It never falls back to a different process. Disconnect removes only that socket's registration, leaving other processes on the same host connected. Metadata snapshots exclude socket/history/credentials. Status is null until reported, then `idle`/`working`; `connected_at`/`last_seen` are epoch milliseconds (application traffic, not ping/pong).

Ordinary browser views are GET-only (405 otherwise); unknown routes return 404. Static routes are explicitly whitelisted: `/public/app.js`, `/public/style.css`, `/favicon.svg`. Dynamic fragments: `/ui/sessions`, `/ui/sessions/:registrationId`, `/ui/empty`; `/` optionally accepts `?session=<UUID>`. Responses are `no-store`, no-sniff, same-origin-referrer with CSP allowing scripts only from self/jsDelivr, and blocking objects/framing/inline evaluation. HTMX evaluation, injected scripts, indicator styles and history caching are disabled.

Pi v1 is documented in [`docs/pi-protocol-v1.md`](docs/pi-protocol-v1.md). The gateway validates and strips unknown envelope fields from JSON text frames: 1 MiB frame, 100 KiB UTF-8 browser input, 16 KiB tool args. Invalid agent messages/host/ownership cause payload-free cleanup and close 1008; the gateway never sends incompatible error frames to Pi. After authentication the only server → Pi application message is `{version:1,type:"message.send",session_id,text}` with optional `delivery: "steer" | "followUp"` (default: `followUp`).

Browser → gateway:

```json
{"version":1,"type":"message.send","registration_id":"<UUID>","session_id":"s1","text":"Run the tests","delivery":"followUp","request_id":"optional-correlation-ID"}
{"version":1,"type":"session.history","registration_id":"<UUID>","session_id":"s1"}
```

History is request/response, not a subscription. Both targets must match a live registration. Input must be non-blank, whitespace is preserved, and an optional request ID is limited to 128 characters. No automatic resend/acceptance ACK/offline buffering.

Gateway → browser:

| Event | Meaning |
| --- | --- |
| `sessions.snapshot` | Metadata-only `{version:1,type,sessions:[Session,...]}` on browser connection. |
| `session.added/updated` | `{version:1,type,session:Session,reset?}`; `reset:true` on registration. |
| `session.removed/status` | Removal UUID/session ID, or Pi status plus UUID. |
| `session.history` | `{version:1,type,registration_id,session_id,history:{sequence,items,draft,truncated}}`. Items have `order` and `kind:message/activity/notice`; draft is null or `{order,content}`. |
| `message.delta/completed`, `activity.started/completed`, `error` | Validated Pi envelope plus **gateway-only** `registration_id` and monotonic `sequence`. |
| `gateway.error` | `{version:1,type,code,message,request_id?,registration_id?}` for browser parsing/routing failures. |

Registry events refresh the HTMX sidebar without replacing chat. Selection loads escaped history via HTTP, then requests a current WebSocket snapshot. While awaiting it, live feed events are ignored; the snapshot includes them. Later feed events at/below its watermark are ignored. Tool rows/drafts keep their initial order when updated/finalized.

A successful socket write is **not Pi acceptance**. User messages appear only on Pi's normal echo; matching routing errors can restore the last input if the composer is empty. Identical consecutive Pi finals can be legitimate: gateway sequences prevent browser snapshot overlap, not upstream duplicates. Agent disconnects can lose output. No remote start/termination, uploads, persistent history, account telemetry, multi-user authorization or browser push is implemented.

## Verification / tasks

```sh
make css
go test -race ./... && go vet ./...
bun install --frozen-lockfile
bun test && bun run typecheck
(cd pi-extension && npm ci --ignore-scripts && npm run typecheck && npm test)
nix flake check --no-build --all-systems
```

Go tests cover config/auth/protocol validation, bounded history and concurrent registrations. Bun drives the real Go executable for HTTP/WebSocket routing/auth, lifecycle/history restoration, server-rendered pages and jsdom UI tests (safe Markdown, unified/parallel tool rows, composer, snapshot overlap and pinned CDN integrity). Test-only TypeScript history fixtures model browser events; they are not shipped. Set `PI_REMOTE_SERVER_BINARY` to test an already-built executable instead of compiling one. DOM tests use **jsdom** (not Happy DOM, which is not supported for DOMPurify security testing). The real Pi SDK test discovers the **root package from settings**, runs idle/busy remote input and a real tool, then emits a synthetic provider quota failure—no provider network calls or user credentials. Mobile layout/Authelia still need validation in your environment. Nix image/extension builds can be verified here, but there is no local Docker daemon; CI runs the container smoke test and publishing.

Requests and completion evidence live in the versioned [`todo/`](todo/README.md) task list. Gateway code is in root `*.go` files, embedded views in `templates/`, browser JS in `public/` and CSS source in `styles/`, extension in `pi-extension/`. The Go migration plan and build/size evidence are in [`docs/go-server-plan.md`](docs/go-server-plan.md). Local `agents.json`, `.env`, `node_modules` and `result` stay ignored; the existing local credentials are never inspected, overwritten, served or committed.
