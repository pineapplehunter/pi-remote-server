import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setDefaultCACertificates } from "node:tls";
import { after } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { processKey, requestIdentity } from "../extensions/pi-remote/identity.ts";

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
  const issuerProfile = "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign\n";
  const serverProfile = "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n";
  for (const [id, profile] of [["issuer", issuerProfile], ["server", serverProfile]] as const) {
    openssl("req", "-new", ...keyArgs, "-subj", `/CN=${id}`, "-keyout", `${id}.key`, "-out", `${id}.csr`);
    writeFileSync(file(`${id}.ext`), profile);
    openssl("x509", "-req", "-in", `${id}.csr`, "-CA", "root.pem", "-CAkey", "root.key",
      "-extfile", `${id}.ext`, "-days", "3", "-out", `${id}.pem`);
  }
  writeFileSync(file("leaf.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
  mkdirSync(file("bin"));
  writeFileSync(file("bin/pi-remote-issue-certificate"), `#!${process.execPath}
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const leafPEM = execFileSync('openssl', ['x509','-req','-CA','issuer.pem','-CAkey','issuer.key','-extfile','leaf.ext','-days','1'],
  {cwd:${JSON.stringify(directory)},input:readFileSync(0),encoding:'utf8'});
process.stdout.write(JSON.stringify({leafPEM,intermediatePEM:readFileSync(${JSON.stringify(file("issuer.pem"))},'utf8')}));
`, { mode: 0o700 });
  process.env.PATH = `${file("bin")}${delimiter}${process.env.PATH ?? ""}`;
  fixture = { ca: file("root.pem"), cert: file("server.pem"), key: file("server.key") };
  setDefaultCACertificates([readFileSync(fixture.ca, "utf8")]);
  return fixture;
}

export function testHttps() {
  const {ca, cert, key} = tlsFixtures();
  return createServer({ca: readFileSync(ca), cert: readFileSync(cert), key: readFileSync(key), requestCert: true, rejectUnauthorized: true});
}

export function clientIdentity() {
  tlsFixtures();
  return requestIdentity(processKey(), new AbortController().signal);
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

export async function localServer(): Promise<{ server: WebSocketServer; url: string; sockets: Inbox<WebSocket> }> {
  const https = testHttps();
  const server = new WebSocketServer({ server: https });
  const sockets = new Inbox<WebSocket>();
  server.on("connection", (socket) => sockets.push(socket));
  server.once("close", () => https.close());
  https.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  return { server, url: `wss://127.0.0.1:${address.port}/agent/ws`, sockets };
}

export async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
