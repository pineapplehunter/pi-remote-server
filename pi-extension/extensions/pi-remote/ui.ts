import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, DEFAULT_URL, RemoteConfigError, saveConfig, validateConfig, type RemoteConfig } from "./config.ts";
import type { ConnectionState } from "./connection.ts";

export function showConnectionState(ctx: ExtensionContext, state: ConnectionState): void {
  if (!ctx.hasUI) return;
  const colors = {
    connecting: "warning", connected: "success", disconnected: "dim", auth_failed: "error", issuer_failed: "error",
  } as const;
  ctx.ui.setStatus("pi-remote", state === "disabled" ? undefined : ctx.ui.theme.fg(colors[state], "●"));
}

export interface RemoteControls {
  snapshot(): { config?: RemoteConfig; state: ConnectionState; sessionId?: string; signal?: AbortSignal };
  configure(config: RemoteConfig | undefined): void;
}

export function registerRemoteCommands(pi: ExtensionAPI, controls: RemoteControls): void {
  pi.registerCommand("remote-login", {
    description: "Configure remote agent WebSocket endpoint",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Run /remote-login in interactive Pi to configure the endpoint.", "warning");
        return;
      }
      const { config, signal } = controls.snapshot();
      if (!signal || signal.aborted) return;
      const url = await ctx.ui.input("Remote WebSocket URL", config?.url ?? DEFAULT_URL, { signal });
      if (url === undefined || signal.aborted) return;
      try {
        const next = validateConfig({ version: 2, url: url.trim() || config?.url || DEFAULT_URL });
        await saveConfig(next);
        if (signal.aborted) return;
        controls.configure(next);
        ctx.ui.notify("Remote endpoint saved. Connecting in the background.", "info");
      } catch (error) {
        if (!signal.aborted) ctx.ui.notify(error instanceof RemoteConfigError
          ? error.message
          : "Could not configure the remote connection. No credential details were logged.", "error");
      }
    },
  });

  pi.registerCommand("remote-status", {
    description: "Show remote connection status without exposing credentials",
    handler: async (_args, ctx) => {
      const { config, state, sessionId } = controls.snapshot();
      if (!ctx.hasUI) return;
      ctx.ui.notify([
        `Remote: ${state}`,
        ...(config ? [`Server: ${config.url}`] : ["Run /remote-login to configure."]),
        `Session: ${sessionId ?? "none"}`,
        `Config: ${configPath()}`,
        ...(state === "issuer_failed" ? ["Check ssh-keygen, pi-remote-request-ticket, and the host ticket service."] : []),
        ...(state === "auth_failed" ? ["Check the agent endpoint and whether this host is enabled on the gateway."] : []),
      ].join("\n"), "info");
    },
  });

}
