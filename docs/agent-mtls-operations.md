# Set up Pi Remote certificates

Do this once for the server, then once for each computer that runs Pi. The YubiKey is only needed when you add or renew a computer. Pi gets its own temporary certificate automatically whenever it connects.

| Where | What stays there |
| --- | --- |
| Signing computer | The YubiKey holds the main signing key. `root.pem` is its public certificate. |
| Each Pi computer | `intermediate-key.pem` is that computer’s private key. `intermediate.pem` is its signed certificate. |
| Linode | A copy of `root.pem` for Caddy. **No private keys and no list of computers.** |

## 1. Set up the YubiKey once

Use a dedicated YubiKey, or make sure **slot `9c` is empty**. Generating a key in that slot can overwrite what is already there. Unplug any other YubiKeys while following these steps so the tools select the right one.

### Make the signing key

If you already generated `root-public.pem` from slot `9c`, **skip this command**. Otherwise, after checking the slot, run:

```sh
ykman piv keys generate --algorithm ECCP256 9c root-public.pem
```

If `ykman` asks for a **management key**, use the value you saved when setting up the YubiKey. If it asks for a **PIV PIN**, use that instead. Don’t reset PIV to get past either prompt: that erases its keys and certificates.

### Tell OpenSSL which key to use

For slot `9c` and Yubico’s OpenSSL driver, paste this exact line into the terminal on the signing computer:

```sh
export ROOT_KEY_URI='pkcs11:id=%02;type=private'
```

That’s the whole value. `%02` is how the driver refers to slot `9c`; it is **not** something you replace with your PIN, management key, or YubiKey serial number. Keep the quotes. If you open a new terminal later to sign a computer’s certificate, run the line again.

**Before you continue**, follow [OpenSSL setup](#openssl-setup) and check that `openssl engine -t pkcs11` reports `[ available ]`. Setting `ROOT_KEY_URI` selects the key; it doesn’t load the driver. If you see `Invalid engine "pkcs11"`, OpenSSL hasn’t gotten as far as talking to the YubiKey. Don’t regenerate the key. Run the setup and the signing command in the **same shell**.

### Make `root.pem`

In the directory with `root-public.pem`, run the command below. If you already have a `root.pem` for this setup, keep it; don’t overwrite it.

```sh
openssl req -new -x509 -engine pkcs11 -keyform engine -key "$ROOT_KEY_URI" \
  -sha256 -subj '/CN=Pi Remote Offline Root' -days 3650 \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:1' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out root.pem
openssl x509 -in root.pem -noout -dates -fingerprint -sha256
```

For this step, a **PIN** prompt is for your **PIV PIN**, not the management key. Check that `root.pem` is for the key you just created: the two lines below should print the same hash.

```sh
openssl pkey -pubin -in root-public.pem -outform DER | openssl dgst -sha256
openssl x509 -in root.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256
```

Save `root.pem` and its fingerprint. `root-public.pem` is useful for that check, but **`root.pem` is the file Linode needs**. Store the YubiKey safely between signing sessions. If you lose the key, you’ll need to set up a new root and enroll the computers again.

## 2. Add a computer that runs Pi

Pick a recognizable label such as `laptop-01`. Replace `laptop-01` in the example below. The label helps you recognize the computer in the browser; it doesn’t determine which computers can connect.

### On the Pi computer: make a request

Apply the updated `nixos-config` / Home Manager configuration first. Run these commands **on the computer itself, outside Pi’s sandbox**:

```sh
umask 077
issuer_dir="$HOME/.config/pi-remote/issuer"
install -d -m 0700 "$issuer_dir"
# Make the private key only if it does not exist already.
test -e "$issuer_dir/intermediate-key.pem" || \
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$issuer_dir/intermediate-key.pem"
chmod 0600 "$issuer_dir/intermediate-key.pem"
openssl req -new -key "$issuer_dir/intermediate-key.pem" \
  -subj '/CN=laptop-01 Pi Remote Issuer' -out "$issuer_dir/host.csr"
```

Copy **only `host.csr`** to the signing computer. Keep `intermediate-key.pem` on the Pi computer, outside `~/.pi`, the project checkout, and any directories shared with the sandbox.

### On the signing computer: sign the request

Make sure the request came from the computer you intend to add. In a directory containing `host.csr` and `root.pem`, connect the YubiKey and run:

```sh
export ROOT_KEY_URI='pkcs11:id=%02;type=private'
openssl req -in host.csr -verify -noout
```

After verification succeeds, create the rules for this certificate and sign it. This example signs for 365 days; use fewer days if the root expires sooner.

```sh
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

Copy the signed `intermediate.pem` back to `~/.config/pi-remote/issuer/intermediate.pem` on **that Pi computer**. Do not copy the computer’s private key. There is nothing to add on Linode for this computer. Once Caddy trusts `root.pem`, every computer you sign can connect without a server restart.

## 3. Switch the server over and connect Pi

1. Add DNS for **`pi-agent.s.ihavenojob.work`**, pointing to the same Caddy server as `pi.s.ihavenojob.work`. The browser address and Authelia login don’t change.
2. Make sure the updated `linode-server` checkout and gateway image are ready. From the checkout, install the public root certificate before recreating Caddy. Compare its fingerprint with the one you saved on the signing computer:

   ```sh
   openssl x509 -in root.pem -noout -fingerprint -sha256
   install -d -m 0755 pi-remote-server/pki
   install -m 0644 root.pem pi-remote-server/pki/root.pem
   ```

   If an earlier version used `enrollments.json`, the new gateway no longer reads it.
3. From the `linode-server` checkout, run:

   ```sh
   docker compose config --quiet
   docker compose pull pi-remote-server
   docker compose up -d --force-recreate caddy alloy pi-remote-server
   docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
   docker compose logs --tail=50 caddy pi-remote-server alloy
   ```

4. Update and restart Pi. Run `/remote-login` and enter **`wss://pi-agent.s.ihavenojob.work/agent/ws`**. No token or computer ID is needed in Pi. `/remote-status` should say `connected`.
5. Check that you can still log into the browser UI and send a prompt. A request to the old `https://pi.s.ihavenojob.work/agent/ws` should return `404`. A connection to the new agent address without a client certificate should fail. Check that Alloy still gets Caddy metrics and that `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` works.
6. Once the new connection works, remove the old encrypted token entry using SOPS and delete the old extracted token file on Linode. There is no fallback to tokens.

If Pi reports an issuer error, check `command -v pi-remote-issue-certificate` **inside Pi’s sandbox**, and run `journalctl --user -u pi-remote-issuer.service` **on the Pi computer outside the sandbox**. Check that both files are in `~/.config/pi-remote/issuer/`, that the private key is readable by the host service, and that the certificate has not expired. If Pi reports an authentication error, check the agent hostname, the clocks on the Pi computer and Linode, and that Caddy trusts the root that signed your computer’s certificate.

## 4. Renew certificates or respond to a lost key

- **Temporary Pi certificates:** Nothing to do. Pi gets a new one before every connection attempt. An open connection doesn’t close just because its certificate expires.
- **Computer certificate nearing expiry:** Sign a new certificate before the old one expires and replace `intermediate.pem` on that computer. If you keep the same root, there’s nothing to change or restart on Linode.
- **Lost or stolen computer key:** This setup can’t block just that computer. A stolen signing key can make fresh Pi certificates until the computer’s certificate expires. If you need to block it sooner, replace the root trusted by Caddy and sign new certificates only for the computers you still trust.
- **Lost or expiring YubiKey root:** Prepare a replacement root and have it sign fresh certificates for all computers before changing Linode. Plan a coordinated switch: this setup trusts one root at a time. Recreate Caddy after replacing `root.pem` so Docker sees the new mounted file.

## Technical details

### OpenSSL setup

The commands above use OpenSSL 3 with the `pkcs11` **engine** from `libp11`, and Yubico’s `libykcs11.so` library. [Yubico’s OpenSSL setup guide](https://developers.yubico.com/yubico-piv-tool/YKCS11/Supported_applications/openssl_engine.html) describes this combination. Have your normal smart-card service running on the signing computer.

On NixOS, one way to load these tools and set the paths is:

```sh
nix shell nixpkgs#openssl nixpkgs#yubikey-manager nixpkgs#yubico-piv-tool --command bash
```

Once that opens Bash, paste the next block there. Stay in that shell for signing; the settings disappear when you leave it.

```sh
libp11=$(nix build 'nixpkgs#libp11^out' --no-link --print-out-paths)
yubico_piv=$(nix build 'nixpkgs#yubico-piv-tool^out' --no-link --print-out-paths)
export OPENSSL_ENGINES="$libp11/lib/engines"
export PKCS11_MODULE_PATH="$yubico_piv/lib/libykcs11.so"
export ROOT_KEY_URI='pkcs11:id=%02;type=private'
openssl engine -t pkcs11
```

On another Linux distribution, install the equivalent packages and export `PKCS11_MODULE_PATH` with the full path to your `libykcs11.so`. If OpenSSL still can’t find `pkcs11`, set `OPENSSL_ENGINES` to the directory containing the installed `pkcs11.so` engine. `openssl engine -t pkcs11` should report `[ available ]`; that checks the engine, not your YubiKey PIN or slot.

`ROOT_KEY_URI` is a [PKCS#11 locator](https://www.rfc-editor.org/rfc/rfc7512), not a secret. Yubico’s [slot mapping](https://developers.yubico.com/yubico-piv-tool/YKCS11/) assigns `9c` object ID `02`. The locator selects a private-key object without exporting it. If you deliberately chose another slot, look up its ID in that mapping instead of putting the slot number itself in the locator. If multiple tokens must stay connected or a key can’t be found, list private-key **metadata** with `pkcs11-tool --module "$PKCS11_MODULE_PATH" --login --list-objects --type privkey` and check the ID and token. Never put a PIN or management key in a URI or command history.

### PIN versus management key

Creating or replacing a key in a slot requires the PIV management key. `ykman` supports a management key stored on the YubiKey and unlocked by the PIV PIN. If you manage the key yourself and prefer `yubico-piv-tool`, append `-k` to prompt for it: `yubico-piv-tool -a generate -s 9c -A ECCP256 -o root-public.pem -k`. Without `-k`, that tool tries the factory default. This is an alternative to `ykman`, not a second step. After the key exists, signing with it uses the PIV PIN and may require a touch, depending on the key’s policy.

### What the certificates do

The YubiKey holds the offline root CA key. It signs each computer’s certificate request (CSR), producing a `pathLen=0` intermediate CA certificate. That allows the computer to sign short-lived Pi client certificates but not another CA. A Pi process holds its own key in memory; on each dial it sends a PEM CSR over filtered D-Bus to `pi-remote-issuer.service`, which returns the PEM client certificate and intermediate. A client certificate is valid for at most 24 hours, and never past the intermediate’s expiry. No private key is sent over D-Bus or to Linode.

Caddy alone verifies mTLS on the agent hostname against `root.pem`. It proxies the WebSocket through the Unix socket in the private `pi-remote-agent` volume and overwrites `X-Pi-Remote-Host` with the certificate’s issuer name for display only. Go receives no certificate or CA config and makes no certificate-based authorization decision. Stock Caddy’s client-auth verifier options don’t provide a per-host revocation list here; no custom verifier is deployed.

Both Caddy and the gateway run as container root in the same rootless Docker daemon. This lets Caddy use `agent.sock` with mode `0600`; changing container users means checking the mapped IDs and socket permissions, **not** publishing an agent TCP port. The browser listener stays unpublished on port 3000. Caddy’s admin API is loopback-only inside its container, and Alloy scrapes the separate metrics listener at `caddy:2020/metrics`.

See the [design and lifecycle diagrams](agent-mtls-plan.md) for the complete flow.
