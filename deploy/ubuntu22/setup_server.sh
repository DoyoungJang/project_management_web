#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   sudo bash deploy/ubuntu22/setup_server.sh
#
# What this script does:
# 1) Install runtime packages (nginx, redis, python venv, build tools)
# 2) Create service user and deployment directories
# 3) Harden redis for local-only access

APP_USER="${APP_USER:-pmweb}"
APP_GROUP="${APP_GROUP:-pmweb}"
APP_ROOT="${APP_ROOT:-/opt/project_management_web}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Run as root: sudo bash deploy/ubuntu22/setup_server.sh"
  exit 1
fi

echo "[1/5] Installing packages..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  python3 \
  python3-venv \
  python3-pip \
  python3-dev \
  build-essential \
  nginx \
  redis-server \
  rsync \
  curl \
  ufw

echo "[2/5] Creating app user/group..."
if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${APP_GROUP}"
fi
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${APP_GROUP}" --home-dir "${APP_ROOT}" --shell /usr/sbin/nologin "${APP_USER}"
fi

echo "[3/5] Creating deployment directories..."
mkdir -p "${APP_ROOT}/current" "${APP_ROOT}/shared" "${APP_ROOT}/logs"
chown -R "${APP_USER}:${APP_GROUP}" "${APP_ROOT}"
chmod 750 "${APP_ROOT}"

echo "[4/5] Configuring redis (local-only)..."
REDIS_CONF="/etc/redis/redis.conf"
if [[ -f "${REDIS_CONF}" ]]; then
  sed -i "s/^#\?bind .*/bind 127.0.0.1 ::1/" "${REDIS_CONF}"
  sed -i "s/^#\?protected-mode .*/protected-mode yes/" "${REDIS_CONF}"
  sed -i "s/^#\?supervised .*/supervised systemd/" "${REDIS_CONF}"
fi
systemctl enable --now redis-server

echo "[5/5] Enabling nginx and base firewall profile..."
systemctl enable --now nginx
ufw allow OpenSSH || true
ufw allow "Nginx Full" || true

echo
echo "Server bootstrap complete."
echo "Next:"
echo "1) Copy project source to the server."
echo "2) Run: sudo bash deploy/ubuntu22/deploy_app.sh <SOURCE_DIR> <SERVER_IP_OR_DOMAIN>"
