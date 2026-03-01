#!/usr/bin/env bash
set -euo pipefail

# One-command deployment for Ubuntu 22.04
#
# Usage:
#   sudo bash deploy/ubuntu22/auto_deploy.sh /path/to/project_management_web 192.168.0.20
#
# Behavior:
# - If base components are missing, runs setup_server.sh
# - Always runs deploy_app.sh

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Run as root: sudo bash deploy/ubuntu22/auto_deploy.sh <SOURCE_DIR> <SERVER_NAME>"
  exit 1
fi

SOURCE_DIR="${1:-}"
SERVER_NAME="${2:-}"
if [[ -z "${SOURCE_DIR}" || -z "${SERVER_NAME}" ]]; then
  echo "Usage: sudo bash deploy/ubuntu22/auto_deploy.sh <SOURCE_DIR> <SERVER_IP_OR_DOMAIN>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="${APP_USER:-pmweb}"

NEED_SETUP=0
if ! command -v nginx >/dev/null 2>&1; then
  NEED_SETUP=1
fi
if ! command -v redis-server >/dev/null 2>&1; then
  NEED_SETUP=1
fi
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  NEED_SETUP=1
fi

if [[ "${NEED_SETUP}" -eq 1 ]]; then
  echo "[auto] Base setup is missing. Running setup_server.sh ..."
  bash "${SCRIPT_DIR}/setup_server.sh"
else
  echo "[auto] Base setup looks ready. Skipping setup_server.sh."
fi

echo "[auto] Running deploy_app.sh ..."
bash "${SCRIPT_DIR}/deploy_app.sh" "${SOURCE_DIR}" "${SERVER_NAME}"

echo "[auto] Done."
