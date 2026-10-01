import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { saveConfig } from "../extensions/pi-remote/config.ts";
import type { OutgoingMessage } from "../extensions/pi-remote/protocol.ts";
import { closeServer, Inbox, localServer } from "./helpers.ts";

// The real Pi SDK loads the TS extension with jiti and runs its actual user/agent/tool lifecycle.
// Only model streaming is synthetic; no provider request, real credential, or user session is used.
test("real Pi loads extension and accepts idle/busy WS messages as normal user input", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-sdk-"));
  const home = process.env.HOME;
  process.env.HOME = root;
  const { server, url, sockets } = await localServer();
  const messages = new Inbox<OutgoingMessage>();
  server.on("connection", (socket) => socket.on("message", (data) => messages.push(JSON.parse(data.toString()))));
  const next = (type: OutgoingMessage["type"]) => messages.next((message) => message.type === type);
  // Discover the repository root exactly as settings.json packages does.
  const settings = SettingsManager.inMemory({ packages: [fileURLToPath(new URL("../../", import.meta.url))], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: join(root, ".pi", "agent"), settingsManager: settings,
    noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  try {
    await saveConfig({ version: 1, url, host_id: "sdk-test", token: "private-bearer-token" });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
    await modelRuntime.setRuntimeApiKey("openai", "not-a-real-provider-key");
    const model: Model<"openai-completions"> = {
      id: "remote-test-model", name: "Remote test model", provider: "openai", api: "openai-completions",
      baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024,
    };
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, ".pi", "agent"), model,
      modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager: settings, tools: ["bash"], thinkingLevel: "off" }));
    let calls = 0;
    session.agent.streamFunction = (activeModel) => {
      const stream = createAssistantMessageEventStream();
      const call = ++calls;
      const text = call === 1 ? "Running tool." : call === 2 ? "Hello from the remote client." : "Follow-up received.";
      const message: AssistantMessage = {
        role: "assistant", content: [], api: activeModel.api, provider: activeModel.provider, model: activeModel.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: call === 1 ? "toolUse" : "stop", timestamp: Date.now(),
      };
      void (async () => {
        stream.push({ type: "start", partial: message });
        if (call === 1) await firstGate;
        message.content = [{ type: "text", text }];
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        if (call === 1) message.content.push({ type: "toolCall", id: "remote-test-call", name: "bash", arguments: { command: "printf remote-smoke" } });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      })();
      return stream;
    };
    const queue = new Inbox<readonly string[]>();
    session.subscribe((event) => { if (event.type === "queue_update") queue.push(event.followUp); });
    let renamePrompted = false;
    await session.bindExtensions({ mode: "rpc", uiContext: {
      input: async (title: string) => { assert.equal(title, "Rename session"); renamePrompted = true; return "  Renamed SDK session  "; },
      notify() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text },
    } as unknown as ExtensionUIContext });
    const socket = await sockets.next();
    const registration = await next("session.register");
    assert.equal(registration.session_id, session.sessionManager.getSessionId());
    await next("session.status");
    await session.prompt("/remote-rename");
    assert.equal(renamePrompted, true);
    assert.equal(session.sessionManager.getSessionName(), "Renamed SDK session");
    assert.deepEqual(await next("session.updated"), { version: 1, type: "session.updated",
      session_id: registration.session_id, name: "Renamed SDK session" });
    assert.equal(calls, 0, "Renaming must not trigger a model request");
    socket.send(JSON.stringify({ version: 1, type: "message.send", session_id: registration.session_id, text: "Say hello from the remote client" }));
    const status = await next("session.status"); assert.equal(status.type === "session.status" && status.status, "working");
    socket.send(JSON.stringify({ version: 1, type: "message.send", session_id: registration.session_id, text: "Now do the follow-up" }));
    assert.deepEqual(await queue.next((items) => items.length > 0), ["Now do the follow-up"]);
    releaseFirst();
    await next("activity.started"); await next("activity.completed");
    await next("message.delta");
    await messages.next((message) => message.type === "session.status" && message.status === "idle");
    const users = session.messages.filter((message) => message.role === "user");
    assert.equal(users.length, 2);
    assert.ok(JSON.stringify(users).includes("Say hello from the remote client"));
    assert.ok(JSON.stringify(users).includes("Now do the follow-up"));
    assert.equal(calls, 3);
    assert.equal(session.getLastAssistantText(), "Follow-up received.");
    // A provider's failed AssistantMessage reaches message_end on the real Pi lifecycle.
    session.agent.streamFunction = (activeModel) => {
      const stream = createAssistantMessageEventStream();
      const error: AssistantMessage = { role: "assistant", content: [], api: activeModel.api, provider: activeModel.provider, model: activeModel.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit. private-bearer-token", timestamp: Date.now() };
      stream.push({ type: "error", reason: "error", error }); stream.end();
      return stream;
    };
    await session.prompt("Demonstrate quota reporting");
    const limit = await messages.next(message => message.type === "error" && message.code === "usage_limit_reached");
    assert.equal(limit.type, "error");
    if (limit.type === "error") { assert.match(limit.message, /ChatGPT usage limit/); assert.ok(!limit.message.includes("private-bearer-token")); }
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal((await next("session.unregister")).session_id, registration.session_id);
  } finally {
    releaseFirst();
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await closeServer(server);
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    await rm(root, { recursive: true, force: true });
  }
});
