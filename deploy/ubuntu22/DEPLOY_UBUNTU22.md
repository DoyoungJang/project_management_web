# Ubuntu 22.04 Deployment Guide

## Stack
- `nginx`: reverse proxy on `:80`
- `uvicorn (systemd)`: FastAPI app on `127.0.0.1:8001`
- `redis-server`: local-only (`127.0.0.1`), infra-ready
- `sqlite`: persistent DB at `/opt/project_management_web/shared/project_manager.db`

## 1) Bootstrap server
```bash
cd /path/to/project_management_web
chmod +x deploy/ubuntu22/*.sh
sudo bash deploy/ubuntu22/setup_server.sh
```

## 2) Deploy app
```bash
sudo bash deploy/ubuntu22/deploy_app.sh /path/to/project_management_web <SERVER_IP_OR_DOMAIN>
```

Example:
```bash
sudo bash deploy/ubuntu22/deploy_app.sh /home/ubuntu/project_management_web 192.168.0.20
```

## 3) Set production environment
```bash
sudo vi /opt/project_management_web/shared/.env
sudo systemctl restart project-management-web
```

Minimum required changes:
- `BOOTSTRAP_ADMIN_PASSWORD`: strong password
- `CORS_ALLOW_ORIGINS`: actual web address(es)
- `SESSION_COOKIE_SECURE=1` when HTTPS is enabled

## 4) Verify
```bash
curl -i http://<SERVER_IP_OR_DOMAIN>/api/health
systemctl status project-management-web --no-pager
systemctl status nginx --no-pager
systemctl status redis-server --no-pager
```

## 5) Logs
```bash
journalctl -u project-management-web -f
journalctl -u nginx -f
journalctl -u redis-server -f
```

## Automatic Deploy Options
### A. One-command bootstrap + deploy
```bash
sudo bash deploy/ubuntu22/auto_deploy.sh /path/to/project_management_web <SERVER_IP_OR_DOMAIN>
```

### B. Periodic git pull + redeploy (systemd timer)
Use this only when server has a git clone of this repository.
```bash
sudo bash deploy/ubuntu22/install_autodeploy_timer.sh /path/to/project_management_web <SERVER_IP_OR_DOMAIN> main 5
```
- Checks every `5` minutes (last argument).
- Pulls `origin/main` (third argument).
- Runs deploy only if commit changed.

Useful commands:
```bash
systemctl list-timers | grep project-management-autodeploy
systemctl status project-management-autodeploy.timer --no-pager
systemctl start project-management-autodeploy.service
journalctl -u project-management-autodeploy.service -f
```

## Notes
- Current application does not require Redis at runtime yet.
- Redis is installed and hardened for future session/cache/rate-limit extensions.
- For SQLite stability, keep Uvicorn workers at `1` (default in deploy script).
