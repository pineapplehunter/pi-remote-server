# Go gateway / smaller OCI image plan

Request: “I want the docker image to be smaller. rewrite the server in go. make a implementation paln, make the todo items then implement and commit the changes.”

Baseline: `36cf8ea` (Bun gateway, Nix layered image).

## Approach

1. Port the gateway to Go using `net/http` and Gorilla WebSocket (one small, pure-Go runtime dependency). Keep the Pi extension TypeScript and browser JS/CSS unchanged. Embed templates and public assets into the executable so deployment needs no source tree or JS runtime.
2. Preserve configuration/token validation, header-only agent auth, exact browser Origin checks, GET-only routes/security headers, validated v1 envelopes, per-connection UUID routing, reconnect cleanup, bounded history, rendering/escaping, ping/pong and slow-client limits. Use a registry mutex plus a bounded outbound queue per socket; network writes must not block registry operations.
3. Replace Bun server unit tests with focused Go tests; run existing HTTP/WebSocket integration and browser DOM tests against the Go server/rendered pages. Keep browser-test fixtures out of the shipped server. Verify the unchanged extension separately.
4. Package a stripped, CGO-disabled Go executable with Nix `buildGoModule`. The image should contain the executable with embedded assets (plus Nix's standard Go timezone/MIME/network data dependencies); no Bun, Node, npm packages or CA bundle (the gateway makes no outbound TLS connections). Preserve image name, port, environment and mounted-token workflow. Keep the separate Pi-extension Nix output.
5. Update development commands, CI and dependency locks. Build baseline/new images, compare actual image-layer sizes if possible, record test/build results and limitations, complete TODOs and commit.

## Verification

- `go test -race ./...`, `go vet ./...`, Go build with `CGO_ENABLED=0`.
- Bun HTTP/WebSocket compatibility and jsdom UI/security/SRI tests against Go; root TypeScript typecheck.
- Pi extension typecheck/tests, including SDK discovery from repository root.
- Nix flake evaluation, extension/server/image builds; inspect image configuration and layer sizes. Docker container smoke test when a daemon is available (otherwise CI retains it).

## Scope

No new browser auth, persistence, protocol version, frontend framework or extension rewrite. Local credentials are not read or changed. Keep implementation direct; avoid introducing a framework or a second production server.

## Execution results

Implemented and verified on 2026-10-16 (linux/amd64), using the unchanged `flake.lock` for both builds.

### Measured image size

| Image | Uncompressed image layers (bytes) | MiB |
| --- | ---: | ---: |
| Bun baseline `36cf8ea` | 127,037,440 | 121.15 |
| Go implementation | 12,380,160 | 11.81 |
| Saved | **114,657,280** | **109.35 (90.25%)** |

These are actual built-image measurements, not estimates or executable-only sizes. Built each `.#docker` with Nix, ran its streamer into a Docker archive, read `manifest.json`, and summed the tar member sizes of its referenced `Layers`. Both archives are uncompressed; this is comparable to Docker's uncompressed image-size metric, not a GHCR compressed transfer-size measurement. The baseline was a clean `git archive 36cf8ea`, without local credentials or dependencies.

The Go executable is 8,722,448 bytes (8.32 MiB); the remainder is Nix's timezone, MIME and network databases plus layer metadata. ELF program headers confirm there is no dynamic interpreter (`PT_INTERP`). Image archive inspection confirms no Bun, `node_modules` or token file. Image command, exposed port 3000 and HOST/PORT defaults are preserved. CA certificates and npm fixed-output runtime dependencies are no longer included.

### Verification results

- `go test -race ./...`: passed (config/auth, protocol, bounded history, stale socket, byte/frame backpressure, concurrent same-ID registrations).
- `go vet ./...`: passed.
- `CGO_ENABLED=0 go build -trimpath -ldflags='-s -w'`: passed.
- `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`: passed; **15 tests / 166 assertions** against the Go server and Go-rendered templates. Server-only TypeScript tests were ported to Go; the remaining TS history model is a browser mock fixture only.
- Re-ran all 15 integration/browser tests with `PI_REMOTE_SERVER_BINARY` pointing to the actual Nix-built static executable: passed.
- Pi extension: `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`: passed, **29 tests**, including real SDK root-package discovery. Extension source and browser assets are unchanged.
- `nix flake check --no-build --all-systems`: passed (Linux x86_64/aarch64 and aarch64 Darwin evaluation).
- `nix build .#docker .#server .#pi-extension --no-link`: passed on x86_64 Linux, including the Go package's check phase. Other architectures were evaluated, not built.
- CI now tests Go/races/vet, builds the server and extension, retains Docker container smoke checks and rejects images over 20,000,000 uncompressed bytes.

No Docker daemon is available in this sandbox, so actual container startup/publishing remains a CI check. Existing deployment-specific Authelia/mobile validation limitations are unchanged. Planning and implementation are recorded in separate commits; the coupled gateway/packaging changes are committed atomically to avoid a broken intermediate image.
