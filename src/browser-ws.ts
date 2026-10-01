import { parseBrowserMessage, ProtocolError, type BrowserMessage, type SendMessage } from "./protocol.ts";
import { Registry, send, type Socket } from "./registry.ts";

export function browserMessage(registry: Registry, socket: Socket, raw: string | Buffer): void {
  let message: BrowserMessage | undefined;
  try {
    message = parseBrowserMessage(raw);
    const session = registry.sessions.get(message.registration_id);
    if (!session) throw new ProtocolError("unknown_session", "This Pi connection is gone. Select a live session; the message was not forwarded.");
    if (session.session_id !== message.session_id) throw new ProtocolError("wrong_session", "Session ID does not match this live registration.");
    if (message.type === "session.history") {
      send(socket, { version: 1, type: "session.history", registration_id: session.registration_id,
        session_id: session.session_id, history: session.history.snapshot() });
      return;
    }
    const outgoing: SendMessage = { version: 1, type: "message.send", session_id: session.session_id, text: message.text };
    if (!send(session.socket, outgoing)) {
      registry.disconnectAgent(session.socket, session.host_id);
      throw new ProtocolError("session_unavailable", "Pi is disconnected. The message was not forwarded.");
    }
    // No success/acceptance ACK: v1 has no Pi delivery acknowledgment. Wait for Pi's user echo.
  } catch (error) {
    send(socket, { version: 1, type: "gateway.error",
      code: error instanceof ProtocolError ? error.code : "routing_failed",
      message: error instanceof ProtocolError ? error.message : "Could not forward the message.",
      ...(message?.request_id ? { request_id: message.request_id } : {}),
      ...(message ? { registration_id: message.registration_id } : {}),
    });
  }
}
