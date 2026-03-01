#!/usr/bin/env bash
set -euo pipefail

# Install systemd timer for periodic git-based auto deploy.
#
# Usage:
#   sudo bash deploy/ubuntu22/install_autodeploy_timer.sh /srv/project_management_web 192.168.0.20 main 5
#
# Args:
#   1) REPO_DIR
#   2) SERVER_NAME
#   3) BRANCH (default: main)
#   4) INTERVAL_MINUTES (default: 5)

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Run as root."
  exit 1
fi

REPO_DIR="${1:-}"
SERVER_NAME="${2:-}"
BRANCH="${3:-main}"
INTERVAL_MINUTES="${4:-5}"

if [[ -z "${REPO_DIR}" || -z "${SERVER_NAME}" ]]; then
  echo "Usage: sudo bash deploy/ubuntu22/install_autodeploy_timer.sh <REPO_DIR> <SERVER_NAME> [BRANCH] [INTERVAL_MINUTES]"
  exit 1
fi
if [[ ! -d "${REPO_DIR}" ]]; then
  echo "[ERROR] REPO_DIR not found: ${REPO_DIR}"
  exit 1
fi
if ! [[ "${INTERVAL_MINUTES}" =~ ^[0-9]+$ ]] || [[ "${INTERVAL_MINUTES}" -lt 1 ]]; then
  echo "[ERROR] INTERVAL_MINUTES must be an integer >= 1."
  exit 1
fi

SERVICE_NAME="project-management-autodeploy"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
TIMER_PATH="/etc/systemd/system/${SERVICE_NAME}.timer"

cat > "${SERVICE_PATH}" <<EOF
[Unit]
Description=Project Management Web auto deploy from git
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${REPO_DIR}/deploy/ubuntu22/auto_update_from_git.sh ${REPO_DIR} ${SERVER_NAME} ${BRANCH}
WorkingDirectory=${REPO_DIR}
EOF

cat > "${TIMER_PATH}" <<EOF
[Unit]
Description=Run Project Management auto deploy every ${INTERVAL_MINUTES} minute(s)

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL_MINUTES}min
Persistent=true
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.timer"

echo "Installed timer: ${SERVICE_NAME}.timer"
echo "Check: systemctl list-timers | grep ${SERVICE_NAME}"
echo "Manual run: systemctl start ${SERVICE_NAME}.service"
