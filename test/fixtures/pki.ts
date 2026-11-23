import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";

export function testPKI() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-pki-"));
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd, stdio: "pipe" });
  const output = (path: string) => readFileSync(join(cwd, path), "utf8");
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc"];
  try {
    openssl("req", "-new", "-x509", ...key, "-subj", "/CN=Test Root", "-days", "5",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:1", "-addext", "keyUsage=critical,keyCertSign",
      "-keyout", "root.key", "-out", "root.pem");
    writeFileSync(join(cwd, "ca.ext"), "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign\n");
    writeFileSync(join(cwd, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
    function host(id: string) {
      openssl("req", "-new", ...key, "-subj", `/CN=${id}`, "-keyout", `${id}.key`, "-out", `${id}.csr`);
      openssl("x509", "-req", "-in", `${id}.csr`, "-CA", "root.pem", "-CAkey", "root.key", "-days", "4", "-extfile", "ca.ext", "-out", `${id}.pem`);
      // The leaf's display name is deliberately unrelated to its real identity.
      openssl("req", "-new", ...key, "-subj", "/CN=not-the-host-id", "-keyout", "leaf.key", "-out", "leaf.csr");
      openssl("x509", "-req", "-in", "leaf.csr", "-CA", `${id}.pem`, "-CAkey", `${id}.key`, "-days", "1", "-extfile", "leaf.ext", "-out", "leaf.pem");
      return { intermediate: output(`${id}.pem`), leaf: new X509Certificate(output("leaf.pem")).raw.toString("base64") };
    }
    return { root: output("root.pem"), hosts: { laptop: host("laptop"), gpu01: host("gpu01"), unknown: host("unknown") } };
  } finally {
    rmSync(cwd, { recursive: true });
  }
}
