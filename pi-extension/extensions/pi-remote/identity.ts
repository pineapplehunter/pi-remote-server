import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command: string, args: string[], input: string, signal: AbortSignal): Promise<string> {
  const env = { ...process.env };
  delete env.SSH_AUTH_SOCK;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { signal, env, timeout: 10000, killSignal: "SIGKILL", maxBuffer: 8192, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(new Error("Remote authentication command failed")); else resolve(stdout);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export function validateEndpoint(value: string): string {
  if (value.length > 4096 || !/^wss:\/\/[^/\s@?#\\]+\/agent\/ws$/.test(value)) throw new Error("Invalid host endpoint");
  return new URL(value).href;
}

export async function requestIdentity(signal: AbortSignal) {
  signal.throwIfAborted();
  // mkdtemp creates a private 0700 directory before ssh-keygen creates either file.
  const dir = mkdtempSync(join(tmpdir(), "pi-remote-key-"));
  const key = join(dir, "agent");
  function dispose() {
    rmSync(dir, { recursive: true, force: true });
    process.off("exit", dispose);
    signal.removeEventListener("abort", dispose);
  }
  process.once("exit", dispose);
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const url = validateEndpoint((await run("pi-remote-request-ticket", ["--ws-url"], "", signal)).trimEnd());
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key], "", signal);
    const pub = readFileSync(`${key}.pub`, "utf8").trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(pub)) throw new Error("Invalid agent public key");
    const result = await run("pi-remote-request-ticket", [], `${pub}\n`, signal);
    if (!/^[A-Za-z0-9_-]{1,4096}\n$/.test(result)) throw new Error("Invalid agent ticket");
    return { url, ticket: result.trimEnd(), dispose, sign: (nonce: string) => run("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "pi-remote-agent-v1"], `pi-remote-agent-v1\n${nonce}\n`, signal) };
  } catch (error) { dispose(); throw error; }
}
