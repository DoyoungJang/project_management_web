# Project Management Web

내부망용 프로젝트 관리 웹앱입니다. (FastAPI + SQLite)

## 주요 기능
- 프로젝트/업무/체크리스트 관리
- 체크리스트 목표일(`target_date`) 관리
- 프로젝트별 알림 규칙(D-1, D-3 등) 다중 설정
- 체크리스트 Trello 스타일 보드(`upcoming / inprogress / done`) + 드래그앤드롭
- 체크박스 완료 처리와 보드 상태 동기화
- 템플릿 항목에 과정(stage) 태그 표시
- 로그인 후 첫 화면에서 내 프로젝트의 마감 임박 체크리스트 표시

## 실행
```powershell
cd c:\Users\doyoungjang\PycharmProjects\project_management_web
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## 기본 관리자 계정
- `admin / admin123!`

## 관련 API
- `GET /api/my/checklists/upcoming?days=30`
- `GET /api/projects/{project_id}/notifications/preview?days=30`
- `GET /api/projects/{project_id}/notification-rules`
- `POST /api/projects/{project_id}/notification-rules`
- `DELETE /api/notification-rules/{rule_id}`
