import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credentials, loadCredentials } from "../src/auth.ts";
import { browserOriginAllowed, loadConfig } from "../src/config.ts";

const entries = [{ host_id: "laptop", token: "long-random-secret" }];
describe("machine authentication", () => {
  const auth = new Credentials(entries);
  test("valid bearer identity comes from file", () => expect(auth.authenticate("Bearer long-random-secret")).toBe("laptop"));
  test("invalid, missing and malformed headers", () => {
    for (const value of [null, "Bearer wrong", "Basic long-random-secret", "Bearer", "Bearer long-random-secret extra", "Bearer  long-random-secret"]) {
      expect(auth.authenticate(value)).toBeUndefined();
    }
  });
  test("rejects invalid entries and duplicates without leaking values", () => {
    for (const value of [null, {}, [], [{ host_id: "bad host", token: "SECRET" }], [{ host_id: "host", token: "bad token" }], [{ ...entries[0], extra: true }], [entries[0], { host_id: "laptop", token: "different" }], [entries[0], { host_id: "gpu01", token: "long-random-secret" }]]) {
      expect(() => new Credentials(value)).toThrow();
    }
    try { new Credentials([{ host_id: "bad host", token: "SECRET" }]); } catch (error) { expect(String(error)).not.toContain("SECRET"); }
  });
  test("loads once; malformed or unreadable JSON refuses startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
    const path = join(dir, "agents.json");
    try {
      await writeFile(path, JSON.stringify(entries));
      const credentials = await loadCredentials(path);
      await writeFile(path, "not JSON");
      expect(credentials.authenticate("Bearer long-random-secret")).toBe("laptop");
      await expect(loadCredentials(path)).rejects.toThrow("Cannot read or parse");
      await expect(loadCredentials(join(dir, "missing"))).rejects.toThrow();
      await writeFile(path, JSON.stringify([entries[0], entries[0]]));
      await expect(loadCredentials(path)).rejects.toThrow("Duplicate");
    } finally { await rm(dir, { recursive: true }); }
  });
});

describe("configuration and Origin", () => {
  test("requires token file, validates values and defaults to loopback", () => {
    expect(() => loadConfig({})).toThrow();
    expect(loadConfig({ PI_REMOTE_TOKEN_FILE: "/test" })).toEqual({ host: "127.0.0.1", port: 3000, tokenFile: "/test", publicOrigin: undefined });
    for (const port of ["", "x", "0", "65536", "1.5"]) expect(() => loadConfig({ PI_REMOTE_TOKEN_FILE: "/test", PORT: port })).toThrow();
    for (const origin of ["wss://host", "https://host/path", "https://user:pass@host", "https://host/?x=1"]) expect(() => loadConfig({ PI_REMOTE_TOKEN_FILE: "/test", PUBLIC_ORIGIN: origin })).toThrow();
  });
  test("exact origin; forwarded headers do not bypass checks", () => {
    expect(browserOriginAllowed(new Request("http://localhost:3000/ws", { headers: { Origin: "http://localhost:3000" } }))).toBe(true);
    expect(browserOriginAllowed(new Request("http://localhost:3000/ws"))).toBe(false);
    expect(browserOriginAllowed(new Request("http://localhost:3000/ws", { headers: { Origin: "https://evil", "X-Forwarded-Host": "evil" } }))).toBe(false);
    expect(browserOriginAllowed(new Request("http://localhost:3000/ws", { headers: { Origin: "https://pi.example" } }), "https://pi.example")).toBe(true);
  });
});
