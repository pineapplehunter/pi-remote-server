# Go gateway / smaller OCI image plan

Request: “I want the docker image to be smaller. rewrite the server in go. make a implementation paln, make the todo items then implement and commit the changes.”

Baseline: `36cf8ea` (Bun gateway, Nix layered image).

## Approach

1. Port the gateway to Go using `net/http` and Gorilla WebSocket (one small, pure-Go runtime dependency). Keep the Pi extension TypeScript and browser JS/CSS unchanged. Embed templates and public assets into the executable so deployment needs no source tree or JS runtime.
2. Preserve configuration/token validation, header-only agent auth, exact browser Origin checks, GET-only routes/security headers, validated v1 envelopes, per-connection UUID routing, reconnect cleanup, bounded history, rendering/escaping, ping/pong and slow-client limits. Use a registry mutex plus a bounded outbound queue per socket; network writes must not block registry operations.
3. Replace Bun server unit tests with focused Go tests; run existing HTTP/WebSocket integration and browser DOM tests against the Go server/rendered pages. Keep browser-test fixtures out of the shipped server. Verify the unchanged extension separately.
4. Package a stripped, CGO-disabled Go executable with Nix `buildGoModule`. The image should contain the executable only, with embedded assets; no Bun, Node, npm packages or CA bundle (the gateway makes no outbound TLS connections). Preserve image name, port, environment and mounted-token workflow. Keep the separate Pi-extension Nix output.
5. Update development commands, CI and dependency locks. Build baseline/new images, compare actual image-layer sizes if possible, record test/build results and limitations, complete TODOs and commit.

## Verification

- `go test -race ./...`, `go vet ./...`, Go build with `CGO_ENABLED=0`.
- Bun HTTP/WebSocket compatibility and jsdom UI/security/SRI tests against Go; root TypeScript typecheck.
- Pi extension typecheck/tests, including SDK discovery from repository root.
- Nix flake evaluation, extension/server/image builds; inspect image configuration and layer sizes. Docker container smoke test when a daemon is available (otherwise CI retains it).

## Scope

No new browser auth, persistence, protocol version, frontend framework or extension rewrite. Local credentials are not read or changed. Keep implementation direct; avoid introducing a framework or a second production server.

## Execution results

To be recorded after implementation.
