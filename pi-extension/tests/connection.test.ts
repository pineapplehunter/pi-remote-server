import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Backoff, RemoteConnection, type ConnectionState } from "../extensions/pi-remote/connection.ts";
import { closeServer, Inbox, localServer } from "./helpers.ts";

test("backoff follows 1/2/5/10/30 seconds and resets", () => {
  const backoff = new Backoff();
  assert.deepEqual(Array.from({ length: 7 }, () => backoff.next()), [1000, 2000, 5000, 10000, 30000, 30000, 30000]);
  backoff.reset(); assert.equal(backoff.next(), 1000);
});

test("auth header, reconnect, binary handling, and stop cleanup", async () => {
  const { server, url, sockets } = await localServer();
  const states = new Inbox<ConnectionState>();
  const input = new Inbox<string>();
  let opens = 0;
  let binaries = 0;
  server.on("connection", (_socket, request) => {
    assert.equal(request.headers.authorization, "Bearer test");
    assert.equal(request.url, "/agent/ws");
  });
  const connection = new RemoteConnection({ version: 1, url, host_id: "laptop", token: "test" }, {
    onOpen: () => { opens++; }, onMessage: (raw) => input.push(raw),
    onBinary: () => { binaries++; }, onState: (state) => states.push(state),
  }, { reconnectDelays: [20, 30], heartbeatMs: 100 });
  try {
    assert.equal(connection.send({ version: 1, type: "session.status", session_id: "id", status: "idle" }), false);
    connection.start(); connection.start();
    const first = await sockets.next(); await states.next((state) => state === "connected");
    first.send("hello"); assert.equal(await input.next(), "hello");
    first.send(Buffer.from("binary")); first.send("after binary");
    assert.equal(await input.next(), "after binary"); assert.equal(binaries, 1);
    first.terminate(); await states.next((state) => state === "disconnected");
    await sockets.next(); await states.next((state) => state === "connected");
    assert.equal(opens, 2);
    connection.stop(); connection.stop(); connection.start();
    await delay(80); assert.equal(opens, 2);
  } finally { connection.stop(); await closeServer(server); }
});

test("HTTP authentication failure is detectable and retry timer is cancelled", async () => {
  const server = createServer();
  let upgrades = 0;
  server.on("upgrade", (_request, socket) => {
    upgrades++; socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const states = new Inbox<ConnectionState>();
  const connection = new RemoteConnection({ version: 1, url: `ws://127.0.0.1:${address.port}`, host_id: "laptop", token: "test" }, {
    onOpen() {}, onMessage() {}, onBinary() {}, onState: (state) => states.push(state),
  }, { reconnectDelays: [50] });
  try {
    connection.start(); await states.next((state) => state === "auth_failed");
    connection.stop(); await delay(100); assert.equal(upgrades, 1);
  } finally { connection.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("callback failures cannot escape a network event", async () => {
  const { server, url, sockets } = await localServer();
  const connection = new RemoteConnection({ version: 1, url, host_id: "laptop", token: "test" }, {
    onOpen() { throw new Error("callback"); }, onMessage() { throw new Error("callback"); },
    onBinary() { throw new Error("callback"); }, onState() { throw new Error("callback"); },
  });
  try { connection.start(); const socket = await sockets.next(); socket.send("payload"); await delay(20); }
  finally { connection.stop(); await closeServer(server); }
});
