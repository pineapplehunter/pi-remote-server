import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, readdir, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, loadConfig, RemoteConfigError, saveConfig, validateConfig } from "../extensions/pi-remote/config.ts";

const config = { version: 1 as const, url: "wss://pi.s.ihavenojob.work/agent/ws", host_id: "laptop", token: "secret-token" };
test("secure URLs and config validation", () => {
  assert.equal(configPath(), join(homedir(), ".pi", "agent", "remote.json"));
  assert.deepEqual(validateConfig(config), config);
  for (const url of ["ws://localhost:8765", "ws://127.0.0.1:8765", "ws://[::1]:8765"]) assert.ok(validateConfig({ ...config, url }));
  for (const url of ["ws://example.com", "https://example.com", "wss://user:pass@example.com", "wss://example.com?token=secret", "wss://example.com#token"]) {
    assert.throws(() => validateConfig({ ...config, url }));
  }
  for (const patch of [{ token: "" }, { token: "secret\r\nheader" }, { host_id: "bad host" }, { version: 2 }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
});
test("credentials save atomically with 0600 permissions; missing/invalid config is safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-config-"));
  const path = join(root, "remote.json");
  try {
    assert.equal(await loadConfig(path), undefined);
    await saveConfig(config, path);
    assert.deepEqual(await loadConfig(path), config);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await saveConfig({ ...config, host_id: "workstation" }, path);
    assert.deepEqual(await readdir(root), ["remote.json"]);
    assert.ok((await readFile(path, "utf8")).endsWith("\n"));
    await assert.rejects(saveConfig(config, join(path, "remote.json")), (error: Error) =>
      error instanceof RemoteConfigError && /EEXIST|ENOTDIR/.test(error.message) && !error.message.includes(config.token));
    await writeFile(path, "{secret-token");
    await assert.rejects(loadConfig(path), (error: Error) => !error.message.includes("secret-token"));
    await unlink(path);
    assert.equal(await loadConfig(path), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
