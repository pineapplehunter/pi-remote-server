# SSH tickets for Pi Remote

Enroll the **host**, not individual sessions. Each configured Pi process (including a subagent) gets its own key, ticket, and connection. Browser monitoring and Authelia login are unchanged.

## Server

Set `PI_REMOTE_DB` to a file on a persistent volume owned by the gateway, `PI_REMOTE_TICKET_SOCKET` to the private agent socket, and `PUBLIC_ORIGIN` to the exact browser origin. Keep the browser listener private behind Authelia, including `/admin/hosts`: browser access grants host-management access. Back up the enrollment DB using SQLite's backup facilities or stop the gateway before copying it.

Compose stores `hosts.sqlite` in `./data/` beside the standalone Compose file, or `./pi-remote-server/data/` in the Linode stack. If you already enrolled hosts using the old named volume, stop the gateway and copy the volume contents (including SQLite sidecar files) into the new directory before recreating it. Preserve ownership and restrict access to the gateway operator. An empty directory starts a fresh enrollment database.

**Migrating from mTLS:** publish/load the ticket-capable gateway first. The new Caddy route must target `ticket.sock`, **never the old `agent.sock`**: the old listener trusted Caddy's TLS decision and is not safe behind ordinary HTTPS. Recreate the gateway with its new environment and DB volume, verify the new listener rejects unauthenticated upgrades, then reload Caddy. Stop the old service/listener. Do not solve mixed-version failures by enabling unauthenticated fallback. On rollback restore Caddy's mTLS enforcement *before* routing to legacy code.

## Host and workers

1. On the host, run `ssh-add -L` and choose an already-loaded Ed25519 public key. If needed, load your existing key with `ssh-add ~/.ssh/id_ed25519`. No new key is required.
2. In **Trusted hosts**, enroll that public key under a unique name such as `build-laptop`. An existing enrollment works if its key is loaded. Names are case-sensitive. If upgrading with duplicate enabled names, disable the duplicates before switching the broker.
3. Run `pi-remote-setup` on the host. Confirm the enrollment name and the `wss://…/agent/ws` address; Enter keeps each displayed default. For manual configuration, set `~/.config/pi-remote/host.json` to `{"host_name":"build-laptop"}`. The default origin is `https://pi-agent.s.ihavenojob.work`; add `"origin":"https://agents.example.org"` only for another gateway. Upgrade the gateway first, then replace the old `host_id` setting with the enrollment name. From the host shell with the correct SSH agent, run `systemctl --user import-environment SSH_AUTH_SOCK` before restarting the service (repeat if the socket changes). Keep this socket out of worker environments.
4. Restart the updated host broker and launch Pi with the matching wrapper and extension. The agent discovers its WebSocket URL automatically (`pi-remote-request-ticket --ws-url`); use `/remote-status` to check it. With the extension enabled, launch a `pi-subagent`: parent and worker should appear as distinct registrations. The worker gets only the ticket and URL-discovery D-Bus methods, never the host key or its SSH agent.
5. To retire a host, disable its enrollment or select **Delete host → Confirm deletion** to permanently remove it. Re-enroll with a fresh key if the private key is lost. Check that active registrations disappear and reconnects from the disabled host are rejected.

## Wire contract

Use strict TLS hostname verification for HTTPS/WSS. Requests and responses below are JSON; reject redirects. `agent_key` is canonical `ssh-ed25519 BASE64` with no comment. Challenges and tickets are opaque, random 32-byte values encoded as unpadded base64url. SSH signatures are armored OpenSSH SSHSIG text, not SSH login attempts.

1. The agent creates an ephemeral key pair; only the public key goes to the helper. The helper POSTs `{host_name,agent_key}` to `/agent/challenge` and receives `{host_id,challenge,fingerprint}`. It matches the OpenSSH SHA-256 fingerprint to one of its local SSH agent’s loaded Ed25519 keys. If the key is unavailable, no ticket is issued.
2. In namespace `pi-remote-host-v1`, the host signs the UTF-8 bytes `pi-remote-host-v1\nHOST_ID\nAGENT_KEY\nCHALLENGE\n` (LFs, including the final LF). It POSTs `{host_id,agent_key,challenge,signature}` to `/agent/ticket`. A valid proof consumes the challenge and returns `{ticket}`. The helper passes only the ticket to the agent.
3. The agent upgrades `/agent/ws` with `Authorization: Bearer TICKET`. The pending socket receives `{type:"auth.challenge",challenge}`. In namespace `pi-remote-agent-v1`, sign `pi-remote-agent-v1\nCHALLENGE\n` and send `{type:"auth.proof",signature}`. Wait for `{type:"auth.ok"}` before registration.
4. Expiry (60 seconds) applies at redemption, not to the established socket. Failed agent proofs must not consume the ticket. A reconnect gets a fresh key and ticket. No JWT signing secret or certificate chain is required.
