# Pi Remote WebSocket protocol

Each connection starts with a new ephemeral Ed25519 public key. The host helper reads `ssh-ed25519 BASE64\n` from stdin and returns a raw base64url ticket followed by a newline on stdout. Only the host service requests challenges and tickets; it uses its own configured gateway and never receives a URL from Pi.

1. Connect to the configured `wss://…/agent/ws` with `Authorization: Bearer <ticket>`. Validate server TLS and never follow redirects.
2. Receive a text JSON frame `{"type":"auth.challenge","challenge":"…"}`. The nonce is 32 random bytes encoded in unpadded base64url.
3. Sign the UTF-8 string `pi-remote-agent-v1\n${challenge}\n` in OpenSSH SSHSIG namespace `pi-remote-agent-v1`. Send `{"type":"auth.proof","signature":"…"}` with the armored SSHSIG.
4. Only after receiving `{"type":"auth.ok"}` may the normal [registration, chat and browser input protocol](../docs/pi-protocol-v1.md) begin. Errors or timeouts close the connection; reconnect starts over with a fresh key and ticket.
