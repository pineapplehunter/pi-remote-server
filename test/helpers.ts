import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { testPKI } from "./fixtures/pki.ts";

const pki = testPKI();
export const clientCertHeader = "X-Pi-Remote-Client-Cert";

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
export async function harness(publicOrigin?: string, revoked_hosts: string[] = []) {
  // Reserve an ephemeral port, then hand it to the real Go process.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const base = `http://127.0.0.1:${reservation.port}`;
  reservation.stop(true);
  const dir = mkdtempSync(join(tmpdir(), "pi-go-test-"));
  const socket = join(dir, "agent.sock");
  const root = join(dir, "root.pem");
  const enrollments = join(dir, "enrollments.json");
  writeFileSync(root, pki.root);
  writeFileSync(enrollments, JSON.stringify({ hosts: ["laptop", "gpu01"].map((host_id) => ({
    host_id, intermediate: pki.hosts[host_id as "laptop" | "gpu01"].intermediate,
  })), revoked_hosts }));
  const env: Record<string, string | undefined> = {
    ...process.env, HOST: "127.0.0.1", PORT: new URL(base).port, PI_REMOTE_AGENT_SOCKET: socket,
    PI_REMOTE_ROOT_CA_FILE: root, PI_REMOTE_ENROLLMENTS_FILE: enrollments,
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
  const agentCert = (host: keyof typeof pki.hosts) => pki.hosts[host].leaf;
  const agentHTTP = (path: string, headers?: HeadersInit) => fetch(`http://localhost${path}`, { unix: socket, headers });
  async function agent(host: keyof typeof pki.hosts = "laptop") {
    const client = new Client(agentURL, { [clientCertHeader]: agentCert(host) });
    clients.push(client);
    await client.opened;
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
  return { base, wsBase, agent, agentURL, agentHTTP, agentCert, browser, sessions, stop() { for (const client of clients) client.socket.close(); child.kill("SIGTERM"); void child.exited.then(() => rmSync(dir, { recursive: true, force: true })); } };
}
export function register(agent: Client, fields: object = {}) {
  agent.send({ version: 1, type: "session.register", session_id: "s1", cwd: "/work", name: "Test session", pid: 123, ...fields });
}
