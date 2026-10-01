import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const credentialsSchema = z.array(z.object({
  host_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  token: z.string().regex(/^[\x21-\x7e]{1,8192}$/),
}).strict()).min(1);

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** Stores token digests only; never serialize this object into a response or log. */
export class Credentials {
  private readonly hostsByDigest = new Map<string, string>();

  constructor(value: unknown) {
    const parsed = credentialsSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid credential file entries.");
    const hosts = new Set<string>();
    for (const entry of parsed.data) {
      const hash = digest(entry.token);
      if (hosts.has(entry.host_id) || this.hostsByDigest.has(hash)) {
        throw new Error("Duplicate host ID or token in credential file.");
      }
      hosts.add(entry.host_id);
      this.hostsByDigest.set(hash, entry.host_id);
    }
  }

  authenticate(authorization: string | null): string | undefined {
    if (!authorization) return undefined;
    const match = /^Bearer ([\x21-\x7e]{1,8192})$/i.exec(authorization);
    return match ? this.hostsByDigest.get(digest(match[1]!)) : undefined;
  }
}

export async function loadCredentials(path: string): Promise<Credentials> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Cannot read or parse credential file."); }
  return new Credentials(value);
}
