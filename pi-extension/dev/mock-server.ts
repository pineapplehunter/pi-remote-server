// Development only: loopback server, no persistence, no production authentication service.
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_FRAME_BYTES } from "../extensions/pi-remote/protocol.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8765" }, token: { type: "string", default: "test" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
const token = values.token!;
const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
const sessions = new Map<string, WebSocket>();
const input = createInterface({ input: process.stdin });

server.on("upgrade", (request, socket, head) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});
wss.on("connection", (ws) => {
  console.log("[mock] agent connected");
  ws.on("error", () => console.log("[mock] socket error"));
  ws.on("message", (data) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(data.toString()); } catch { console.log("[mock] invalid agent JSON"); return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "session.register" && typeof message.session_id === "string") sessions.set(message.session_id, ws);
    const activity = message.activity as Record<string, unknown> | undefined;
    const summary = [message.type, message.session_id, message.status, message.role, activity?.tool, message.code]
      .filter((part) => typeof part === "string").join(" ");
    // Event types/IDs only: never print auth, conversation content, or tool arguments/results.
    console.log(`[mock] ${summary.replaceAll(token, "[REDACTED]")}`);
    if (message.type === "session.unregister" && typeof message.session_id === "string" && sessions.get(message.session_id) === ws) sessions.delete(message.session_id);
  });
  ws.on("close", () => {
    for (const [id, socket] of sessions) if (socket === ws) sessions.delete(id);
    console.log("[mock] agent disconnected");
  });
});

input.on("line", (line) => {
  if (line === "/sessions") { console.log([...sessions.keys()].join("\n") || "No connected sessions"); return; }
  if (line === "/drop") { for (const ws of wss.clients) ws.terminate(); return; }
  let message: Record<string, unknown>;
  try { message = JSON.parse(line); } catch { console.log("[mock] paste a JSON message.send, /sessions, or /drop"); return; }
  if (!message || typeof message !== "object") { console.log("[mock] expected JSON object"); return; }
  // Route invalid/wrong-session messages to the sole client too, for validation testing.
  const ws = typeof message.session_id === "string" ? sessions.get(message.session_id) : undefined;
  const target = ws ?? (wss.clients.size === 1 ? [...wss.clients][0] : undefined);
  if (!target || target.readyState !== WebSocket.OPEN) { console.log("[mock] no unambiguous connected target"); return; }
  target.send(JSON.stringify(message), (error) => { if (error) console.log("[mock] send failed"); });
});

server.on("error", () => { console.error("[mock] cannot listen on the requested loopback port"); stop(); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => {
  console.log(`[mock] listening on ws://127.0.0.1:${port}/agent/ws`);
  console.log("[mock] paste JSON to send; /sessions lists IDs; /drop tests reconnect. Ctrl-C exits.");
});
function stop(): void {
  input.close();
  for (const ws of wss.clients) ws.terminate();
  wss.close(); server.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
