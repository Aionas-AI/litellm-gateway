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

echo "Starting gateway..."
docker compose pull
docker compose up -d
echo "Done. Check: docker compose ps"
