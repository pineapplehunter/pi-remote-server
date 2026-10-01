import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_URL = "wss://pi.s.ihavenojob.work/agent/ws";

/** Only static, credential-free messages from configuration operations may reach the UI. */
export class RemoteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteConfigError";
  }
}
export interface RemoteConfig {
  version: 1;
  url: string;
  host_id: string;
  token: string;
}

/** Deliberately shared by normal/work agent profiles; no PI_REMOTE_* environment access. */
export function configPath(): string {
  return join(homedir(), ".pi", "agent", "remote.json");
}

export function validateConfig(value: unknown): RemoteConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RemoteConfigError("Invalid remote configuration.");
  const config = value as Record<string, unknown>;
  if (config.version !== 1) throw new RemoteConfigError("Remote configuration must have version 1.");
  if (typeof config.url !== "string" || config.url.length > 4096) throw new RemoteConfigError("Invalid remote server URL. Enter a full ws:// or wss:// URL.");
  let url: URL;
  try { url = new URL(config.url); } catch { throw new RemoteConfigError("Invalid remote server URL. Enter a full ws:// or wss:// URL."); }
  if (url.username || url.password || url.search || url.hash) throw new RemoteConfigError("Server URL must not contain credentials, query parameters, or a fragment.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new RemoteConfigError("Use wss://, or ws:// on loopback for development. HTTP(S) URLs are not WebSocket URLs.");
  }
  if (typeof config.host_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.host_id)) {
    throw new RemoteConfigError("Host ID must use 1–128 letters, digits, dots, underscores, or hyphens.");
  }
  if (typeof config.token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(config.token)) {
    throw new RemoteConfigError("Token must be non-empty printable ASCII without whitespace (maximum 8 KiB). Paste only the token, without a Bearer prefix.");
  }
  return { version: 1, url: url.href, host_id: config.host_id, token: config.token };
}

export async function loadConfig(path = configPath()): Promise<RemoteConfig | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RemoteConfigError("Cannot read remote configuration.");
  }
  if (Buffer.byteLength(text, "utf8") > 32 * 1024) throw new RemoteConfigError("Remote configuration is too large.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RemoteConfigError("Remote configuration is not valid JSON."); }
  return validateConfig(value);
}

export async function saveConfig(value: RemoteConfig, path = configPath()): Promise<void> {
  const config = validateConfig(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const safeCode = code && ["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "ENOENT", "ENOTDIR", "EISDIR", "EEXIST"].includes(code) ? ` (${code})` : "";
    throw new RemoteConfigError(`Cannot save remote credentials${safeCode}. Check directory permissions and available space.`);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
