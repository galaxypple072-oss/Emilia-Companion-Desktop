#!/usr/bin/env bash
# Emilia Companion private relay bootstrapper for Ubuntu/Debian.
# It is intentionally safe to rerun: an existing .env keeps its private path
# and pairing code, while the containers are rebuilt from the selected branch.
set -Eeuo pipefail

REPO_URL="https://github.com/galaxypple072-oss/Emilia-Companion-Desktop.git"
BRANCH="main"
INSTALL_DIR="/opt/emilia-relay"
DOMAIN=""

usage() {
  echo "Usage: sudo bash install-relay-ubuntu.sh --domain relay.example.com [--dir /opt/emilia-relay]"
}

while (($#)); do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID} -ne 0 ]]; then echo "Please run this installer with sudo." >&2; exit 1; fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || [[ "$DOMAIN" != *.* ]]; then
  echo "--domain must be a public DNS name, for example relay.example.com" >&2; exit 2
fi
if [[ "$INSTALL_DIR" != /opt/* ]]; then echo "--dir must be below /opt" >&2; exit 2; fi

echo "[1/5] Installing prerequisites…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl tar openssl docker.io docker-compose-plugin
systemctl enable --now docker

echo "[2/5] Downloading the relay release…"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
curl --fail --location --silent --show-error "${REPO_URL%/.git}/archive/refs/heads/${BRANCH}.tar.gz" -o "$WORK_DIR/source.tar.gz"
mkdir -p "$WORK_DIR/source"
tar -xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR/source" --strip-components=1
test -f "$WORK_DIR/source/infra/relay/compose.yml"
test -f "$WORK_DIR/source/apps/companion-relay/src/server.ts"

mkdir -p "$INSTALL_DIR/infra" "$INSTALL_DIR/apps/companion-relay/src"
cp -a "$WORK_DIR/source/infra/relay/." "$INSTALL_DIR/infra/relay/"
cp -a "$WORK_DIR/source/apps/companion-relay/package.json" "$INSTALL_DIR/apps/companion-relay/"
cp -a "$WORK_DIR/source/apps/companion-relay/src/server.ts" "$INSTALL_DIR/apps/companion-relay/src/"

ENV_FILE="$INSTALL_DIR/infra/relay/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  RELAY_PATH="/$(openssl rand -hex 24)"
  RELAY_SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  PAIRING_CODE="emilia1.core-$(cat /proc/sys/kernel/random/uuid).${RELAY_SECRET}"
  umask 077
  printf 'RELAY_DOMAIN=%s\nRELAY_PATH=%s\nRELAY_PAIRING_CODE=%s\n' "$DOMAIN" "$RELAY_PATH" "$PAIRING_CODE" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  RELAY_DOMAIN="$(sed -n 's/^RELAY_DOMAIN=//p' "$ENV_FILE" | head -n1)"
  if [[ "$RELAY_DOMAIN" != "$DOMAIN" ]]; then
    echo "Existing relay belongs to $RELAY_DOMAIN; refusing to replace it with $DOMAIN." >&2; exit 1
  fi
fi

echo "[3/5] Opening local firewall ports when UFW is active…"
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
fi

echo "[4/5] Starting encrypted relay and TLS proxy…"
cd "$INSTALL_DIR"
docker compose --env-file infra/relay/.env -f infra/relay/compose.yml up -d --build

echo "[5/5] Checking services…"
docker compose --env-file infra/relay/.env -f infra/relay/compose.yml ps
RELAY_PATH="$(sed -n 's/^RELAY_PATH=//p' "$ENV_FILE" | head -n1)"
PAIRING_CODE="$(sed -n 's/^RELAY_PAIRING_CODE=//p' "$ENV_FILE" | head -n1)"
cat <<EOF

Emilia private relay is installed.

In the Windows Core app, open Settings → Private relay connection and paste:
  Relay address: wss://${DOMAIN}${RELAY_PATH}
  Pairing code:  ${PAIRING_CODE}

Then click “Save relay and restart Core”, wait for it to become online, and click
“Generate relay connection code” for each additional device.

Keep the pairing code private. Before TLS can finish, ensure this server's DNS A/AAAA
record points to it and the cloud firewall permits TCP 80 and TCP/UDP 443.
EOF
