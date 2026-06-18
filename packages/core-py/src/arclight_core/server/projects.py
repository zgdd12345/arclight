"""Read-only GET /api/projects. Parity with packages/core/src/server/routes/projects.ts
(GET / handler + listAvailableDirs). Reads the shared SQLite workspaces table; TS remains
the sole writer (one-writer-per-table). Never writes, never migrates.
"""
import os
import sqlite3

from starlette.requests import Request
from starlette.responses import JSONResponse

from .db import connect
from .httputil import json_or_empty
from .settings import Settings


def _read_workspaces(db_path: str) -> list[dict]:
    # Read-only by discipline: SELECT only. Deterministic ORDER BY rowid (insertion
    # order) now that workspaces writes move to Python (slice-3 carry-forward).
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"not found: {db_path}")
    conn = connect(db_path)
    try:
        rows = conn.execute("SELECT id, name, repo_path FROM workspaces ORDER BY rowid").fetchall()
        return [{"workspaceId": r["id"], "name": r["name"], "repoPath": r["repo_path"]} for r in rows]
    finally:
        conn.close()


def list_available_dirs(projects_root: str, registered: set[str]) -> list[dict]:
    root = os.path.abspath(projects_root)
    out: list[dict] = []
    try:
        entries = list(os.scandir(root))
    except OSError:
        return []
    for entry in entries:
        name = entry.name
        if name.startswith("."):
            continue
        if entry.is_symlink():
            continue
        if not entry.is_dir(follow_symlinks=False):
            continue
        if os.path.abspath(os.path.join(root, name)) in registered:
            continue
        out.append({"name": name})
    out.sort(key=lambda d: d["name"])
    return out


def make_projects_get(settings: Settings):
    async def _handler(_request: Request) -> JSONResponse:
        try:
            projects = _read_workspaces(settings.db_path)
        except FileNotFoundError as exc:
            return JSONResponse(
                {"ok": False, "message": f"database error: {exc}"},
                status_code=500,
            )
        except sqlite3.OperationalError as exc:
            return JSONResponse(
                {"ok": False, "message": f"database error: {exc}"},
                status_code=500,
            )
        registered = {os.path.abspath(p["repoPath"]) for p in projects}
        available = list_available_dirs(settings.projects_root, registered)
        return JSONResponse(
            {
                "ok": True,
                "projectsRoot": os.path.abspath(settings.projects_root),
                "projects": projects,
                "available": available,
            }
        )

    return _handler


def make_projects_patch(settings: Settings):
    # Rename a workspace (display name only; repo_path/disk untouched). Parity with
    # projects.ts PATCH /:workspaceId. Writes ONLY workspaces.name.
    async def _handler(request: Request) -> JSONResponse:
        ws_id = request.path_params["workspace_id"]
        body = await json_or_empty(request)
        name = str(body.get("name", "") or "").strip()[:60]
        if not name:
            return JSONResponse({"ok": False, "code": "VALIDATION", "message": "name required"}, status_code=400)
        if not os.path.exists(settings.db_path):
            return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
        conn = connect(settings.db_path)
        try:
            row = conn.execute("SELECT id FROM workspaces WHERE id = ?", (ws_id,)).fetchone()
            if row is None:
                return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
            conn.execute("UPDATE workspaces SET name = ? WHERE id = ?", (name, ws_id))
            conn.commit()
        finally:
            conn.close()
        return JSONResponse({"ok": True})

    return _handler


# Turn statuses that block workspace deletion (parity with projects.ts DELETE guard).
_ACTIVE_TURN_STATUSES = ("queued", "running", "awaiting_approval")


def make_projects_delete(settings: Settings):
    # Unregister a workspace + FK-cascade its sessions/turns. Disk files untouched.
    # Fail-closed if any session has an active turn. Parity with projects.ts DELETE.
    # Writes ONLY workspaces (cascade is an engine side-effect of the FK).
    async def _handler(request: Request) -> JSONResponse:
        ws_id = request.path_params["workspace_id"]
        if not os.path.exists(settings.db_path):
            return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
        conn = connect(settings.db_path)
        try:
            conn.execute("BEGIN IMMEDIATE")  # take the write lock before the guard
            row = conn.execute("SELECT id FROM workspaces WHERE id = ?", (ws_id,)).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
            placeholders = ",".join("?" for _ in _ACTIVE_TURN_STATUSES)
            active = conn.execute(
                "SELECT turns.id FROM turns "
                "JOIN sessions ON turns.session_id = sessions.id "
                f"WHERE sessions.workspace_id = ? AND turns.status IN ({placeholders}) LIMIT 1",
                (ws_id, *_ACTIVE_TURN_STATUSES),
            ).fetchone()
            if active is not None:
                conn.execute("ROLLBACK")
                return JSONResponse(
                    {"ok": False, "code": "TURN_ACTIVE", "message": "项目内有会话正在运行，先停止再删除"},
                    status_code=409,
                )
            conn.execute("DELETE FROM workspaces WHERE id = ?", (ws_id,))
            conn.execute("COMMIT")
        finally:
            conn.close()
        return JSONResponse({"ok": True})

    return _handler
