import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConnectionState } from "./connection.ts";

export function showConnectionState(ctx: ExtensionContext, state: ConnectionState): void {
  if (!ctx.hasUI) return;
  const colors = {
    connecting: "warning", connected: "success", disconnected: "dim", auth_failed: "error", issuer_failed: "error",
  } as const;
  ctx.ui.setStatus("pi-remote", state === "disabled" ? undefined : ctx.ui.theme.fg(colors[state], "●"));
}

export interface RemoteControls {
  snapshot(): { endpoint?: string; state: ConnectionState; sessionId?: string };
}

export function registerRemoteCommands(pi: ExtensionAPI, controls: RemoteControls): void {
  pi.registerCommand("remote-status", {
    description: "Show remote connection status without exposing credentials",
    handler: async (_args, ctx) => {
      const { endpoint, state, sessionId } = controls.snapshot();
      if (!ctx.hasUI) return;
      ctx.ui.notify([
        `Remote: ${state}`,
        ...(endpoint ? [`Server: ${endpoint}`] : []),
        `Session: ${sessionId ?? "none"}`,
        ...(state === "issuer_failed" ? ["Check ssh-keygen, pi-remote-request-ticket, and the host ticket service."] : []),
        ...(state === "auth_failed" ? ["Check the agent endpoint and whether this host is enabled on the gateway."] : []),
      ].join("\n"), "info");
    },
  });

}
