import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import WebSocket from "ws";
import { Inbox } from "./helpers.ts";

test("development mock authenticates, registers, and routes stdin JSON", { timeout: 10000 }, async () => {
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const address = reserve.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const child = spawn(process.execPath, ["--experimental-transform-types", "dev/mock-server.ts", "--port", String(address.port), "--token", "private-bearer-token"], {
    cwd: dirname(fileURLToPath(new URL("../package.json", import.meta.url))), stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = new Inbox<string>();
  let pending = "";
  let output = "";
  child.stdout.on("data", (data) => {
    const text = data.toString(); output += text; pending += text;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) { lines.push(pending.slice(0, end)); pending = pending.slice(end + 1); }
  });
  const sockets: WebSocket[] = [];
  try {
    await lines.next((line) => line.includes("listening"));
    const unauthorized = new WebSocket(`ws://127.0.0.1:${address.port}/agent/ws`); sockets.push(unauthorized);
    const rejected = new Promise<void>((resolve) => unauthorized.once("error", () => resolve()));
    await rejected;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent/ws`, { headers: { Authorization: "Bearer private-bearer-token" } }); sockets.push(socket);
    await once(socket, "open");
    socket.send(JSON.stringify({ version: 1, type: "session.register", session_id: "mock-session", host_id: "laptop", cwd: "/tmp", name: null, pid: 123 }));
    await lines.next((line) => line.includes("session.register mock-session"));
    socket.send(JSON.stringify({ version: 1, type: "message.completed", session_id: "mock-session", role: "assistant", content: "private-bearer-token private conversation" }));
    await lines.next((line) => line.includes("message.completed"));
    assert.equal(output.includes("private-bearer-token"), false); assert.equal(output.includes("private conversation"), false);
    const received = once(socket, "message");
    child.stdin.write(`${JSON.stringify({ version: 1, type: "message.send", session_id: "mock-session", text: "remote input" })}\n`);
    const [data] = await received; assert.equal(JSON.parse(data.toString()).text, "remote input");
    child.stdin.write("/drop\n"); await once(socket, "close");
  } finally {
    for (const socket of sockets) socket.terminate();
    const exit = once(child, "exit"); child.kill("SIGTERM"); await exit;
  }
});
