import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
export const agentHostHeader = "X-Pi-Remote-Host";

mkdirSync(".cache", { recursive: true });
const binary = process.env.PI_REMOTE_SERVER_BINARY ?? `${process.cwd()}/.cache/pi-remote-server`;
if (!process.env.PI_REMOTE_SERVER_BINARY) {
  const build = Bun.spawnSync(["go", "build", "-o", binary, "."]);
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
}

export interface Event { type: string; [key: string]: any }
export class Client {
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;
  readonly events: Event[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(url: string, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(url, { headers });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("WebSocket open failed")), { once: true });
    });
    this.closed = new Promise(resolve => this.socket.addEventListener("close", () => resolve(), { once: true }));
    this.socket.addEventListener("message", event => {
      this.events.push(JSON.parse(String(event.data)));
      for (const listener of this.listeners) listener();
    });
  }
  send(message: object | string) { this.socket.send(typeof message === "string" ? message : JSON.stringify(message)); }
  async take(type: string, predicate: (event: Event) => boolean = () => true): Promise<Event> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = this.events.findIndex(event => event.type === type && predicate(event));
        if (index < 0) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(this.events.splice(index, 1)[0]!);
      };
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(`Timed out waiting for ${type}`)); }, 2000);
      this.listeners.add(check);
      check();
    });
  }
}
export async function harness(publicOrigin?: string) {
  // Reserve an ephemeral port, then hand it to the real Go process.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const base = `http://127.0.0.1:${reservation.port}`;
  reservation.stop(true);
  const dir = mkdtempSync(join(tmpdir(), "pi-go-test-"));
  const socket = join(dir, "agent.sock");
  const env: Record<string, string | undefined> = {
    ...process.env, HOST: "127.0.0.1", PORT: new URL(base).port, PI_REMOTE_TICKET_SOCKET: socket,
    PI_REMOTE_DB: join(dir, "hosts.sqlite"),
  };
  delete env.PUBLIC_ORIGIN;
  if (publicOrigin) env.PUBLIC_ORIGIN = publicOrigin;
  const child = Bun.spawn([binary], { env, stdout: "ignore", stderr: "pipe" });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await Bun.sleep(10);
  }
  if (!ready) { child.kill(); rmSync(dir, { recursive: true }); throw new Error(`Go gateway did not start: ${await new Response(child.stderr).text()}`); }
  const wsBase = base.replace("http:", "ws:");
  const clients: Client[] = [];
  const agentURL = `ws+unix://${socket}:/agent/ws`;
  const agentHTTP = (path: string) => fetch(`http://localhost${path}`, { unix: socket });
  const hosts = new Map<string, { id: string; key: string }>();
  function keypair() {
    const file = join(dir, randomUUID());
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", file]);
    return { file, pub: readFileSync(file + ".pub", "utf8").trim() };
  }
  function sign(file: string, namespace: string, ...lines: string[]) {
    return execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-n", namespace, "-f", file],
      { input: [namespace, ...lines, ""].join("\n"), encoding: "utf8" });
  }
  async function post(path: string, body: object) {
    const res = await fetch(`http://localhost/agent/${path}`, { unix: socket, method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Agent ${path}: HTTP ${res.status}`);
    return await res.json() as Record<string, string>;
  }
  async function agent(host = "laptop") {
    let enrolled = hosts.get(host);
    if (!enrolled) {
      const key = keypair();
      const admin = await fetch(`${base}/admin/hosts`, { method: "POST", redirect: "manual",
        headers: { Origin: publicOrigin ?? base },
        body: new URLSearchParams({ action: "add", name: host, key: key.pub }),
      });
      if (admin.status !== 303) throw new Error(`Host enrollment: HTTP ${admin.status}`);
      const list = await fetch(`${base}/admin/hosts`);
      const id = (await list.text()).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g)?.find(id => ![...hosts.values()].some(h => h.id === id));
      if (!id) throw new Error("Missing enrollment ID");
      enrolled = { id, key: key.file };
      hosts.set(host, enrolled);
    }
    const ephemeral = keypair(), params = {host_id: enrolled.id, agent_key: ephemeral.pub};
    const challenge = (await post("challenge", params)).challenge!;
    const signature = sign(enrolled.key, "pi-remote-host-v1", enrolled.id, ephemeral.pub, challenge);
    const {ticket} = await post("ticket", {...params, challenge, signature});
    const client = new Client(agentURL, {Authorization: `Bearer ${ticket}`});
    clients.push(client);
    await client.opened;
    const proof = await client.take("auth.challenge");
    client.send({type: "auth.proof", signature: sign(ephemeral.file, "pi-remote-agent-v1", proof.challenge)});
    await client.take("auth.ok");
    return client;
  }
  async function browser() {
    const client = new Client(`${wsBase}/ws`, { Origin: publicOrigin ?? base });
    clients.push(client);
    await client.opened;
    await client.take("sessions.snapshot");
    return client;
  }
  async function sessions(): Promise<Event[]> {
    const client = new Client(`${wsBase}/ws`, { Origin: publicOrigin ?? base });
    await client.opened;
    const snapshot = await client.take("sessions.snapshot");
    client.socket.close();
    return snapshot.sessions;
  }
  return { base, wsBase, agent, agentHTTP, browser, sessions, hostID: (name: string) => hosts.get(name)?.id, stop() { for (const client of clients) client.socket.close(); child.kill("SIGTERM"); void child.exited.then(() => rmSync(dir, { recursive: true, force: true })); } };
}
export function register(agent: Client, fields: object = {}) {
  agent.send({ version: 1, type: "session.register", session_id: "s1", cwd: "/work", name: "Test session", pid: 123, ...fields });
}
