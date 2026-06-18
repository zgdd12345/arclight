# Python Core Migration — M1 Slice 4: `memories` write-ownership transfer (whole `/api/memories` CRUD → Python) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfer the entire `/api/memories` CRUD group (GET list, POST create, PATCH update, DELETE) from the TS core to the Python core. `memories` is a clean single-writer table — `memories.ts` is its only writer (the loop only reads enabled rows) — so the whole group flips to Python with no split-brain and no exact-match routing gymnastics.

**Architecture:** Because every method and path under `/api/memories` migrates (no sibling stays on TS), the proxy route table flips the group with a single plain entry (`"/api/memories": "py"`); no `=`-exact channel is needed (unlike slice 3's `/api/projects`, which kept `GET /:id/sessions` on TS). The Python app gains a `memories.py` module (read list + create/update/delete handlers) writing only the shared `memories` table via the existing `db.connect()` (autocommit; single-statement writes auto-commit — no `BEGIN IMMEDIATE` needed since there is no cross-row guard or FK cascade here). A shared `json_or_empty()` body-parser is extracted from `projects.py` into `httputil.py` so both route modules reuse it (DRY). A cross-runtime e2e drives the full CRUD lifecycle (create → list → update → delete) through the proxy against a real uvicorn over a seeded SQLite.

**Tech Stack:** Python 3.12 (conda env `arclight`), Starlette + uvicorn, stdlib `sqlite3`/`uuid`/`time`; TypeScript/Bun proxy.

## Global Constraints

- **web/cli unchanged; proxy transparent; proxy NOT in the production launch path.** No edits to `serve.ts`, dev scripts, or the web `baseUrl`. The seam is proven by the e2e.
- **`memories` is single-writer; the whole group migrates.** Verified: the only writer of the `memories` table is `memories.ts` (INSERT/UPDATE/DELETE); the loop (`runner.ts`) only `SELECT`s enabled rows. So GET+POST+PATCH+DELETE all move to Python with strict one-writer-per-table preserved (Python becomes the sole writer; TS stops serving the group). No second-writer deferral (unlike slice-3's workspaces POST).
- **Routing flips the whole group with a plain entry.** `DEFAULT_TABLE["/api/memories"]` changes from `"ts"` to `"py"` (a plain `Upstream`, all methods, longest-prefix). No `=`-exact entry needed — nothing under `/api/memories` stays on TS.
- **Contract parity (exact), source of truth `packages/core/src/server/routes/memories.ts`** (`MAX_CONTENT = 500`):
  - **GET `/`** (`/api/memories`): `{"ok": true, "memories": [{"id", "content", "enabled": <bool>, "createdAt": <ms int>}]}`, ordered newest-first. `enabled` is the boolean form of the stored 0/1; `createdAt` is the stored `created_at` ms integer.
  - **POST `/`**: body `{content}`; `content = (body.content ?? "").trim()[:500]`; empty → `400 {"ok":false,"code":"VALIDATION","message":"content required"}`; else INSERT (new uuid4 id; `enabled`/`created_at`/`updated_at`/`tenant_id` use SQL defaults) → `201 {"ok": true, "id": <id>}`.
  - **PATCH `/:id`**: body `{content?, enabled?}`. Unknown id → `404 {"ok":false,"code":"NOT_FOUND"}` (checked FIRST, before field validation — TS order). Always bump `updated_at` to now-ms. If `content` key present: `trim()[:500]`, empty → `400 {"ok":false,"code":"VALIDATION","message":"content required"}`, else set it. If `enabled` key present: must be a JSON boolean, else → `400 {"ok":false,"code":"VALIDATION","message":"enabled 须为布尔"}` (verbatim CN), else set 1/0. Success → `200 {"ok": true}`.
  - **DELETE `/:id`**: unknown id → `404 {"ok":false,"code":"NOT_FOUND"}`; else `DELETE FROM memories WHERE id=?` → `200 {"ok": true}`.
- **Ordering: deterministic.** GET uses `ORDER BY created_at DESC, rowid DESC` (TS uses `desc(createdAt)`; the `rowid DESC` tiebreaker is the slice-3 determinism lesson, now that Python owns both the writes and the read — newest-inserted wins on equal timestamps).
- **`enabled` is a SQLite integer 0/1** (drizzle `mode:"boolean"`, `DEFAULT true`). Python writes `1`/`0` and converts to a Python `bool` in the GET response.
- **Missing-DB discipline (consistency with slices 2-3, not new behavior):** GET prechecks `os.path.exists(db_path)` and raises `FileNotFoundError` if absent (parity with the slice-2 projects GET → Starlette 500). POST/PATCH/DELETE precheck `os.path.exists` and return `404 NOT_FOUND` if absent (parity with the slice-3 write handlers) — BEFORE any `sqlite3.connect`, so no phantom DB file is ever created. In production the DB always exists (migrations run at boot); these are defensive guards.
- **No `BEGIN IMMEDIATE` here.** `memories` has no FK children and no cross-row guard (unlike slice-3's DELETE active-turn guard + cascade). Each write is a single statement that auto-commits under `db.connect`'s `isolation_level=None`. The PATCH/DELETE `SELECT`-then-write pair has only a benign race (a concurrently-deleted row makes the write a 0-row no-op returning `{ok:true}` — no data corruption), so a transaction is not warranted. (Stated so a reviewer doesn't flag the absence.)
- **Python writes ONLY `memories`**; never migrates; uses `db.connect`. **No SQL injection:** all values parameterized; the PATCH dynamic `SET` clause joins only fixed column-name fragments, never user input.
- **Auth parity unchanged.** `/api/memories/*` is already gated by `BearerAuthMiddleware` (slice 2). No auth changes.
- **Python env = conda env `arclight`** (Python 3.12); run via `conda run -n arclight`; no `uv`. No new deps (`sqlite3`/`uuid`/`time` are stdlib).
- **Commits exclude the unrelated dirty `bun.lock`** — always `git add <explicit paths>`, never `git add -A`.
- Run `bun run check` before any TS commit; run focused Python tests via `conda run -n arclight python -m pytest`.
- **Task-end gate (project CLAUDE.md):** after the final task, an independent `codex` review of the branch diff is mandatory; fix its Critical/Important findings before declaring done.

---

## Scope note (what this slice deliberately does NOT do)

- Does NOT migrate `/api/files` (`POST /:id/files`) — it writes NO DB table (it's a multipart upload to `<repo>/.arclight/uploads/` on disk) and reads the M3 `sessions` table to resolve the workspace path. Different concern (multipart + disk I/O + path sanitization); deferred to **slice 5** (separate plan).
- Does NOT migrate `/api/config`, grants, sessions/commands/snapshot, or POST `/api/projects` (M3).
- Does NOT add `BEGIN IMMEDIATE` transactions (not needed for this table — see Global Constraints).

---

## File Structure

**Created:**
- `packages/core-py/src/arclight_core/server/httputil.py` — shared `json_or_empty(request)` (moved from `projects.py`).
- `packages/core-py/src/arclight_core/server/memories.py` — `_read_memories` + GET/POST/PATCH/DELETE handler factories.
- `packages/core-py/tests/test_memories.py` — GET + POST contract.
- `packages/core-py/tests/test_memories_write.py` — PATCH + DELETE contract.
- `packages/proxy/src/__tests__/e2e-memories.test.ts` — cross-runtime CRUD e2e.

**Modified:**
- `packages/proxy/src/route-table.ts` — flip `"/api/memories"` → `"py"`.
- `packages/proxy/src/__tests__/route-table.test.ts` — memories-group routing case.
- `packages/core-py/src/arclight_core/server/projects.py` — import `json_or_empty` from `httputil` (remove the local `_json_or_empty`).
- `packages/core-py/src/arclight_core/server/app.py` — mount the four memories routes.

---

### Task 1: Flip the `/api/memories` proxy group to Python

**Files:**
- Modify: `packages/proxy/src/route-table.ts`
- Modify: `packages/proxy/src/__tests__/route-table.test.ts`

**Interfaces:**
- Consumes: existing `RouteTable`, `resolveUpstream`, `DEFAULT_TABLE`.
- Produces: `DEFAULT_TABLE["/api/memories"] === "py"` (plain `Upstream`, all methods).

- [ ] **Step 1: Add the failing routing test**

In `packages/proxy/src/__tests__/route-table.test.ts`, inside the existing `describe("DEFAULT_TABLE", ...)` block, replace the existing assertion line `expect(resolveUpstream("/api/sessions", DEFAULT_TABLE, "GET")).toBe("ts");` test body's surrounding test OR add a new test. Concretely, add this test inside that describe block:
```ts
  test("whole /api/memories group → py (all methods + subpaths)", () => {
    expect(resolveUpstream("/api/memories", DEFAULT_TABLE, "GET")).toBe("py");
    expect(resolveUpstream("/api/memories", DEFAULT_TABLE, "POST")).toBe("py");
    expect(resolveUpstream("/api/memories/m1", DEFAULT_TABLE, "PATCH")).toBe("py");
    expect(resolveUpstream("/api/memories/m1", DEFAULT_TABLE, "DELETE")).toBe("py");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/proxy && bun test src/__tests__/route-table.test.ts`
Expected: FAIL — `DEFAULT_TABLE["/api/memories"]` is still `"ts"`, so all four assertions return `"ts"`.

- [ ] **Step 3: Flip the group**

In `packages/proxy/src/route-table.ts`, change the `DEFAULT_TABLE` entry:
```ts
  "/api/memories": "ts",
```
to:
```ts
  "/api/memories": "py",
```
(One line. No other change — `memories` has no sibling path that stays on TS, so a plain entry is correct.)

- [ ] **Step 4: Run the route-table suite**

Run: `cd packages/proxy && bun test src/__tests__/route-table.test.ts`
Expected: PASS — the new memories-group test green; all prior cases unaffected.

- [ ] **Step 5: Run the full proxy suite**

Run: `cd packages/proxy && bun test`
Expected: PASS — route-table green; `proxy-forward`, `e2e-health`, `e2e-projects`, `e2e-projects-write` still pass (they pass explicit tables / are unaffected by the memories flip).

- [ ] **Step 6: Commit**

```bash
git add packages/proxy/src/route-table.ts packages/proxy/src/__tests__/route-table.test.ts
git commit -m "feat(proxy): flip /api/memories group → py (whole CRUD, single-writer table)"
```

---

### Task 2: Python `memories` GET + POST (+ shared `json_or_empty` extraction)

**Files:**
- Create: `packages/core-py/src/arclight_core/server/httputil.py`
- Modify: `packages/core-py/src/arclight_core/server/projects.py`
- Create: `packages/core-py/src/arclight_core/server/memories.py`
- Modify: `packages/core-py/src/arclight_core/server/app.py`
- Create: `packages/core-py/tests/test_memories.py`

**Interfaces:**
- Consumes: `Settings.db_path`, `db.connect`.
- Produces:
  - `arclight_core.server.httputil.json_or_empty(request) -> dict` — any parse failure or non-dict body → `{}` (parity with TS `c.req.json().catch(() => ({}))`).
  - `arclight_core.server.memories._read_memories(db_path) -> list[dict]` — `[{"id","content","enabled":bool,"createdAt":int}]`, `ORDER BY created_at DESC, rowid DESC`.
  - `arclight_core.server.memories.make_memories_get(settings)` / `make_memories_post(settings)` — async Starlette handlers.

- [ ] **Step 1: Write the failing GET+POST test**

`packages/core-py/tests/test_memories.py`:
```python
import sqlite3

from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings

# Real on-disk schema (subset) matching packages/core/src/db/migrations/0001_*.sql.
_SCHEMA = (
    "CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT DEFAULT 'local' NOT NULL, "
    "content TEXT NOT NULL, enabled integer DEFAULT true NOT NULL, "
    "created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, "
    "updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL)"
)


def _seed(tmp_path, rows=()):
    db = tmp_path / "arclight.sqlite"
    conn = sqlite3.connect(str(db))
    conn.execute(_SCHEMA)
    # rows: (id, content, enabled 0/1, created_at)
    for r in rows:
        conn.execute(
            "INSERT INTO memories (id, content, enabled, created_at) VALUES (?,?,?,?)", r
        )
    conn.commit()
    conn.close()
    return db


def _client(db, tmp_path):
    s = Settings(db_path=str(db), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    return TestClient(create_app(s))


def test_get_lists_newest_first_with_bool_enabled(tmp_path):
    db = _seed(tmp_path, rows=[("m1", "older", 1, 100), ("m2", "newer", 0, 200)])
    r = _client(db, tmp_path).get("/api/memories")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["memories"] == [
        {"id": "m2", "content": "newer", "enabled": False, "createdAt": 200},
        {"id": "m1", "content": "older", "enabled": True, "createdAt": 100},
    ]


def test_post_creates_and_returns_id(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).post("/api/memories", json={"content": "  remember this  "})
    assert r.status_code == 201
    new_id = r.json()["id"]
    assert r.json()["ok"] is True
    conn = sqlite3.connect(str(db))
    row = conn.execute("SELECT content, enabled FROM memories WHERE id=?", (new_id,)).fetchone()
    conn.close()
    assert row[0] == "remember this"  # trimmed
    assert row[1] == 1  # enabled defaults true


def test_post_truncates_to_500(tmp_path):
    db = _seed(tmp_path)
    new_id = _client(db, tmp_path).post("/api/memories", json={"content": "x" * 600}).json()["id"]
    conn = sqlite3.connect(str(db))
    content = conn.execute("SELECT content FROM memories WHERE id=?", (new_id,)).fetchone()[0]
    conn.close()
    assert len(content) == 500


def test_post_empty_content_is_400(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).post("/api/memories", json={"content": "   "})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "code": "VALIDATION", "message": "content required"}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_memories.py -v`
Expected: FAIL — `/api/memories` is not routed in the Python app (404); `memories` module / handlers don't exist.

- [ ] **Step 3: Extract `json_or_empty` into `httputil.py`**

Create `packages/core-py/src/arclight_core/server/httputil.py`:
```python
"""Small HTTP helpers shared across route modules."""
from starlette.requests import Request


async def json_or_empty(request: Request) -> dict:
    # Parity with TS `await c.req.json().catch(() => ({}))`: any parse failure → {}.
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}
```

Then in `packages/core-py/src/arclight_core/server/projects.py`: remove the local `_json_or_empty` function, add the import `from .httputil import json_or_empty`, and change the one call site in `make_projects_patch` from `body = await _json_or_empty(request)` to `body = await json_or_empty(request)`. (No other change to projects.py.)

- [ ] **Step 4: Implement `memories.py` GET + POST**

Create `packages/core-py/src/arclight_core/server/memories.py`:
```python
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
```

- [ ] **Step 5: Mount GET + POST in `app.py`**

In `packages/core-py/src/arclight_core/server/app.py`, inside `create_app`, import the memories factories and add the two routes. Add to the existing `from .projects import ...` area:
```python
    from .memories import make_memories_get, make_memories_post
```
and append to the `routes` list (after the projects routes):
```python
        Route("/api/memories", make_memories_get(settings), methods=["GET"]),
        Route("/api/memories", make_memories_post(settings), methods=["POST"]),
```

- [ ] **Step 6: Run the GET+POST test + ensure projects tests still pass (json_or_empty move)**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_memories.py tests/test_projects_write.py -v && conda run -n arclight ruff check .`
Expected: memories GET+POST tests pass (4); the projects PATCH tests still pass (the `json_or_empty` import move is behavior-preserving); ruff clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core-py/src/arclight_core/server/httputil.py packages/core-py/src/arclight_core/server/projects.py packages/core-py/src/arclight_core/server/memories.py packages/core-py/src/arclight_core/server/app.py packages/core-py/tests/test_memories.py
git commit -m "feat(core-py): GET+POST /api/memories (+ shared json_or_empty in httputil)"
```

---

### Task 3: Python `memories` PATCH `/:id` (partial update)

**Files:**
- Modify: `packages/core-py/src/arclight_core/server/memories.py` (add `make_memories_patch`)
- Modify: `packages/core-py/src/arclight_core/server/app.py` (mount PATCH)
- Create: `packages/core-py/tests/test_memories_write.py`

**Interfaces:**
- Produces: `arclight_core.server.memories.make_memories_patch(settings)` — async handler for `PATCH /api/memories/{memory_id}`; partial update of `content`/`enabled`, always bumps `updated_at`.

- [ ] **Step 1: Write the failing PATCH test**

`packages/core-py/tests/test_memories_write.py`:
```python
import sqlite3

from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings

_SCHEMA = (
    "CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT DEFAULT 'local' NOT NULL, "
    "content TEXT NOT NULL, enabled integer DEFAULT true NOT NULL, "
    "created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, "
    "updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL)"
)


def _seed(tmp_path):
    db = tmp_path / "arclight.sqlite"
    conn = sqlite3.connect(str(db))
    conn.execute(_SCHEMA)
    conn.execute(
        "INSERT INTO memories (id, content, enabled, created_at, updated_at) VALUES "
        "('m1','original',1,100,100)"
    )
    conn.commit()
    conn.close()
    return db


def _client(db, tmp_path):
    s = Settings(db_path=str(db), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    return TestClient(create_app(s))


def _row(db):
    conn = sqlite3.connect(str(db))
    row = conn.execute("SELECT content, enabled, updated_at FROM memories WHERE id='m1'").fetchone()
    conn.close()
    return row


def test_patch_content_only_bumps_updated_at(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"content": "  edited  "})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    content, enabled, updated_at = _row(db)
    assert content == "edited"  # trimmed
    assert enabled == 1  # untouched
    assert updated_at > 100  # bumped


def test_patch_enabled_only(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"enabled": False})
    assert r.status_code == 200
    content, enabled, _ = _row(db)
    assert content == "original"  # untouched
    assert enabled == 0


def test_patch_truncates_content_to_500(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"content": "y" * 600})
    assert r.status_code == 200
    assert len(_row(db)[0]) == 500


def test_patch_empty_content_is_400(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"content": "   "})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "code": "VALIDATION", "message": "content required"}


def test_patch_non_boolean_enabled_is_400(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/m1", json={"enabled": "yes"})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "code": "VALIDATION", "message": "enabled 须为布尔"}


def test_patch_unknown_id_is_404(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/memories/nope", json={"content": "x"})
    assert r.status_code == 404
    assert r.json() == {"ok": False, "code": "NOT_FOUND"}


def test_patch_missing_db_is_404(tmp_path):
    s = Settings(db_path=str(tmp_path / "absent.sqlite"), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    r = TestClient(create_app(s)).patch("/api/memories/m1", json={"content": "x"})
    assert r.status_code == 404
    assert not (tmp_path / "absent.sqlite").exists()  # no phantom file
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_memories_write.py -k patch -v`
Expected: FAIL — `PATCH /api/memories/m1` not routed (405/404); `make_memories_patch` undefined.

- [ ] **Step 3: Implement `make_memories_patch`**

Append to `packages/core-py/src/arclight_core/server/memories.py` (after `make_memories_post`):
```python
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
```

- [ ] **Step 4: Mount PATCH in `app.py`**

In `packages/core-py/src/arclight_core/server/app.py`, extend the memories import to include `make_memories_patch`:
```python
    from .memories import make_memories_get, make_memories_patch, make_memories_post
```
and append after the memories POST route:
```python
        Route("/api/memories/{memory_id}", make_memories_patch(settings), methods=["PATCH"]),
```

- [ ] **Step 5: Run the PATCH tests**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_memories_write.py -k patch -v`
Expected: PASS (7 — content-only, enabled-only, truncate, empty→400, non-bool→400, unknown→404, missing-db→404).

- [ ] **Step 6: Commit**

```bash
git add packages/core-py/src/arclight_core/server/memories.py packages/core-py/src/arclight_core/server/app.py packages/core-py/tests/test_memories_write.py
git commit -m "feat(core-py): PATCH /api/memories/:id (partial content/enabled + updated_at bump)"
```

---

### Task 4: Python `memories` DELETE `/:id`

**Files:**
- Modify: `packages/core-py/src/arclight_core/server/memories.py` (add `make_memories_delete`)
- Modify: `packages/core-py/src/arclight_core/server/app.py` (mount DELETE)
- Modify: `packages/core-py/tests/test_memories_write.py` (DELETE cases)

**Interfaces:**
- Produces: `arclight_core.server.memories.make_memories_delete(settings)` — async handler for `DELETE /api/memories/{memory_id}`.

- [ ] **Step 1: Write the failing DELETE tests**

Append to `packages/core-py/tests/test_memories_write.py`:
```python
def test_delete_removes_row(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).delete("/api/memories/m1")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT COUNT(*) FROM memories WHERE id='m1'").fetchone()[0] == 0
    conn.close()


def test_delete_unknown_id_is_404(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).delete("/api/memories/nope")
    assert r.status_code == 404
    assert r.json() == {"ok": False, "code": "NOT_FOUND"}


def test_delete_missing_db_is_404(tmp_path):
    s = Settings(db_path=str(tmp_path / "absent.sqlite"), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    r = TestClient(create_app(s)).delete("/api/memories/m1")
    assert r.status_code == 404
    assert not (tmp_path / "absent.sqlite").exists()  # no phantom file
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_memories_write.py -k delete -v`
Expected: FAIL — `DELETE /api/memories/m1` not routed; `make_memories_delete` undefined.

- [ ] **Step 3: Implement `make_memories_delete`**

Append to `packages/core-py/src/arclight_core/server/memories.py` (after `make_memories_patch`):
```python
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
```

- [ ] **Step 4: Mount DELETE in `app.py`**

In `packages/core-py/src/arclight_core/server/app.py`, extend the memories import to include `make_memories_delete`:
```python
    from .memories import (
        make_memories_delete,
        make_memories_get,
        make_memories_patch,
        make_memories_post,
    )
```
and append after the memories PATCH route:
```python
        Route("/api/memories/{memory_id}", make_memories_delete(settings), methods=["DELETE"]),
```

- [ ] **Step 5: Run the DELETE tests, then the full Python suite + ruff**

Run: `cd packages/core-py && conda run -n arclight python -m pytest -q && conda run -n arclight ruff check .`
Expected: all Python tests pass (health + auth + projects + projects_write + db + memories + memories_write + protocol/model); ruff `All checks passed!`.

- [ ] **Step 6: Commit**

```bash
git add packages/core-py/src/arclight_core/server/memories.py packages/core-py/src/arclight_core/server/app.py packages/core-py/tests/test_memories_write.py
git commit -m "feat(core-py): DELETE /api/memories/:id"
```

---

### Task 5: Cross-runtime e2e (full `/api/memories` CRUD via real Python)

**Files:**
- Create: `packages/proxy/src/__tests__/e2e-memories.test.ts`

**Interfaces:**
- Consumes: `makeProxy` + `resolveUpstream` (Task 1); the real Python app (Tasks 2-4); the `arclightEnvAvailable()` + `freePort()` + `waitForPython()` patterns from `e2e-projects-write.test.ts`.
- Produces: an automated proof that authed create→list→update→delete through the proxy is served by the real Python server over a seeded SQLite.

- [ ] **Step 1: Write the failing CRUD e2e**

`packages/proxy/src/__tests__/e2e-memories.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProxy } from "../server";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop();
  return p;
}

function arclightEnvAvailable(): boolean {
  try {
    const probe = Bun.spawnSync(
      ["conda", "run", "-n", "arclight", "python", "-c", "import arclight_core.server.app"],
      { cwd: repoRoot, env: { ...process.env, PYTHONPATH: `${repoRoot}packages/core-py/src` }, stdout: "ignore", stderr: "ignore" },
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}
const E2E_AVAILABLE = arclightEnvAvailable();
if (!E2E_AVAILABLE) console.warn("[e2e-memories] skipping: conda env 'arclight' or arclight_core not importable");

const PY_PORT = freePort();
const TOKEN = "test-token-mem";
let py: ReturnType<typeof Bun.spawn> | undefined;
let workdir: string;

async function waitForPython(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status === 200 || r.status === 401) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`python server did not become ready at ${url}`);
}

beforeAll(async () => {
  if (!E2E_AVAILABLE) return;
  workdir = mkdtempSync(join(tmpdir(), "arc-e2e-mem-"));
  const dbPath = join(workdir, "arclight.sqlite");
  const seed = Bun.spawnSync(
    ["conda", "run", "-n", "arclight", "python", "-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT DEFAULT 'local' NOT NULL, content TEXT NOT NULL, enabled integer DEFAULT true NOT NULL, created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL)")
c.commit(); c.close()`,
      dbPath],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (seed.exitCode !== 0) throw new Error(`seed failed: ${new TextDecoder().decode(seed.stderr)}`);

  py = Bun.spawn(
    ["conda", "run", "-n", "arclight", "python", "-m", "uvicorn",
      "arclight_core.server.app:app", "--port", String(PY_PORT), "--app-dir", "packages/core-py/src"],
    {
      cwd: repoRoot,
      env: { ...process.env, ARCLIGHT_DB_PATH: dbPath, ARCLIGHT_PROJECTS_ROOT: workdir, ARCLIGHT_TOKEN: TOKEN },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await waitForPython(`http://localhost:${PY_PORT}/health`);
});

afterAll(() => {
  if (!E2E_AVAILABLE) return;
  py?.kill();
  Bun.spawn(["pkill", "-f", `arclight_core.server.app:app --port ${PY_PORT}`]);
});

describe.skipIf(!E2E_AVAILABLE)("cross-runtime seam: /api/memories CRUD", () => {
  function proxy() {
    return makeProxy({
      table: { "/api/memories": "py" },
      tsUpstream: "http://localhost:1", // unused — every memories method routes to py
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
  }
  const auth = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  test("create → list → update → delete via real Python", async () => {
    // create
    const created = await proxy()(
      new Request("http://proxy/api/memories", { method: "POST", headers: auth, body: JSON.stringify({ content: "alpha" }) }),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    expect(id).toBeTruthy();

    // list
    const listed = await proxy()(new Request("http://proxy/api/memories", { headers: auth }));
    const memBody = (await listed.json()) as { memories: { id: string; content: string; enabled: boolean }[] };
    const found = memBody.memories.find((m) => m.id === id);
    expect(found).toEqual({ id, content: "alpha", enabled: true, createdAt: found!.createdAt } as never);

    // update (disable + edit)
    const patched = await proxy()(
      new Request(`http://proxy/api/memories/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ content: "beta", enabled: false }) }),
    );
    expect(patched.status).toBe(200);
    const after = (await (await proxy()(new Request("http://proxy/api/memories", { headers: auth }))).json()) as { memories: { id: string; content: string; enabled: boolean }[] };
    expect(after.memories.find((m) => m.id === id)).toMatchObject({ content: "beta", enabled: false });

    // delete
    const del = await proxy()(new Request(`http://proxy/api/memories/${id}`, { method: "DELETE", headers: auth }));
    expect(del.status).toBe(200);
    const final = (await (await proxy()(new Request("http://proxy/api/memories", { headers: auth }))).json()) as { memories: { id: string }[] };
    expect(final.memories.find((m) => m.id === id)).toBeUndefined();
  });

  test("missing token is rejected by Python auth (401)", async () => {
    const res = await proxy()(new Request("http://proxy/api/memories", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd /mnt/data/fsm/project/arclightagent/arclight && bun test packages/proxy/src/__tests__/e2e-memories.test.ts`
Expected: PASS (2 pass) where the env is present. To debug a boot/seed failure, run the seed + boot manually (as in the slice-3 e2e) and `curl -H "Authorization: Bearer t" -H 'content-type: application/json' -d '{"content":"x"}' localhost:<p>/api/memories`.

> Same cross-runtime-flakiness fallback as prior slices: if the spawn proves unreliable under contention, report DONE_WITH_CONCERNS and deliver the proof as `packages/proxy/scripts/smoke-memories.sh` with captured output. Repo-wide 60s hook timeouts already apply.

- [ ] **Step 3: Whole proxy suite + leak check**

Run: `cd packages/proxy && bun test`
Expected: PASS — route-table, proxy-forward, e2e-health, e2e-projects, e2e-projects-write, e2e-memories all green.
Then: `pgrep -f "arclight_core.server.app:app" || echo "no leak"` → `no leak`. (Do NOT run a bare `pkill -f "arclight_core.server.app"` from a shell whose command contains that string — self-match → exit 144.)

- [ ] **Step 4: Repo-wide check**

Run: `cd /mnt/data/fsm/project/arclightagent/arclight && bun run check`
Expected: `check:py` + `check:contract` + biome/types all green.

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/__tests__/e2e-memories.test.ts
git commit -m "test(proxy): e2e authed /api/memories CRUD via real Python"
```

---

### Task 6: Update the STATUS tracker

**Files:**
- Modify: `docs/superpowers/python-migration-STATUS.md`

- [ ] **Step 1: Mark slice 4 done + record slice 5 = files**

In `docs/superpowers/python-migration-STATUS.md`:
1. Roadmap table — **M1 slice 4** row: Scope → "Write-ownership transfer for `memories` (whole `/api/memories` CRUD → Python; single-writer table, plain route flip)"; Status → `✅ **done** (2026-06-18)`; Merge → the slice's final commit SHA; Plan → `[m1-slice4](plans/2026-06-18-python-core-migration-m1-slice4.md)`.
2. Add a new **M1 slice 5** row: Scope → "`/api/files` upload (`POST /:id/files`) → Python — multipart + disk write to `.arclight/uploads/` + filename sanitization; reads M3 `sessions` for the workspace path (read-only). Writes NO DB table."; Status `▶ **next**`; Merge `—`; Plan `(to write)`.
3. **Delivered so far** — add an **M1 slice 4** bullet (whole memories CRUD migrated; single-writer; `enabled` 0/1↔bool; partial PATCH with `updated_at` bump; deterministic `ORDER BY created_at DESC, rowid DESC`; shared `json_or_empty` extracted to `httputil`; cross-runtime CRUD e2e).
4. **Carry-forward** — no new hard prereqs from this slice; keep the ★ M3 SSE/ASGI-middleware prerequisite and the workspaces-two-INSERT-writers (M3) bullets unchanged.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/python-migration-STATUS.md
git commit -m "docs: M1 slice 4 done (memories CRUD → Python); slice 5 = files upload"
```

---

## Self-Review

**1. Spec coverage (this slice + carried decisions):**
- Whole `/api/memories` CRUD migrated, single-writer preserved → Tasks 1-4. ✓
- Plain route flip (no exact-match needed; nothing stays on TS) → Task 1. ✓
- GET contract (newest-first, `enabled` bool, `createdAt` ms) + deterministic order → Task 2 + order test. ✓
- POST (trim, 500-cap, empty→400, 201+id) → Task 2. ✓
- PATCH partial semantics (404-first, always bump `updated_at`, content-empty→400, enabled-non-bool→400 verbatim CN, 0/1 storage) → Task 3. ✓
- DELETE (404 / 200) → Task 4. ✓
- No phantom DB on every handler (precheck) → Tasks 2-4 missing-db tests. ✓
- DRY: `json_or_empty` shared, projects.py still green → Task 2 (extraction + projects regression run). ✓
- Cross-runtime e2e of the full lifecycle + 401 → Task 5. ✓
- STATUS/roadmap updated (slice 4 done, slice 5 = files) → Task 6. ✓
- Mandatory codex task-end review (project CLAUDE.md) → run after Task 6.

**2. Placeholder scan:** No TBD/handle-errors. All code blocks complete; the dynamic PATCH `SET` builds only fixed column fragments (no injection); the e2e `tsUpstream` is intentionally a dead address (`http://localhost:1`) because every memories method routes to py — documented inline.

**3. Type/contract consistency:** `Settings(db_path, projects_root, token, dev_no_auth)` unchanged. `json_or_empty(request)` signature identical in `httputil.py`, its `projects.py` import, and its `memories.py` use. `make_memories_get/post/patch/delete(settings)` signatures match between `memories.py` definitions and the `app.py` imports/mounts. Response shapes (`{ok:true}` / `{ok:true,id}` / `{ok:false,code:"VALIDATION",message:"content required"}` / `{...message:"enabled 须为布尔"}` / `{ok:false,code:"NOT_FOUND"}`) are byte-identical between `memories.ts`, the Python handlers, the pytest assertions, and the e2e. `_MAX_CONTENT = 500` matches TS `MAX_CONTENT`. Route `"/api/memories": "py"` (plain) is consistent across `route-table.ts`, its test, and the e2e table.

**Known residual risks (flagged):**
- (a) Non-string `content`/`enabled=null` edge: TS would `.trim()`/typecheck and may 500 on a non-string; Python coerces (`str(... or "")`) — Python is more lenient on unreachable client inputs (the web client always sends correct types). Same benign divergence noted in slice 3. 
- (b) PATCH/DELETE `SELECT`-then-write has a benign TOCTOU (no cascade, no guard) — a concurrently-deleted row makes the write a 0-row no-op returning `{ok:true}`; no `BEGIN IMMEDIATE` warranted (contrast slice-3 DELETE). Stated so review doesn't mis-flag the absence.
- (c) Task 5 is cross-runtime (Bun spawns uvicorn) with the documented smoke-script fallback and repo-wide 60s hook timeouts.
