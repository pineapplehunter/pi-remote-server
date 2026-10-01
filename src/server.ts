import { Credentials } from "./auth.ts";
import { browserOriginAllowed, type Config } from "./config.ts";
import { agentMessage } from "./agent-ws.ts";
import { browserMessage } from "./browser-ws.ts";
import { MAX_FRAME_BYTES } from "./protocol.ts";
import { Registry, log, send, type SocketData } from "./registry.ts";
import { emptyDetail, page, selectedSession, sessionList } from "./views.ts";

const publicFiles = new Map([
  ["/favicon.svg", new URL("../public/favicon.svg", import.meta.url)],
  ["/public/app.js", new URL("../public/app.js", import.meta.url)],
  ["/public/style.css", new URL("../public/style.css", import.meta.url)],

]);
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const html = (body: string, status = 200) => new Response(body, { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });

export function startServer(config: Config, credentials: Credentials) {
  const registry = new Registry();
  const server = Bun.serve<SocketData>({
    hostname: config.host,
    port: config.port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET" } });
      if (url.pathname === "/agent/ws") {
        // Reject query strings entirely, including when a valid header also exists.
        const hostId = url.search ? undefined : credentials.authenticate(request.headers.get("authorization"));
        if (!hostId) {
          log("agent.authentication_rejected");
          return new Response("Unauthorized", { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } });
        }
        if (server.upgrade(request, { data: { kind: "agent", hostId } })) return;
        return new Response("WebSocket upgrade required", { status: 426, headers });
      }
      if (url.pathname === "/ws") {
        if (!browserOriginAllowed(request, config.publicOrigin)) return new Response("Forbidden origin", { status: 403, headers });
        if (server.upgrade(request, { data: { kind: "browser" } })) return;
        return new Response("WebSocket upgrade required", { status: 426, headers });
      }
      const asset = publicFiles.get(url.pathname);
      if (asset) return new Response(Bun.file(asset), { headers });
      if (url.pathname === "/") {
        const session = registry.sessions.get(url.searchParams.get("session") ?? "");
        return html(page(registry.list(), session ? registry.snapshot(session) : undefined, session?.history.snapshot()));
      }
      if (url.pathname === "/ui/sessions") return html(sessionList(registry.list()));
      if (url.pathname === "/ui/empty") return html(emptyDetail());
      const match = /^\/ui\/sessions\/([^/]+)$/.exec(url.pathname);
      if (match) {
        // Registration keys are server-created UUIDs; Pi's opaque IDs never enter URL paths.
        const session = registry.sessions.get(match[1]!);
        return session ? html(selectedSession(registry.snapshot(session), session.history.snapshot())) : html("<p>This Pi connection is no longer available. Select a live session.</p>", 404);
      }
      return new Response("Not found", { status: 404, headers });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      idleTimeout: 90,
      sendPings: true,
      backpressureLimit: 2 * MAX_FRAME_BYTES,
      closeOnBackpressureLimit: true,
      open(socket) {
        if (socket.data.kind === "agent") registry.connectAgent(socket, socket.data.hostId);
        else {
          registry.browsers.add(socket);
          send(socket, { version: 1, type: "sessions.snapshot", sessions: registry.list() });
          log("browser.connected");
        }
      },
      message(socket, raw) {
        if (socket.data.kind === "agent") agentMessage(registry, socket, socket.data.hostId, raw);
        else browserMessage(registry, socket, raw);
      },
      close(socket) {
        if (socket.data.kind === "agent") registry.disconnectAgent(socket, socket.data.hostId);
        else { registry.browsers.delete(socket); log("browser.disconnected"); }
      },
    },
    error() {
      log("server.request_error");
      return new Response("Internal server error", { status: 500, headers });
    },
  });
  return { server, registry };
}
