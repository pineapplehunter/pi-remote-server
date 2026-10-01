import type { ServerWebSocket } from "bun";
import type { AgentMessage } from "./protocol.ts";

export type SocketData = { kind: "agent"; hostId: string } | { kind: "browser" };
export type Socket = ServerWebSocket<SocketData>;
export interface Session {
  registration_id: string;
  session_id: string;
  host_id: string;
  cwd: string;
  name: string | null;
  pid: number;
  status: "idle" | "working" | null;
  connected_at: number;
  last_seen: number;
}
export interface LiveSession extends Session { socket: Socket }
export type BrowserEvent =
  | { version: 1; type: "sessions.snapshot"; sessions: Session[] }
  | { version: 1; type: "session.added" | "session.updated"; session: Session; reset?: true }
  | { version: 1; type: "session.removed"; registration_id: string; session_id: string }
  | (AgentMessage & { registration_id: string })
  | { version: 1; type: "gateway.error"; code: string; message: string; request_id?: string; registration_id?: string };

export function log(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** send() == 0 means queued, not failed; -1 means dropped. Never queue offline. */
export function send(socket: Socket, value: BrowserEvent | object): boolean {
  if (socket.readyState !== 1) return false;
  try {
    const payload = JSON.stringify(value);
    if (socket.getBufferedAmount() + Buffer.byteLength(payload) > 2 * 1024 * 1024) {
      socket.close(1013, "Slow connection; reconnect.");
      return false;
    }
    if (socket.send(payload) === -1) {
      socket.close(1013, "Socket send dropped; reconnect.");
      return false;
    }
    return true;
  } catch {
    socket.close(1011, "Socket send failed.");
    return false;
  }
}

export class Registry {
  // A host has many independent extension runtimes, not one host-supervisor socket.
  readonly hosts = new Map<string, Set<Socket>>();
  readonly sessions = new Map<string, LiveSession>(); // gateway registration IDs, NOT Pi IDs
  readonly browsers = new Set<Socket>();
  private readonly byConnection = new Map<Socket, string>();

  snapshot(session: LiveSession): Session {
    const { socket: _socket, ...metadata } = session;
    return metadata;
  }
  list(): Session[] { return [...this.sessions.values()].map(session => this.snapshot(session)); }
  broadcast(event: BrowserEvent): void {
    for (const browser of this.browsers) if (!send(browser, event)) this.browsers.delete(browser);
  }
  connectAgent(socket: Socket, hostId: string): void {
    const connections = this.hosts.get(hostId) ?? new Set<Socket>();
    connections.add(socket);
    this.hosts.set(hostId, connections);
    log("host.connected");
  }
  register(socket: Socket, hostId: string, message: Extract<AgentMessage, { type: "session.register" }>): void {
    const previousId = this.byConnection.get(socket);
    let session = previousId ? this.sessions.get(previousId) : undefined;
    if (session && (session.session_id !== message.session_id || session.pid !== message.pid)) {
      this.remove(socket);
      session = undefined;
    }
    const existing = !!session;
    if (!session) {
      session = { registration_id: crypto.randomUUID(), session_id: message.session_id, host_id: hostId,
        cwd: message.cwd, name: message.name, pid: message.pid, status: null,
        connected_at: Date.now(), last_seen: Date.now(), socket };
      this.sessions.set(session.registration_id, session);
      this.byConnection.set(socket, session.registration_id);
    } else {
      session.cwd = message.cwd;
      session.name = message.name;
      session.last_seen = Date.now();
    }
    // Every registration starts a fresh browser draft/activity view, including idempotent repeats.
    this.broadcast({ version: 1, type: existing ? "session.updated" : "session.added", session: this.snapshot(session), reset: true });
    log("session.registered", { registration_id: session.registration_id });
  }
  owned(socket: Socket, sessionId: string): LiveSession | undefined {
    const id = this.byConnection.get(socket);
    const session = id ? this.sessions.get(id) : undefined;
    return session?.session_id === sessionId ? session : undefined;
  }
  remove(socket: Socket): void {
    const id = this.byConnection.get(socket);
    if (!id) return;
    const session = this.sessions.get(id);
    this.byConnection.delete(socket);
    this.sessions.delete(id);
    if (session) {
      this.broadcast({ version: 1, type: "session.removed", registration_id: id, session_id: session.session_id });
      log("session.unregistered", { registration_id: id });
    }
  }
  disconnectAgent(socket: Socket, hostId: string): void {
    this.remove(socket);
    const connections = this.hosts.get(hostId);
    const wasConnected = connections?.delete(socket);
    if (connections?.size === 0) this.hosts.delete(hostId);
    if (wasConnected) log("host.disconnected");
  }
}
