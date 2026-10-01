import { Credentials } from "../src/auth.ts";
import { startServer } from "../src/server.ts";

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
export function harness(publicOrigin?: string) {
  const credentials = new Credentials([{ host_id: "laptop", token: "test-secret" }, { host_id: "gpu01", token: "gpu-secret" }]);
  const gateway = startServer({ host: "127.0.0.1", port: 0, tokenFile: "unused", publicOrigin }, credentials);
  const base = `http://127.0.0.1:${gateway.server.port}`;
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
  return { ...gateway, base, wsBase, agent, browser, stop() { for (const client of clients) client.socket.close(); gateway.server.stop(true); } };
}
export function register(agent: Client, fields: object = {}) {
  agent.send({ version: 1, type: "session.register", session_id: "s1", host_id: "laptop", cwd: "/work", name: "Test session", pid: 123, ...fields });
}
