import { execFile } from "node:child_process";
import { createPublicKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from "node:crypto";

let key: KeyObject | undefined;

export function processKey(): KeyObject {
  return key ??= generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
}

function der(tag: number, ...fields: Buffer[]): Buffer {
  const body = Buffer.concat(fields);
  // Fixed P-256 CSR fields keep every length below 256 bytes.
  if (body.length > 255) throw new Error("Unexpected CSR size");
  const header = body.length < 128 ? [tag, body.length] : [tag, 0x81, body.length];
  return Buffer.concat([Buffer.from(header), body]);
}

export function csrPEM(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  // PKCS#10 CertificationRequestInfo: version 0, empty subject, SPKI, empty attributes.
  const info = der(0x30, Buffer.from("0201003000", "hex"), spki, Buffer.from("a000", "hex"));
  const algorithm = Buffer.from("300a06082a8648ce3d040302", "hex"); // ecdsa-with-SHA256
  const signature = der(0x03, Buffer.from([0]), sign("sha256", info, privateKey));
  const lines = der(0x30, info, algorithm, signature).toString("base64").match(/.{1,64}/g)!;
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
}

export async function requestIdentity(privateKey: KeyObject, signal: AbortSignal): Promise<{ key: string; cert: string }> {
  const csr = csrPEM(privateKey);
  const result = await new Promise<string>((resolve, reject) => {
    const child = execFile("pi-remote-issue-certificate", {
      encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024, signal,
    }, (error, stdout) => {
      if (error) reject(new Error("Pi Remote certificate issuer unavailable or rejected the request"));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => { /* Early exit is reported by execFile. */ });
    child.stdin?.end(csr);
  });
  const { leafPEM, intermediatePEM } = JSON.parse(result) as { leafPEM?: unknown; intermediatePEM?: unknown };
  if (typeof leafPEM !== "string" || typeof intermediatePEM !== "string" ||
      !new X509Certificate(leafPEM).checkPrivateKey(privateKey) || !new X509Certificate(intermediatePEM).ca) {
    throw new Error("Pi Remote issuer returned an invalid certificate chain");
  }
  return {
    key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    cert: `${leafPEM.trim()}\n${intermediatePEM.trim()}\n`,
  };
}
