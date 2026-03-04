from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Cookie, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
DB_PATH = BASE_DIR / "project_manager.db"
STATIC_DIR = BASE_DIR / "static"
SESSION_HOURS = 12
SESSION_COOKIE_NAME = "session_token"
CSRF_COOKIE_NAME = "csrf_token"
SAFE_SAMESITE_VALUES = {"lax", "strict", "none"}
DEFAULT_CORS_ORIGINS = ["http://127.0.0.1:8000", "http://127.0.0.1:8080", "http://localhost:8000", "http://localhost:8080"]
CSRF_EXEMPT_PATHS = {"/api/auth/login", "/api/auth/register", "/api/health"}
DEFAULT_PROJECT_STAGES = [
    {"key": "data_acquisition", "name": "1. 데이터 획득"},
    {"key": "labeling", "name": "2. 라벨링"},
    {"key": "development", "name": "3. 개발"},
]


def load_env_file(env_path: Path) -> None:
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_env_file(PROJECT_ROOT / ".env")


def parse_bool_env(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def parse_int_env(name: str, default: str, min_value: int, max_value: int) -> int:
    raw = os.getenv(name, default).strip()
    try:
        value = int(raw)
    except ValueError:
        value = int(default)
    if value < min_value:
        return min_value
    if value > max_value:
        return max_value
    return value


def parse_allowed_origins(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


CORS_ALLOW_ORIGINS = parse_allowed_origins(os.getenv("CORS_ALLOW_ORIGINS")) or DEFAULT_CORS_ORIGINS
SESSION_COOKIE_SECURE = parse_bool_env("SESSION_COOKIE_SECURE", "0")
SESSION_COOKIE_SAMESITE = os.getenv("SESSION_COOKIE_SAMESITE", "lax").strip().lower()
if SESSION_COOKIE_SAMESITE not in SAFE_SAMESITE_VALUES:
    SESSION_COOKIE_SAMESITE = "lax"
LOGIN_WINDOW_SECONDS = parse_int_env("LOGIN_WINDOW_SECONDS", "300", 60, 86400)
LOGIN_LOCKOUT_SECONDS = parse_int_env("LOGIN_LOCKOUT_SECONDS", "900", 60, 604800)
LOGIN_MAX_ATTEMPTS_USER_IP = parse_int_env("LOGIN_MAX_ATTEMPTS_USER_IP", "5", 1, 100)
LOGIN_MAX_ATTEMPTS_IP = parse_int_env("LOGIN_MAX_ATTEMPTS_IP", "20", 1, 300)

CSP_POLICY = (
    "default-src 'self'; "
    "img-src 'self' data:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'unsafe-inline'; "
    "connect-src 'self'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)

app = FastAPI(title="Project Management API", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-CSRF-Token"],
)


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    path = request.url.path
    method = request.method.upper()

    if path.startswith("/api/") and method in {"POST", "PUT", "PATCH", "DELETE"} and path not in CSRF_EXEMPT_PATHS:
        session_token = request.cookies.get(SESSION_COOKIE_NAME)
        if session_token:
            csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME, "")
            csrf_header = request.headers.get("X-CSRF-Token", "")

            if not csrf_cookie or not csrf_header or not hmac.compare_digest(csrf_cookie, csrf_header):
                return JSONResponse(status_code=403, content={"detail": "CSRF validation failed."})

            with get_db() as conn:
                session = conn.execute(
                    "SELECT csrf_token, expires_at FROM user_sessions WHERE session_token=?",
                    (session_token,),
                ).fetchone()

            now_ts = int(time.time())
            if not session or int(session["expires_at"]) <= now_ts:
                return JSONResponse(status_code=401, content={"detail": "Invalid or expired session."})

            db_csrf = str(session["csrf_token"] or "")
            if not db_csrf or not hmac.compare_digest(db_csrf, csrf_cookie):
                return JSONResponse(status_code=403, content={"detail": "CSRF validation failed."})

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    response.headers.setdefault("Content-Security-Policy", CSP_POLICY)
    if request.url.scheme == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@contextmanager
def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row["name"] == column for row in rows)


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    if not column_exists(conn, table, column):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def hash_password(password: str, salt: str | None = None) -> str:
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120000)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        salt, stored_hash = password_hash.split("$", 1)
    except ValueError:
        return False
    candidate = hash_password(password, salt).split("$", 1)[1]
    return hmac.compare_digest(candidate, stored_hash)


def normalize_stage_key(name: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "_", name.strip().lower())
    key = key.strip("_")
    return key or "stage"


def default_stage_name_from_key(stage_key: str) -> str:
    for stage in DEFAULT_PROJECT_STAGES:
        if stage["key"] == stage_key:
            return stage["name"]
    return stage_key


def generate_unique_stage_key(conn: sqlite3.Connection, project_id: int, stage_name: str) -> str:
    base = normalize_stage_key(stage_name)
    candidate = base
    suffix = 2
    while conn.execute(
        "SELECT 1 FROM project_stages WHERE project_id=? AND stage_key=?",
        (project_id, candidate),
    ).fetchone():
        candidate = f"{base}_{suffix}"
        suffix += 1
    return candidate


def ensure_default_project_stages(conn: sqlite3.Connection, project_id: int) -> None:
    count_row = conn.execute(
        "SELECT COUNT(*) AS c FROM project_stages WHERE project_id=?",
        (project_id,),
    ).fetchone()
    if int(count_row["c"]) > 0:
        return
    for idx, stage in enumerate(DEFAULT_PROJECT_STAGES):
        conn.execute(
            """
            INSERT INTO project_stages (project_id, stage_key, stage_name, position)
            VALUES (?, ?, ?, ?)
            """,
            (project_id, stage["key"], stage["name"], idx),
        )


def generate_unique_template_stage_key(conn: sqlite3.Connection, template_id: int, stage_name: str) -> str:
    base = normalize_stage_key(stage_name)
    candidate = base
    suffix = 2
    while conn.execute(
        "SELECT 1 FROM checklist_template_stages WHERE template_id=? AND stage_key=?",
        (template_id, candidate),
    ).fetchone():
        candidate = f"{base}_{suffix}"
        suffix += 1
    return candidate


def ensure_default_template_stages(conn: sqlite3.Connection, template_id: int) -> None:
    count_row = conn.execute(
        "SELECT COUNT(*) AS c FROM checklist_template_stages WHERE template_id=?",
        (template_id,),
    ).fetchone()
    if int(count_row["c"]) == 0:
        for idx, stage in enumerate(DEFAULT_PROJECT_STAGES):
            conn.execute(
                """
                INSERT INTO checklist_template_stages (template_id, stage_key, stage_name, position)
                VALUES (?, ?, ?, ?)
                """,
                (template_id, stage["key"], stage["name"], idx),
            )

    item_stage_rows = conn.execute(
        """
        SELECT DISTINCT stage
        FROM checklist_template_items
        WHERE template_id=?
        """,
        (template_id,),
    ).fetchall()
    existing_stage_keys = {
        str(row["stage_key"])
        for row in conn.execute(
            "SELECT stage_key FROM checklist_template_stages WHERE template_id=?",
            (template_id,),
        ).fetchall()
    }

    next_position = conn.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM checklist_template_stages WHERE template_id=?",
        (template_id,),
    ).fetchone()
    insert_pos = int(next_position["next_position"])

    for row in item_stage_rows:
        stage_key = str(row["stage"] or "").strip()
        if not stage_key or stage_key in existing_stage_keys:
            continue
        conn.execute(
            """
            INSERT INTO checklist_template_stages (template_id, stage_key, stage_name, position)
            VALUES (?, ?, ?, ?)
            """,
            (template_id, stage_key, default_stage_name_from_key(stage_key), insert_pos),
        )
        existing_stage_keys.add(stage_key)
        insert_pos += 1


def ensure_project_stage_exists(conn: sqlite3.Connection, project_id: int, stage_key: str) -> sqlite3.Row:
    ensure_default_project_stages(conn, project_id)
    row = conn.execute(
        """
        SELECT *
        FROM project_stages
        WHERE project_id=? AND stage_key=?
        """,
        (project_id, stage_key),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=400, detail=f"Invalid stage key: {stage_key}")
    return row


def init_db() -> None:
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS user_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                session_token TEXT NOT NULL UNIQUE,
                csrf_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS login_rate_limits (
                key TEXT PRIMARY KEY,
                fail_count INTEGER NOT NULL DEFAULT 0,
                window_start INTEGER NOT NULL,
                locked_until INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                owner TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'done')),
                due_date TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                assignee TEXT NOT NULL,
                priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
                status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')),
                due_date TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_checklist_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                stage TEXT NOT NULL,
                content TEXT NOT NULL,
                is_done INTEGER NOT NULL DEFAULT 0,
                workflow_status TEXT NOT NULL DEFAULT 'upcoming'
                    CHECK (workflow_status IN ('upcoming', 'inprogress', 'done')),
                position INTEGER NOT NULL DEFAULT 0,
                target_date TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_notification_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                days_before INTEGER NOT NULL CHECK (days_before >= 0 AND days_before <= 365),
                created_by INTEGER NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS project_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (project_id, user_id),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_stages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                stage_key TEXT NOT NULL,
                stage_name TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (project_id, stage_key),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS checklist_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT DEFAULT '',
                created_by INTEGER NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS checklist_template_stages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL,
                stage_key TEXT NOT NULL,
                stage_name TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (template_id, stage_key),
                FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS checklist_template_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL,
                stage TEXT NOT NULL,
                content TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE
            );
            """
        )
        conn.commit()

        ensure_column(conn, "users", "auth_provider", "TEXT NOT NULL DEFAULT 'local'")
        ensure_column(conn, "users", "email", "TEXT")
        ensure_column(conn, "user_sessions", "csrf_token", "TEXT")
        ensure_column(conn, "project_checklist_items", "target_date", "TEXT")
        ensure_column(conn, "project_checklist_items", "workflow_status", "TEXT NOT NULL DEFAULT 'upcoming'")

        checklist_table_sql_row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='project_checklist_items'"
        ).fetchone()
        checklist_table_sql = str(checklist_table_sql_row["sql"] or "") if checklist_table_sql_row else ""
        if "CHECK (stage IN ('data_acquisition', 'labeling', 'development'))" in checklist_table_sql:
            conn.executescript(
                """
                ALTER TABLE project_checklist_items RENAME TO project_checklist_items_legacy;

                CREATE TABLE project_checklist_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    stage TEXT NOT NULL,
                    content TEXT NOT NULL,
                    is_done INTEGER NOT NULL DEFAULT 0,
                    workflow_status TEXT NOT NULL DEFAULT 'upcoming'
                        CHECK (workflow_status IN ('upcoming', 'inprogress', 'done')),
                    position INTEGER NOT NULL DEFAULT 0,
                    target_date TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );

                INSERT INTO project_checklist_items
                    (id, project_id, stage, content, is_done, workflow_status, position, target_date, created_at)
                SELECT
                    id,
                    project_id,
                    stage,
                    content,
                    is_done,
                    CASE
                        WHEN workflow_status IS NULL OR workflow_status='' THEN
                            CASE WHEN is_done=1 THEN 'done' ELSE 'upcoming' END
                        ELSE workflow_status
                    END,
                    position,
                    target_date,
                    created_at
                FROM project_checklist_items_legacy;

                DROP TABLE project_checklist_items_legacy;
                """
            )
            conn.commit()

        template_items_sql_row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='checklist_template_items'"
        ).fetchone()
        template_items_table_sql = str(template_items_sql_row["sql"] or "") if template_items_sql_row else ""
        if "CHECK (stage IN ('data_acquisition', 'labeling', 'development'))" in template_items_table_sql:
            conn.executescript(
                """
                ALTER TABLE checklist_template_items RENAME TO checklist_template_items_legacy;

                CREATE TABLE checklist_template_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    template_id INTEGER NOT NULL,
                    stage TEXT NOT NULL,
                    content TEXT NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (template_id) REFERENCES checklist_templates(id) ON DELETE CASCADE
                );

                INSERT INTO checklist_template_items
                    (id, template_id, stage, content, position, created_at)
                SELECT id, template_id, stage, content, position, created_at
                FROM checklist_template_items_legacy;

                DROP TABLE checklist_template_items_legacy;
                """
            )
            conn.commit()

        stale_sessions = conn.execute(
            "SELECT id FROM user_sessions WHERE csrf_token IS NULL OR csrf_token=''"
        ).fetchall()
        for session_row in stale_sessions:
            conn.execute(
                "UPDATE user_sessions SET csrf_token=? WHERE id=?",
                (secrets.token_urlsafe(32), session_row["id"]),
            )
        now_ts = int(time.time())
        conn.execute(
            """
            DELETE FROM login_rate_limits
            WHERE locked_until < ?
              AND updated_at < ?
            """,
            (now_ts, now_ts - max(LOGIN_WINDOW_SECONDS, LOGIN_LOCKOUT_SECONDS) * 2),
        )
        conn.execute(
            """
            UPDATE projects
            SET owner = (SELECT u.username FROM users u WHERE u.id = CAST(projects.owner AS INTEGER))
            WHERE owner <> ''
              AND owner NOT GLOB '*[^0-9]*'
              AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.username = projects.owner)
              AND EXISTS (SELECT 1 FROM users u WHERE u.id = CAST(projects.owner AS INTEGER))
            """
        )
        conn.execute(
            """
            UPDATE projects
            SET owner = (SELECT u.username FROM users u WHERE u.display_name = projects.owner LIMIT 1)
            WHERE owner <> ''
              AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.username = projects.owner)
              AND EXISTS (SELECT 1 FROM users u3 WHERE u3.display_name = projects.owner)
            """
        )
        conn.execute(
            """
            UPDATE project_checklist_items
            SET workflow_status = CASE WHEN is_done=1 THEN 'done' ELSE 'upcoming' END
            WHERE workflow_status IS NULL OR workflow_status=''
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO project_participants (project_id, user_id)
            SELECT p.id, u.id
            FROM projects p
            JOIN users u ON u.username = p.owner
            """
        )
        project_rows = conn.execute("SELECT id FROM projects").fetchall()
        for project_row in project_rows:
            ensure_default_project_stages(conn, int(project_row["id"]))
        template_rows = conn.execute("SELECT id FROM checklist_templates").fetchall()
        for template_row in template_rows:
            ensure_default_template_stages(conn, int(template_row["id"]))
        conn.commit()

        admin_exists = conn.execute("SELECT id FROM users WHERE is_admin=1 LIMIT 1").fetchone()
        if not admin_exists:
            bootstrap_username = os.getenv("BOOTSTRAP_ADMIN_USERNAME", "admin").strip() or "admin"
            bootstrap_display = os.getenv("BOOTSTRAP_ADMIN_DISPLAY_NAME", "System Admin").strip() or "System Admin"
            bootstrap_password = (os.getenv("BOOTSTRAP_ADMIN_PASSWORD") or "").strip()
            generated = False
            if not bootstrap_password:
                bootstrap_password = secrets.token_urlsafe(16)
                generated = True
            conn.execute(
                """
                INSERT INTO users (username, display_name, password_hash, is_admin)
                VALUES (?, ?, ?, 1)
                """,
                (bootstrap_username, bootstrap_display, hash_password(bootstrap_password)),
            )
            conn.commit()
            if generated:
                print(
                    "[SECURITY] Initial admin account created. "
                    f"username={bootstrap_username}, temporary_password={bootstrap_password}. "
                    "Please change this password immediately."
                )


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


def user_public(user_row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": user_row["id"],
        "username": user_row["username"],
        "display_name": user_row["display_name"],
        "is_admin": bool(user_row["is_admin"]),
        "auth_provider": user_row["auth_provider"],
        "email": user_row["email"],
        "created_at": user_row["created_at"],
    }


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        max_age=SESSION_HOURS * 60 * 60,
        path="/",
    )


def set_csrf_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=token,
        httponly=False,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        max_age=SESSION_HOURS * 60 * 60,
        path="/",
    )


def ensure_session_csrf_token(conn: sqlite3.Connection, session_token: str) -> str | None:
    row = conn.execute("SELECT id, csrf_token FROM user_sessions WHERE session_token=?", (session_token,)).fetchone()
    if not row:
        return None
    csrf_token = str(row["csrf_token"] or "").strip()
    if csrf_token:
        return csrf_token
    csrf_token = secrets.token_urlsafe(32)
    conn.execute("UPDATE user_sessions SET csrf_token=? WHERE id=?", (csrf_token, row["id"]))
    conn.commit()
    return csrf_token


def get_client_ip(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def login_limit_keys(username: str, ip_addr: str) -> tuple[str, str]:
    user_key = f"user_ip:{username.strip().lower()}|{ip_addr}"
    ip_key = f"ip:{ip_addr}"
    return user_key, ip_key


def get_lock_seconds_remaining(conn: sqlite3.Connection, key: str, now_ts: int) -> int:
    row = conn.execute(
        "SELECT locked_until FROM login_rate_limits WHERE key=?",
        (key,),
    ).fetchone()
    if not row:
        return 0
    locked_until = int(row["locked_until"] or 0)
    if locked_until <= now_ts:
        return 0
    return locked_until - now_ts


def apply_login_failure(
    conn: sqlite3.Connection, key: str, max_attempts: int, now_ts: int
) -> None:
    row = conn.execute(
        """
        SELECT fail_count, window_start, locked_until
        FROM login_rate_limits
        WHERE key=?
        """,
        (key,),
    ).fetchone()
    if not row:
        conn.execute(
            """
            INSERT INTO login_rate_limits (key, fail_count, window_start, locked_until, updated_at)
            VALUES (?, 1, ?, 0, ?)
            """,
            (key, now_ts, now_ts),
        )
        return

    fail_count = int(row["fail_count"] or 0)
    window_start = int(row["window_start"] or now_ts)
    locked_until = int(row["locked_until"] or 0)

    if now_ts - window_start > LOGIN_WINDOW_SECONDS:
        fail_count = 1
        window_start = now_ts
        locked_until = 0
    else:
        fail_count += 1

    if fail_count >= max_attempts:
        locked_until = max(locked_until, now_ts + LOGIN_LOCKOUT_SECONDS)

    conn.execute(
        """
        UPDATE login_rate_limits
        SET fail_count=?, window_start=?, locked_until=?, updated_at=?
        WHERE key=?
        """,
        (fail_count, window_start, locked_until, now_ts, key),
    )


def record_login_failure(conn: sqlite3.Connection, username: str, ip_addr: str, now_ts: int) -> None:
    user_key, ip_key = login_limit_keys(username, ip_addr)
    apply_login_failure(conn, user_key, LOGIN_MAX_ATTEMPTS_USER_IP, now_ts)
    apply_login_failure(conn, ip_key, LOGIN_MAX_ATTEMPTS_IP, now_ts)
    conn.commit()


def clear_login_failures(conn: sqlite3.Connection, username: str, ip_addr: str) -> None:
    user_key, ip_key = login_limit_keys(username, ip_addr)
    conn.execute("DELETE FROM login_rate_limits WHERE key IN (?, ?)", (user_key, ip_key))
    conn.commit()


def get_login_lock_remaining(conn: sqlite3.Connection, username: str, ip_addr: str, now_ts: int) -> int:
    user_key, ip_key = login_limit_keys(username, ip_addr)
    return max(
        get_lock_seconds_remaining(conn, user_key, now_ts),
        get_lock_seconds_remaining(conn, ip_key, now_ts),
    )


def create_session(conn: sqlite3.Connection, user_id: int) -> tuple[str, int, str]:
    token = secrets.token_urlsafe(36)
    csrf_token = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + (SESSION_HOURS * 60 * 60)
    conn.execute(
        "INSERT INTO user_sessions (user_id, session_token, csrf_token, expires_at) VALUES (?, ?, ?, ?)",
        (user_id, token, csrf_token, expires_at),
    )
    conn.commit()
    return token, expires_at, csrf_token


def find_session_user(conn: sqlite3.Connection, session_token: str) -> sqlite3.Row | None:
    now_ts = int(time.time())
    conn.execute("DELETE FROM user_sessions WHERE expires_at <= ?", (now_ts,))
    row = conn.execute(
        """
        SELECT users.*
        FROM user_sessions
        JOIN users ON users.id = user_sessions.user_id
        WHERE user_sessions.session_token = ? AND user_sessions.expires_at > ?
        """,
        (session_token, now_ts),
    ).fetchone()
    return row


def get_current_user(
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> dict[str, Any]:
    if not session_token:
        raise HTTPException(status_code=401, detail="Authentication required.")
    with get_db() as conn:
        row = find_session_user(conn, session_token)
    if not row:
        raise HTTPException(status_code=401, detail="Invalid or expired session.")
    return user_public(row)


def get_admin_user(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    if not current_user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin permission required.")
    return current_user


def get_user_id_by_username(conn: sqlite3.Connection, username: str) -> int | None:
    row = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        return None
    return int(row["id"])


def ensure_username_exists(conn: sqlite3.Connection, username: str) -> int:
    user_id = get_user_id_by_username(conn, username)
    if user_id is None:
        raise HTTPException(status_code=400, detail="Username does not exist.")
    return user_id


def ensure_project_owner_in_participants(
    conn: sqlite3.Connection, project_id: int, owner_username: str
) -> None:
    owner_user_id = ensure_username_exists(conn, owner_username)
    conn.execute(
        """
        INSERT OR IGNORE INTO project_participants (project_id, user_id)
        VALUES (?, ?)
        """,
        (project_id, owner_user_id),
    )


def is_project_participant(conn: sqlite3.Connection, project_id: int, username: str) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM project_participants pp
        JOIN users u ON u.id = pp.user_id
        WHERE pp.project_id=? AND u.username=?
        LIMIT 1
        """,
        (project_id, username),
    ).fetchone()
    return bool(row)


def require_project_owner(
    conn: sqlite3.Connection, project_id: int, current_user: dict[str, Any]
) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found.")
    if not current_user["is_admin"] and row["owner"] != current_user["username"]:
        raise HTTPException(status_code=403, detail="Only owner can modify this project.")
    return row


def require_project_access(
    conn: sqlite3.Connection, project_id: int, current_user: dict[str, Any]
) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found.")
    if current_user["is_admin"]:
        return row
    if row["owner"] == current_user["username"]:
        return row
    if is_project_participant(conn, project_id, current_user["username"]):
        return row
    raise HTTPException(status_code=403, detail="No permission to access this project.")
    return row


def require_template_edit_access(
    conn: sqlite3.Connection, template_id: int, current_user: dict[str, Any]
) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Template not found.")
    if row["created_by"] != current_user["id"] and not current_user["is_admin"]:
        raise HTTPException(status_code=403, detail="No permission to edit this template.")
    return row


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=2, max_length=40)
    password: str = Field(min_length=6, max_length=128)


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
    display_name: str = Field(min_length=2, max_length=60)
    password: str = Field(min_length=6, max_length=128)


class AdminUserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
    display_name: str = Field(min_length=2, max_length=60)
    password: str = Field(min_length=6, max_length=128)
    email: str = Field(min_length=3, max_length=120, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    is_admin: bool = False


class AdminUserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = Field(default=None, min_length=2, max_length=60)
    password: str | None = Field(default=None, min_length=6, max_length=128)
    email: str | None = Field(default=None, max_length=120)
    is_admin: bool | None = None


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=100)
    description: str = Field(default="", max_length=500)
    owner: str = Field(min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
    status: str = Field(pattern="^(planned|active|done)$")
    due_date: str | None = None


class ProjectUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=2, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    owner: str | None = Field(default=None, min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
    status: str | None = Field(default=None, pattern="^(planned|active|done)$")
    due_date: str | None = None


class ProjectDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=128)


class ChecklistItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stage: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9_]+$")
    content: str = Field(min_length=1, max_length=200)
    target_date: str | None = None
    workflow_status: str = Field(default="upcoming", pattern="^(upcoming|inprogress|done)$")


class ChecklistItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stage: str | None = Field(default=None, min_length=1, max_length=60, pattern=r"^[a-z0-9_]+$")
    content: str | None = Field(default=None, min_length=1, max_length=200)
    is_done: bool | None = None
    position: int | None = Field(default=None, ge=0)
    target_date: str | None = None
    workflow_status: str | None = Field(default=None, pattern="^(upcoming|inprogress|done)$")


class NotificationRuleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    days_before: int = Field(ge=0, le=365)


class ParticipantCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")


class ProjectStageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)


class ProjectStageUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)


class TemplateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=300)


class TemplateUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=300)


class TemplateStageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)


class TemplateStageUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)


class TemplateStageDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=80)
    position: int = Field(ge=0)


class TemplateStagesReplaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stages: list[TemplateStageDraft] = Field(min_length=1, max_length=300)


class TemplateItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stage: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9_]+$")
    content: str = Field(min_length=1, max_length=200)


class TemplateItemDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stage: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9_]+$")
    content: str = Field(min_length=1, max_length=200)
    position: int = Field(ge=0)


class TemplateItemsReplaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[TemplateItemDraft]


class TemplateRestoreItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stage: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9_]+$")
    content: str = Field(min_length=1, max_length=200)
    position: int = Field(ge=0)


class TemplateRestoreStage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=80)
    position: int = Field(ge=0)


class TemplateRestoreEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=300)
    stages: list[TemplateRestoreStage] = Field(default_factory=list, max_length=300)
    items: list[TemplateRestoreItem] = Field(default_factory=list, max_length=2000)


class TemplatesRestoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: str = Field(default="overwrite", pattern="^(overwrite|skip)$")
    templates: list[TemplateRestoreEntry] = Field(min_length=1, max_length=300)


class TemplateExportSelectedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    template_ids: list[int] = Field(min_length=1, max_length=300)


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(payload: LoginRequest, request: Request, response: Response) -> dict[str, Any]:
    username = payload.username.strip()
    ip_addr = get_client_ip(request)
    now_ts = int(time.time())

    with get_db() as conn:
        lock_remaining = get_login_lock_remaining(conn, username, ip_addr, now_ts)
        if lock_remaining > 0:
            raise HTTPException(
                status_code=429,
                detail=f"Too many login attempts. Try again in {lock_remaining} seconds.",
                headers={"Retry-After": str(lock_remaining)},
            )
        user = conn.execute(
            "SELECT * FROM users WHERE username=? AND (auth_provider='local' OR auth_provider IS NULL)",
            (username,),
        ).fetchone()
        if not user or not verify_password(payload.password, user["password_hash"]):
            record_login_failure(conn, username, ip_addr, now_ts)
            raise HTTPException(status_code=401, detail="Invalid username or password.")
        clear_login_failures(conn, username, ip_addr)
        token, expires_at, csrf_token = create_session(conn, user["id"])

    set_session_cookie(response, token)
    set_csrf_cookie(response, csrf_token)
    return {"user": user_public(user), "expires_at": expires_at}


@app.post("/api/auth/register", status_code=201)
def register(payload: RegisterRequest) -> dict[str, Any]:
    username = payload.username.strip()
    display_name = payload.display_name.strip()

    with get_db() as conn:
        exists = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        if exists:
            raise HTTPException(status_code=400, detail="Username already exists.")
        cur = conn.execute(
            """
            INSERT INTO users (username, display_name, password_hash, is_admin, auth_provider, email)
            VALUES (?, ?, ?, 0, 'local', NULL)
            """,
            (username, display_name, hash_password(payload.password)),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    return {"user": user_public(row)}


@app.post("/api/auth/logout")
def logout(
    response: Response,
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    _: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    if session_token:
        with get_db() as conn:
            conn.execute("DELETE FROM user_sessions WHERE session_token=?", (session_token,))
            conn.commit()
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    response.delete_cookie(CSRF_COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(
    response: Response,
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if session_token:
        with get_db() as conn:
            csrf_token = ensure_session_csrf_token(conn, session_token)
        if csrf_token:
            set_csrf_cookie(response, csrf_token)
    return current_user


@app.get("/api/users/exists/{username}")
def user_exists(username: str, _: dict[str, Any] = Depends(get_current_user)) -> dict[str, bool]:
    with get_db() as conn:
        row = conn.execute("SELECT id FROM users WHERE username=?", (username.strip(),)).fetchone()
    return {"exists": bool(row)}


@app.get("/api/users/exists")
def user_exists_query(
    username: str = Query(min_length=2, max_length=40),
    _: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    with get_db() as conn:
        row = conn.execute("SELECT id FROM users WHERE username=?", (username.strip(),)).fetchone()
    return {"exists": bool(row)}


@app.get("/api/admin/users")
def admin_list_users(_: dict[str, Any] = Depends(get_admin_user)) -> list[dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY id ASC").fetchall()
    return [user_public(row) for row in rows]


@app.post("/api/admin/users", status_code=201)
def admin_create_user(
    payload: AdminUserCreate, _: dict[str, Any] = Depends(get_admin_user)
) -> dict[str, Any]:
    with get_db() as conn:
        exists = conn.execute("SELECT id FROM users WHERE username=?", (payload.username.strip(),)).fetchone()
        if exists:
            raise HTTPException(status_code=400, detail="Username already exists.")
        cur = conn.execute(
            """
            INSERT INTO users (username, display_name, password_hash, is_admin, auth_provider, email)
            VALUES (?, ?, ?, ?, 'local', ?)
            """,
            (
                payload.username.strip(),
                payload.display_name.strip(),
                hash_password(payload.password),
                1 if payload.is_admin else 0,
                payload.email.strip(),
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    return user_public(row)


@app.patch("/api/admin/users/{user_id}")
def admin_update_user(
    user_id: int,
    payload: AdminUserUpdate,
    current_admin: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update.")

    with get_db() as conn:
        target = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="User not found.")

        if "is_admin" in updates and target["id"] == current_admin["id"] and not updates["is_admin"]:
            raise HTTPException(status_code=400, detail="You cannot remove your own admin role.")

        sql_updates: dict[str, Any] = {}
        if "display_name" in updates:
            sql_updates["display_name"] = str(updates["display_name"]).strip()
        if "is_admin" in updates:
            sql_updates["is_admin"] = 1 if updates["is_admin"] else 0
        if "password" in updates:
            sql_updates["password_hash"] = hash_password(str(updates["password"]))
        if "email" in updates:
            sql_updates["email"] = (str(updates["email"]).strip() or None)

        set_clause = ", ".join([f"{k}=?" for k in sql_updates.keys()])
        values = list(sql_updates.values()) + [user_id]
        conn.execute(f"UPDATE users SET {set_clause} WHERE id=?", values)
        conn.commit()

        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return user_public(row)


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(
    user_id: int, current_admin: dict[str, Any] = Depends(get_admin_user)
) -> dict[str, bool]:
    if user_id == current_admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    with get_db() as conn:
        cur = conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="User not found.")
        conn.commit()
    return {"ok": True}


@app.get("/api/dashboard")
def dashboard(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with get_db() as conn:
        if current_user["is_admin"]:
            project_total = conn.execute("SELECT COUNT(*) AS c FROM projects").fetchone()["c"]
            work_total = conn.execute("SELECT COUNT(*) AS c FROM project_checklist_items").fetchone()["c"]
            work_done = conn.execute(
                "SELECT COUNT(*) AS c FROM project_checklist_items WHERE is_done=1"
            ).fetchone()["c"]
            active_projects = conn.execute(
                "SELECT COUNT(*) AS c FROM projects WHERE status='active'"
            ).fetchone()["c"]
        else:
            project_total = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM (
                    SELECT DISTINCT p.id
                    FROM projects p
                    LEFT JOIN project_participants pp ON pp.project_id = p.id
                    LEFT JOIN users u ON u.id = pp.user_id
                    WHERE p.owner=? OR u.username=?
                ) x
                """,
                (current_user["username"], current_user["username"]),
            ).fetchone()["c"]
            work_total = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM project_checklist_items c
                JOIN projects p ON p.id = c.project_id
                WHERE (
                    p.owner=?
                    OR EXISTS (
                        SELECT 1
                        FROM project_participants pp
                        JOIN users u ON u.id = pp.user_id
                        WHERE pp.project_id = p.id AND u.username=?
                    )
                )
                """,
                (current_user["username"], current_user["username"]),
            ).fetchone()["c"]
            work_done = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM project_checklist_items c
                JOIN projects p ON p.id = c.project_id
                WHERE c.is_done=1
                  AND (
                    p.owner=?
                    OR EXISTS (
                        SELECT 1
                        FROM project_participants pp
                        JOIN users u ON u.id = pp.user_id
                        WHERE pp.project_id = p.id AND u.username=?
                    )
                )
                """,
                (current_user["username"], current_user["username"]),
            ).fetchone()["c"]
            active_projects = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM (
                    SELECT DISTINCT p.id
                    FROM projects p
                    LEFT JOIN project_participants pp ON pp.project_id = p.id
                    LEFT JOIN users u ON u.id = pp.user_id
                    WHERE (p.owner=? OR u.username=?) AND p.status='active'
                ) x
                """,
                (current_user["username"], current_user["username"]),
            ).fetchone()["c"]

    completion_rate = 0 if work_total == 0 else round((work_done / work_total) * 100, 1)
    return {
        "projects": project_total,
        "active_projects": active_projects,
        "tasks": work_total,
        "completion_rate": completion_rate,
    }


@app.get("/api/projects")
def list_projects(current_user: dict[str, Any] = Depends(get_current_user)) -> list[dict[str, Any]]:
    with get_db() as conn:
        if current_user["is_admin"]:
            rows = conn.execute("SELECT * FROM projects ORDER BY id DESC").fetchall()
        else:
            rows = conn.execute(
                """
                SELECT DISTINCT p.*
                FROM projects p
                LEFT JOIN project_participants pp ON pp.project_id = p.id
                LEFT JOIN users u ON u.id = pp.user_id
                WHERE p.owner=? OR u.username=?
                ORDER BY p.id DESC
                """,
                (current_user["username"], current_user["username"]),
            ).fetchall()
    return [row_to_dict(row) for row in rows]


@app.get("/api/projects/{project_id}")
def get_project(project_id: int, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with get_db() as conn:
        row = require_project_access(conn, project_id, current_user)
    return row_to_dict(row)


@app.get("/api/projects/{project_id}/stages")
def list_project_stages(
    project_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> list[dict[str, Any]]:
    with get_db() as conn:
        require_project_access(conn, project_id, current_user)
        ensure_default_project_stages(conn, project_id)
        rows = conn.execute(
            """
            SELECT *
            FROM project_stages
            WHERE project_id=?
            ORDER BY position ASC, id ASC
            """,
            (project_id,),
        ).fetchall()
        conn.commit()
    return [row_to_dict(row) for row in rows]


@app.post("/api/projects/{project_id}/stages", status_code=201)
def create_project_stage(
    project_id: int,
    payload: ProjectStageCreate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    stage_name = payload.name.strip()
    if not stage_name:
        raise HTTPException(status_code=400, detail="Stage name is required.")

    with get_db() as conn:
        require_project_owner(conn, project_id, current_user)
        ensure_default_project_stages(conn, project_id)
        duplicate = conn.execute(
            """
            SELECT id
            FROM project_stages
            WHERE project_id=? AND lower(stage_name)=lower(?)
            """,
            (project_id, stage_name),
        ).fetchone()
        if duplicate:
            raise HTTPException(status_code=400, detail="Stage name already exists.")

        stage_key = generate_unique_stage_key(conn, project_id, stage_name)
        next_pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM project_stages WHERE project_id=?",
            (project_id,),
        ).fetchone()
        cur = conn.execute(
            """
            INSERT INTO project_stages (project_id, stage_key, stage_name, position)
            VALUES (?, ?, ?, ?)
            """,
            (project_id, stage_key, stage_name, int(next_pos["next_position"])),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM project_stages WHERE id=?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.patch("/api/projects/{project_id}/stages/{stage_id}")
def update_project_stage(
    project_id: int,
    stage_id: int,
    payload: ProjectStageUpdate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    stage_name = payload.name.strip()
    if not stage_name:
        raise HTTPException(status_code=400, detail="Stage name is required.")

    with get_db() as conn:
        require_project_owner(conn, project_id, current_user)
        ensure_default_project_stages(conn, project_id)
        current_row = conn.execute(
            "SELECT * FROM project_stages WHERE id=? AND project_id=?",
            (stage_id, project_id),
        ).fetchone()
        if not current_row:
            raise HTTPException(status_code=404, detail="Stage not found.")
        duplicate = conn.execute(
            """
            SELECT id
            FROM project_stages
            WHERE project_id=? AND lower(stage_name)=lower(?) AND id<>?
            """,
            (project_id, stage_name, stage_id),
        ).fetchone()
        if duplicate:
            raise HTTPException(status_code=400, detail="Stage name already exists.")
        conn.execute(
            "UPDATE project_stages SET stage_name=? WHERE id=?",
            (stage_name, stage_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM project_stages WHERE id=?", (stage_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/projects/{project_id}/stages/{stage_id}")
def delete_project_stage(
    project_id: int,
    stage_id: int,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    with get_db() as conn:
        require_project_owner(conn, project_id, current_user)
        ensure_default_project_stages(conn, project_id)
        current_row = conn.execute(
            "SELECT * FROM project_stages WHERE id=? AND project_id=?",
            (stage_id, project_id),
        ).fetchone()
        if not current_row:
            raise HTTPException(status_code=404, detail="Stage not found.")

        stage_count = conn.execute(
            "SELECT COUNT(*) AS c FROM project_stages WHERE project_id=?",
            (project_id,),
        ).fetchone()
        if int(stage_count["c"]) <= 1:
            raise HTTPException(status_code=400, detail="At least one stage must remain.")

        in_use = conn.execute(
            """
            SELECT COUNT(*) AS c
            FROM project_checklist_items
            WHERE project_id=? AND stage=?
            """,
            (project_id, current_row["stage_key"]),
        ).fetchone()
        if int(in_use["c"]) > 0:
            raise HTTPException(status_code=400, detail="Cannot delete a stage that has checklist items.")

        conn.execute("DELETE FROM project_stages WHERE id=?", (stage_id,))
        remaining_rows = conn.execute(
            "SELECT id FROM project_stages WHERE project_id=? ORDER BY position ASC, id ASC",
            (project_id,),
        ).fetchall()
        for idx, row in enumerate(remaining_rows):
            conn.execute("UPDATE project_stages SET position=? WHERE id=?", (idx, int(row["id"])))
        conn.commit()
    return {"ok": True}


@app.get("/api/projects/{project_id}/participants")
def list_project_participants(
    project_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> list[dict[str, Any]]:
    with get_db() as conn:
        project = require_project_access(conn, project_id, current_user)
        ensure_project_owner_in_participants(conn, project_id, str(project["owner"]))
        conn.commit()
        rows = conn.execute(
            """
            SELECT u.id, u.username, u.display_name, pp.created_at
            FROM project_participants pp
            JOIN users u ON u.id = pp.user_id
            WHERE pp.project_id=?
            ORDER BY u.username ASC
            """,
            (project_id,),
        ).fetchall()
    result = [row_to_dict(row) for row in rows]
    for item in result:
        item["project_owner"] = project["owner"]
    return result


@app.post("/api/projects/{project_id}/participants", status_code=201)
def add_project_participant(
    project_id: int,
    payload: ParticipantCreate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    username = payload.username.strip()
    with get_db() as conn:
        project = require_project_owner(conn, project_id, current_user)
        if username == project["owner"]:
            raise HTTPException(status_code=400, detail="Project owner is already included.")
        user_id = ensure_username_exists(conn, username)
        exists = conn.execute(
            "SELECT id FROM project_participants WHERE project_id=? AND user_id=?",
            (project_id, user_id),
        ).fetchone()
        if exists:
            raise HTTPException(status_code=400, detail="This participant is already added.")
        conn.execute(
            "INSERT INTO project_participants (project_id, user_id) VALUES (?, ?)",
            (project_id, user_id),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT u.id, u.username, u.display_name
            FROM users u
            WHERE u.id=?
            """,
            (user_id,),
        ).fetchone()
    return row_to_dict(row)


@app.delete("/api/projects/{project_id}/participants/{username}")
def delete_project_participant(
    project_id: int,
    username: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    with get_db() as conn:
        project = require_project_owner(conn, project_id, current_user)
        target_username = username.strip()
        if target_username == project["owner"]:
            raise HTTPException(status_code=400, detail="Owner must remain a participant.")
        user_id = get_user_id_by_username(conn, target_username)
        if user_id is None:
            raise HTTPException(status_code=404, detail="Participant not found.")
        cur = conn.execute(
            "DELETE FROM project_participants WHERE project_id=? AND user_id=?",
            (project_id, user_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Participant not found.")
        conn.commit()
    return {"ok": True}


@app.post("/api/projects", status_code=201)
def create_project(
    payload: ProjectCreate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    owner = payload.owner.strip()
    name = payload.name.strip()
    with get_db() as conn:
        ensure_username_exists(conn, owner)
        exists = conn.execute("SELECT id FROM projects WHERE name=?", (name,)).fetchone()
        if exists:
            raise HTTPException(status_code=400, detail="Project name already exists.")
        if not current_user["is_admin"] and owner != current_user["username"]:
            raise HTTPException(status_code=403, detail="You can create only your own projects.")
        cur = conn.execute(
            """
            INSERT INTO projects (name, description, owner, status, due_date)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                name,
                payload.description.strip(),
                owner,
                payload.status,
                payload.due_date,
            ),
        )
        new_project_id = int(cur.lastrowid)
        ensure_project_owner_in_participants(conn, new_project_id, owner)
        ensure_default_project_stages(conn, new_project_id)
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id=?", (new_project_id,)).fetchone()
    return row_to_dict(row)


@app.patch("/api/projects/{project_id}")
def update_project(
    project_id: int, payload: ProjectUpdate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update.")

    with get_db() as conn:
        require_project_owner(conn, project_id, current_user)
        if "name" in updates:
            name = str(updates["name"]).strip()
            duplicate = conn.execute(
                "SELECT id FROM projects WHERE name=? AND id<>?",
                (name, project_id),
            ).fetchone()
            if duplicate:
                raise HTTPException(status_code=400, detail="Project name already exists.")
            updates["name"] = name
        if "owner" in updates:
            owner = str(updates["owner"]).strip()
            ensure_username_exists(conn, owner)
            if not current_user["is_admin"] and owner != current_user["username"]:
                raise HTTPException(status_code=403, detail="Owner must be your username.")
            updates["owner"] = owner
        set_clause = ", ".join([f"{k}=?" for k in updates.keys()])
        values = list(updates.values()) + [project_id]
        cur = conn.execute(f"UPDATE projects SET {set_clause} WHERE id=?", values)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Project not found.")
        owner_row = conn.execute("SELECT owner FROM projects WHERE id=?", (project_id,)).fetchone()
        if owner_row:
            ensure_project_owner_in_participants(conn, project_id, str(owner_row["owner"]))
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/projects/{project_id}")
def delete_project(
    project_id: int,
    payload: ProjectDeleteRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    with get_db() as conn:
        user_row = conn.execute("SELECT password_hash FROM users WHERE id=?", (current_user["id"],)).fetchone()
        if not user_row or not verify_password(payload.password, str(user_row["password_hash"])):
            raise HTTPException(status_code=400, detail="Invalid password.")
        require_project_owner(conn, project_id, current_user)
        cur = conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Project not found.")
        conn.commit()
    return {"ok": True}


@app.get("/api/projects/{project_id}/checklists")
def list_project_checklists(
    project_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> list[dict[str, Any]]:
    with get_db() as conn:
        require_project_access(conn, project_id, current_user)
        ensure_default_project_stages(conn, project_id)
        rows = conn.execute(
            """
            SELECT c.*, ps.stage_name
            FROM project_checklist_items c
            LEFT JOIN project_stages ps
              ON ps.project_id = c.project_id
             AND ps.stage_key = c.stage
            WHERE c.project_id=?
            ORDER BY
                CASE c.workflow_status
                    WHEN 'upcoming' THEN 1
                    WHEN 'inprogress' THEN 2
                    WHEN 'done' THEN 3
                    ELSE 4
                END,
                c.position ASC,
                COALESCE(ps.position, 999) ASC,
                c.id ASC
            """,
            (project_id,),
        ).fetchall()
        conn.commit()
    return [row_to_dict(row) for row in rows]


@app.post("/api/projects/{project_id}/checklists", status_code=201)
def create_checklist_item(
    project_id: int, payload: ChecklistItemCreate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    with get_db() as conn:
        require_project_access(conn, project_id, current_user)
        ensure_project_stage_exists(conn, project_id, payload.stage)
        next_pos_row = conn.execute(
            """
            SELECT COALESCE(MAX(position), -1) + 1 AS next_position
            FROM project_checklist_items
            WHERE project_id=? AND workflow_status=?
            """,
            (project_id, payload.workflow_status),
        ).fetchone()
        is_done = 1 if payload.workflow_status == "done" else 0
        cur = conn.execute(
            """
            INSERT INTO project_checklist_items
                (project_id, stage, content, is_done, workflow_status, position, target_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                payload.stage,
                payload.content.strip(),
                is_done,
                payload.workflow_status,
                int(next_pos_row["next_position"]),
                payload.target_date,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM project_checklist_items WHERE id=?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.patch("/api/checklists/{item_id}")
def update_checklist_item(
    item_id: int, payload: ChecklistItemUpdate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update.")

    with get_db() as conn:
        current = conn.execute(
            """
            SELECT c.*, p.owner
            FROM project_checklist_items c
            JOIN projects p ON p.id = c.project_id
            WHERE c.id=?
            """,
            (item_id,),
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Checklist item not found.")
        if not current_user["is_admin"] and current["owner"] != current_user["username"]:
            raise HTTPException(status_code=403, detail="No permission to edit this checklist item.")

        if "content" in updates:
            updates["content"] = str(updates["content"]).strip()
        if "stage" in updates:
            updates["stage"] = str(updates["stage"]).strip()
            ensure_project_stage_exists(conn, int(current["project_id"]), updates["stage"])

        if "is_done" in updates:
            updates["is_done"] = 1 if updates["is_done"] else 0
            if updates["is_done"] == 1:
                updates["workflow_status"] = "done"
            elif "workflow_status" not in updates and current["workflow_status"] == "done":
                updates["workflow_status"] = "upcoming"

        if "workflow_status" in updates:
            updates["is_done"] = 1 if updates["workflow_status"] == "done" else 0
            if "position" not in updates:
                next_pos_row = conn.execute(
                    """
                    SELECT COALESCE(MAX(position), -1) + 1 AS next_position
                    FROM project_checklist_items
                    WHERE project_id=? AND workflow_status=?
                    """,
                    (current["project_id"], updates["workflow_status"]),
                ).fetchone()
                updates["position"] = int(next_pos_row["next_position"])

        set_clause = ", ".join([f"{k}=?" for k in updates.keys()])
        values = list(updates.values()) + [item_id]
        cur = conn.execute(f"UPDATE project_checklist_items SET {set_clause} WHERE id=?", values)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Checklist item not found.")
        conn.commit()
        row = conn.execute("SELECT * FROM project_checklist_items WHERE id=?", (item_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/checklists/{item_id}")
def delete_checklist_item(
    item_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, bool]:
    with get_db() as conn:
        current = conn.execute(
            """
            SELECT c.id, p.owner
            FROM project_checklist_items c
            JOIN projects p ON p.id = c.project_id
            WHERE c.id=?
            """,
            (item_id,),
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Checklist item not found.")
        if not current_user["is_admin"] and current["owner"] != current_user["username"]:
            raise HTTPException(status_code=403, detail="No permission to delete this checklist item.")
        cur = conn.execute("DELETE FROM project_checklist_items WHERE id=?", (item_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Checklist item not found.")
        conn.commit()
    return {"ok": True}


@app.get("/api/projects/{project_id}/notification-rules")
def list_notification_rules(
    project_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> list[dict[str, Any]]:
    with get_db() as conn:
        require_project_access(conn, project_id, current_user)
        rows = conn.execute(
            """
            SELECT *
            FROM project_notification_rules
            WHERE project_id=?
            ORDER BY days_before ASC, id ASC
            """,
            (project_id,),
        ).fetchall()
    return [row_to_dict(row) for row in rows]


@app.post("/api/projects/{project_id}/notification-rules", status_code=201)
def create_notification_rule(
    project_id: int,
    payload: NotificationRuleCreate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    with get_db() as conn:
        require_project_access(conn, project_id, current_user)
        cur = conn.execute(
            """
            INSERT INTO project_notification_rules (project_id, days_before, created_by)
            VALUES (?, ?, ?)
            """,
            (project_id, payload.days_before, current_user["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM project_notification_rules WHERE id=?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/notification-rules/{rule_id}")
def delete_notification_rule(
    rule_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, bool]:
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT r.*, p.owner
            FROM project_notification_rules r
            JOIN projects p ON p.id = r.project_id
            WHERE r.id=?
            """,
            (rule_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Notification rule not found.")
        if not current_user["is_admin"] and row["owner"] != current_user["username"]:
            raise HTTPException(status_code=403, detail="No permission to delete this rule.")
        conn.execute("DELETE FROM project_notification_rules WHERE id=?", (rule_id,))
        conn.commit()
    return {"ok": True}


@app.get("/api/projects/{project_id}/notifications/preview")
def preview_project_notifications(
    project_id: int,
    days: int = Query(default=30, ge=1, le=365),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    with get_db() as conn:
        project = require_project_access(conn, project_id, current_user)
        rows = conn.execute(
            """
            SELECT
                c.id AS checklist_id,
                c.content,
                c.stage,
                c.target_date,
                r.id AS rule_id,
                r.days_before,
                date(c.target_date, '-' || r.days_before || ' day') AS notify_date
            FROM project_checklist_items c
            JOIN project_notification_rules r ON r.project_id = c.project_id
            WHERE c.project_id=?
              AND c.is_done=0
              AND c.target_date IS NOT NULL
              AND date(c.target_date, '-' || r.days_before || ' day')
                  BETWEEN date('now','localtime') AND date('now','localtime', '+' || ? || ' day')
            ORDER BY notify_date ASC, c.stage ASC, c.position ASC
            """,
            (project_id, days),
        ).fetchall()
    result = [row_to_dict(row) for row in rows]
    for item in result:
        item["project_name"] = project["name"]
    return result


@app.get("/api/notifications/today")
def notifications_today(current_user: dict[str, Any] = Depends(get_current_user)) -> list[dict[str, Any]]:
    with get_db() as conn:
        if current_user["is_admin"]:
            rows = conn.execute(
                """
                SELECT
                    p.id AS project_id,
                    p.name AS project_name,
                    c.id AS checklist_id,
                    c.content,
                    c.stage,
                    c.target_date,
                    r.days_before
                FROM project_checklist_items c
                JOIN projects p ON p.id = c.project_id
                JOIN project_notification_rules r ON r.project_id = c.project_id
                WHERE c.is_done=0
                  AND c.target_date IS NOT NULL
                  AND date(c.target_date, '-' || r.days_before || ' day') = date('now','localtime')
                ORDER BY p.name ASC, c.stage ASC, c.position ASC, r.days_before ASC
                """
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT
                    p.id AS project_id,
                    p.name AS project_name,
                    c.id AS checklist_id,
                    c.content,
                    c.stage,
                    c.target_date,
                    r.days_before
                FROM project_checklist_items c
                JOIN projects p ON p.id = c.project_id
                JOIN project_notification_rules r ON r.project_id = c.project_id
                WHERE c.is_done=0
                  AND c.target_date IS NOT NULL
                  AND (
                        p.owner=?
                        OR EXISTS (
                            SELECT 1
                            FROM project_participants pp
                            JOIN users u ON u.id = pp.user_id
                            WHERE pp.project_id = p.id
                              AND u.username=?
                        )
                  )
                  AND date(c.target_date, '-' || r.days_before || ' day') = date('now','localtime')
                ORDER BY p.name ASC, c.stage ASC, c.position ASC, r.days_before ASC
                """,
                (current_user["username"], current_user["username"]),
            ).fetchall()
    result = [row_to_dict(row) for row in rows]
    for item in result:
        item["receiver_user_id"] = current_user["id"]
    return result


@app.get("/api/my/checklists/upcoming")
def my_upcoming_checklists(
    days: int = Query(default=30, ge=1, le=365),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    with get_db() as conn:
        if current_user["is_admin"]:
            rows = conn.execute(
                """
                SELECT
                    p.id AS project_id,
                    p.name AS project_name,
                    c.id AS checklist_id,
                    c.stage,
                    c.content,
                    c.target_date,
                    CAST(julianday(date(c.target_date)) - julianday(date('now','localtime')) AS INTEGER) AS days_left,
                    'admin' AS membership_type
                FROM project_checklist_items c
                JOIN projects p ON p.id = c.project_id
                WHERE c.is_done=0
                  AND c.target_date IS NOT NULL
                  AND date(c.target_date) BETWEEN date('now','localtime') AND date('now','localtime', '+' || ? || ' day')
                ORDER BY date(c.target_date) ASC, p.name ASC, c.stage ASC, c.position ASC
                """,
                (days,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT
                    p.id AS project_id,
                    p.name AS project_name,
                    c.id AS checklist_id,
                    c.stage,
                    c.content,
                    c.target_date,
                    CAST(julianday(date(c.target_date)) - julianday(date('now','localtime')) AS INTEGER) AS days_left,
                    CASE WHEN p.owner=? THEN 'owner' ELSE 'participant' END AS membership_type
                FROM project_checklist_items c
                JOIN projects p ON p.id = c.project_id
                WHERE c.is_done=0
                  AND c.target_date IS NOT NULL
                  AND (
                        p.owner=?
                        OR EXISTS (
                            SELECT 1
                            FROM project_participants pp
                            JOIN users u ON u.id = pp.user_id
                            WHERE pp.project_id = p.id
                              AND u.username=?
                        )
                  )
                  AND date(c.target_date) BETWEEN date('now','localtime') AND date('now','localtime', '+' || ? || ' day')
                ORDER BY date(c.target_date) ASC, p.name ASC, c.stage ASC, c.position ASC
                """,
                (current_user["username"], current_user["username"], current_user["username"], days),
            ).fetchall()
    return [row_to_dict(row) for row in rows]


@app.get("/api/templates")
def list_templates(current_user: dict[str, Any] = Depends(get_current_user)) -> list[dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT checklist_templates.*, users.display_name AS creator_name
            FROM checklist_templates
            JOIN users ON users.id = checklist_templates.created_by
            ORDER BY checklist_templates.id DESC
            """
        ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        item = row_to_dict(row)
        item["is_owner"] = item["created_by"] == current_user["id"]
        result.append(item)
    return result


def build_templates_export_payload(
    conn: sqlite3.Connection,
    selected_template_ids: list[int] | None = None,
) -> dict[str, Any]:
    filters = ""
    params: list[Any] = []
    if selected_template_ids is not None:
        normalized = sorted({int(x) for x in selected_template_ids})
        if not normalized:
            return {
                "version": 1,
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "templates": [],
            }
        placeholders = ",".join(["?"] * len(normalized))
        filters = f" WHERE t.id IN ({placeholders})"
        params.extend(normalized)

    template_rows = conn.execute(
        f"""
        SELECT
            t.id,
            t.name,
            t.description,
            t.created_at,
            u.username AS creator_username,
            u.display_name AS creator_name
        FROM checklist_templates t
        JOIN users u ON u.id = t.created_by
        {filters}
        ORDER BY t.id ASC
        """,
        tuple(params),
    ).fetchall()

    if not template_rows:
        return {
            "version": 1,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "templates": [],
        }

    template_ids = [int(row["id"]) for row in template_rows]
    item_placeholders = ",".join(["?"] * len(template_ids))
    stage_rows = conn.execute(
        f"""
        SELECT template_id, stage_key, stage_name, position
        FROM checklist_template_stages
        WHERE template_id IN ({item_placeholders})
        ORDER BY template_id ASC, position ASC, id ASC
        """,
        tuple(template_ids),
    ).fetchall()

    item_rows = conn.execute(
        f"""
        SELECT
            i.template_id,
            i.stage,
            i.content,
            i.position,
            COALESCE(s.position, 999999) AS stage_position
        FROM checklist_template_items i
        LEFT JOIN checklist_template_stages s
          ON s.template_id = i.template_id
         AND s.stage_key = i.stage
        WHERE i.template_id IN ({item_placeholders})
        ORDER BY
            i.template_id ASC,
            stage_position ASC,
            i.position ASC,
            i.id ASC
        """,
        tuple(template_ids),
    ).fetchall()

    stages_by_template: dict[int, list[dict[str, Any]]] = {}
    for row in stage_rows:
        key = int(row["template_id"])
        stages_by_template.setdefault(key, []).append(
            {
                "key": row["stage_key"],
                "name": row["stage_name"],
                "position": int(row["position"]),
            }
        )

    items_by_template: dict[int, list[dict[str, Any]]] = {}
    stage_pos_by_template: dict[int, dict[str, int]] = {}
    for tpl_id, stages in stages_by_template.items():
        stage_pos_by_template[tpl_id] = {str(s["key"]): int(s["position"]) for s in stages}

    grouped_items: dict[int, dict[str, list[sqlite3.Row]]] = {}
    for row in item_rows:
        tpl_id = int(row["template_id"])
        grouped_items.setdefault(tpl_id, {}).setdefault(str(row["stage"]), []).append(row)

    for tpl_id, stage_rows_by_key in grouped_items.items():
        stage_order = stage_pos_by_template.get(tpl_id, {})
        ordered_stage_keys = sorted(
            stage_rows_by_key.keys(),
            key=lambda k: (stage_order.get(k, 999999), k),
        )
        out: list[dict[str, Any]] = []
        for stage_key in ordered_stage_keys:
            rows = sorted(stage_rows_by_key[stage_key], key=lambda x: int(x["position"]))
            for idx, row in enumerate(rows):
                out.append(
                    {
                        "stage": stage_key,
                        "content": row["content"],
                        "position": idx,
                    }
                )
        items_by_template[tpl_id] = out

    templates: list[dict[str, Any]] = []
    for row in template_rows:
        template_id = int(row["id"])
        templates.append(
            {
                "id": template_id,
                "name": row["name"],
                "description": row["description"] or "",
                "created_at": row["created_at"],
                "creator_username": row["creator_username"],
                "creator_name": row["creator_name"],
                "stages": stages_by_template.get(template_id, []),
                "items": items_by_template.get(template_id, []),
            }
        )

    return {
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "templates": templates,
    }


@app.get("/api/template-export")
def export_templates_all(_: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with get_db() as conn:
        return build_templates_export_payload(conn)


@app.post("/api/template-export/selected")
def export_templates_selected(
    payload: TemplateExportSelectedRequest,
    _: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    with get_db() as conn:
        return build_templates_export_payload(conn, payload.template_ids)


@app.get("/api/templates/export")
def export_templates_legacy(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    # Backward compatibility endpoint.
    return export_templates_all(current_user)


@app.post("/api/templates/restore")
def restore_templates(
    payload: TemplatesRestoreRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    incoming_names = [tpl.name.strip() for tpl in payload.templates]

    if len(set(incoming_names)) != len(incoming_names):
        raise HTTPException(status_code=400, detail="Duplicate template names found in restore file.")

    total_items = sum(len(tpl.items) for tpl in payload.templates)
    if total_items > 10000:
        raise HTTPException(status_code=400, detail="Restore payload is too large.")

    created = 0
    updated = 0
    skipped = 0
    failed: list[dict[str, str]] = []

    with get_db() as conn:
        for tpl in payload.templates:
            name = tpl.name.strip()
            description = (tpl.description or "").strip()

            stage_defs: list[tuple[str, str, int]] = []
            stage_by_key: dict[str, tuple[str, str, int]] = {}

            if tpl.stages:
                for stage in sorted(tpl.stages, key=lambda x: x.position):
                    key = stage.key.strip()
                    label = stage.name.strip()
                    if not key or not label:
                        continue
                    if key in stage_by_key:
                        raise HTTPException(status_code=400, detail=f"Duplicate stage key in restore payload: {key}")
                    stage_def = (key, label, int(stage.position))
                    stage_by_key[key] = stage_def
                stage_defs = sorted(stage_by_key.values(), key=lambda x: x[2])
            else:
                for idx, default_stage in enumerate(DEFAULT_PROJECT_STAGES):
                    stage_def = (default_stage["key"], default_stage["name"], idx)
                    stage_defs.append(stage_def)
                    stage_by_key[default_stage["key"]] = stage_def

            for item in tpl.items:
                stage_key = item.stage.strip()
                if stage_key in stage_by_key:
                    continue
                next_pos = len(stage_defs)
                stage_def = (stage_key, default_stage_name_from_key(stage_key), next_pos)
                stage_defs.append(stage_def)
                stage_by_key[stage_key] = stage_def

            grouped: dict[str, list[TemplateRestoreItem]] = {key: [] for key, _, _ in stage_defs}
            for item in tpl.items:
                grouped.setdefault(item.stage, []).append(item)

            normalized_items: list[tuple[str, str, int]] = []
            for stage_key, _, _ in sorted(stage_defs, key=lambda x: x[2]):
                items = sorted(grouped.get(stage_key, []), key=lambda x: x.position)
                for idx, item in enumerate(items):
                    normalized_items.append((stage_key, item.content.strip(), idx))

            existing = conn.execute(
                "SELECT id, created_by FROM checklist_templates WHERE name=?",
                (name,),
            ).fetchone()

            if existing:
                if payload.mode == "skip":
                    skipped += 1
                    continue

                can_edit = existing["created_by"] == current_user["id"] or bool(current_user["is_admin"])
                if not can_edit:
                    failed.append({"name": name, "reason": "No permission to overwrite this template."})
                    continue

                template_id = int(existing["id"])
                conn.execute(
                    "UPDATE checklist_templates SET description=? WHERE id=?",
                    (description, template_id),
                )
                conn.execute("DELETE FROM checklist_template_stages WHERE template_id=?", (template_id,))
                conn.execute("DELETE FROM checklist_template_items WHERE template_id=?", (template_id,))
                for stage_key, stage_name, pos in sorted(stage_defs, key=lambda x: x[2]):
                    conn.execute(
                        """
                        INSERT INTO checklist_template_stages (template_id, stage_key, stage_name, position)
                        VALUES (?, ?, ?, ?)
                        """,
                        (template_id, stage_key, stage_name, pos),
                    )
                for stage, content, pos in normalized_items:
                    conn.execute(
                        """
                        INSERT INTO checklist_template_items (template_id, stage, content, position)
                        VALUES (?, ?, ?, ?)
                        """,
                        (template_id, stage, content, pos),
                    )
                updated += 1
                continue

            cur = conn.execute(
                """
                INSERT INTO checklist_templates (name, description, created_by)
                VALUES (?, ?, ?)
                """,
                (name, description, current_user["id"]),
            )
            template_id = int(cur.lastrowid)
            for stage_key, stage_name, pos in sorted(stage_defs, key=lambda x: x[2]):
                conn.execute(
                    """
                    INSERT INTO checklist_template_stages (template_id, stage_key, stage_name, position)
                    VALUES (?, ?, ?, ?)
                    """,
                    (template_id, stage_key, stage_name, pos),
                )
            for stage, content, pos in normalized_items:
                conn.execute(
                    """
                    INSERT INTO checklist_template_items (template_id, stage, content, position)
                    VALUES (?, ?, ?, ?)
                    """,
                    (template_id, stage, content, pos),
                )
            created += 1

        conn.commit()

    return {
        "ok": True,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "failed": failed,
    }


@app.post("/api/templates", status_code=201)
def create_template(
    payload: TemplateCreate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    with get_db() as conn:
        exists = conn.execute(
            "SELECT id FROM checklist_templates WHERE name=?", (payload.name.strip(),)
        ).fetchone()
        if exists:
            raise HTTPException(status_code=400, detail="Template name already exists.")
        cur = conn.execute(
            """
            INSERT INTO checklist_templates (name, description, created_by)
            VALUES (?, ?, ?)
            """,
            (payload.name.strip(), payload.description.strip(), current_user["id"]),
        )
        template_id = int(cur.lastrowid)
        ensure_default_template_stages(conn, template_id)
        conn.commit()
        row = conn.execute("SELECT * FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
    return row_to_dict(row)


@app.patch("/api/templates/{template_id}")
def update_template(
    template_id: int, payload: TemplateUpdate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update.")

    with get_db() as conn:
        target = conn.execute("SELECT * FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="Template not found.")
        if target["created_by"] != current_user["id"] and not current_user["is_admin"]:
            raise HTTPException(status_code=403, detail="No permission to update this template.")

        if "name" in updates:
            updates["name"] = str(updates["name"]).strip()
            dup = conn.execute(
                "SELECT id FROM checklist_templates WHERE name=? AND id<>?",
                (updates["name"], template_id),
            ).fetchone()
            if dup:
                raise HTTPException(status_code=400, detail="Template name already exists.")
        if "description" in updates:
            updates["description"] = str(updates["description"]).strip()

        set_clause = ", ".join([f"{k}=?" for k in updates.keys()])
        values = list(updates.values()) + [template_id]
        conn.execute(f"UPDATE checklist_templates SET {set_clause} WHERE id=?", values)
        conn.commit()
        row = conn.execute("SELECT * FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/templates/{template_id}")
def delete_template(
    template_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, bool]:
    with get_db() as conn:
        target = conn.execute("SELECT * FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="Template not found.")
        if target["created_by"] != current_user["id"] and not current_user["is_admin"]:
            raise HTTPException(status_code=403, detail="No permission to delete this template.")

        conn.execute("DELETE FROM checklist_templates WHERE id=?", (template_id,))
        conn.commit()
    return {"ok": True}


@app.get("/api/templates/{template_id}/stages")
def list_template_stages(
    template_id: int, _: dict[str, Any] = Depends(get_current_user)
) -> list[dict[str, Any]]:
    with get_db() as conn:
        template = conn.execute("SELECT id FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found.")
        ensure_default_template_stages(conn, template_id)
        rows = conn.execute(
            """
            SELECT *
            FROM checklist_template_stages
            WHERE template_id=?
            ORDER BY position ASC, id ASC
            """,
            (template_id,),
        ).fetchall()
        conn.commit()
    return [row_to_dict(row) for row in rows]


@app.post("/api/templates/{template_id}/stages", status_code=201)
def create_template_stage(
    template_id: int,
    payload: TemplateStageCreate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    stage_name = payload.name.strip()
    if not stage_name:
        raise HTTPException(status_code=400, detail="Stage name is required.")

    with get_db() as conn:
        require_template_edit_access(conn, template_id, current_user)
        ensure_default_template_stages(conn, template_id)
        duplicate = conn.execute(
            """
            SELECT id
            FROM checklist_template_stages
            WHERE template_id=? AND lower(stage_name)=lower(?)
            """,
            (template_id, stage_name),
        ).fetchone()
        if duplicate:
            raise HTTPException(status_code=400, detail="Stage name already exists.")

        stage_key = generate_unique_template_stage_key(conn, template_id, stage_name)
        next_pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM checklist_template_stages WHERE template_id=?",
            (template_id,),
        ).fetchone()
        cur = conn.execute(
            """
            INSERT INTO checklist_template_stages (template_id, stage_key, stage_name, position)
            VALUES (?, ?, ?, ?)
            """,
            (template_id, stage_key, stage_name, int(next_pos["next_position"])),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM checklist_template_stages WHERE id=?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.put("/api/templates/{template_id}/stages")
def replace_template_stages(
    template_id: int,
    payload: TemplateStagesReplaceRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    ordered_stages = sorted(payload.stages, key=lambda x: x.position)
    keys_seen: set[str] = set()
    names_seen: set[str] = set()
    normalized: list[tuple[str, str, int]] = []
    for idx, stage in enumerate(ordered_stages):
        key = stage.key.strip()
        name = stage.name.strip()
        if key in keys_seen:
            raise HTTPException(status_code=400, detail=f"Duplicate stage key: {key}")
        folded_name = name.lower()
        if folded_name in names_seen:
            raise HTTPException(status_code=400, detail=f"Duplicate stage name: {name}")
        keys_seen.add(key)
        names_seen.add(folded_name)
        normalized.append((key, name, idx))

    with get_db() as conn:
        require_template_edit_access(conn, template_id, current_user)
        conn.execute("DELETE FROM checklist_template_stages WHERE template_id=?", (template_id,))
        for key, name, pos in normalized:
            conn.execute(
                """
                INSERT INTO checklist_template_stages (template_id, stage_key, stage_name, position)
                VALUES (?, ?, ?, ?)
                """,
                (template_id, key, name, pos),
            )

        valid_stage_keys = [key for key, _, _ in normalized]
        placeholders = ",".join(["?"] * len(valid_stage_keys))
        conn.execute(
            f"DELETE FROM checklist_template_items WHERE template_id=? AND stage NOT IN ({placeholders})",
            (template_id, *valid_stage_keys),
        )
        for stage_key in valid_stage_keys:
            rows = conn.execute(
                """
                SELECT id
                FROM checklist_template_items
                WHERE template_id=? AND stage=?
                ORDER BY position ASC, id ASC
                """,
                (template_id, stage_key),
            ).fetchall()
            for idx, row in enumerate(rows):
                conn.execute(
                    "UPDATE checklist_template_items SET position=? WHERE id=?",
                    (idx, int(row["id"])),
                )
        conn.commit()
    return {"ok": True}


@app.patch("/api/templates/{template_id}/stages/{stage_id}")
def update_template_stage(
    template_id: int,
    stage_id: int,
    payload: TemplateStageUpdate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    stage_name = payload.name.strip()
    if not stage_name:
        raise HTTPException(status_code=400, detail="Stage name is required.")

    with get_db() as conn:
        require_template_edit_access(conn, template_id, current_user)
        ensure_default_template_stages(conn, template_id)
        current_row = conn.execute(
            "SELECT * FROM checklist_template_stages WHERE id=? AND template_id=?",
            (stage_id, template_id),
        ).fetchone()
        if not current_row:
            raise HTTPException(status_code=404, detail="Stage not found.")

        duplicate = conn.execute(
            """
            SELECT id
            FROM checklist_template_stages
            WHERE template_id=? AND lower(stage_name)=lower(?) AND id<>?
            """,
            (template_id, stage_name, stage_id),
        ).fetchone()
        if duplicate:
            raise HTTPException(status_code=400, detail="Stage name already exists.")

        conn.execute(
            "UPDATE checklist_template_stages SET stage_name=? WHERE id=?",
            (stage_name, stage_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM checklist_template_stages WHERE id=?", (stage_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/templates/{template_id}/stages/{stage_id}")
def delete_template_stage(
    template_id: int,
    stage_id: int,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    with get_db() as conn:
        require_template_edit_access(conn, template_id, current_user)
        ensure_default_template_stages(conn, template_id)
        stage_row = conn.execute(
            "SELECT * FROM checklist_template_stages WHERE id=? AND template_id=?",
            (stage_id, template_id),
        ).fetchone()
        if not stage_row:
            raise HTTPException(status_code=404, detail="Stage not found.")

        stage_count = conn.execute(
            "SELECT COUNT(*) AS c FROM checklist_template_stages WHERE template_id=?",
            (template_id,),
        ).fetchone()
        if int(stage_count["c"]) <= 1:
            raise HTTPException(status_code=400, detail="At least one stage is required.")

        stage_key = str(stage_row["stage_key"])
        conn.execute(
            "DELETE FROM checklist_template_items WHERE template_id=? AND stage=?",
            (template_id, stage_key),
        )
        conn.execute("DELETE FROM checklist_template_stages WHERE id=?", (stage_id,))

        remain_rows = conn.execute(
            "SELECT id FROM checklist_template_stages WHERE template_id=? ORDER BY position ASC, id ASC",
            (template_id,),
        ).fetchall()
        for idx, row in enumerate(remain_rows):
            conn.execute("UPDATE checklist_template_stages SET position=? WHERE id=?", (idx, int(row["id"])))

        conn.commit()
    return {"ok": True}


@app.get("/api/templates/{template_id}/items")
def list_template_items(
    template_id: int, _: dict[str, Any] = Depends(get_current_user)
) -> list[dict[str, Any]]:
    with get_db() as conn:
        template = conn.execute("SELECT id FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found.")
        ensure_default_template_stages(conn, template_id)
        rows = conn.execute(
            """
            SELECT i.*
            FROM checklist_template_items i
            LEFT JOIN checklist_template_stages s
              ON s.template_id = i.template_id
             AND s.stage_key = i.stage
            WHERE i.template_id=?
            ORDER BY COALESCE(s.position, 999999) ASC, i.position ASC, i.id ASC
            """,
            (template_id,),
        ).fetchall()
        conn.commit()
    return [row_to_dict(row) for row in rows]


@app.post("/api/templates/{template_id}/items", status_code=201)
def create_template_item(
    template_id: int, payload: TemplateItemCreate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    with get_db() as conn:
        require_template_edit_access(conn, template_id, current_user)
        ensure_default_template_stages(conn, template_id)
        stage_row = conn.execute(
            "SELECT id FROM checklist_template_stages WHERE template_id=? AND stage_key=?",
            (template_id, payload.stage),
        ).fetchone()
        if not stage_row:
            raise HTTPException(status_code=400, detail="Invalid stage key.")

        next_pos_row = conn.execute(
            """
            SELECT COALESCE(MAX(position), -1) + 1 AS next_position
            FROM checklist_template_items
            WHERE template_id=? AND stage=?
            """,
            (template_id, payload.stage),
        ).fetchone()
        cur = conn.execute(
            """
            INSERT INTO checklist_template_items (template_id, stage, content, position)
            VALUES (?, ?, ?, ?)
            """,
            (template_id, payload.stage, payload.content.strip(), int(next_pos_row["next_position"])),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM checklist_template_items WHERE id=?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/template-items/{item_id}")
def delete_template_item(
    item_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, bool]:
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT checklist_template_items.id AS item_id, checklist_templates.created_by
            FROM checklist_template_items
            JOIN checklist_templates ON checklist_templates.id = checklist_template_items.template_id
            WHERE checklist_template_items.id=?
            """,
            (item_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Template item not found.")
        if row["created_by"] != current_user["id"] and not current_user["is_admin"]:
            raise HTTPException(status_code=403, detail="No permission to edit this template.")

        conn.execute("DELETE FROM checklist_template_items WHERE id=?", (item_id,))
        conn.commit()
    return {"ok": True}


@app.put("/api/templates/{template_id}/items")
def replace_template_items(
    template_id: int,
    payload: TemplateItemsReplaceRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    with get_db() as conn:
        require_template_edit_access(conn, template_id, current_user)
        ensure_default_template_stages(conn, template_id)
        valid_stage_keys = {
            str(row["stage_key"])
            for row in conn.execute(
                "SELECT stage_key FROM checklist_template_stages WHERE template_id=?",
                (template_id,),
            ).fetchall()
        }
        invalid_stages = sorted({item.stage for item in payload.items if item.stage not in valid_stage_keys})
        if invalid_stages:
            raise HTTPException(status_code=400, detail=f"Invalid stage keys: {', '.join(invalid_stages)}")

        conn.execute("DELETE FROM checklist_template_items WHERE template_id=?", (template_id,))
        for item in payload.items:
            conn.execute(
                """
                INSERT INTO checklist_template_items (template_id, stage, content, position)
                VALUES (?, ?, ?, ?)
                """,
                (template_id, item.stage, item.content.strip(), item.position),
            )
        conn.commit()
    return {"ok": True}


@app.post("/api/projects/{project_id}/apply-template/{template_id}")
def apply_template_to_project(
    project_id: int,
    template_id: int,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    with get_db() as conn:
        require_project_access(conn, project_id, current_user)
        ensure_default_project_stages(conn, project_id)
        template = conn.execute("SELECT id FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found.")
        ensure_default_template_stages(conn, template_id)

        template_stages = conn.execute(
            """
            SELECT stage_key, stage_name, position
            FROM checklist_template_stages
            WHERE template_id=?
            ORDER BY position ASC, id ASC
            """,
            (template_id,),
        ).fetchall()

        template_items = conn.execute(
            """
            SELECT i.stage, i.content, i.position
            FROM checklist_template_items i
            LEFT JOIN checklist_template_stages s
              ON s.template_id = i.template_id
             AND s.stage_key = i.stage
            WHERE i.template_id=?
            ORDER BY COALESCE(s.position, 999999) ASC, i.position ASC, i.id ASC
            """,
            (template_id,),
        ).fetchall()

        for stage in template_stages:
            stage_key = str(stage["stage_key"])
            stage_name = str(stage["stage_name"])
            stage_position = int(stage["position"])
            stage_row = conn.execute(
                "SELECT id FROM project_stages WHERE project_id=? AND stage_key=?",
                (project_id, stage_key),
            ).fetchone()
            if not stage_row:
                next_pos_row = conn.execute(
                    "SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM project_stages WHERE project_id=?",
                    (project_id,),
                ).fetchone()
                conn.execute(
                    """
                    INSERT INTO project_stages (project_id, stage_key, stage_name, position)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        project_id,
                        stage_key,
                        stage_name,
                        stage_position,
                    ),
                )
            else:
                conn.execute(
                    "UPDATE project_stages SET stage_name=?, position=? WHERE project_id=? AND stage_key=?",
                    (stage_name, stage_position, project_id, stage_key),
                )

        keep_stage_keys = [str(stage["stage_key"]) for stage in template_stages]
        if keep_stage_keys:
            placeholders = ",".join(["?"] * len(keep_stage_keys))
            conn.execute(
                f"DELETE FROM project_stages WHERE project_id=? AND stage_key NOT IN ({placeholders})",
                (project_id, *keep_stage_keys),
            )

        conn.execute("DELETE FROM project_checklist_items WHERE project_id=?", (project_id,))
        for idx, item in enumerate(template_items):
            conn.execute(
                """
                INSERT INTO project_checklist_items
                    (project_id, stage, content, is_done, workflow_status, position, target_date)
                VALUES (?, ?, ?, 0, 'upcoming', ?, NULL)
                """,
                (project_id, item["stage"], item["content"], idx),
            )
        conn.commit()
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
