#!/usr/bin/env bash
set -euo pipefail

# Auto update from git and redeploy when changed.
#
# Usage:
#   sudo bash deploy/ubuntu22/auto_update_from_git.sh /srv/project_management_web 192.168.0.20 main

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Run as root."
  exit 1
fi

REPO_DIR="${1:-}"
SERVER_NAME="${2:-}"
BRANCH="${3:-main}"

if [[ -z "${REPO_DIR}" || -z "${SERVER_NAME}" ]]; then
  echo "Usage: sudo bash deploy/ubuntu22/auto_update_from_git.sh <REPO_DIR> <SERVER_NAME> [BRANCH]"
  exit 1
fi
if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "[ERROR] REPO_DIR is not a git repository: ${REPO_DIR}"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="/tmp/project-management-autodeploy.lock"

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "[auto-update] Another deployment is already running. Skip."
  exit 0
fi

cd "${REPO_DIR}"

if ! git fetch origin "${BRANCH}"; then
  echo "[auto-update] git fetch failed."
  exit 1
fi

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/${BRANCH}")"

if [[ "${LOCAL_SHA}" == "${REMOTE_SHA}" ]]; then
  echo "[auto-update] No changes on origin/${BRANCH}. Skip deploy."
  exit 0
fi

echo "[auto-update] Changes detected. Pulling origin/${BRANCH} ..."
git pull --ff-only origin "${BRANCH}"

echo "[auto-update] Running auto_deploy ..."
bash "${SCRIPT_DIR}/auto_deploy.sh" "${REPO_DIR}" "${SERVER_NAME}"

echo "[auto-update] Completed."
