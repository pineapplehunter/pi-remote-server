# SSH tickets for Pi Remote

Enroll the **host**, not individual sessions. Each configured Pi process (including a subagent) gets its own key, ticket, and connection. Browser monitoring and Authelia login are unchanged.

## Server

Set `PI_REMOTE_DB` to a file on a persistent volume owned by the gateway, `PI_REMOTE_TICKET_SOCKET` to the private agent socket, and `PUBLIC_ORIGIN` to the exact browser origin. Set a strong random `PI_REMOTE_ADMIN_TOKEN` via deployment secrets to enable host administration. Never use this credential in Pi, in a URL, or as the host SSH key passphrase. Keep the browser listener private behind Authelia, including `/admin/hosts`. Back up the enrollment DB using SQLite's backup facilities or stop the gateway before copying it.

**Migrating from mTLS:** publish/load the ticket-capable gateway first. The new Caddy route must target `ticket.sock`, **never the old `agent.sock`**: the old listener trusted Caddy's TLS decision and is not safe behind ordinary HTTPS. Recreate the gateway with its new environment and DB volume, verify the new listener rejects unauthenticated upgrades, then reload Caddy. Stop the old service/listener. Do not solve mixed-version failures by enabling unauthenticated fallback. On rollback restore Caddy's mTLS enforcement *before* routing to legacy code.

## Host and workers

1. Generate a dedicated OpenSSH Ed25519 key outside any worker-accessible mount, e.g. `install -d -m 700 ~/.config/pi-remote && ssh-keygen -t ed25519 -f ~/.config/pi-remote/host_ed25519`. Use a key accessible to the unattended host helper. An existing supported key also works; avoid sharing one private key across machines.
2. On the browser hostname choose **Trusted hosts** (or visit `/admin/hosts`), enter the admin token as the HTTP Basic password (e.g. username `admin`), and enroll the public key and a recognizable name. Copy the assigned host ID.
3. Configure the **host-side** helper by putting `{"host_id":"ENROLLED-UUID","origin":"https://pi-agent.s.ihavenojob.work"}` in `~/.config/pi-remote/host.json`. Its signing key is `~/.config/pi-remote/host_ed25519`. Install the matching wrapper/launcher and restart the parent Pi process. The gateway origin must not come from the D-Bus caller.
4. Install the matching extension and use `/remote-login` with the agent WSS URL. With the extension enabled, launch a `pi-subagent`: parent and worker should appear as distinct registrations. The worker gets only the ticket-issuance D-Bus endpoint, never the host key or its SSH agent.
5. To retire a host, disable its enrollment. Re-enroll with a fresh key if the private key is lost. Check that active registrations disappear and reconnects from the disabled host are rejected.

## Wire contract

Use strict TLS hostname verification for HTTPS/WSS. Requests and responses below are JSON; reject redirects. `agent_key` is canonical `ssh-ed25519 BASE64` with no comment. Challenges and tickets are opaque, random 32-byte values encoded as unpadded base64url. SSH signatures are armored OpenSSH SSHSIG text, not SSH login attempts.

1. The agent creates an ephemeral key pair; only the public key goes to the helper. The helper POSTs `{host_id,agent_key}` to `/agent/challenge` and receives `{challenge}`.
2. In namespace `pi-remote-host-v1`, the host signs the UTF-8 bytes `pi-remote-host-v1\nHOST_ID\nAGENT_KEY\nCHALLENGE\n` (LFs, including the final LF). It POSTs `{host_id,agent_key,challenge,signature}` to `/agent/ticket`. A valid proof consumes the challenge and returns `{ticket}`. The helper passes only the ticket to the agent.
3. The agent upgrades `/agent/ws` with `Authorization: Bearer TICKET`. The pending socket receives `{type:"auth.challenge",challenge}`. In namespace `pi-remote-agent-v1`, sign `pi-remote-agent-v1\nCHALLENGE\n` and send `{type:"auth.proof",signature}`. Wait for `{type:"auth.ok"}` before registration.
4. Expiry (60 seconds) applies at redemption, not to the established socket. Failed agent proofs must not consume the ticket. A reconnect gets a fresh key and ticket. No JWT signing secret or certificate chain is required.
