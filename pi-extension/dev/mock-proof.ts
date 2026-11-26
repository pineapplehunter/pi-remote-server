// Synthetic loopback tests only: check the actual SSHSIG bytes with OpenSSH.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";

export function mockProof(ws: WebSocket, pub: string, accepted: () => void) {
  const challenge = randomBytes(32).toString("base64url");
  ws.send(JSON.stringify({ type: "auth.challenge", challenge }));
  const timer = setTimeout(() => ws.terminate(), 10000);
  ws.once("close", () => clearTimeout(timer));
  ws.once("message", (data, binary) => {
    clearTimeout(timer);
    const dir = mkdtempSync(join(tmpdir(), "pi-test-proof-"));
    try {
      const msg = JSON.parse(data.toString());
      if (binary || msg.type !== "auth.proof" || typeof msg.signature !== "string" || msg.signature.length > 4096) throw Error();
      writeFileSync(join(dir, "sig"), msg.signature);
      writeFileSync(join(dir, "allowed"), `test ${pub}\n`);
      execFileSync("ssh-keygen", ["-Y", "verify", "-n", "pi-remote-agent-v1", "-f", "allowed", "-I", "test", "-s", "sig"], {
        cwd: dir, stdio: "pipe", input: `pi-remote-agent-v1\n${challenge}\n`, timeout: 3000,
      });
      ws.send(JSON.stringify({ type: "auth.ok" }));
      accepted();
    } catch { ws.terminate(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
