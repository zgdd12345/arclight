"""Read-only GET /api/projects. Parity with packages/core/src/server/routes/projects.ts
(GET / handler + listAvailableDirs). Reads the shared SQLite workspaces table; TS remains
the sole writer (one-writer-per-table). Never writes, never migrates.
"""
import os
import sqlite3

from starlette.requests import Request
from starlette.responses import JSONResponse

from .db import connect
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
