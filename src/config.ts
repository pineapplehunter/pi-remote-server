import { z } from "zod";

const schema = z.object({
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PI_REMOTE_TOKEN_FILE: z.string().trim().min(1),
  PUBLIC_ORIGIN: z.string().optional(),
});

export interface Config {
  host: string;
  port: number;
  tokenFile: string;
  publicOrigin?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error("Invalid configuration: set PI_REMOTE_TOKEN_FILE and valid HOST/PORT.");
  const value = parsed.data;
  let publicOrigin: string | undefined;
  if (value.PUBLIC_ORIGIN !== undefined) {
    let url: URL;
    try { url = new URL(value.PUBLIC_ORIGIN); } catch { throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a path, credentials, query or fragment.");
    }
    publicOrigin = url.origin;
  }
  return { host: value.HOST, port: value.PORT, tokenFile: value.PI_REMOTE_TOKEN_FILE, publicOrigin };
}

// Do not trust X-Forwarded-* headers. Set PUBLIC_ORIGIN for a TLS reverse proxy.
export function browserOriginAllowed(request: Request, publicOrigin?: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === (publicOrigin ?? new URL(request.url).origin);
}
