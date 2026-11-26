import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setDefaultCACertificates } from "node:tls";
import { after } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { mockProof } from "../dev/mock-proof.ts";

let fixture: { ca: string; key: string; cert: string } | undefined;
let fixtureDirectory: string | undefined;
after(() => { if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true }); });
export function tlsFixtures() {
  if (fixture) return fixture;
  const directory = fixtureDirectory = mkdtempSync(join(tmpdir(), "pi-remote-tls-"));
  const file = (name: string) => join(directory, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  const keyArgs = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc"];
  openssl("req", "-new", "-x509", ...keyArgs, "-subj", "/CN=Pi Test Root", "-days", "5",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:1", "-addext", "keyUsage=critical,keyCertSign",
    "-keyout", "root.key", "-out", "root.pem");
  openssl("req", "-new", ...keyArgs, "-subj", "/CN=localhost", "-keyout", "server.key", "-out", "server.csr");
  writeFileSync(file("server.ext"), "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n");
  openssl("x509", "-req", "-in", "server.csr", "-CA", "root.pem", "-CAkey", "root.key", "-extfile", "server.ext", "-days", "3", "-out", "server.pem");
  mkdirSync(file("bin"));
  writeFileSync(file("bin/pi-remote-request-ticket"), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--ws-url') { console.log(fs.readFileSync(${JSON.stringify(file("endpoint"))}, 'utf8')); process.exit(0); }
const pub = fs.readFileSync(0, 'utf8').trimEnd();
if (!/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(pub) || process.env.SSH_AUTH_SOCK) process.exit(1);
const ticket = require('node:crypto').randomBytes(32).toString('base64url');
fs.writeFileSync(require('node:path').join(${JSON.stringify(directory)},ticket), pub);
console.log(ticket);
`, { mode: 0o700 });
  process.env.PATH = `${file("bin")}${delimiter}${process.env.PATH ?? ""}`;
  fixture = { ca: file("root.pem"), cert: file("server.pem"), key: file("server.key") };
  setDefaultCACertificates([readFileSync(fixture.ca, "utf8")]);
  return fixture;
}

export function testHttps() {
  const {cert, key} = tlsFixtures();
  return createServer({ cert: readFileSync(cert), key: readFileSync(key) });
}

export function hostEndpoint(url: string) { writeFileSync(join(fixtureDirectory!, "endpoint"), url); }

export function ticketPub(ticket: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw Error("Invalid fixture ticket");
  return readFileSync(join(fixtureDirectory!, ticket), "utf8");
}

/** Event-driven inbox with bounded waits; tests never need a model or external service. */
export class Inbox<T> {
  private values: T[] = [];
  private waiters: { predicate: (value: T) => boolean; resolve: (value: T) => void }[] = [];
  push(value: T): void {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(value));
    if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(value);
    else this.values.push(value);
  }
  next(predicate: (value: T) => boolean = () => true): Promise<T> {
    const index = this.values.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.values.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error("Timed out waiting for test event"));
      }, 3000);
      const waiter = { predicate, resolve: (value: T) => { clearTimeout(timer); resolve(value); } };
      this.waiters.push(waiter);
    });
  }
}

export async function localServer(prove = true): Promise<{ server: WebSocketServer; url: string; sockets: Inbox<WebSocket> }> {
  const https = testHttps();
  const server = new WebSocketServer({ server: https });
  const sockets = new Inbox<WebSocket>();
  server.on("connection", (socket, req) => {
    if (!prove) { sockets.push(socket); return; }
    const ticket = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!ticket) { socket.terminate(); return; }
    mockProof(socket, ticketPub(ticket), () => sockets.push(socket));
  });
  server.once("close", () => https.close());
  https.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const url = `wss://127.0.0.1:${address.port}/agent/ws`;
  hostEndpoint(url);
  return { server, url, sockets };
}

export async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
