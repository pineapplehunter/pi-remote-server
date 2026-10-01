import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { configPath, DEFAULT_URL, RemoteConfigError, saveConfig, validateConfig, type RemoteConfig } from "./config.ts";
import type { ConnectionState } from "./connection.ts";

export function showConnectionState(ctx: ExtensionContext, state: ConnectionState): void {
  if (!ctx.hasUI) return;
  const colors = {
    connecting: "warning", connected: "success", disconnected: "dim", auth_failed: "error",
  } as const;
  ctx.ui.setStatus("pi-remote", state === "disabled" ? undefined : ctx.ui.theme.fg(colors[state], "●"));
}

/** Input owns editing/paste; this component never renders its plaintext value. */
export class MaskedTokenInput implements Component, Focusable {
  private readonly input = new Input();
  constructor(done: (value: string | undefined) => void, private readonly redraw: () => void) {
    this.input.onSubmit = (value) => done(value);
    this.input.onEscape = () => done(undefined);
  }
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  handleInput(data: string): void { this.input.handleInput(data); this.redraw(); }
  invalidate(): void {}
  render(width: number): string[] {
    const count = Math.min(this.input.getValue().length, Math.max(0, width - 3));
    return [
      truncateToWidth("Remote bearer token", width),
      truncateToWidth(`> ${"•".repeat(count)}${this.focused ? CURSOR_MARKER : ""}`, width),
      truncateToWidth("Enter saves · Escape cancels", width),
    ];
  }
}

export interface RemoteControls {
  snapshot(): { config?: RemoteConfig; state: ConnectionState; sessionId?: string; signal?: AbortSignal };
  configure(config: RemoteConfig | undefined): void;
}

export function registerRemoteCommands(pi: ExtensionAPI, controls: RemoteControls): void {
  pi.registerCommand("remote-login", {
    description: "Configure remote WebSocket server, host ID, and bearer token",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Run /remote-login in interactive Pi to enter a masked token.", "warning");
        return;
      }
      const { config, signal } = controls.snapshot();
      if (!signal || signal.aborted) return;
      const url = await ctx.ui.input("Remote WebSocket URL", config?.url ?? DEFAULT_URL, { signal });
      if (url === undefined || signal.aborted) return;
      const suggestedHost = config?.host_id ?? (hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128) || "workstation");
      const host = await ctx.ui.input("Stable remote host ID", suggestedHost, { signal });
      if (host === undefined || signal.aborted) return;
      let token: string | undefined;
      if (config && await ctx.ui.confirm("Remote token", "Keep the existing saved token?", { signal })) token = config.token;
      if (signal.aborted) return;
      if (token === undefined) {
        token = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
          const abort = () => done(undefined);
          signal.addEventListener("abort", abort, { once: true });
          const input = new MaskedTokenInput(done, () => tui.requestRender());
          return Object.assign(input, { dispose: () => signal.removeEventListener("abort", abort) });
        });
      }
      if (token === undefined || signal.aborted) return;
      try {
        const next = validateConfig({ version: 1, url: url.trim() || config?.url || DEFAULT_URL,
          host_id: host.trim() || suggestedHost, token });
        await saveConfig(next);
        if (signal.aborted) return;
        controls.configure(next);
        ctx.ui.notify("Remote credentials saved. Connecting in the background.", "info");
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
        ...(config ? [`Server: ${config.url}`, `Host: ${config.host_id}`] : ["Run /remote-login to configure."]),
        `Session: ${sessionId ?? "none"}`,
        `Credentials: ${configPath()}`,
      ].join("\n"), "info");
    },
  });

}
