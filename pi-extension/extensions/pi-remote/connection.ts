import WebSocket from "ws";
import type { RemoteConfig } from "./config.ts";
import { MAX_FRAME_BYTES, type OutgoingMessage } from "./protocol.ts";

export type ConnectionState = "disabled" | "connecting" | "connected" | "disconnected" | "auth_failed";
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000] as const;
const MAX_BUFFERED_BYTES = 1024 * 1024;

export class Backoff {
  private attempt = 0;
  constructor(private readonly delays: readonly number[] = RECONNECT_DELAYS) {}
  next(): number {
    return this.delays[Math.min(this.attempt++, this.delays.length - 1)]!;
  }
  reset(): void { this.attempt = 0; }
}

interface ConnectionCallbacks {
  onOpen(): void;
  onMessage(text: string): void;
  onBinary(): void;
  onState(state: ConnectionState): void;
}
interface ConnectionOptions {
  /** Short delays are only useful to keep development tests fast. */
  reconnectDelays?: readonly number[];
  heartbeatMs?: number;
}

/** Networking owns no Pi context. All callbacks are isolated from socket failures. */
export class RemoteConnection {
  private socket: WebSocket | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private stopped = false;
  private started = false;
  private readonly backoff: Backoff;

  constructor(
    private readonly config: RemoteConfig,
    private readonly callbacks: ConnectionCallbacks,
    private readonly options: ConnectionOptions = {},
  ) {
    this.backoff = new Backoff(options.reconnectDelays);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connect();
  }

  /** Best effort only: never waits for delivery or grows a disconnected queue. */
  send(message: OutgoingMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.stopped) return false;
    try {
      const payload = JSON.stringify(message);
      if (socket.bufferedAmount + Buffer.byteLength(payload) > MAX_BUFFERED_BYTES) {
        socket.terminate();
        return false;
      }
      socket.send(payload, (error) => { if (error) socket.terminate(); });
      return true;
    } catch {
      socket.terminate();
      return false;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    this.retryTimer = undefined;
    this.heartbeat = undefined;
    const socket = this.socket;
    this.socket = undefined;
    // send() writes immediately when possible; no graceful-close wait on Pi shutdown.
    if (socket) socket.terminate();
  }

  private safely(callback: () => void): void {
    try { callback(); } catch { /* Never let an integration callback crash Node's event loop. */ }
  }

  private state(state: ConnectionState): void {
    this.safely(() => this.callbacks.onState(state));
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, this.backoff.next());
    this.retryTimer.unref();
  }

  private connect(): void {
    if (this.stopped) return;
    this.state("connecting");
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.config.url, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        handshakeTimeout: 10000,
        followRedirects: false,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
      });
    } catch {
      this.state("disconnected");
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    let authenticationFailed = false;
    let alive = true;
    const current = () => !this.stopped && this.socket === socket;

    socket.on("open", () => {
      if (!current()) { socket.terminate(); return; }
      this.backoff.reset();
      this.state("connected");
      this.safely(() => this.callbacks.onOpen());
      if (!current()) return;
      // Detect half-open connections; no extra application protocol is introduced.
      this.heartbeat = setInterval(() => {
        if (!current()) return;
        if (!alive) { socket.terminate(); return; }
        alive = false;
        try { socket.ping(); } catch { socket.terminate(); }
      }, this.options.heartbeatMs ?? 30000);
      this.heartbeat.unref();
    });
    socket.on("pong", () => { alive = true; });
    socket.on("message", (data, isBinary) => {
      if (!current()) return;
      if (isBinary) this.safely(() => this.callbacks.onBinary());
      else this.safely(() => this.callbacks.onMessage(data.toString()));
    });
    socket.on("unexpected-response", (_request, response) => {
      if (!current()) return;
      authenticationFailed = response.statusCode === 401 || response.statusCode === 403;
      response.resume();
      socket.terminate();
    });
    // ws emits close after errors, including handshake timeout/failure.
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!current()) return;
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.socket = undefined;
      this.state(authenticationFailed ? "auth_failed" : "disconnected");
      this.scheduleRetry();
    });
  }
}
