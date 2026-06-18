"""/api/memories CRUD. Parity with packages/core/src/server/routes/memories.ts.
Reads + writes the shared SQLite `memories` table; Python is the SOLE writer (the
loop only SELECTs enabled rows). Never migrates schema. enabled is a SQLite 0/1.
"""
import os
import time
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


def make_memories_patch(settings: Settings):
    # Partial update of content/enabled; always bumps updated_at. Parity with
    # memories.ts PATCH /:id. enabled stored as 0/1. The dynamic SET clause joins
    # only fixed column-name fragments — values are always parameterized.
    async def _handler(request: Request) -> JSONResponse:
        mem_id = request.path_params["memory_id"]
        body = await json_or_empty(request)
        if not os.path.exists(settings.db_path):
            return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
        conn = connect(settings.db_path)
        try:
            row = conn.execute("SELECT id FROM memories WHERE id = ?", (mem_id,)).fetchone()
            if row is None:
                return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
            cols = ["updated_at = ?"]
            vals: list = [int(time.time() * 1000)]
            if "content" in body:
                content = str(body.get("content") or "").strip()[:_MAX_CONTENT]
                if not content:
                    return JSONResponse(
                        {"ok": False, "code": "VALIDATION", "message": "content required"},
                        status_code=400,
                    )
                cols.append("content = ?")
                vals.append(content)
            if "enabled" in body:
                enabled = body.get("enabled")
                if not isinstance(enabled, bool):
                    return JSONResponse(
                        {"ok": False, "code": "VALIDATION", "message": "enabled 须为布尔"},
                        status_code=400,
                    )
                cols.append("enabled = ?")
                vals.append(1 if enabled else 0)
            vals.append(mem_id)
            conn.execute(f"UPDATE memories SET {', '.join(cols)} WHERE id = ?", vals)
        finally:
            conn.close()
        return JSONResponse({"ok": True})

    return _handler


def make_memories_delete(settings: Settings):
    # Delete a memory. Parity with memories.ts DELETE /:id. No FK children, no
    # guard — a single auto-committed DELETE (the SELECT only shapes the 404).
    async def _handler(request: Request) -> JSONResponse:
        mem_id = request.path_params["memory_id"]
        if not os.path.exists(settings.db_path):
            return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
        conn = connect(settings.db_path)
        try:
            row = conn.execute("SELECT id FROM memories WHERE id = ?", (mem_id,)).fetchone()
            if row is None:
                return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
            conn.execute("DELETE FROM memories WHERE id = ?", (mem_id,))
        finally:
            conn.close()
        return JSONResponse({"ok": True})

    return _handler
