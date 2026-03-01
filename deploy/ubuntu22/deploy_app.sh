#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   sudo bash deploy/ubuntu22/deploy_app.sh /path/to/project_management_web 192.168.0.10
#   sudo APP_PORT=8001 APP_USER=pmweb APP_ROOT=/opt/project_management_web \
#        bash deploy/ubuntu22/deploy_app.sh /srv/src/project_management_web pm.example.local
#
# Notes:
# - This script deploys FastAPI behind nginx + systemd.
# - Redis is installed by setup_server.sh and kept local-only. Current app does not require Redis.

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Run as root: sudo bash deploy/ubuntu22/deploy_app.sh <SOURCE_DIR> <SERVER_NAME>"
  exit 1
fi

SOURCE_DIR="${1:-}"
SERVER_NAME="${2:-}"
if [[ -z "${SOURCE_DIR}" || -z "${SERVER_NAME}" ]]; then
  echo "Usage: sudo bash deploy/ubuntu22/deploy_app.sh <SOURCE_DIR> <SERVER_IP_OR_DOMAIN>"
  exit 1
fi
if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "[ERROR] SOURCE_DIR not found: ${SOURCE_DIR}"
  exit 1
fi
if [[ ! -f "${SOURCE_DIR}/app/main.py" || ! -f "${SOURCE_DIR}/requirements.txt" ]]; then
  echo "[ERROR] SOURCE_DIR must be project_management_web root (missing app/main.py or requirements.txt)."
  exit 1
fi

APP_USER="${APP_USER:-pmweb}"
APP_GROUP="${APP_GROUP:-pmweb}"
APP_ROOT="${APP_ROOT:-/opt/project_management_web}"
APP_PORT="${APP_PORT:-8001}"
SERVICE_NAME="${SERVICE_NAME:-project-management-web}"
VENV_PATH="${APP_ROOT}/venv"
CURRENT_PATH="${APP_ROOT}/current"
SHARED_PATH="${APP_ROOT}/shared"
SYSTEMD_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
NGINX_SITE_PATH="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
NGINX_LINK_PATH="/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  echo "[ERROR] APP_USER '${APP_USER}' does not exist. Run setup_server.sh first."
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "[ERROR] systemctl not found."
  exit 1
fi
if ! command -v nginx >/dev/null 2>&1; then
  echo "[ERROR] nginx not found. Run setup_server.sh first."
  exit 1
fi

echo "[1/8] Preparing directories..."
mkdir -p "${CURRENT_PATH}" "${SHARED_PATH}" "${APP_ROOT}/logs"

echo "[2/8] Syncing source code..."
rsync -a --delete \
  --exclude ".git" \
  --exclude ".venv" \
  --exclude "__pycache__" \
  --exclude "*.pyc" \
  --exclude "app/project_manager.db" \
  "${SOURCE_DIR}/" "${CURRENT_PATH}/"

echo "[3/8] Preparing environment and persistent DB..."
if [[ ! -f "${SHARED_PATH}/.env" ]]; then
  cp "${CURRENT_PATH}/deploy/ubuntu22/env.production.example" "${SHARED_PATH}/.env"
  echo "[INFO] Created ${SHARED_PATH}/.env from template. Edit it before production use."
fi
ln -sfn "${SHARED_PATH}/.env" "${CURRENT_PATH}/.env"

touch "${SHARED_PATH}/project_manager.db"
ln -sfn "${SHARED_PATH}/project_manager.db" "${CURRENT_PATH}/app/project_manager.db"

echo "[4/8] Building Python virtualenv..."
if [[ ! -x "${VENV_PATH}/bin/python3" ]]; then
  python3 -m venv "${VENV_PATH}"
fi
"${VENV_PATH}/bin/pip" install --upgrade pip wheel
"${VENV_PATH}/bin/pip" install -r "${CURRENT_PATH}/requirements.txt"

echo "[5/8] Writing systemd service..."
cat > "${SYSTEMD_PATH}" <<EOF
[Unit]
Description=Project Management Web (FastAPI/Uvicorn)
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${CURRENT_PATH}
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=${SHARED_PATH}/.env
ExecStart=${VENV_PATH}/bin/uvicorn app.main:app --host 127.0.0.1 --port ${APP_PORT} --workers 1
Restart=always
RestartSec=3
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

echo "[6/8] Writing nginx site config..."
cat > "${NGINX_SITE_PATH}" <<EOF
server {
    listen 80;
    server_name ${SERVER_NAME};

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sfn "${NGINX_SITE_PATH}" "${NGINX_LINK_PATH}"
rm -f /etc/nginx/sites-enabled/default
nginx -t

echo "[7/8] Setting ownership/permissions..."
chown -R "${APP_USER}:${APP_GROUP}" "${APP_ROOT}"
chmod 750 "${APP_ROOT}" "${CURRENT_PATH}" "${SHARED_PATH}" || true
chmod 640 "${SHARED_PATH}/.env" || true

echo "[8/8] Restarting services..."
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
systemctl restart nginx

echo
echo "Deploy complete."
echo "Service:  systemctl status ${SERVICE_NAME}"
echo "Nginx:    systemctl status nginx"
echo "Health:   curl -i http://${SERVER_NAME}/api/health"
echo
echo "IMPORTANT:"
echo "- Edit ${SHARED_PATH}/.env and set BOOTSTRAP_ADMIN_PASSWORD to a strong value."
echo "- If using HTTPS reverse proxy, set SESSION_COOKIE_SECURE=1 in ${SHARED_PATH}/.env."
