"""/api/memories CRUD. Parity with packages/core/src/server/routes/memories.ts.
Reads + writes the shared SQLite `memories` table; Python is the SOLE writer (the
loop only SELECTs enabled rows). Never migrates schema. enabled is a SQLite 0/1.
"""
import os
import uuid

from starlette.requests import Request
from starlette.responses import JSONResponse

from .db import connect
from .httputil import json_or_empty
from .settings import Settings

_MAX_CONTENT = 500


def _read_memories(db_path: str) -> list[dict]:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"not found: {db_path}")
    conn = connect(db_path)
    try:
        rows = conn.execute(
            "SELECT id, content, enabled, created_at FROM memories "
            "ORDER BY created_at DESC, rowid DESC"
        ).fetchall()
        return [
            {
                "id": r["id"],
                "content": r["content"],
                "enabled": bool(r["enabled"]),
                "createdAt": r["created_at"],
            }
            for r in rows
        ]
    finally:
        conn.close()


def make_memories_get(settings: Settings):
    async def _handler(_request: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "memories": _read_memories(settings.db_path)})

    return _handler


def make_memories_post(settings: Settings):
    async def _handler(request: Request) -> JSONResponse:
        body = await json_or_empty(request)
        content = str(body.get("content", "") or "").strip()[:_MAX_CONTENT]
        if not content:
            return JSONResponse(
                {"ok": False, "code": "VALIDATION", "message": "content required"}, status_code=400
            )
        if not os.path.exists(settings.db_path):
            return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
        mem_id = str(uuid.uuid4())
        conn = connect(settings.db_path)
        try:
            conn.execute("INSERT INTO memories (id, content) VALUES (?, ?)", (mem_id, content))
        finally:
            conn.close()
        return JSONResponse({"ok": True, "id": mem_id}, status_code=201)

    return _handler
