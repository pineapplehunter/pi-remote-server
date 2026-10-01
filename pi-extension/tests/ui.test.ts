import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerRemoteCommands, showConnectionState } from "../extensions/pi-remote/ui.ts";

async function login(url: string, host: string, token: string, configure: () => void = () => assert.fail("Invalid input should not configure")): Promise<string[]> {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const notices: string[] = [];
  const answers = [url, host];
  const ctx = {
    mode: "tui", hasUI: true,
    ui: { input: async () => answers.shift(), custom: async () => token,
      notify: (message: string) => notices.push(message) },
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
    ["http://127.0.0.1:3000/agent/ws", "kpro-takata", secret, "HTTP(S) URLs are not WebSocket URLs"],
    ["pi.s.ihavenojob.work", "kpro-takata", secret, "Enter a full ws:// or wss:// URL"],
    ["ws://127.0.0.1:3000/agent/ws", "invalid host", secret, "Host ID must use"],
    ["ws://127.0.0.1:3000/agent/ws", "kpro-takata", `Bearer ${secret}`, "Paste only the token"],
  ];
  for (const [url, host, token, expected] of cases) {
    const notices = await login(url!, host!, token!);
    assert.equal(notices.length, 1);
    assert.ok(notices[0]!.includes(expected!));
    assert.equal(notices[0]!.includes(secret), false);
  }
});

test("remote-rename prompts offline and safely handles cancellation, blank input, and stale sessions", async () => {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const names: string[] = [];
  const notices: string[] = [];
  const answers = ["  Debug the failing tests  ", undefined, " \t "];
  const lifetime = new AbortController();
  const pi = {
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => { commands.set(name, command); },
    setSessionName: (name: string) => { names.push(name); },
  } as ExtensionAPI;
  registerRemoteCommands(pi, {
    snapshot: () => ({ state: "disabled", signal: lifetime.signal }),
    configure: () => assert.fail("Renaming must not require a remote connection"),
  });
  assert.deepEqual([...commands.keys()], ["remote-rename", "remote-login", "remote-status"]);
  const ctx = {
    hasUI: true, sessionManager: { getSessionName: () => "Current name" },
    ui: { notify: (message: string) => notices.push(message),
      input: async (title: string, placeholder: string, options: { signal: AbortSignal }) => {
        assert.equal(title, "Rename session"); assert.equal(placeholder, "Current name");
        assert.equal(options.signal, lifetime.signal); return answers.shift();
      } },
  } as unknown as ExtensionCommandContext;
  const rename = commands.get("remote-rename")!.handler;
  await rename("", ctx);
  assert.deepEqual(names, ["Debug the failing tests"]);
  assert.deepEqual(notices, ["Session renamed."]);
  await rename("", ctx); await rename("", ctx);
  assert.equal(names.length, 1);
  await rename("", { hasUI: false } as ExtensionCommandContext);
  assert.equal(names.length, 1);
  ctx.ui.input = async () => { lifetime.abort(); return "Wrong session"; };
  await rename("", ctx);
  assert.equal(names.length, 1);
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
    const notices = await login("ws://127.0.0.1:3000/agent/ws", "kpro-takata", secret,
      () => { throw new Error(`Authorization: Bearer ${secret}`); });
    assert.equal(notices[0], "Could not configure the remote connection. No credential details were logged.");
    assert.equal(JSON.stringify(notices).includes(secret), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
