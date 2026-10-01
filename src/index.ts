import { loadCredentials } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { log } from "./registry.ts";
import { startServer } from "./server.ts";

try {
  const config = loadConfig();
  const credentials = await loadCredentials(config.tokenFile);
  const { server } = startServer(config, credentials);
  log("server.started", { host: config.host, port: server.port ?? config.port });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { server.stop(true); process.exit(0); });
  }
} catch (error) {
  // Only our own config/auth errors are printed; bind failures get a generic message.
  const safe = error instanceof Error && /^(Invalid configuration:|PUBLIC_ORIGIN |Invalid credential file|Duplicate host ID|Cannot read or parse credential file)/.test(error.message);
  log("server.startup_failed", { message: safe ? error.message : "Cannot start gateway. Check configuration and listening address." });
  process.exitCode = 1;
}
