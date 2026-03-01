# Project Management Web

사내망에서 사용하는 프로젝트 관리 웹앱입니다. (FastAPI + SQLite)

## 주요 기능
- 프로젝트/작업/체크리스트 관리
- 체크리스트 목표일(`target_date`) 관리
- 프로젝트별 알림 규칙(D-1, D-3 등) 다중 설정
- Trello 스타일 작업 보드(`upcoming / inprogress / done`) + 드래그앤드롭
- 체크박스 완료 처리와 보드 상태 동시 관리
- 템플릿 기반 단계(stage) 작업 구성
- 로그인 후 마감 임박 작업 확인

## 실행 방법
```powershell
cd c:\Users\doyoungjang\PycharmProjects\project_management_web
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## 서버 구축 가이드 (Ubuntu 22.04)
권장 구성:
- OS: Ubuntu Server 22.04 LTS
- CPU/RAM: 2 vCPU / 4GB RAM 이상
- 디스크: 20GB 이상 (SQLite DB/로그 증가 고려)
- 네트워크: 내부망 고정 IP 또는 내부 DNS 권장

서버 구성 요소:
- `nginx`: 외부(내부망 사용자) 요청 수신
- `uvicorn + systemd`: FastAPI 애플리케이션 실행/자동 재시작
- `redis-server`: 로컬 전용으로 설치(현재 앱 필수는 아님, 확장 대비)
- `sqlite`: `/opt/project_management_web/shared/project_manager.db`에 영구 저장

포트 정책(기본):
- 외부 오픈: `80/tcp` (nginx)
- 내부 전용: `127.0.0.1:8001` (uvicorn), `127.0.0.1:6379` (redis)

사전 준비 체크:
1. 코드 위치 확정 (예: `/srv/project_management_web` 또는 `/home/ubuntu/project_management_web`)
2. 접속 주소 확정 (`<SERVER_IP_OR_DOMAIN>`)
3. 운영 환경변수 값 준비 (`BOOTSTRAP_ADMIN_PASSWORD`, `CORS_ALLOW_ORIGINS` 등)
4. HTTPS 사용 여부 결정 (HTTPS면 `SESSION_COOKIE_SECURE=1`)

## Ubuntu 22.04 배포 (nginx + systemd + redis)
아래 스크립트 2개로 서버 초기 구성과 앱 배포를 분리했습니다.
상세 운영 가이드는 `deploy/ubuntu22/DEPLOY_UBUNTU22.md`를 참고하세요.

1. 서버 초기 구성 (패키지 설치, nginx/redis 활성화, 배포 계정/디렉터리 생성)
```bash
cd /path/to/project_management_web
chmod +x deploy/ubuntu22/*.sh
sudo bash deploy/ubuntu22/setup_server.sh
```

2. 앱 배포 (코드 동기화, venv 설치, systemd 서비스/ nginx 설정 생성)
```bash
sudo bash deploy/ubuntu22/deploy_app.sh /path/to/project_management_web <SERVER_IP_OR_DOMAIN>
```

3. 환경변수 수정 (운영 필수)
```bash
sudo vi /opt/project_management_web/shared/.env
```

4. 서비스 상태/헬스체크
```bash
systemctl status project-management-web
systemctl status nginx
systemctl status redis-server
curl -i http://<SERVER_IP_OR_DOMAIN>/api/health
```

### 자동 배포(원클릭)
수동 2단계 대신 아래 한 줄로 초기 구성 + 앱 배포를 자동 처리할 수 있습니다.
```bash
sudo bash deploy/ubuntu22/auto_deploy.sh /path/to/project_management_web <SERVER_IP_OR_DOMAIN>
```

### 자동 배포(주기적 git pull + 재배포)
서버에 git 저장소가 있을 때, 변경이 생기면 자동으로 pull 후 재배포하도록 timer를 설치합니다.
```bash
sudo bash deploy/ubuntu22/install_autodeploy_timer.sh /path/to/project_management_web <SERVER_IP_OR_DOMAIN> main 5
```
위 예시는 5분마다 `origin/main` 변경 여부를 확인하고, 변경 시 자동 재배포합니다.

주의:
- 현재 앱은 Redis를 필수로 사용하지는 않지만, 운영 확장 대비로 함께 구성합니다.
- HTTPS를 적용하면 `.env`의 `SESSION_COOKIE_SECURE=1`로 변경하세요.
- SQLite 특성상 Uvicorn worker는 1개를 권장합니다(스크립트 기본값).

## 기본 관리자 계정
- `BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD`

## 관련 API
- `GET /api/my/checklists/upcoming?days=30`
- `GET /api/projects/{project_id}/notifications/preview?days=30`
- `GET /api/projects/{project_id}/notification-rules`
- `POST /api/projects/{project_id}/notification-rules`
- `DELETE /api/notification-rules/{rule_id}`
