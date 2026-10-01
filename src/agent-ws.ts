import { parseAgentMessage, ProtocolError } from "./protocol.ts";
import { log, Registry, type Socket } from "./registry.ts";

export function agentMessage(registry: Registry, socket: Socket, hostId: string, raw: string | Buffer): void {
  // Ignore any callbacks already queued after rejection/close.
  if (socket.readyState !== 1 || !registry.hosts.get(hostId)?.has(socket)) return;
  try {
    const message = parseAgentMessage(raw);
    if (message.type === "session.register") {
      if (message.host_id !== hostId) throw new ProtocolError("wrong_host", "Authenticated host does not match registration.");
      registry.register(socket, hostId, message);
      return;
    }
    const session = registry.owned(socket, message.session_id);
    if (!session) throw new ProtocolError("wrong_session", "Session is not registered on this socket.");
    session.last_seen = Date.now();
    if (message.type === "session.unregister") { registry.remove(socket); return; }
    if (message.type === "session.updated") {
      session.name = message.name;
      registry.broadcast({ version: 1, type: "session.updated", session: registry.snapshot(session) });
      return;
    }
    if (message.type === "session.status") session.status = message.status;
    registry.broadcast({ ...message, registration_id: session.registration_id });
  } catch (error) {
    // Pi accepts only message.send. Do NOT send an incompatible gateway error to Pi.
    log("agent.rejected", { code: error instanceof ProtocolError ? error.code : "invalid_message" });
    registry.disconnectAgent(socket, hostId);
    socket.close(1008, "Invalid agent protocol message.");
  }
}
