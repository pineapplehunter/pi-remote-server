import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    // Bun accepts a headers options object; jsdom's DOM typings describe only browser protocols.
    const ClientWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    this.socket = new ClientWebSocket(url, { headers });
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
  const tokenFile = join(dir, "agents.json");
  writeFileSync(tokenFile, JSON.stringify([{ host_id: "laptop", token: "test-secret" }, { host_id: "gpu01", token: "gpu-secret" }]), { mode: 0o600 });
  const env: Record<string, string | undefined> = { ...process.env, HOST: "127.0.0.1", PORT: new URL(base).port, PI_REMOTE_TOKEN_FILE: tokenFile };
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
  async function agent(token = "test-secret") {
    const client = new Client(`${wsBase}/agent/ws`, { Authorization: `Bearer ${token}` });
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
  return { base, wsBase, agent, browser, sessions, stop() { for (const client of clients) client.socket.close(); child.kill("SIGTERM"); rmSync(dir, { recursive: true }); } };
}
export function register(agent: Client, fields: object = {}) {
  agent.send({ version: 1, type: "session.register", session_id: "s1", host_id: "laptop", cwd: "/work", name: "Test session", pid: 123, ...fields });
}
