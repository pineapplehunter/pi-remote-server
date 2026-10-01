# Pi remote gateway

Small Bun/TypeScript gateway and Pi extension. Server-rendered HTML, plain CSS and one vanilla-JavaScript browser WebSocket. HTMX, Marked and DOMPurify load from pinned jsDelivr URLs with SHA-384 integrity checks. No frontend build, database, browser login, supervisor, remote process launching or offline input queues.

## Start

Use Bun (verified with **1.4.2**), or enter `nix develop` for Bun and Node.js/npm:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
cp -n agents.example.json agents.json
chmod 600 agents.json
```

**Replace the example tokens before deployment**, using a different random token per host:

```sh
bun -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

The token file is a JSON array:

```json
[{"host_id":"laptop","token":"replace-with-a-unique-random-secret"}]
```

Loopback development:

```sh
export HOST=127.0.0.1 PORT=3000
export PI_REMOTE_TOKEN_FILE="$PWD/agents.json"
bun src/index.ts
```

Open `http://127.0.0.1:3000`. Install/configure the extension below; `/remote-login` uses `ws://127.0.0.1:3000/agent/ws`, host `laptop`, and its matching token. Start Pi sessions on the host, not in this UI. Browser input remains literal text; busy Pi queues follow-ups.

Behind a TLS proxy, set `PUBLIC_ORIGIN=https://pi.s.ihavenojob.work` (your actual origin). `HOST` defaults to loopback, `PORT` to 3000. `PI_REMOTE_TOKEN_FILE` is required. `PUBLIC_ORIGIN` must be one HTTP(S) origin without path, query or credentials. Credentials are validated and loaded **once at startup**; invalid files/duplicates abort startup. Restart to rotate tokens. Keep the file readable only by its owner/administrator.

The root production dependencies are Zod (gateway validation) and `ws@8.22.0` (Pi Git-package runtime). Pi itself is supplied by the host. Browser library packages are **development-only**, for reproducible offline tests; browser deployment fetches their pinned CDN files. Application JS/CSS and the favicon stay local. If CDN/SRI loading fails, the UI keeps sending disabled and displays a library-loading error; allow `cdn.jsdelivr.net` and reload. There is no local vendor fallback.

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

Requires Pi **0.87.1** or a compatible later API and Node >=22.19. Commands: `/remote-login`, `/remote-status`. Use Pi's built-in `/name <name>` to rename sessions. Credentials live at **`~/.pi/agent/remote.json`**, mode 0600, outside this repository/Nix store. Do not put tokens in `settings.json` or Nix expressions. See [`pi-extension/README.md`](pi-extension/README.md) for configuration and API details. Do not load multiple copies of this extension.

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

`ws` was updated from the supplied 8.18.3 to patched **8.22.0** in both packages. `npm audit` still reports a development-only `brace-expansion` advisory in Pi's test dependency tree; those dependencies are not in the Nix extension or gateway image.

## Conversation, Markdown and history

Chat, assistant drafts, tool activity and Pi notices share **one chronological stream**. Tool rows show short tool/path/command summaries; parallel calls update their own rows by `tool_call_id`. Tool results, thinking and full argument objects are not displayed. Finalized user/assistant text supports Markdown: paragraphs, headings, emphasis, lists, links, tables and fenced code. Drafts stream incrementally as plain text and become Markdown on completion. Marked output is sanitized by DOMPurify before inserting DOM fragments; images, SVG, forms, style/ID/name/class/data attributes and unsafe links are excluded. Server-rendered history/metadata and live notices/activity are escaped or use text nodes.

Use **Tool calls** in the chat header to show/hide activity rows. The browser remembers this display preference across sessions/reloads using localStorage (only the boolean preference, never conversation data). Hiding tools does not stop receiving/updating/buffering them or hide chat/usage-limit notices. If storage is blocked, the toggle still works for the current page.

The composer uses a rounded, auto-growing multiline field and a separate Send action. **Ctrl+Enter sends; Enter inserts a newline.** Repeated keys and active IME composition do not send. Send stays disabled for blank/offline input, but the draft remains editable; busy Pi still accepts follow-ups. Successful sends shrink/clear the field; a matched routing error restores its text and height. Height is capped so long drafts scroll inside the input. The design adapts [LibreChat and assistant-ui composer patterns](docs/composer-design.md), without adding React, attachments or unsupported stop controls.

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

The detail is bounded to 500 characters and the configured bearer token is redacted. At most one notice is emitted per agent run, including retries. The gateway forwards it over `/ws` and retains/displays it in the unified stream, even if the browser was closed at the time.

A bare HTTP 429, throughput `rate_limit_exceeded`, other provider failures and successful text discussing limits **are not classified as exhausted usage**. This detects provider-reported failure text, not account telemetry or a predicted reset time; unfamiliar provider wording may need a classifier update. Upgrade **both gateway and extension** for the additional v1 error code; older gateways reject unknown codes. All other Pi wire shapes stay unchanged; history/sequence fields are browser-only.

## Docker / OCI

Packaging follows [prometheus-switchbot](https://github.com/pineapplehunter/prometheus-switchbot): Nix `dockerTools.streamLayeredImage`, an executable image streamer, and GitHub Actions publishing GHCR `latest`. No Dockerfile/frontend build. The image contains Bun, CA certificates, gateway source/static assets and production dependencies from `bun.lock`, but no extension code, dev dependencies, credentials, tests or `.env`.

```sh
nix build .#docker
./result | docker load
```

The default `nix build` does the same. Image: `pi-remote-server:latest`. Linux x86_64/aarch64 outputs are available; Darwin has a development shell, not a native image output.

```sh
docker run --detach --name pi-remote --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env PI_REMOTE_TOKEN_FILE=/run/pi-remote/agents.json \
  --env PUBLIC_ORIGIN=https://pi.s.ihavenojob.work \
  --mount "type=bind,src=$PWD/agents.json,dst=/run/pi-remote/agents.json,readonly" \
  pi-remote-server:latest
```

For loopback testing use `PUBLIC_ORIGIN=http://127.0.0.1:3000` and exactly that browser address. The image uses `HOST=0.0.0.0` **inside** the container; publish on **host loopback only**. The reference-style image defaults to root; an optional `--user UID:GID` needs permission to read the mounted credentials. Startup fails without a readable token file. Restart after in-place credential changes; recreate after replacing the bind-mounted file.

With the supplied `compose.yaml`:

```sh
export PUBLIC_ORIGIN=https://pi.s.ihavenojob.work
docker compose pull
docker compose up -d
# After replacing/rotating the credential file:
docker compose up -d --force-recreate
```

Compose refuses a missing credential file and defaults to `ghcr.io/pineapplehunter/pi-remote-server:latest`. For a locally built image change it to `pi-remote-server:latest` and use `--pull never`. Unset `PUBLIC_ORIGIN` for Compose's loopback default. If the proxy runs in Docker, use a private network and `http://pi-remote:3000`, not a public host port.

[CI](.github/workflows/upload-oci.yml) tests/type-checks both packages and builds the Pi extension for pull requests. Main pushes/manual main runs additionally build/load/smoke-test the image and publish `ghcr.io/<lowercase owner/repository>:latest` using `GITHUB_TOKEN` (`packages: write`). The runner publishes linux/amd64, not a multi-platform manifest. GHCR visibility may need to be made public, or private pulls need a `read:packages` login. Nothing is published until the commits are pushed and CI succeeds.

Production dependencies are a fixed-output Nix derivation. When changing root manifests/lock, build `nix build .#runtime-dependencies --no-link` and update `outputHash` in `flake.nix` from Nix's reported `got: sha256-...` (temporarily use `pkgs.lib.fakeHash` if needed). Installs disable lifecycle scripts; the dependency store name includes both manifest hashes to avoid stale reuse.

## Authentication / reverse proxy

**There is no browser authentication in this server.** Bind it to loopback/private networking and put Authelia forward-auth in front of every browser route **and `/ws` upgrades**. All authenticated users see all connected registrations; no per-user filtering. Origin checking is defense-in-depth, not authentication.

Deploy at the domain root, with two proxy branches:

1. Exact **`/agent/ws`**: bypass Authelia; preserve `Authorization: Bearer <token>`. Bun independently authenticates the host token. No redirects or token query parameters; query strings are rejected even with a valid header.
2. **Every other path**, including `/`, `/ui/*`, `/public/*`, `/favicon.svg`, `/ws`, reserved `/api/*`: require successful Authelia forward-auth **before** forwarding. Reject unauthenticated upgrades; HTTP can redirect to the login portal.

Terminate TLS with a valid certificate. Use HTTP/1.1 upstream, `Upgrade`/`Connection` headers, no WebSocket response buffering, and a read timeout comfortably above Bun's 90-second idle window (e.g. 3600s). Preserve Host/Origin; never rewrite Origin to a trusted value. `/ws` requires exact `PUBLIC_ORIGIN`, or the direct request origin when unset; missing/null/foreign origins fail. Forwarded host/proto are not trusted. Pass original URL/method/cookies to Authelia using its supported proxy configuration. CDN script requests do not carry gateway credentials (`crossorigin="anonymous"`, same-origin referrer policy).

Forward-auth checks the initial upgrade, not every message; existing sockets do not continuously recheck authorization. Browser reconnects re-run forward-auth. Keep Bun accessible only to trusted local processes/proxy. Tokens/logs never include conversation text, tool args or raw headers. Avoid Authorization/payload logging in the proxy too. This remains a trusted conversation feed: only the configured extension token is specifically redacted; other arbitrary secrets are not detected.

## Routing / browser protocol

```text
Browser -- HTTP fragments + /ws --> Bun gateway <-- /agent/ws -- Pi extension
```

Each Pi process owns a socket. Host IDs map to socket sets. A Pi session ID can collide across processes; the gateway assigns a unique **`registration_id` UUID** and checks its exact owner plus original `session_id`. It never falls back to a different process. Disconnect removes only its registration; the host stays until its last socket closes. Metadata snapshots exclude socket/history/credentials. Status is null until reported, then `idle`/`working`; `connected_at`/`last_seen` are epoch milliseconds (application traffic, not ping/pong).

All HTTP routes are GET-only (405 otherwise); unknown routes return 404. Static routes are explicitly whitelisted: `/public/app.js`, `/public/style.css`, `/favicon.svg`. Dynamic fragments: `/ui/sessions`, `/ui/sessions/:registrationId`, `/ui/empty`; `/` optionally accepts `?session=<UUID>`. Responses are `no-store`, no-sniff, same-origin-referrer with CSP allowing scripts only from self/jsDelivr, and blocking objects/framing/inline evaluation. HTMX evaluation, injected scripts, indicator styles and history caching are disabled.

Pi v1 is documented in [`docs/pi-protocol-v1.md`](docs/pi-protocol-v1.md). Zod validates text frames: 1 MiB frame, 100 KiB UTF-8 browser input, 16 KiB tool args. Invalid agent messages/host/ownership cause payload-free cleanup and close 1008; the gateway never sends incompatible error frames to Pi. The only server → Pi message is `{version:1,type:"message.send",session_id,text}`.

Browser → gateway:

```json
{"version":1,"type":"message.send","registration_id":"<UUID>","session_id":"s1","text":"Run the tests","request_id":"optional-correlation-ID"}
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
bun test && bun run typecheck
(cd pi-extension && npm ci --ignore-scripts && npm run typecheck && npm test)
nix flake check --no-build --all-systems
```

Tests cover real local Bun WebSocket routing/auth, bounds/lifecycle/history restoration, safe server/Markdown rendering, unified/parallel tool rows, snapshot overlap and pinned CDN integrity. DOM tests use **jsdom** (not Happy DOM, which is not supported for DOMPurify security testing). The real Pi SDK test discovers the **root package from settings**, runs idle/busy remote input and a real tool, then emits a synthetic provider quota failure—no provider network calls or user credentials. Mobile layout/Authelia still need validation in your environment. Nix image/extension builds can be verified here, but there is no local Docker daemon; CI runs the container smoke test and publishing.

Requests and completion evidence live in the versioned [`todo/`](todo/README.md) task list. Gateway code is in `src/`, client JS/CSS in `public/`, extension in `pi-extension/`. Local `agents.json`, `.env`, `node_modules` and `result` stay ignored; the existing local credentials are never inspected, overwritten, served or committed.
