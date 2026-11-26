import WebSocket from "ws";
import { MAX_FRAME_BYTES, type OutgoingMessage } from "./protocol.ts";
import { requestIdentity } from "./identity.ts";

export type ConnectionState = "disabled" | "connecting" | "connected" | "disconnected" | "issuer_failed" | "auth_failed";
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
  proofTimeoutMs?: number;
}

/** Networking owns no Pi context. All callbacks are isolated from socket failures. */
export class RemoteConnection {
  private socket: WebSocket | undefined;
  private enrollment: AbortController | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private stopped = false;
  private started = false;
  private readonly backoff: Backoff;
  private authenticated = false;

  constructor(
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
    if (!this.authenticated || !socket || socket.readyState !== WebSocket.OPEN || this.stopped) return false;
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
    this.enrollment?.abort();
    this.enrollment = undefined;
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

  endpoint?: string;

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.endpoint = undefined;
    this.state("connecting");
    if (this.stopped) return;
    const enrollment = new AbortController();
    this.enrollment = enrollment;
    let identity: Awaited<ReturnType<typeof requestIdentity>>;
    try {
      identity = await requestIdentity(enrollment.signal);
    } catch {
      if (this.stopped) return;
      this.enrollment = undefined;
      this.state("issuer_failed");
      this.scheduleRetry();
      return;
    }
    if (this.stopped || this.enrollment !== enrollment) return;
    let socket: WebSocket;
    try {
      this.endpoint = identity.url;
      socket = new WebSocket(identity.url, {
        headers: { Authorization: `Bearer ${identity.ticket}` },
        rejectUnauthorized: true,
        handshakeTimeout: 10000,
        followRedirects: false,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
      });
    } catch {
      enrollment.abort();
      this.state("disconnected");
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    let authenticationFailed = false;
    let alive = true;
    const current = () => !this.stopped && this.socket === socket;

    let phase: "challenge" | "signing" | "ack" = "challenge";
    let proofTimer: NodeJS.Timeout | undefined;
    const reject = () => { authenticationFailed = true; socket.terminate(); };
    socket.on("open", () => {
      proofTimer = setTimeout(reject, this.options.proofTimeoutMs ?? 10000);
      proofTimer.unref();
    });
    const connected = () => {
      clearTimeout(proofTimer);
      this.authenticated = true;
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
    };
    socket.on("pong", () => { alive = true; });
    socket.on("message", async (data, isBinary) => {
      if (!current() || authenticationFailed) return;
      if (!this.authenticated) {
        try {
          if (isBinary || !Buffer.isBuffer(data) || data.length > 4096) return reject();
          const msg = JSON.parse(data.toString());
          if (phase === "challenge" && msg?.type === "auth.challenge" && typeof msg.challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(msg.challenge)) {
            phase = "signing";
            const signature = await identity.sign(msg.challenge);
            identity.dispose();
            if (!current() || socket.readyState !== WebSocket.OPEN) return;
            phase = "ack";
            socket.send(JSON.stringify({ type: "auth.proof", signature }));
          } else if (phase === "ack" && msg?.type === "auth.ok") connected();
          else reject();
        } catch { reject(); }
        return;
      }
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
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (current() && /^(ERR_(TLS|SSL)_|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED_)/.test(error.code ?? "")) {
        authenticationFailed = true;
      }
    });
    socket.on("close", () => {
      clearTimeout(proofTimer);
      enrollment.abort();
      if (!current()) return;
      this.enrollment = undefined;
      authenticationFailed ||= !this.authenticated && phase !== "challenge";
      this.authenticated = false;
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.socket = undefined;
      this.state(authenticationFailed ? "auth_failed" : "disconnected");
      this.scheduleRetry();
    });
  }
}
