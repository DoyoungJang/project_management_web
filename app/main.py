from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import Cookie, Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "project_manager.db"
STATIC_DIR = BASE_DIR / "static"
SESSION_HOURS = 12

app = FastAPI(title="Project Management API", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
                expires_at INTEGER NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
                stage TEXT NOT NULL CHECK (stage IN ('data_acquisition', 'labeling', 'development')),
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

            CREATE TABLE IF NOT EXISTS checklist_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT DEFAULT '',
                created_by INTEGER NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS checklist_template_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL,
                stage TEXT NOT NULL CHECK (stage IN ('data_acquisition', 'labeling', 'development')),
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
        ensure_column(conn, "project_checklist_items", "target_date", "TEXT")
        ensure_column(conn, "project_checklist_items", "workflow_status", "TEXT NOT NULL DEFAULT 'upcoming'")
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
        conn.commit()

        admin_exists = conn.execute("SELECT id FROM users WHERE is_admin=1 LIMIT 1").fetchone()
        if not admin_exists:
            conn.execute(
                """
                INSERT INTO users (username, display_name, password_hash, is_admin)
                VALUES (?, ?, ?, 1)
                """,
                ("admin", "System Admin", hash_password("admin123!")),
            )
            conn.commit()


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


def create_session(conn: sqlite3.Connection, user_id: int) -> tuple[str, int]:
    token = secrets.token_urlsafe(36)
    expires_at = int(time.time()) + (SESSION_HOURS * 60 * 60)
    conn.execute(
        "INSERT INTO user_sessions (user_id, session_token, expires_at) VALUES (?, ?, ?)",
        (user_id, token, expires_at),
    )
    conn.commit()
    return token, expires_at


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


def get_current_user(session_token: str | None = Cookie(default=None)) -> dict[str, Any]:
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


class LoginRequest(BaseModel):
    username: str = Field(min_length=2, max_length=40)
    password: str = Field(min_length=6, max_length=128)


class AdminUserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
    display_name: str = Field(min_length=2, max_length=60)
    password: str = Field(min_length=6, max_length=128)
    email: str | None = Field(default=None, max_length=120)
    is_admin: bool = False


class AdminUserUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=60)
    password: str | None = Field(default=None, min_length=6, max_length=128)
    email: str | None = Field(default=None, max_length=120)
    is_admin: bool | None = None


class ProjectCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    description: str = Field(default="", max_length=500)
    owner: str = Field(min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
    status: str = Field(pattern="^(planned|active|done)$")
    due_date: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    owner: str | None = Field(default=None, min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
    status: str | None = Field(default=None, pattern="^(planned|active|done)$")
    due_date: str | None = None


class TaskCreate(BaseModel):
    project_id: int
    title: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=500)
    assignee: str = Field(min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
    priority: str = Field(pattern="^(low|medium|high)$")
    status: str = Field(pattern="^(todo|in_progress|done)$")
    due_date: str | None = None


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    assignee: str | None = Field(default=None, min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
    priority: str | None = Field(default=None, pattern="^(low|medium|high)$")
    status: str | None = Field(default=None, pattern="^(todo|in_progress|done)$")
    due_date: str | None = None


class ChecklistItemCreate(BaseModel):
    stage: str = Field(pattern="^(data_acquisition|labeling|development)$")
    content: str = Field(min_length=1, max_length=200)
    target_date: str | None = None
    workflow_status: str = Field(default="upcoming", pattern="^(upcoming|inprogress|done)$")


class ChecklistItemUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=200)
    is_done: bool | None = None
    position: int | None = Field(default=None, ge=0)
    target_date: str | None = None
    workflow_status: str | None = Field(default=None, pattern="^(upcoming|inprogress|done)$")


class NotificationRuleCreate(BaseModel):
    days_before: int = Field(ge=0, le=365)


class ParticipantCreate(BaseModel):
    username: str = Field(min_length=2, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")


class TemplateCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=300)


class TemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=300)


class TemplateItemCreate(BaseModel):
    stage: str = Field(pattern="^(data_acquisition|labeling|development)$")
    content: str = Field(min_length=1, max_length=200)


class TemplateItemDraft(BaseModel):
    stage: str = Field(pattern="^(data_acquisition|labeling|development)$")
    content: str = Field(min_length=1, max_length=200)
    position: int = Field(ge=0)


class TemplateItemsReplaceRequest(BaseModel):
    items: list[TemplateItemDraft]


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(payload: LoginRequest, response: Response) -> dict[str, Any]:
    with get_db() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE username=? AND (auth_provider='local' OR auth_provider IS NULL)",
            (payload.username.strip(),),
        ).fetchone()
        if not user or not verify_password(payload.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid username or password.")
        token, expires_at = create_session(conn, user["id"])

    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=SESSION_HOURS * 60 * 60,
        path="/",
    )
    return {"user": user_public(user), "expires_at": expires_at}


@app.post("/api/auth/logout")
def logout(
    response: Response,
    session_token: str | None = Cookie(default=None),
    _: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    if session_token:
        with get_db() as conn:
            conn.execute("DELETE FROM user_sessions WHERE session_token=?", (session_token,))
            conn.commit()
    response.delete_cookie("session_token", path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
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
                (payload.email or "").strip() or None,
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
            task_total = conn.execute("SELECT COUNT(*) AS c FROM tasks").fetchone()["c"]
            task_done = conn.execute("SELECT COUNT(*) AS c FROM tasks WHERE status='done'").fetchone()["c"]
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
            task_total = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM tasks
                WHERE tasks.project_id IN (
                    SELECT DISTINCT p.id
                    FROM projects p
                    LEFT JOIN project_participants pp ON pp.project_id = p.id
                    LEFT JOIN users u ON u.id = pp.user_id
                    WHERE p.owner=? OR u.username=?
                )
                """,
                (current_user["username"], current_user["username"]),
            ).fetchone()["c"]
            task_done = conn.execute(
                """
                SELECT COUNT(*) AS c
                FROM tasks
                WHERE tasks.status='done'
                  AND tasks.project_id IN (
                    SELECT DISTINCT p.id
                    FROM projects p
                    LEFT JOIN project_participants pp ON pp.project_id = p.id
                    LEFT JOIN users u ON u.id = pp.user_id
                    WHERE p.owner=? OR u.username=?
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

    completion_rate = 0 if task_total == 0 else round((task_done / task_total) * 100, 1)
    return {
        "projects": project_total,
        "active_projects": active_projects,
        "tasks": task_total,
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


@app.get("/api/projects/{project_id}/participants")
def list_project_participants(
    project_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> list[dict[str, Any]]:
    with get_db() as conn:
        project = require_project_access(conn, project_id, current_user)
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
        require_project_owner(conn, project_id, current_user)
        user_id = get_user_id_by_username(conn, username.strip())
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
    with get_db() as conn:
        ensure_username_exists(conn, owner)
        if not current_user["is_admin"] and owner != current_user["username"]:
            raise HTTPException(status_code=403, detail="You can create only your own projects.")
        cur = conn.execute(
            """
            INSERT INTO projects (name, description, owner, status, due_date)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                payload.name.strip(),
                payload.description.strip(),
                owner,
                payload.status,
                payload.due_date,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id=?", (cur.lastrowid,)).fetchone()
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
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/projects/{project_id}")
def delete_project(
    project_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, bool]:
    with get_db() as conn:
        require_project_owner(conn, project_id, current_user)
        cur = conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Project not found.")
        conn.commit()
    return {"ok": True}


@app.get("/api/tasks")
def list_tasks(
    project_id: int | None = Query(default=None),
    status: str | None = Query(default=None, pattern="^(todo|in_progress|done)$"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    query = """
    SELECT tasks.*, projects.name AS project_name
    FROM tasks
    JOIN projects ON projects.id = tasks.project_id
    """
    conditions: list[str] = []
    values: list[Any] = []

    if project_id is not None:
        conditions.append("tasks.project_id=?")
        values.append(project_id)
    if status is not None:
        conditions.append("tasks.status=?")
        values.append(status)
    if not current_user["is_admin"]:
        conditions.append(
            """
            (
                projects.owner=?
                OR EXISTS (
                    SELECT 1
                    FROM project_participants pp
                    JOIN users u ON u.id = pp.user_id
                    WHERE pp.project_id = projects.id
                      AND u.username=?
                )
            )
            """
        )
        values.extend([current_user["username"], current_user["username"]])
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY tasks.id DESC"

    with get_db() as conn:
        rows = conn.execute(query, values).fetchall()
    return [row_to_dict(row) for row in rows]


@app.post("/api/tasks", status_code=201)
def create_task(payload: TaskCreate, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with get_db() as conn:
        project = require_project_access(conn, payload.project_id, current_user)
        ensure_username_exists(conn, payload.assignee.strip())
        cur = conn.execute(
            """
            INSERT INTO tasks (project_id, title, description, assignee, priority, status, due_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.project_id,
                payload.title.strip(),
                payload.description.strip(),
                payload.assignee.strip(),
                payload.priority,
                payload.status,
                payload.due_date,
            ),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT tasks.*, projects.name AS project_name
            FROM tasks JOIN projects ON projects.id = tasks.project_id
            WHERE tasks.id=?
            """,
            (cur.lastrowid,),
        ).fetchone()
    return row_to_dict(row)


@app.patch("/api/tasks/{task_id}")
def update_task(
    task_id: int, payload: TaskUpdate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update.")

    with get_db() as conn:
        task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found.")
        require_project_access(conn, int(task["project_id"]), current_user)
        if "assignee" in updates:
            assignee = str(updates["assignee"]).strip()
            ensure_username_exists(conn, assignee)
            updates["assignee"] = assignee
        set_clause = ", ".join([f"{k}=?" for k in updates.keys()])
        values = list(updates.values()) + [task_id]
        cur = conn.execute(f"UPDATE tasks SET {set_clause} WHERE id=?", values)
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Task not found.")
        conn.commit()
        row = conn.execute(
            """
            SELECT tasks.*, projects.name AS project_name
            FROM tasks JOIN projects ON projects.id = tasks.project_id
            WHERE tasks.id=?
            """,
            (task_id,),
        ).fetchone()
    return row_to_dict(row)


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: int, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, bool]:
    with get_db() as conn:
        task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found.")
        require_project_access(conn, int(task["project_id"]), current_user)
        cur = conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Task not found.")
        conn.commit()
    return {"ok": True}


@app.get("/api/projects/{project_id}/checklists")
def list_project_checklists(
    project_id: int, current_user: dict[str, Any] = Depends(get_current_user)
) -> list[dict[str, Any]]:
    with get_db() as conn:
        require_project_access(conn, project_id, current_user)
        rows = conn.execute(
            """
            SELECT *
            FROM project_checklist_items
            WHERE project_id=?
            ORDER BY
                CASE workflow_status
                    WHEN 'upcoming' THEN 1
                    WHEN 'inprogress' THEN 2
                    WHEN 'done' THEN 3
                    ELSE 4
                END,
                position ASC,
                CASE stage
                    WHEN 'data_acquisition' THEN 1
                    WHEN 'labeling' THEN 2
                    WHEN 'development' THEN 3
                    ELSE 4
                END,
                id ASC
            """,
            (project_id,),
        ).fetchall()
    return [row_to_dict(row) for row in rows]


@app.post("/api/projects/{project_id}/checklists", status_code=201)
def create_checklist_item(
    project_id: int, payload: ChecklistItemCreate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    with get_db() as conn:
        require_project_access(conn, project_id, current_user)
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
                    CAST(julianday(date(c.target_date)) - julianday(date('now','localtime')) AS INTEGER) AS days_left
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
                    CAST(julianday(date(c.target_date)) - julianday(date('now','localtime')) AS INTEGER) AS days_left
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
                (current_user["username"], current_user["username"], days),
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
        conn.commit()
        row = conn.execute("SELECT * FROM checklist_templates WHERE id=?", (cur.lastrowid,)).fetchone()
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


@app.get("/api/templates/{template_id}/items")
def list_template_items(
    template_id: int, _: dict[str, Any] = Depends(get_current_user)
) -> list[dict[str, Any]]:
    with get_db() as conn:
        template = conn.execute("SELECT id FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found.")
        rows = conn.execute(
            """
            SELECT *
            FROM checklist_template_items
            WHERE template_id=?
            ORDER BY
                CASE stage
                    WHEN 'data_acquisition' THEN 1
                    WHEN 'labeling' THEN 2
                    WHEN 'development' THEN 3
                    ELSE 4
                END,
                position ASC,
                id ASC
            """,
            (template_id,),
        ).fetchall()
    return [row_to_dict(row) for row in rows]


@app.post("/api/templates/{template_id}/items", status_code=201)
def create_template_item(
    template_id: int, payload: TemplateItemCreate, current_user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    with get_db() as conn:
        template = conn.execute("SELECT * FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found.")
        if template["created_by"] != current_user["id"] and not current_user["is_admin"]:
            raise HTTPException(status_code=403, detail="No permission to edit this template.")

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
        template = conn.execute("SELECT * FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found.")
        if template["created_by"] != current_user["id"] and not current_user["is_admin"]:
            raise HTTPException(status_code=403, detail="No permission to edit this template.")

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
        template = conn.execute("SELECT id FROM checklist_templates WHERE id=?", (template_id,)).fetchone()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found.")

        template_items = conn.execute(
            """
            SELECT stage, content, position
            FROM checklist_template_items
            WHERE template_id=?
            ORDER BY
                CASE stage
                    WHEN 'data_acquisition' THEN 1
                    WHEN 'labeling' THEN 2
                    WHEN 'development' THEN 3
                    ELSE 4
                END,
                position ASC,
                id ASC
            """,
            (template_id,),
        ).fetchall()

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
