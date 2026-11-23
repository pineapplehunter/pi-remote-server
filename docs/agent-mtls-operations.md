# Deploy and operate Pi Remote mTLS

This runbook uses the `linode-server` Compose configuration and the Pi host's `nixos-config` Home Manager module. The gateway, host wrapper and Pi extension must all be updated. There is no bearer-token fallback.

| Location | Files or service |
| --- | --- |
| Offline CA workstation | YubiKey holds the root private key; `root.pem` is public |
| Each Pi host, outside the sandbox | `~/.config/pi-remote/issuer/intermediate-key.pem` and `intermediate.pem` |
| Linode Compose checkout | `pi-remote-server/pki/root.pem` and `pi-remote-server/pki/enrollments.json`, public certificates plus the host revocation list |
| Pi process | In-memory leaf key, fresh PEM leaf and chain on every dial |

## 1. Create the offline root once

Use a YubiKey dedicated to this CA or an **unused** PIV slot. Key generation replaces any key already in that slot. Set a non-default PIV PIN and management key and make a recovery/rollover plan before enrolling hosts. Use your offline workstation with `yubico-piv-tool`, OpenSSL and a working PKCS#11 provider or engine. [Yubico's OpenSSL engine setup](https://developers.yubico.com/yubico-piv-tool/YKCS11/Supported_applications/openssl_engine.html) shows how to point it at `libykcs11`; the exact module path and private-key URI depend on your installation. Do not put a PIN in a command line, config file, or shell history.

Example for an OpenSSL `pkcs11` engine setup. Generate the key in the chosen slot and set `ROOT_KEY_URI` to its private-key URI (identify the slot and token, especially if more than one token is present):

```sh
yubico-piv-tool -a generate -s 9c -A ECCP256 -o root-public.pem
# Set PKCS11_MODULE_PATH for your workstation as required, and set ROOT_KEY_URI.
openssl req -new -x509 -engine pkcs11 -keyform engine -key "$ROOT_KEY_URI" \
  -sha256 -subj '/CN=Pi Remote Offline Root' -days 3650 \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:1' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out root.pem
openssl x509 -in root.pem -noout -subject -dates -fingerprint -sha256
```

Keep the YubiKey offline between signing sessions. Before installing `root.pem` elsewhere, verify its fingerprint over a trusted channel. These commands describe the hardware procedure; the disposable software PKI used in tests is not a substitute for your production root.

## 2. Enroll each host

1. Apply the updated Pi host/Home Manager configuration using your usual switch command. The wrapper exposes only `IssueClientCertificate` through its filtered session bus; the host service is named `pi-remote-issuer.service`.
2. Choose a unique, never-reused host ID (for example, `laptop-01`). On the **host**, not in the sandbox, generate the intermediate key and its CSR. Do not store the key in `~/.pi`, a checkout, or any sandbox bind mount:

   ```sh
   umask 077
   dir="$HOME/.config/pi-remote/issuer"
   install -d -m 0700 "$dir"
   # First enrollment only. Do not overwrite an existing issuer key.
   test ! -e "$dir/intermediate-key.pem" || exit 1
   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$dir/intermediate-key.pem"
   openssl req -new -key "$dir/intermediate-key.pem" -subj '/CN=laptop-01 Pi Remote Issuer' \
     -out "$dir/host.csr"
   ```

3. Bring **only** `host.csr` to the offline workstation. Confirm the source host out of band, verify the CSR, and sign it as a direct, `pathLen=0` intermediate. Set the duration so the certificate expires before the root. Do not copy CSR extensions.

   ```sh
   openssl req -in host.csr -verify -noout
   cat > host.ext <<'EOF'
   basicConstraints=critical,CA:TRUE,pathlen:0
   keyUsage=critical,keyCertSign,cRLSign
   subjectKeyIdentifier=hash
   authorityKeyIdentifier=keyid
   EOF
   openssl x509 -req -in host.csr -CA root.pem -engine pkcs11 \
     -CAkeyform engine -CAkey "$ROOT_KEY_URI" -days 365 -sha256 \
     -extfile host.ext -out intermediate.pem
   openssl verify -CAfile root.pem intermediate.pem
   ```

4. Install `intermediate.pem` on the Pi host beside the key; keep the key at `0600`. Verify the certificate matches the key (the commands should produce the same SHA-256 digest):

   ```sh
   openssl pkey -in "$dir/intermediate-key.pem" -pubout -outform DER | openssl dgst -sha256
   openssl x509 -in "$dir/intermediate.pem" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256
   ```

5. On Linode, install `root.pem` in `pi-remote-server/pki/`. Create `enrollments.json` there, embedding each **public** intermediate PEM under its ID. For the initial file only, with `jq`:

   ```sh
   install -d -m 0755 pi-remote-server/pki
   install -m 0644 root.pem pi-remote-server/pki/root.pem
   jq -n --arg id laptop-01 --rawfile cert intermediate.pem \
     '{hosts:[{host_id:$id, intermediate:$cert}], revoked_hosts:[]}' \
     > pi-remote-server/pki/enrollments.json
   ```

   For additional hosts, append a new entry, retaining all existing enrollments and revocations. **Never copy intermediate private keys to Linode.** Keep a record of retired host IDs; the gateway cannot check IDs against a deleted deployment history.

## 3. Cut over Caddy, the gateway and Pi

1. Add DNS for `pi-agent.s.ihavenojob.work` pointed at the same Caddy as `pi.s.ihavenojob.work`. Confirm Caddy can issue its normal public server certificate. The YubiKey root is used for client auth only.
2. Publish/select the matching gateway image and Pi extension revision. Check the Linode checkout has the new `compose.yml`, Caddyfile, and Alloy configuration. Provision both PKI files **before** recreating Caddy. Validate config with `docker compose config --quiet`; once the updated mounts are in place, validate Caddy with `docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile`.
3. Recreate Caddy, Alloy and the gateway as a coordinated change:

   ```sh
   docker compose pull pi-remote-server
   docker compose up -d --force-recreate caddy alloy pi-remote-server
   docker compose logs --tail=50 caddy pi-remote-server alloy
   ```

   The agent mount is the shared `pi-remote-agent` volume and the socket is `agent.sock` (`0600`). Both services run as container root in the same rootless Docker daemon in this Compose setup. If changing either user, verify the UID mapping and socket permissions rather than publishing another port. Browser HTTP on `:3000` stays unpublished. The Caddy admin API is now loopback-only; Alloy scrapes `caddy:2020/metrics` on the Docker network.
4. Update/restart Pi and run `/remote-login`. Use `wss://pi-agent.s.ihavenojob.work/agent/ws`; `/remote-status` should report `connected`. Running setup overwrites the old config with URL-only config. Do not enter a token or host ID. If enrollment fails, check `command -v pi-remote-issue-certificate` inside the wrapper and `journalctl --user -u pi-remote-issuer.service` on the host. Confirm the issuer certificate, key permissions, hostname/DNS and system clocks.
5. Check the old `https://pi.s.ihavenojob.work/agent/ws` returns 404, that the new hostname rejects a client with no certificate, and that browser login, `/ws`, and sending a prompt still work. Verify Alloy metrics and that `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` works. Once cutover is verified, retire the old encrypted token entry through normal SOPS editing and remove obsolete extracted token files on Linode. No re-enable/dual-auth switch is provided.

## 4. Renew or revoke

- **Process leaves:** No intervention. A running Pi retains its in-memory key and gets a fresh leaf before every dial. Expiry does not disconnect an open socket.
- **Intermediate:** Re-sign the host CSR with the same key before expiry, replace the public intermediate on the host and in `enrollments.json`, and restart the gateway. Caddy need not change if the root is the same. If rotating the key, enroll under a new ID and retire the old one.
- **Revoke a host:** Add its `host_id` to `revoked_hosts` and run `docker compose restart pi-remote-server`. The restart drops all current sockets. New connections from revoked hosts are then rejected, even with newly issued leaves. Clients on other enrolled hosts can reconnect. Do not reuse revoked or retired IDs.
- **Root loss or expiry:** Provision a new offline root and re-sign/re-enroll the host intermediates in a planned cutover. Keep enough overlap to distribute the new files. Recreate Caddy if replacing the bind-mounted `root.pem` file, so the container sees the new file. Do not lose the inventory of retired host IDs.
