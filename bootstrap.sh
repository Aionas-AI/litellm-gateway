#!/usr/bin/env bash
# Bootstrap a stateless LiteLLM gateway on a fresh Amazon Linux 2023 EC2 box.
# Run as: sudo bash bootstrap.sh
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  dnf install -y docker
  systemctl enable --now docker
  usermod -aG docker ec2-user || true
fi

# docker compose plugin
if ! docker compose version >/dev/null 2>&1; then
  echo "Installing docker compose plugin..."
  mkdir -p /usr/local/lib/docker/cli-plugins
  ARCH="$(uname -m)"
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

# docker buildx plugin (needed by `docker compose build`, requires >= 0.17;
# the distro docker package may ship an older one, so check the version)
BUILDX_OK=false
if docker buildx version >/dev/null 2>&1; then
  BUILDX_MINOR="$(docker buildx version | sed -E 's/.* v?[0-9]+\.([0-9]+).*/\1/')"
  BUILDX_MAJOR="$(docker buildx version | sed -E 's/.* v?([0-9]+)\..*/\1/')"
  if [ "${BUILDX_MAJOR}" -gt 0 ] || [ "${BUILDX_MINOR}" -ge 17 ]; then
    BUILDX_OK=true
  fi
fi
if [ "${BUILDX_OK}" != "true" ]; then
  echo "Installing docker buildx plugin..."
  mkdir -p /usr/local/lib/docker/cli-plugins
  ARCH="$(uname -m)"
  case "${ARCH}" in
    x86_64) BUILDX_ARCH=amd64 ;;
    aarch64) BUILDX_ARCH=arm64 ;;
    *) BUILDX_ARCH="${ARCH}" ;;
  esac
  BUILDX_URL="$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest \
    | grep browser_download_url | grep "linux-${BUILDX_ARCH}\"" | cut -d'"' -f4)"
  curl -fsSL "${BUILDX_URL}" -o /usr/local/lib/docker/cli-plugins/docker-buildx
  chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx
fi

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

# Domain-free deployment: if DOMAIN is unset or left at the placeholder, derive a
# magic-DNS hostname (<public-ip>.sslip.io) from the instance's public IP. sslip.io
# resolves it to the IP so Caddy can still obtain a real Let's Encrypt certificate —
# no domain purchase or DNS provider required.
DOMAIN="$(grep -E '^DOMAIN=' .env | head -n1 | cut -d= -f2- | tr -d '[:space:]')"
if [ -z "${DOMAIN}" ] || [ "${DOMAIN}" = "llm.example.com" ]; then
  TOKEN="$(curl -sf -X PUT 'http://169.254.169.254/latest/api/token' \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' || true)"
  PUBLIC_IP="$(curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" \
    http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
  if [ -n "${PUBLIC_IP}" ]; then
    DOMAIN="${PUBLIC_IP}.sslip.io"
    if grep -q '^DOMAIN=' .env; then
      sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
    else
      echo "DOMAIN=${DOMAIN}" >> .env
    fi
    echo "No domain set — using magic-DNS hostname: ${DOMAIN}"
  else
    echo "ERROR: DOMAIN is unset and no public IP was found via instance metadata." >&2
    echo "Set DOMAIN in .env manually (a hostname that resolves to this box)." >&2
    exit 1
  fi
fi

# Seed the runtime config from the committed base config on first run. After
# that, the key-manager service owns runtime/config.yaml (base + tenant keys).
mkdir -p runtime
if [ ! -f runtime/config.yaml ]; then
  cp config.yaml runtime/config.yaml
  chmod 600 runtime/config.yaml
  echo "Seeded runtime/config.yaml from config.yaml"
fi

echo "Starting gateway..."
docker compose pull
docker compose build
docker compose up -d
echo "Done. Check: docker compose ps"
