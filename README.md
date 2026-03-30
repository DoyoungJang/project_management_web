# Project Management Web

사내 프로젝트와 작업을 웹에서 관리하는 FastAPI 기반 애플리케이션입니다.

- 백엔드: `FastAPI`
- 애플리케이션 서버: `Uvicorn`
- 데이터베이스: `SQLite`
- 프론트엔드: 정적 HTML/CSS/JavaScript

현재 저장소의 실행/배포 기준 서버는 `Gunicorn`이 아니라 `Uvicorn`입니다.  
`requirements.txt`에 `uvicorn`이 포함되어 있으므로 별도 서버 패키지를 따로 설치할 필요는 없습니다.

## 현재 포함된 주요 화면

- 로그인 / 회원가입
- 메인 대시보드
- 프로젝트 작업 보드
- 프로젝트 설정 / 작업 추가·관리
- 프로젝트 간트 차트
- 프로젝트 캘린더
- 템플릿 관리 / 템플릿 선택 백업
- 내 설정
- 관리자 페이지

상세한 화면 설명은 [docs/PAGE_GUIDE_KO.md](docs/PAGE_GUIDE_KO.md)를 참고하세요.

## 1. 로컬 실행 방법

### Windows PowerShell 기준

프로젝트 루트에서 아래 순서대로 실행합니다.

```powershell
cd c:\Users\doyoungjang\PycharmProjects\project_management_web
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

`.env`를 연 뒤 최소한 아래 값은 실제 환경에 맞게 수정하는 것을 권장합니다.

- `BOOTSTRAP_ADMIN_PASSWORD`
- `CORS_ALLOW_ORIGINS`
- `SESSION_COOKIE_SECURE`

그 다음 실행합니다.

### 방법 A. 편의 스크립트 사용

```powershell
.\run_server.ps1
```

기본 실행 주소:

- `http://127.0.0.1:8080`
- `http://localhost:8080`

`run_server.ps1`는 프로젝트 루트의 `.env`를 읽고, 값이 없으면 로컬 테스트용 기본값을 일부 채워 넣은 뒤 Uvicorn을 실행합니다.

포트나 호스트를 바꾸고 싶으면 다음처럼 실행합니다.

```powershell
.\run_server.ps1 -Host 0.0.0.0 -Port 8080
```

### 방법 B. Uvicorn 직접 실행

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8080 --reload
```

`--reload`는 개발 중 자동 재시작용 옵션입니다. 운영 서버에서는 보통 사용하지 않습니다.

## 2. 가상환경과 패키지 설치 기준

`requirements.txt`에는 현재 아래 패키지가 포함되어 있습니다.

- `fastapi`
- `pydantic`
- `pydantic-core`
- `uvicorn`

즉, "가상환경 생성 -> requirements 설치"까지만 완료하면 Uvicorn 서버까지 함께 설치됩니다.

## 3. 주요 환경 변수

`.env.example`를 복사해서 `.env`로 사용하는 것을 권장합니다.

| 변수명 | 용도 | 비고 |
| --- | --- | --- |
| `BOOTSTRAP_ADMIN_USERNAME` | 초기 관리자 아이디 | 기본값 `admin` |
| `BOOTSTRAP_ADMIN_DISPLAY_NAME` | 초기 관리자 표시 이름 | 기본값 `System Admin` |
| `BOOTSTRAP_ADMIN_PASSWORD` | 초기 관리자 비밀번호 | 비워 두면 관리자 생성 시 임시 비밀번호가 콘솔에 출력됨 |
| `CORS_ALLOW_ORIGINS` | 허용할 웹 Origin 목록 | 쉼표로 구분 |
| `SESSION_COOKIE_SECURE` | HTTPS 전용 쿠키 여부 | 로컬 HTTP는 `0`, HTTPS 운영은 `1` 권장 |
| `SESSION_COOKIE_SAMESITE` | 세션 쿠키 SameSite 정책 | 기본값 `lax` |
| `LOGIN_WINDOW_SECONDS` | 로그인 시도 집계 시간 창 | 무차별 대입 방지용 |
| `LOGIN_LOCKOUT_SECONDS` | 로그인 잠금 시간 | 무차별 대입 방지용 |
| `LOGIN_MAX_ATTEMPTS_USER_IP` | 사용자+IP 기준 허용 시도 횟수 | 무차별 대입 방지용 |
| `LOGIN_MAX_ATTEMPTS_IP` | IP 기준 허용 시도 횟수 | 무차별 대입 방지용 |

## 4. 데이터와 주요 경로

- 애플리케이션 진입점: `app/main.py`
- 정적 페이지 경로: `app/static/`
- 로컬 SQLite 파일: `app/project_manager.db`
- 로컬 실행 스크립트: `run_server.ps1`
- 환경 변수 예시: `.env.example`

`/` 요청은 FastAPI가 `app/static/index.html`을 반환하고, `/static/*` 경로는 정적 파일로 마운트되어 있습니다.

## 5. Ubuntu 22.04 서버 배포

운영 배포는 현재 `nginx + systemd + uvicorn + sqlite` 기준으로 정리되어 있습니다.

### 빠른 배포 순서

1. 서버 초기 구성

```bash
cd /path/to/project_management_web
chmod +x deploy/ubuntu22/*.sh
sudo bash deploy/ubuntu22/setup_server.sh
```

2. 애플리케이션 배포

```bash
sudo bash deploy/ubuntu22/deploy_app.sh /path/to/project_management_web <SERVER_IP_OR_DOMAIN>
```

예시:

```bash
sudo bash deploy/ubuntu22/deploy_app.sh /home/ubuntu/project_management_web 192.168.0.20
```

3. 운영 환경 변수 수정

```bash
sudo vi /opt/project_management_web/shared/.env
```

4. 서비스 상태 확인

```bash
systemctl status project-management-web --no-pager
systemctl status nginx --no-pager
curl -i http://<SERVER_IP_OR_DOMAIN>/api/health
```

### 자동 배포 스크립트

초기 구성과 배포를 한 번에 진행하려면:

```bash
sudo bash deploy/ubuntu22/auto_deploy.sh /path/to/project_management_web <SERVER_IP_OR_DOMAIN>
```

주기적 `git pull + 재배포` 타이머를 설치하려면:

```bash
sudo bash deploy/ubuntu22/install_autodeploy_timer.sh /path/to/project_management_web <SERVER_IP_OR_DOMAIN> main 5
```

더 자세한 운영 절차는 [deploy/ubuntu22/DEPLOY_UBUNTU22.md](deploy/ubuntu22/DEPLOY_UBUNTU22.md)를 참고하세요.

## 6. 주의 사항

- 이 프로젝트는 현재 SQLite를 사용하므로, 운영 환경에서는 다중 worker 확장보다 단일 프로세스 안정성을 우선하는 편이 안전합니다.
- 관리자 계정이 하나도 없는 상태에서 앱이 처음 올라오면 부트스트랩 관리자 계정이 생성됩니다.
- `BOOTSTRAP_ADMIN_PASSWORD`를 비워 두면 임시 비밀번호가 콘솔에 출력될 수 있으므로, 운영 환경에서는 반드시 명시적으로 설정하세요.

## 7. 문서

- 화면별 상세 사용 가이드: [docs/PAGE_GUIDE_KO.md](docs/PAGE_GUIDE_KO.md)
- Ubuntu 배포 가이드: [deploy/ubuntu22/DEPLOY_UBUNTU22.md](deploy/ubuntu22/DEPLOY_UBUNTU22.md)
