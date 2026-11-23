import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerRemoteCommands, showConnectionState } from "../extensions/pi-remote/ui.ts";

async function login(url: string, configure: () => void = () => assert.fail("Invalid input should not configure")): Promise<string[]> {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const notices: string[] = [];
  const ctx = {
    mode: "tui", hasUI: true,
    ui: { input: async () => url, notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;
  registerRemoteCommands({ registerCommand: (name, command) => { commands.set(name, command); } } as ExtensionAPI, {
    snapshot: () => ({ state: "disabled", signal: new AbortController().signal }), configure,
  });
  await commands.get("remote-login")!.handler("", ctx);
  return notices;
}

test("login identifies the rejected field without echoing credentials or invalid input", async () => {
  const secret = "secret-not-to-print";
  const cases = [
    ["http://127.0.0.1:3000/agent/ws", "Use a wss:// server URL"],
    ["pi-agent.s.ihavenojob.work", "Enter a full wss:// URL"],
    [`wss://user:${secret}@example.test/agent/ws`, "must not contain credentials"],
  ] as const;
  for (const [url, expected] of cases) {
    const notices = await login(url);
    assert.equal(notices.length, 1);
    assert.ok(notices[0]!.includes(expected!));
    assert.equal(notices[0]!.includes(secret), false);
  }
});

test("remote commands only register login and status", () => {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  registerRemoteCommands({
    registerCommand: (name, command) => { commands.set(name, command); },
  } as ExtensionAPI, {
    snapshot: () => ({ state: "disabled" }),
    configure: () => {},
  });
  assert.deepEqual([...commands.keys()], ["remote-login", "remote-status"]);
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

test("unexpected connection errors stay generic and cannot expose credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-ui-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const secret = "secret-not-to-print";
  try {
    const notices = await login("wss://127.0.0.1:3000/agent/ws", () => { throw new Error(secret); });
    assert.equal(notices[0], "Could not configure the remote connection. No credential details were logged.");
    assert.equal(JSON.stringify(notices).includes(secret), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
