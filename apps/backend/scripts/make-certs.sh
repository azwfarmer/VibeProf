#!/usr/bin/env bash
# Generate a local CA + SAN-scoped server cert so the backend can serve HTTPS.
# Microphone/WebRTC require a secure context; HTTPS provides one over the LAN/iPad.
# Re-run with extra hostnames/IPs as arguments, e.g.:
#   ./make-certs.sh 192.168.1.50 my-mac.local
# The CA is reused across runs so devices only trust it once; pass --new-ca to start fresh:
#   ./make-certs.sh --new-ca 192.168.1.50
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/certs"
mkdir -p "$DIR"

# Optional --new-ca flag: force a fresh CA (discards the old one). Parse it before
# collecting SANs so it is never mistaken for a hostname.
FORCE_NEW_CA=0
if [ "${1:-}" = "--new-ca" ]; then FORCE_NEW_CA=1; shift; fi

# Collect SAN entries: always cover localhost + loopback, plus auto-detected LAN IPs,
# plus any extra hosts/IPs passed as arguments.
DNS=("localhost")
IPS=("127.0.0.1" "::1")
while IFS= read -r ip; do [ -n "$ip" ] && IPS+=("$ip"); done < <(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '127.0.0.1' || true)
for arg in "$@"; do
  if [[ "$arg" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then IPS+=("$arg"); else DNS+=("$arg"); fi
done

ALT=""
i=1; for d in "${DNS[@]}"; do ALT+="DNS.$i = $d"$'\n'; i=$((i+1)); done
i=1; for p in "${IPS[@]}"; do ALT+="IP.$i = $p"$'\n'; i=$((i+1)); done

# 1) Local CA (import/trust this on the iPad). Reuse an existing CA when present so
# you only trust it once per device. Regenerating the CA would invalidate every device
# that already trusts it, so we only mint a new one when none exists. Pass --new-ca to
# force a fresh CA (e.g. if the key was compromised or you want to start clean).
if [ "$FORCE_NEW_CA" = "1" ]; then rm -f "$DIR/local-ca-key.pem" "$DIR/local-ca.cer" "$DIR/local-ca.srl"; fi

if [ -f "$DIR/local-ca-key.pem" ] && [ -f "$DIR/local-ca.cer" ]; then
  echo "Reusing existing local CA at $DIR/local-ca.cer (already-trusted devices stay valid)."
else
  echo "Creating a new local CA — trust $DIR/local-ca.cer on each device (Mac keychain / iPad profile)."
  openssl genrsa -out "$DIR/local-ca-key.pem" 2048
  openssl req -x509 -new -nodes -key "$DIR/local-ca-key.pem" -sha256 -days 825 \
    -subj "/CN=AI Tutor Local CA" -out "$DIR/local-ca.cer"
fi

# 2) Server key + CSR.
openssl genrsa -out "$DIR/server-key.pem" 2048
openssl req -new -key "$DIR/server-key.pem" -subj "/CN=AI Tutor" -out "$DIR/server.csr"

# 3) Sign the server cert with the CA, embedding the SANs.
cat > "$DIR/server-ext.cnf" <<EOF
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
$ALT
EOF

openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/local-ca.cer" -CAkey "$DIR/local-ca-key.pem" \
  -CAcreateserial -days 825 -sha256 -extfile "$DIR/server-ext.cnf" -out "$DIR/server-cert.pem"

rm -f "$DIR/server.csr" "$DIR/server-ext.cnf"
echo "Certs written to $DIR"
ls -1 "$DIR"
