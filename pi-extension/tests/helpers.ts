import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";

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
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = new Inbox<WebSocket>();
  server.on("connection", (socket) => sockets.push(socket));
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  return { server, url: `ws://127.0.0.1:${address.port}/agent/ws`, sockets };
}

export async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
