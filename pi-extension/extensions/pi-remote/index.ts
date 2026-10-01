import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig, type RemoteConfig } from "./config.ts";
import { RemoteConnection, type ConnectionState } from "./connection.ts";
import { RemoteInput } from "./input.ts";
import { parseServerMessage, VERSION, type ProtocolError, type OutgoingMessage } from "./protocol.ts";
import { completed, textDelta, TextRedactor, toolStarted, toolCompleted } from "./translation.ts";
import { registerRemoteCommands, showConnectionState } from "./ui.ts";

interface ActiveSession {
  ctx: ExtensionContext;
  id: string;
  cwd: string;
  name: string | null;
  busy: boolean;
  state: ConnectionState;
  lifetime: AbortController;
  config?: RemoteConfig;
  connection?: RemoteConnection;
  redactor?: TextRedactor;
  input?: RemoteInput;
}

export default function remoteExtension(pi: ExtensionAPI): void {
  let active: ActiveSession | undefined;
  let configGeneration = 0;

  function send(message: OutgoingMessage): void { active?.connection?.send(message); }

  function setState(session: ActiveSession, state: ConnectionState): void {
    if (active !== session) return;
    session.state = state;
    showConnectionState(session.ctx, state);
  }

  function registration(session: ActiveSession): void {
    if (!session.config) return;
    send({ version: VERSION, type: "session.register", session_id: session.id,
      host_id: session.config.host_id, cwd: session.cwd,
      name: session.name?.replaceAll(session.config.token, "[REDACTED]") ?? null, pid: process.pid });
    send({ version: VERSION, type: "session.status", session_id: session.id,
      status: session.busy ? "working" : "idle" });
  }

  function protocolError(session: ActiveSession, error: ProtocolError): void {
    if (active !== session) return;
    send({ version: VERSION, type: "error", session_id: session.id, ...error });
    // Footer/status command already exposes network state. No raw payload logging.
  }

  function configure(config: RemoteConfig | undefined): void {
    configGeneration++;
    const session = active;
    if (!session) return;
    session.connection?.stop();
    session.input?.clear();
    session.connection = undefined;
    session.config = config;
    session.redactor = config ? new TextRedactor(config.token) : undefined;
    if (!config) { setState(session, "disabled"); return; }
    const connection = new RemoteConnection(config, {
      onOpen: () => { if (active === session) registration(session); },
      onState: (state) => setState(session, state),
      onBinary: () => protocolError(session, { code: "invalid_message", message: "Expected a JSON text frame." }),
      onMessage: (raw) => {
        if (active !== session || session.connection !== connection || session.lifetime.signal.aborted) return;
        // Validate against SessionManager again at injection time, not a remote-provided ID.
        const parsed = parseServerMessage(raw, session.ctx.sessionManager.getSessionId());
        if (!parsed.ok) { protocolError(session, parsed.error); return; }
        session.input?.receive(parsed.message.text, session.busy);
      },
    });
    session.connection = connection;
    connection.start();
  }

  registerRemoteCommands(pi, {
    snapshot: () => ({ config: active?.config, state: active?.state ?? "disabled",
      sessionId: active?.id, signal: active?.lifetime.signal }),
    configure,
  });

  pi.on("session_start", (_event, ctx) => {
    // Some invocations discover extensions without a session: no socket exists before here.
    active?.lifetime.abort();
    active?.connection?.stop();
    const session: ActiveSession = {
      ctx, id: ctx.sessionManager.getSessionId(), cwd: ctx.sessionManager.getCwd(),
      name: ctx.sessionManager.getSessionName() ?? null, busy: !ctx.isIdle(),
      state: "disabled", lifetime: new AbortController(),
    };
    active = session;
    session.input = new RemoteInput(pi, () => !session.ctx.isIdle(), (error) => protocolError(session, error));
    const generation = ++configGeneration;
    // Never return/await this promise from the startup handler.
    void loadConfig().then((config) => {
      if (active === session && generation === configGeneration) configure(config);
    }).catch(() => {
      if (active === session && generation === configGeneration && ctx.hasUI) {
        ctx.ui.notify(`Remote connection disabled: invalid or unreadable ${configPath()}. Use /remote-login.`, "warning");
      }
    });
  });

  pi.on("session_info_changed", (event) => {
    if (!active) return;
    active.name = event.name ?? null;
    send({ version: VERSION, type: "session.updated", session_id: active.id,
      name: active.name && active.config ? active.name.replaceAll(active.config.token, "[REDACTED]") : active.name });
  });

  pi.on("agent_start", () => {
    if (!active) return;
    active.busy = true;
    send({ version: VERSION, type: "session.status", session_id: active.id, status: "working" });
    active.input?.agentStarted();
  });
  pi.on("agent_settled", () => {
    if (!active) return;
    active.busy = false;
    send({ version: VERSION, type: "session.status", session_id: active.id, status: "idle" });
    active.input?.agentSettled();
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") {
      active?.redactor?.reset();
      active?.input?.agentStarted();
    }
  });
  pi.on("message_update", (event) => {
    if (!active?.redactor) return;
    const text = textDelta(event);
    if (text === undefined) return;
    const delta = active.redactor.push(text);
    if (delta) send({ version: VERSION, type: "message.delta", session_id: active.id, delta });
  });
  pi.on("message_end", (event) => {
    if (!active?.config) return;
    if (event.message.role === "assistant") {
      const delta = active.redactor?.finish();
      if (delta) send({ version: VERSION, type: "message.delta", session_id: active.id, delta });
    }
    const message = completed(event, active.id, active.config.token);
    if (message) send(message);
  });
  pi.on("tool_execution_start", (event) => {
    if (active?.config) send(toolStarted(event, active.id, active.config.token));
  });
  pi.on("tool_execution_end", (event) => {
    if (active?.config) send(toolCompleted(event, active.id));
  });
  pi.on("session_shutdown", (event) => {
    if (!active) return;
    send({ version: VERSION, type: "session.unregister", session_id: active.id, reason: event.reason });
    const session = active;
    active = undefined;
    configGeneration++;
    session.lifetime.abort();
    session.input?.clear();
    session.connection?.stop();
    if (session.ctx.hasUI) session.ctx.ui.setStatus("pi-remote", undefined);
  });
}
