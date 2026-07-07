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

echo "Starting gateway..."
docker compose pull
docker compose up -d
echo "Done. Check: docker compose ps"
