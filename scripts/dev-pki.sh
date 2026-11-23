#!/usr/bin/env bash
# Disposable local/CI PKI. Do not deploy this software root in production.
set -euo pipefail
umask 077
out=${1:?usage: bash scripts/dev-pki.sh NEW_DIRECTORY}
mkdir -- "$out"
cd -- "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

openssl req -new -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
  -subj /CN=PiRemote-Development-Root -days 7 \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:1' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$work/root-key.pem" -out root.pem
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
  -subj /CN=PiRemote-Development-Host -keyout intermediate-key.pem -out "$work/host.csr"
printf '%s\n' 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  'keyUsage=critical,keyCertSign,cRLSign' 'subjectKeyIdentifier=hash' \
  'authorityKeyIdentifier=keyid' > "$work/host.ext"
openssl x509 -req -in "$work/host.csr" -CA root.pem -CAkey "$work/root-key.pem" \
  -days 6 -extfile "$work/host.ext" -out intermediate.pem
chmod 0644 root.pem intermediate.pem
