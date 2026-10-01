import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import remoteExtension from "../extensions/pi-remote/index.ts";
import { saveConfig } from "../extensions/pi-remote/config.ts";
import type { OutgoingMessage } from "../extensions/pi-remote/protocol.ts";
import { MaskedTokenInput } from "../extensions/pi-remote/ui.ts";
import { closeServer, Inbox, localServer } from "./helpers.ts";

test("masked token component never renders plaintext, including pasted text", () => {
  let submitted: string | undefined;
  const input = new MaskedTokenInput((value) => { submitted = value; }, () => {});
  input.focused = true;
  input.handleInput("\x1b[200~super-secret-token\x1b[201~");
  for (const width of [1, 10, 80]) assert.equal(input.render(width).join("\n").includes("super-secret-token"), false);
  input.handleInput("\r"); assert.equal(submitted, "super-secret-token");
});

test("extension bridges live WS, follows lifecycle, rejects wrong sessions, and keeps busy until settled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-extension-"));
  const home = process.env.HOME;
  process.env.HOME = root;
  const { server, url, sockets } = await localServer();
  const messages = new Inbox<OutgoingMessage>();
  server.on("connection", (socket) => socket.on("message", (data) => messages.push(JSON.parse(data.toString()))));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const injected = new Inbox<{ text: string; options: unknown }>();
  const statuses: (string | undefined)[] = [];
  let sessionId = "authoritative-session-1";
  let idle = true;
  const ctx = {
    hasUI: true, mode: "tui", isIdle: () => idle,
    sessionManager: { getSessionId: () => sessionId, getCwd: () => "/session/cwd", getSessionName: () => "Session name" },
    ui: { notify() {}, setStatus: (_key: string, value: string | undefined) => statuses.push(value), theme: { fg: (_color: string, value: string) => value } },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
    registerCommand() {},
    sendUserMessage: (text: string, options: unknown) => injected.push({ text, options }),
  } as unknown as ExtensionAPI;
  const emit = async (type: string, fields: Record<string, unknown> = {}) => handlers.get(type)?.({ type, ...fields }, ctx);
  const next = (type: OutgoingMessage["type"]) => messages.next((message) => message.type === type);
  try {
    await saveConfig({ version: 1, url, host_id: "laptop", token: "private-bearer-token" });
    remoteExtension(pi);
    assert.equal(server.clients.size, 0, "factory must not open a socket");
    await emit("session_start", { reason: "startup" });
    const socket = await sockets.next();
    assert.deepEqual(await next("session.register"), { version: 1, type: "session.register", session_id: sessionId, host_id: "laptop", cwd: "/session/cwd", name: "Session name", pid: process.pid });
    assert.equal((await next("session.status") as { status: string }).status, "idle");
    assert.ok(statuses.includes("●"));

    socket.send(JSON.stringify({ version: 1, type: "message.send", session_id: "wrong", text: "should not inject" }));
    const error = await next("error"); assert.equal(error.type === "error" && error.code, "wrong_session");
    assert.equal(error.session_id, sessionId);
    socket.send("{"); assert.equal((await next("error") as { code: string }).code, "invalid_json");
    socket.send(JSON.stringify({ version: 1, type: "message.send", session_id: sessionId, text: "/literal-command" }));
    assert.deepEqual(await injected.next(), { text: "/literal-command", options: { deliverAs: "followUp", expandPromptTemplates: false } });

    idle = false; await emit("agent_start");
    assert.equal((await next("session.status") as { status: string }).status, "working");
    await emit("agent_end");
    socket.send(JSON.stringify({ version: 1, type: "message.send", session_id: sessionId, text: "queued follow-up" }));
    assert.deepEqual(await injected.next(), { text: "queued follow-up", options: { deliverAs: "followUp", expandPromptTemplates: false } });
    await emit("message_start", { message: { role: "assistant" } });
    await emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "hidden" } });
    await emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hello " } });
    assert.equal((await next("message.delta") as { delta: string }).delta, "hello ");
    await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "hello world" }] } });
    assert.equal((await next("message.completed") as { content: string }).content, "hello world");
    await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "user input" }] } });
    assert.equal((await next("message.completed") as { role: string }).role, "user");
    await emit("tool_execution_start", { toolCallId: "call1", toolName: "bash", args: { command: "true" } });
    assert.equal((await next("activity.started")).type, "activity.started");
    await emit("tool_execution_end", { toolCallId: "call1", toolName: "bash", isError: false, result: "not forwarded" });
    assert.equal((await next("activity.completed")).type, "activity.completed");
    assert.equal(handlers.has("tool_execution_update"), false);
    assert.equal(handlers.has("agent_end"), false);

    socket.terminate();
    const replacementSocket = await sockets.next();
    assert.equal((await next("session.register")).session_id, sessionId);
    assert.equal((await next("session.status") as { status: string }).status, "working", "agent_end must not mark idle");
    idle = true; await emit("agent_settled");
    assert.equal((await next("session.status") as { status: string }).status, "idle");
    await emit("session_info_changed", { name: undefined });
    assert.equal((await next("session.updated") as { name: unknown }).name, null);
    await emit("session_shutdown", { reason: "new" });
    assert.equal((await next("session.unregister") as { reason: string }).reason, "new");
    assert.equal(statuses.at(-1), undefined);
    sessionId = "authoritative-session-2";
    await emit("session_start", { reason: "new" });
    const newSocket = await sockets.next();
    assert.equal((await next("session.register")).session_id, sessionId);
    newSocket.send(JSON.stringify({ version: 1, type: "message.send", session_id: "authoritative-session-1", text: "stale input" }));
    assert.equal((await next("error") as { code: string }).code, "wrong_session");
    assert.notEqual(newSocket, replacementSocket);
  } finally {
    await emit("session_shutdown", { reason: "quit" });
    await closeServer(server);
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    await rm(root, { recursive: true, force: true });
  }
});
