import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, saveConfig, validateConfig } from "../extensions/pi-remote/config.ts";
const config = { version: 2 as const, url: "wss://localhost/agent/ws" };
test("config accepts only secure WSS endpoint version 2", () => {
  assert.deepEqual(validateConfig(config), config);
  for (const url of ["ws://localhost", "https://localhost", "wss://user:pass@example.com", "wss://example.com/agent/ws?q=x", "wss://example.com/agent/ws#x", "wss://example.com/agent/ws?", "wss://example.com/agent/ws#", "wss://example.com/other"]) assert.throws(() => validateConfig({ ...config, url }));
  assert.throws(() => validateConfig({ ...config, version: 1 }));
});
test("config persists atomically with private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "remote-config-")); const path = join(dir, "remote.json");
  try { await saveConfig(config, path); assert.deepEqual(await loadConfig(path), config); assert.equal((await stat(path)).mode & 0o777, 0o600); assert.ok((await readFile(path, "utf8")).endsWith("\n")); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
