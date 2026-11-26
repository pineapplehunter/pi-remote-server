import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerRemoteCommands, showConnectionState } from "../extensions/pi-remote/ui.ts";

test("only remote-status is needed for host-managed connections", () => {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  registerRemoteCommands({
    registerCommand: (name, command) => { commands.set(name, command); },
  } as ExtensionAPI, {
    snapshot: () => ({ state: "disabled" }),
  });
  assert.deepEqual([...commands.keys()], ["remote-status"]);
});

test("connection indicator is only a colored dot and hidden when disabled", () => {
  const values: (string | undefined)[] = [];
  const ctx = { hasUI: true, ui: {
    theme: { fg: (color: string, text: string) => `${color}:${text}` },
    setStatus: (key: string, text: string | undefined) => { assert.equal(key, "pi-remote"); values.push(text); },
  } } as unknown as ExtensionContext;
  for (const state of ["connected", "connecting", "disconnected", "auth_failed", "disabled"] as const) showConnectionState(ctx, state);
  assert.deepEqual(values, ["success:●", "warning:●", "dim:●", "error:●", undefined]);
});
