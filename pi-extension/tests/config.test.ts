import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEndpoint } from "../extensions/pi-remote/identity.ts";

test("discovered endpoint must be a credential-free agent WSS URL", () => {
  assert.equal(validateEndpoint("wss://[::1]:8443/agent/ws"), "wss://[::1]:8443/agent/ws");
  for (const url of ["ws://localhost/agent/ws", "wss://user@localhost/agent/ws", "wss://localhost/agent/ws?", "wss://localhost/agent/ws#", "wss://localhost/other", "not a URL"]) {
    assert.throws(() => validateEndpoint(url));
  }
});
