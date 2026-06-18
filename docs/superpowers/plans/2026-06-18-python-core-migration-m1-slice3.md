# Python Core Migration — M1 Slice 3: Workspaces write-ownership transfer (PATCH + DELETE `/api/projects`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfer the genuinely-single-writer `workspaces` mutations — `PATCH /api/projects/:workspaceId` (rename) and `DELETE /api/projects/:workspaceId` (unregister + FK-cascade) — from the TS core to the Python core, introducing Python's first SQLite **write** layer (`PRAGMA foreign_keys = ON` so the cascade fires) and an exact-vs-subpath-aware proxy route table, while `POST /api/projects` (create) deliberately stays on TS.

**Architecture:** The proxy route table gains an **exact-match channel** (keys prefixed `=`) so `GET /api/projects` (exact → py, slice 2) and `POST /api/projects` (exact → ts, this slice) are routed independently of subpaths, while a prefix entry routes `PATCH`/`DELETE /api/projects/:id` → py and leaves `GET /api/projects/:id/sessions` (an M3 `sessions`-table read) on ts. The Python app gains a shared `db.connect()` helper (foreign_keys + busy_timeout, parity with `client.ts`) and two write handlers that mutate only the `workspaces` table; the DELETE re-implements the TS active-turn guard (a *read* of the M3 `sessions`/`turns` tables, which is permitted) and relies on SQLite `ON DELETE CASCADE` to purge child rows. A cross-runtime e2e drives PATCH/DELETE through the proxy against a real uvicorn over a seeded SQLite and asserts the `/sessions` GET subpath still lands on TS.

**Tech Stack:** Python 3.12 (conda env `arclight`), Starlette + uvicorn, stdlib `sqlite3` (now WRITE, foreign_keys ON) + `uuid`, pytest + httpx TestClient; TypeScript/Bun proxy.

## Global Constraints

- **web/cli unchanged; proxy transparent; proxy NOT in the production launch path.** No edits to `serve.ts`, dev scripts, or the web `baseUrl`. The seam is proven by the e2e, not by routing production traffic.
- **Strict one-writer-per-table preserved (the locked decision, this slice's chosen scope).** Migrate ONLY `PATCH` + `DELETE /api/projects` — the two `workspaces` mutations that *only* the projects route performs (verified: only `projects.ts` issues `UPDATE`/`DELETE workspaces`). `POST /api/projects` (create) **stays TS**, because `sessions.ts` `ensureWorkspace()` also `INSERT`s `workspaces` (M3 group) — migrating only one of two INSERT writers would create a cross-language writer on the table. POST + the sessions-route INSERT co-migrate in M3.
- **FK cascade MUST fire from Python.** Python's `sqlite3` defaults `foreign_keys = OFF`; the DELETE handler's connection MUST run `PRAGMA foreign_keys = ON` (parity with `client.ts`) or the cascade silently no-ops and orphans `sessions`/`turns` rows.
- **Python writes ONLY `workspaces`.** PATCH = `UPDATE workspaces SET name`; DELETE = `DELETE FROM workspaces` (engine cascades to `sessions`/`turns`). The active-turn guard only **reads** `sessions`/`turns` (reads of any table are allowed). Python never writes `sessions`/`turns` directly, never migrates, never creates schema (drizzle stays the migration authority).
- **No phantom DB file.** Both write handlers MUST precheck `os.path.exists(db_path)` and return `404 NOT_FOUND` when the DB is absent, before any `sqlite3.connect` (which would otherwise create an empty file — the slice-2 `deb0478` lesson, now for writes).
- **Auth parity unchanged.** `PATCH`/`DELETE /api/*` are already gated by `BearerAuthMiddleware` (slice 2): missing/wrong token → `401 {"ok":false,"code":"UNAUTHORIZED","message":"invalid token"}`; `ARCLIGHT_DEV_NO_AUTH=1` bypass. No auth changes here.
- **Contract parity (exact), source of truth `packages/core/src/server/routes/projects.ts`:**
  - `PATCH /:workspaceId` body `{name}`: `name = (body.name ?? "").trim().slice(0, 60)`; empty → `400 {"ok":false,"code":"VALIDATION","message":"name required"}`; unknown id → `404 {"ok":false,"code":"NOT_FOUND"}`; success → `200 {"ok":true}` and `UPDATE workspaces SET name=? WHERE id=?` (does NOT touch `updated_at` — parity with the drizzle `.set({ name })`).
  - `DELETE /:workspaceId`: unknown id → `404 {"ok":false,"code":"NOT_FOUND"}`; any session of the workspace has a turn in `('queued','running','awaiting_approval')` → `409 {"ok":false,"code":"TURN_ACTIVE","message":"项目内有会话正在运行，先停止再删除"}`; else `DELETE FROM workspaces WHERE id=?` (cascade) → `200 {"ok":true}`. Disk files are never touched.
- **Deterministic ordering (carry-forward from slice 2).** Now that `workspaces` writes move, give the `GET /api/projects` read a deterministic `ORDER BY rowid` (it previously relied on implicit rowid order). `rowid` = insertion order, byte-identical to the prior implicit behavior.
- **Python env = conda env `arclight`** (Python 3.12); run via `conda run -n arclight`; **no `uv`**. No new deps (`sqlite3`/`uuid` are stdlib).
- **Commits exclude the unrelated dirty `bun.lock`** — always `git add <explicit paths>`, never `git add -A`.
- Run `bun run check` before any TS commit; run focused Python tests via `conda run -n arclight python -m pytest`.

---

## Scope note (what this slice deliberately does NOT do)

- Does NOT migrate `POST /api/projects` (create) — stays TS, co-migrates with `sessions.ts` `ensureWorkspace()` in M3 (the second `workspaces` INSERT writer).
- Does NOT migrate `GET /api/projects/:workspaceId/sessions` — it reads the M3 `sessions` table; stays TS (and this slice fixes the latent slice-2 routing bug that sent it to py).
- Does NOT migrate `/api/files` or `/api/memories` writes — deferred to **slice 4** (separate plan).
- Does NOT migrate `/api/config`, grants, or any loop-core group (M3).
- Does NOT port `resolveProjectPath` (the create-path security fence) — only POST needs it, and POST stays TS.

---

## File Structure

**Created:**
- `packages/core-py/src/arclight_core/server/db.py` — shared `connect(db_path)` (foreign_keys ON + busy_timeout + Row factory); the single place that opens the DB.
- `packages/core-py/tests/test_db.py` — `connect()` enforces FK cascade + no-phantom contract.
- `packages/core-py/tests/test_projects_write.py` — PATCH + DELETE handler contract (incl. cascade + active-turn guard).
- `packages/proxy/src/__tests__/e2e-projects-write.test.ts` — cross-runtime e2e for authed PATCH/DELETE via real Python.

**Modified:**
- `packages/proxy/src/route-table.ts` — exact-match channel (`=`-prefixed keys); `=/api/projects` exact (GET→py, default ts) + `/api/projects` prefix (PATCH/DELETE→py, default ts).
- `packages/proxy/src/__tests__/route-table.test.ts` — exact-vs-subpath cases.
- `packages/core-py/src/arclight_core/server/projects.py` — use `db.connect()`; add `ORDER BY rowid`; add `make_projects_patch` + `make_projects_delete`.
- `packages/core-py/src/arclight_core/server/app.py` — mount `Route("/api/projects/{workspace_id}", …, methods=["PATCH"])` and `…methods=["DELETE"]`.
- `packages/core-py/tests/test_projects.py` — add a 2-row deterministic-order assertion.

---

### Task 1: Exact-match-aware proxy route table

**Files:**
- Modify: `packages/proxy/src/route-table.ts`
- Modify: `packages/proxy/src/__tests__/route-table.test.ts`

**Interfaces:**
- Consumes: existing `Upstream`, `Method`, `MethodUpstream`, `RouteTable` types and `isMethodUpstream` from slice 2.
- Produces:
  - `RouteTable` keys MAY be prefixed with `=` to mean **exact-path match** (the `=` is stripped; the remainder must equal the request path exactly). Exact entries win over every prefix entry. Non-`=` keys remain longest-prefix as before.
  - `resolveUpstream(path, table, method?)` unchanged signature; exact lookup runs first.
  - `DEFAULT_TABLE` gains `"=/api/projects": { GET: "py", default: "ts" }` (exact) and changes `"/api/projects"` to `{ PATCH: "py", DELETE: "py", default: "ts" }` (prefix/subpaths).

- [ ] **Step 1: Update the route-table test for exact-vs-subpath routing**

Replace `packages/proxy/src/__tests__/route-table.test.ts` with:
```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE, type RouteTable, resolveUpstream } from "../route-table";

describe("resolveUpstream — plain + prefix entries", () => {
  const table: RouteTable = { "/health": "py", "/api/sessions": "ts" };
  test("exact + subpath match", () => {
    expect(resolveUpstream("/health", table, "GET")).toBe("py");
    expect(resolveUpstream("/api/sessions/abc/events", table, "GET")).toBe("ts");
  });
  test("unknown path defaults to ts", () => {
    expect(resolveUpstream("/api/unknown", table, "GET")).toBe("ts");
  });
  test("sibling does not false-match", () => {
    expect(resolveUpstream("/healthcheck", { "/health": "py" }, "GET")).toBe("ts");
  });
  test("plain entry ignores method", () => {
    expect(resolveUpstream("/health", { "/health": "py" }, "POST")).toBe("py");
  });
});

describe("resolveUpstream — exact-match channel", () => {
  const table: RouteTable = {
    "=/api/projects": { GET: "py", default: "ts" },
    "/api/projects": { PATCH: "py", DELETE: "py", default: "ts" },
  };
  test("exact path uses the = entry (wins over the prefix entry)", () => {
    expect(resolveUpstream("/api/projects", table, "GET")).toBe("py");
    expect(resolveUpstream("/api/projects", table, "POST")).toBe("ts");
  });
  test("subpaths use the prefix entry, NOT the exact entry", () => {
    expect(resolveUpstream("/api/projects/ws1", table, "PATCH")).toBe("py");
    expect(resolveUpstream("/api/projects/ws1", table, "DELETE")).toBe("py");
    // the M3 sessions read must stay ts (regression: slice 2 sent this to py)
    expect(resolveUpstream("/api/projects/ws1/sessions", table, "GET")).toBe("ts");
    // a subpath POST/unknown method falls to the prefix default
    expect(resolveUpstream("/api/projects/ws1", table, "POST")).toBe("ts");
  });
});

describe("DEFAULT_TABLE", () => {
  test("GET /api/projects → py (slice 2 preserved); POST → ts (stays TS this slice)", () => {
    expect(resolveUpstream("/api/projects", DEFAULT_TABLE, "GET")).toBe("py");
    expect(resolveUpstream("/api/projects", DEFAULT_TABLE, "POST")).toBe("ts");
  });
  test("PATCH/DELETE /api/projects/:id → py; GET :id/sessions → ts", () => {
    expect(resolveUpstream("/api/projects/ws1", DEFAULT_TABLE, "PATCH")).toBe("py");
    expect(resolveUpstream("/api/projects/ws1", DEFAULT_TABLE, "DELETE")).toBe("py");
    expect(resolveUpstream("/api/projects/ws1/sessions", DEFAULT_TABLE, "GET")).toBe("ts");
  });
  test("health → py; other /api/* → ts", () => {
    expect(resolveUpstream("/health", DEFAULT_TABLE, "GET")).toBe("py");
    expect(resolveUpstream("/api/sessions", DEFAULT_TABLE, "GET")).toBe("ts");
    expect(resolveUpstream("/api/config", DEFAULT_TABLE, "GET")).toBe("ts");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/proxy && bun test src/__tests__/route-table.test.ts`
Expected: FAIL — `DEFAULT_TABLE` has no `=/api/projects` key, `/api/projects` still routes `GET`→py / `POST`→ts via the old method-map, and `resolveUpstream` has no exact channel so `=`-keys are treated as prefixes that never match.

- [ ] **Step 3: Add the exact-match channel + update DEFAULT_TABLE**

Replace the contents of `packages/proxy/src/route-table.ts` with:
```ts
// Route-group → upstream. Values are either a plain Upstream (all methods) or a
// per-method map with a required `default`. A key prefixed with "=" is an
// EXACT-path match (the "=" is stripped; the remainder must equal the request
// path exactly) and wins over every prefix entry — this lets an exact path and
// its subpaths route differently (e.g. GET /api/projects → py, but
// GET /api/projects/:id/sessions → ts). Non-"=" keys are longest-prefix.
// Flipping a group/method/exact-path is a one-line edit here.
export type Upstream = "ts" | "py";
export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type MethodUpstream = Partial<Record<Method, Upstream>> & { default: Upstream };
export type RouteTable = Record<string, Upstream | MethodUpstream>;

export const DEFAULT_TABLE: RouteTable = {
  "/health": "py",
  // Exact path: GET → py (slice 2). POST (create) stays TS this slice — it
  // co-migrates with sessions.ts ensureWorkspace() in M3 (second INSERT writer).
  "=/api/projects": { GET: "py", default: "ts" },
  // Subpaths: PATCH/DELETE /:id → py (slice 3). GET /:id/sessions reads the M3
  // sessions table → stays ts (also fixes the latent slice-2 mis-route).
  "/api/projects": { PATCH: "py", DELETE: "py", default: "ts" },
  "/api/config": "ts",
  "/api/files": "ts",
  "/api/grants": "ts",
  "/api/commands": "ts",
  "/api/sessions": "ts",
  "/api/memories": "ts",
};

function isMethodUpstream(v: Upstream | MethodUpstream): v is MethodUpstream {
  return typeof v === "object" && v !== null && "default" in v;
}

function pick(v: Upstream | MethodUpstream, method: string): Upstream {
  if (isMethodUpstream(v)) return v[method as Method] ?? v.default;
  return v;
}

export function resolveUpstream(path: string, table: RouteTable, method = "GET"): Upstream {
  // Exact-match entries (keyed "=<path>") win over prefix entries.
  const exact = table[`=${path}`];
  if (exact !== undefined) return pick(exact, method);
  // Longest-prefix among the non-exact keys.
  let best = "";
  for (const key of Object.keys(table)) {
    if (key.startsWith("=")) continue;
    if (path === key || path.startsWith(`${key}/`)) {
      if (key.length > best.length) best = key;
    }
  }
  if (!best) return "ts";
  return pick(table[best], method);
}
```

- [ ] **Step 4: Run the route-table suite**

Run: `cd packages/proxy && bun test src/__tests__/route-table.test.ts`
Expected: PASS — exact channel, subpath routing, and DEFAULT_TABLE cases all green.

- [ ] **Step 5: Run the full proxy suite (no regressions)**

Run: `cd packages/proxy && bun test`
Expected: PASS — `proxy-forward`, `e2e-health`, and slice-2 `e2e-projects` still green (the slice-2 e2e passes an explicit `{ "/api/projects": { GET: "py", default: "ts" } }` table, which still resolves `GET`→py via the prefix path since it has no `=` key; unaffected by the new channel).

- [ ] **Step 6: Commit**

```bash
git add packages/proxy/src/route-table.ts packages/proxy/src/__tests__/route-table.test.ts
git commit -m "feat(proxy): exact-match route channel; PATCH/DELETE /api/projects/:id → py, GET :id/sessions stays ts"
```

---

### Task 2: Python shared DB connection helper + deterministic read order

**Files:**
- Create: `packages/core-py/src/arclight_core/server/db.py`
- Create: `packages/core-py/tests/test_db.py`
- Modify: `packages/core-py/src/arclight_core/server/projects.py` (read path uses `connect()` + `ORDER BY rowid`)
- Modify: `packages/core-py/tests/test_projects.py` (2-row order assertion)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `arclight_core.server.db.connect(db_path: str) -> sqlite3.Connection` — opens with `timeout=5.0`, sets `row_factory = sqlite3.Row`, runs `PRAGMA foreign_keys = ON` and `PRAGMA busy_timeout = 5000`. Per-connection only; never sets `journal_mode` (the TS migration owns that) and never creates schema.
  - `projects._read_workspaces` now selects `... ORDER BY rowid` and opens via `connect()`.

- [ ] **Step 1: Write the failing db test**

`packages/core-py/tests/test_db.py`:
```python
import sqlite3

import pytest

from arclight_core.server.db import connect


def _make_schema(conn):
    conn.execute(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL "
        "REFERENCES workspaces(id) ON DELETE CASCADE)"
    )


def test_connect_enables_foreign_keys_cascade(tmp_path):
    db = str(tmp_path / "arclight.sqlite")
    c = connect(db)
    _make_schema(c)
    c.execute("INSERT INTO workspaces (id, name, repo_path) VALUES ('w1','a','/p/a')")
    c.execute("INSERT INTO sessions (id, workspace_id) VALUES ('s1','w1')")
    c.commit()
    # FK cascade must be ON: deleting the workspace removes the child session.
    c.execute("DELETE FROM workspaces WHERE id='w1'")
    c.commit()
    assert c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    c.close()


def test_connect_returns_row_factory(tmp_path):
    db = str(tmp_path / "arclight.sqlite")
    c = connect(db)
    c.execute("CREATE TABLE t (k TEXT)")
    c.execute("INSERT INTO t (k) VALUES ('v')")
    row = c.execute("SELECT k FROM t").fetchone()
    assert row["k"] == "v"  # sqlite3.Row keyed access
    c.close()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_db.py -v`
Expected: FAIL — `arclight_core.server.db` does not exist (ImportError).

- [ ] **Step 3: Implement `db.connect`**

`packages/core-py/src/arclight_core/server/db.py`:
```python
"""Shared SQLite connection helper for the Python core.

Parity with packages/core/src/db/client.ts PRAGMAs: foreign_keys ON (so
ON DELETE CASCADE fires — Python's sqlite3 defaults it OFF) and busy_timeout for
WAL contention. Per-connection settings only: never sets journal_mode (the TS
drizzle migration owns the persistent WAL mode) and never creates/migrates
schema. Python writes ONLY the tables it owns (one-writer-per-table).
"""
import sqlite3


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn
```

- [ ] **Step 4: Run the db test to verify it passes**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_db.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Point the read path at `connect()` + add `ORDER BY rowid`**

In `packages/core-py/src/arclight_core/server/projects.py`, replace the import line and the `_read_workspaces` body. Change the top imports from:
```python
import os
import sqlite3

from starlette.requests import Request
from starlette.responses import JSONResponse

from .settings import Settings
```
to:
```python
import os

from starlette.requests import Request
from starlette.responses import JSONResponse

from .db import connect
from .settings import Settings
```
Then replace the `_read_workspaces` function with:
```python
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
```
(The `row_factory` is now set inside `connect()`, so the local `conn.row_factory = sqlite3.Row` line is removed.)

- [ ] **Step 6: Add a 2-row deterministic-order assertion**

Append to `packages/core-py/tests/test_projects.py`:
```python
def test_projects_order_is_insertion_order(tmp_path):
    db = tmp_path / "arclight.sqlite"
    root = tmp_path / "projects"
    root.mkdir()
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL)"
    )
    # Insert zeta before alpha; rowid order must preserve insertion, not name sort.
    conn.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('w2','zeta','/p/zeta')")
    conn.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('w1','alpha','/p/alpha')")
    conn.commit()
    conn.close()
    s = Settings(db_path=str(db), projects_root=str(root), token="t", dev_no_auth=True)
    body = TestClient(create_app(s)).get("/api/projects").json()
    assert [p["name"] for p in body["projects"]] == ["zeta", "alpha"]
```

- [ ] **Step 7: Run the projects + full Python suite + ruff**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_projects.py tests/test_db.py -q && conda run -n arclight ruff check .`
Expected: all pass (the new order test + existing contract tests); ruff `All checks passed!`.

- [ ] **Step 8: Commit**

```bash
git add packages/core-py/src/arclight_core/server/db.py packages/core-py/tests/test_db.py packages/core-py/src/arclight_core/server/projects.py packages/core-py/tests/test_projects.py
git commit -m "feat(core-py): shared db.connect (foreign_keys ON) + deterministic ORDER BY rowid"
```

---

### Task 3: Python `PATCH /api/projects/:workspaceId` (rename)

**Files:**
- Modify: `packages/core-py/src/arclight_core/server/projects.py` (add `make_projects_patch`)
- Modify: `packages/core-py/src/arclight_core/server/app.py` (mount the PATCH route)
- Create: `packages/core-py/tests/test_projects_write.py`

**Interfaces:**
- Consumes: `Settings.db_path`, `db.connect`.
- Produces: `arclight_core.server.projects.make_projects_patch(settings: Settings)` — async Starlette handler for `PATCH /api/projects/{workspace_id}`; reads `request.path_params["workspace_id"]`; returns the exact contract responses.

- [ ] **Step 1: Write the failing PATCH test**

`packages/core-py/tests/test_projects_write.py`:
```python
import sqlite3

from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings

# Real on-disk schema (subset) matching packages/core/src/db/migrations/0000_*.sql,
# with the FK cascade clauses the DELETE handler relies on.
_SCHEMA = [
    "CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT DEFAULT 'local' NOT NULL, "
    "name TEXT NOT NULL, repo_path TEXT NOT NULL, arclight_dir TEXT, "
    "created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, "
    "updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL)",
    "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, "
    "FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE)",
    "CREATE TABLE turns (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, "
    "FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE)",
]


def _seed(tmp_path, *, sessions=(), turns=()):
    db = tmp_path / "arclight.sqlite"
    conn = sqlite3.connect(str(db))
    for stmt in _SCHEMA:
        conn.execute(stmt)
    conn.execute(
        "INSERT INTO workspaces (id, name, repo_path, arclight_dir) VALUES ('w1','alpha','/p/alpha','/p/alpha/.arclight')"
    )
    for sid, wsid in sessions:
        conn.execute("INSERT INTO sessions (id, workspace_id) VALUES (?,?)", (sid, wsid))
    for tid, sid, status in turns:
        conn.execute("INSERT INTO turns (id, session_id, status) VALUES (?,?,?)", (tid, sid, status))
    conn.commit()
    conn.close()
    return db


def _client(db, tmp_path):
    s = Settings(db_path=str(db), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    return TestClient(create_app(s))


def test_patch_renames(tmp_path):
    db = _seed(tmp_path)
    c = _client(db, tmp_path)
    r = c.patch("/api/projects/w1", json={"name": "  beta  "})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT name FROM workspaces WHERE id='w1'").fetchone()[0] == "beta"  # trimmed
    conn.close()


def test_patch_truncates_to_60_chars(tmp_path):
    db = _seed(tmp_path)
    c = _client(db, tmp_path)
    long = "x" * 100
    c.patch("/api/projects/w1", json={"name": long})
    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT name FROM workspaces WHERE id='w1'").fetchone()[0] == "x" * 60
    conn.close()


def test_patch_empty_name_is_400(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/projects/w1", json={"name": "   "})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "code": "VALIDATION", "message": "name required"}


def test_patch_unknown_id_is_404(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).patch("/api/projects/nope", json={"name": "beta"})
    assert r.status_code == 404
    assert r.json() == {"ok": False, "code": "NOT_FOUND"}


def test_patch_missing_db_is_404(tmp_path):
    s = Settings(db_path=str(tmp_path / "absent.sqlite"), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    r = TestClient(create_app(s)).patch("/api/projects/w1", json={"name": "beta"})
    assert r.status_code == 404
    assert not (tmp_path / "absent.sqlite").exists()  # no phantom file created
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_projects_write.py -v`
Expected: FAIL — `PATCH /api/projects/w1` is not routed (Starlette 405/404), `make_projects_patch` undefined.

- [ ] **Step 3: Implement `make_projects_patch`**

Append to `packages/core-py/src/arclight_core/server/projects.py` (after `make_projects_get`):
```python
def make_projects_patch(settings: Settings):
    # Rename a workspace (display name only; repo_path/disk untouched). Parity with
    # projects.ts PATCH /:workspaceId. Writes ONLY workspaces.name.
    async def _handler(request: Request) -> JSONResponse:
        ws_id = request.path_params["workspace_id"]
        body = await request.json() if await _has_body(request) else {}
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
```
And add the small body-parse helper near the top of the file (after the imports), used so a missing/empty JSON body degrades to `{}` exactly like the TS `c.req.json().catch(() => ({}))`:
```python
async def _has_body(request: Request) -> bool:
    # Mirror TS `c.req.json().catch(() => ({}))`: tolerate empty/invalid bodies.
    try:
        body = await request.body()
        return len(body) > 0
    except Exception:
        return False
```
> Note: `_has_body` reads and caches the body; `request.json()` re-parses the cached bytes, so the double read is safe under Starlette. If the cached body is not valid JSON, `request.json()` raises — acceptable parity is achieved more simply by wrapping the parse; replace the two lines `body = await request.json() if await _has_body(request) else {}` reasoning with the robust version in Step 3b.

- [ ] **Step 3b: Make the body parse fully tolerant (match `.catch(() => ({}))`)**

Replace the `_has_body` helper and its call with a single tolerant parser. In `projects.py`, delete the `_has_body` function and change the handler's body line from:
```python
        body = await request.json() if await _has_body(request) else {}
```
to:
```python
        body = await _json_or_empty(request)
```
and add this helper after the imports:
```python
async def _json_or_empty(request: Request) -> dict:
    # Parity with TS `await c.req.json().catch(() => ({}))`: any parse failure → {}.
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}
```

- [ ] **Step 4: Mount the PATCH route**

In `packages/core-py/src/arclight_core/server/app.py`, update the `create_app` import + routes. Change:
```python
    from .projects import make_projects_get

    routes = [
        Route("/health", _health, methods=["GET"]),
        Route("/api/projects", make_projects_get(settings), methods=["GET"]),
    ]
```
to:
```python
    from .projects import make_projects_get, make_projects_patch

    routes = [
        Route("/health", _health, methods=["GET"]),
        Route("/api/projects", make_projects_get(settings), methods=["GET"]),
        Route("/api/projects/{workspace_id}", make_projects_patch(settings), methods=["PATCH"]),
    ]
```

- [ ] **Step 5: Run the PATCH tests to verify they pass**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_projects_write.py -v`
Expected: PASS (5 passed — rename, truncate, empty→400, unknown→404, missing-db→404).

- [ ] **Step 6: Commit**

```bash
git add packages/core-py/src/arclight_core/server/projects.py packages/core-py/src/arclight_core/server/app.py packages/core-py/tests/test_projects_write.py
git commit -m "feat(core-py): PATCH /api/projects/:id rename (workspaces.name write)"
```

---

### Task 4: Python `DELETE /api/projects/:workspaceId` (unregister + cascade + active-turn guard)

**Files:**
- Modify: `packages/core-py/src/arclight_core/server/projects.py` (add `make_projects_delete`)
- Modify: `packages/core-py/src/arclight_core/server/app.py` (mount the DELETE route)
- Modify: `packages/core-py/tests/test_projects_write.py` (DELETE cases)

**Interfaces:**
- Consumes: `Settings.db_path`, `db.connect` (foreign_keys ON ⇒ cascade).
- Produces: `arclight_core.server.projects.make_projects_delete(settings: Settings)` — async handler for `DELETE /api/projects/{workspace_id}`.

- [ ] **Step 1: Write the failing DELETE tests**

Append to `packages/core-py/tests/test_projects_write.py`:
```python
def test_delete_removes_workspace_and_cascades(tmp_path):
    # workspace w1 with a session + a completed turn → delete succeeds and cascades.
    db = _seed(tmp_path, sessions=[("s1", "w1")], turns=[("t1", "s1", "completed")])
    r = _client(db, tmp_path).delete("/api/projects/w1")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0  # cascaded
    assert conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 0     # cascaded (via sessions)
    conn.close()


def test_delete_unknown_id_is_404(tmp_path):
    db = _seed(tmp_path)
    r = _client(db, tmp_path).delete("/api/projects/nope")
    assert r.status_code == 404
    assert r.json() == {"ok": False, "code": "NOT_FOUND"}


def test_delete_blocked_by_active_turn_is_409(tmp_path):
    db = _seed(tmp_path, sessions=[("s1", "w1")], turns=[("t1", "s1", "running")])
    r = _client(db, tmp_path).delete("/api/projects/w1")
    assert r.status_code == 409
    body = r.json()
    assert body["ok"] is False
    assert body["code"] == "TURN_ACTIVE"
    # workspace must NOT be deleted (fail-closed)
    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT COUNT(*) FROM workspaces WHERE id='w1'").fetchone()[0] == 1
    conn.close()


def test_delete_allows_awaiting_approval_blocks(tmp_path):
    db = _seed(tmp_path, sessions=[("s1", "w1")], turns=[("t1", "s1", "awaiting_approval")])
    assert _client(db, tmp_path).delete("/api/projects/w1").status_code == 409


def test_delete_ignores_terminal_turns(tmp_path):
    # failed/interrupted/completed are NOT active → delete proceeds.
    db = _seed(tmp_path, sessions=[("s1", "w1")], turns=[("t1", "s1", "failed")])
    assert _client(db, tmp_path).delete("/api/projects/w1").status_code == 200


def test_delete_missing_db_is_404(tmp_path):
    s = Settings(db_path=str(tmp_path / "absent.sqlite"), projects_root=str(tmp_path), token="t", dev_no_auth=True)
    r = TestClient(create_app(s)).delete("/api/projects/w1")
    assert r.status_code == 404
    assert not (tmp_path / "absent.sqlite").exists()  # no phantom file
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_projects_write.py -k delete -v`
Expected: FAIL — `DELETE /api/projects/w1` not routed; `make_projects_delete` undefined.

- [ ] **Step 3: Implement `make_projects_delete`**

Append to `packages/core-py/src/arclight_core/server/projects.py` (after `make_projects_patch`):
```python
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
            row = conn.execute("SELECT id FROM workspaces WHERE id = ?", (ws_id,)).fetchone()
            if row is None:
                return JSONResponse({"ok": False, "code": "NOT_FOUND"}, status_code=404)
            placeholders = ",".join("?" for _ in _ACTIVE_TURN_STATUSES)
            active = conn.execute(
                "SELECT turns.id FROM turns "
                "JOIN sessions ON turns.session_id = sessions.id "
                f"WHERE sessions.workspace_id = ? AND turns.status IN ({placeholders}) LIMIT 1",
                (ws_id, *_ACTIVE_TURN_STATUSES),
            ).fetchone()
            if active is not None:
                return JSONResponse(
                    {"ok": False, "code": "TURN_ACTIVE", "message": "项目内有会话正在运行，先停止再删除"},
                    status_code=409,
                )
            conn.execute("DELETE FROM workspaces WHERE id = ?", (ws_id,))
            conn.commit()
        finally:
            conn.close()
        return JSONResponse({"ok": True})

    return _handler
```

- [ ] **Step 4: Mount the DELETE route**

In `packages/core-py/src/arclight_core/server/app.py`, update the import and append the route. Change:
```python
    from .projects import make_projects_get, make_projects_patch

    routes = [
        Route("/health", _health, methods=["GET"]),
        Route("/api/projects", make_projects_get(settings), methods=["GET"]),
        Route("/api/projects/{workspace_id}", make_projects_patch(settings), methods=["PATCH"]),
    ]
```
to:
```python
    from .projects import make_projects_delete, make_projects_get, make_projects_patch

    routes = [
        Route("/health", _health, methods=["GET"]),
        Route("/api/projects", make_projects_get(settings), methods=["GET"]),
        Route("/api/projects/{workspace_id}", make_projects_patch(settings), methods=["PATCH"]),
        Route("/api/projects/{workspace_id}", make_projects_delete(settings), methods=["DELETE"]),
    ]
```
> Two `Route`s share the path with disjoint methods: Starlette matches the path then the method (a method-mismatched route yields a partial match; the method-matched route yields the full match and wins). PATCH and DELETE each resolve to their own handler.

- [ ] **Step 5: Run the DELETE tests, then the full write suite**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_projects_write.py -v`
Expected: PASS (all PATCH + DELETE cases — cascade, 404, 409 active, awaiting_approval blocks, terminal proceeds, missing-db→404).

- [ ] **Step 6: Full Python suite + ruff green**

Run: `cd packages/core-py && conda run -n arclight python -m pytest -q && conda run -n arclight ruff check .`
Expected: all Python tests pass (health + auth + projects + projects_write + db + protocol/model); ruff `All checks passed!`.

- [ ] **Step 7: Commit**

```bash
git add packages/core-py/src/arclight_core/server/projects.py packages/core-py/src/arclight_core/server/app.py packages/core-py/tests/test_projects_write.py
git commit -m "feat(core-py): DELETE /api/projects/:id unregister + FK cascade + active-turn guard"
```

---

### Task 5: Cross-runtime e2e (authed PATCH/DELETE via real Python; `/sessions` stays TS)

**Files:**
- Create: `packages/proxy/src/__tests__/e2e-projects-write.test.ts`

**Interfaces:**
- Consumes: `makeProxy` + exact-match `resolveUpstream` (Task 1); the real Python app with PATCH/DELETE (Tasks 3-4); the `arclightEnvAvailable()` + `freePort()` + `waitForPython()` patterns from `e2e-projects.test.ts`.
- Produces: an automated proof that authed `PATCH`/`DELETE /api/projects/:id` through the proxy are served by the real Python server mutating a seeded SQLite, while `GET /api/projects/:id/sessions` still routes to TS.

- [ ] **Step 1: Write the failing write-path e2e**

`packages/proxy/src/__tests__/e2e-projects-write.test.ts`:
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
if (!E2E_AVAILABLE) console.warn("[e2e-projects-write] skipping: conda env 'arclight' or arclight_core not importable");

const PY_PORT = freePort();
const TOKEN = "test-token-456";
let py: ReturnType<typeof Bun.spawn> | undefined;
let tsUpstream: ReturnType<typeof Bun.serve> | undefined;
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
  workdir = mkdtempSync(join(tmpdir(), "arc-e2e-projw-"));
  const dbPath = join(workdir, "arclight.sqlite");
  // Seed: workspace w1 (+ a completed-turn session so DELETE cascade has something to clear).
  const seed = Bun.spawnSync(
    ["conda", "run", "-n", "arclight", "python", "-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, repo_path TEXT NOT NULL)")
c.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE)")
c.execute("CREATE TABLE turns (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE)")
c.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('w1','alpha','/p/alpha')")
c.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('w2','gamma','/p/gamma')")
c.execute("INSERT INTO sessions (id,workspace_id) VALUES ('s1','w1')")
c.execute("INSERT INTO turns (id,session_id,status) VALUES ('t1','s1','completed')")
c.commit(); c.close()`,
      dbPath],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (seed.exitCode !== 0) throw new Error(`seed failed: ${seed.stderr}`);

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

  // TS upstream stub: stands in for the not-migrated GET /:id/sessions (M3) and POST create.
  tsUpstream = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (req.method === "GET" && u.pathname.endsWith("/sessions")) {
        return Response.json({ via: "ts-sessions" });
      }
      if (req.method === "POST" && u.pathname === "/api/projects") {
        return Response.json({ via: "ts-create" });
      }
      return new Response("nope", { status: 404 });
    },
  });
});

afterAll(() => {
  if (!E2E_AVAILABLE) return;
  py?.kill();
  Bun.spawn(["pkill", "-f", `arclight_core.server.app:app --port ${PY_PORT}`]);
  tsUpstream?.stop(true);
});

describe.skipIf(!E2E_AVAILABLE)("cross-runtime seam: workspaces writes", () => {
  function proxy() {
    return makeProxy({
      table: {
        "=/api/projects": { GET: "py", default: "ts" },
        "/api/projects": { PATCH: "py", DELETE: "py", default: "ts" },
      },
      tsUpstream: `http://localhost:${tsUpstream!.port}`,
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
  }
  const auth = { Authorization: `Bearer ${TOKEN}` };

  test("authed PATCH renames via the real Python server", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects/w1", {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // confirm it landed in the DB via Python's GET
    const get = await proxy()(new Request("http://proxy/api/projects", { headers: auth }));
    const body = (await get.json()) as { projects: { workspaceId: string; name: string }[] };
    expect(body.projects.find((p) => p.workspaceId === "w1")?.name).toBe("renamed");
  });

  test("missing token is rejected by Python auth (401)", async () => {
    const res = await proxy()(new Request("http://proxy/api/projects/w1", { method: "PATCH", body: "{}" }));
    expect(res.status).toBe(401);
  });

  test("GET /api/projects/:id/sessions still routes to TS", async () => {
    const res = await proxy()(new Request("http://proxy/api/projects/w1/sessions", { headers: auth }));
    expect(await res.json()).toEqual({ via: "ts-sessions" });
  });

  test("POST /api/projects (create) still routes to TS", async () => {
    const res = await proxy()(new Request("http://proxy/api/projects", { method: "POST", headers: auth }));
    expect(await res.json()).toEqual({ via: "ts-create" });
  });

  test("authed DELETE unregisters via Python + cascades", async () => {
    const res = await proxy()(new Request("http://proxy/api/projects/w2", { method: "DELETE", headers: auth }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const get = await proxy()(new Request("http://proxy/api/projects", { headers: auth }));
    const body = (await get.json()) as { projects: { workspaceId: string }[] };
    expect(body.projects.find((p) => p.workspaceId === "w2")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd /mnt/data/fsm/project/arclightagent/arclight && bun test packages/proxy/src/__tests__/e2e-projects-write.test.ts`
Expected: PASS (5 pass) where the env is present. To debug a boot/seed failure, run the seed + boot manually:
`conda run -n arclight ARCLIGHT_DB_PATH=/tmp/x.sqlite ARCLIGHT_PROJECTS_ROOT=/tmp ARCLIGHT_TOKEN=t python -m uvicorn arclight_core.server.app:app --port <p> --app-dir packages/core-py/src` then `curl -X PATCH -H "Authorization: Bearer t" -H 'content-type: application/json' -d '{"name":"z"}' localhost:<p>/api/projects/w1`.

> Same cross-runtime-flakiness fallback as slices 1-2: if the spawn proves unreliable under contention, report DONE_WITH_CONCERNS and deliver the proof as a `packages/proxy/scripts/smoke-projects-write.sh` with captured output, rather than failure-hiding retries. Generous hook timeouts already apply repo-wide (60s, commit `e69d60d`).

- [ ] **Step 3: Whole proxy suite + leak check**

Run: `cd packages/proxy && bun test`
Expected: PASS — route-table, proxy-forward, e2e-health, e2e-projects, e2e-projects-write all green.
Then: `pgrep -f "arclight_core.server.app:app" || echo "no leak"` → `no leak`.

- [ ] **Step 4: Repo-wide check before the TS commit**

Run: `cd /mnt/data/fsm/project/arclightagent/arclight && bun run check`
Expected: `check:py` + `check:contract` drift gate + biome/types all green.

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/__tests__/e2e-projects-write.test.ts
git commit -m "test(proxy): e2e authed PATCH/DELETE /api/projects via real Python; /sessions stays TS"
```

---

### Task 6: Update the STATUS tracker

**Files:**
- Modify: `docs/superpowers/python-migration-STATUS.md`

- [ ] **Step 1: Mark slice 3 done + record the scope split + new carry-forward**

In `docs/superpowers/python-migration-STATUS.md`:
1. In the roadmap table, set the **M1 slice 3** row Status to `✅ **done**`, fill the merge SHA, and link this plan. Edit its Scope to reflect the chosen scope: "Write-ownership transfer: **PATCH+DELETE** `/api/projects` → Python (Python SQLite write layer, `foreign_keys ON` cascade, deterministic `ORDER BY rowid`, exact-match proxy routing). POST deferred to M3."
2. Add a new **M1 slice 4** row: "Write-ownership transfer for `files`/`memories` groups." Status `▶ next`.
3. In **M3**'s Scope, add: "**also migrates `POST /api/projects` (create) + `sessions.ts` `ensureWorkspace()`** — the two `workspaces` INSERT writers, co-migrated to restore strict one-writer-per-table."
4. Add a **Delivered so far** bullet for slice 3 (write layer, cascade, exact routing, ORDER BY, latent `/sessions` mis-route fixed).
5. In **Carry-forward**, replace the slice-3 ORDER BY bullet (now done) with: "**M3:** `workspaces` has two INSERT writers until M3 — Python (was: projects POST, now deferred) and `sessions.ts` `ensureWorkspace()`. POST create stays TS this whole milestone; co-migrate both INSERT paths in M3 to restore strict one-writer-per-table for `workspaces`." Keep the ★ SSE/ASGI-middleware prerequisite bullet unchanged.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/python-migration-STATUS.md
git commit -m "docs: M1 slice 3 done (PATCH/DELETE projects → Python); slice 4 = files/memories; POST→M3"
```

---

## Self-Review

**1. Spec coverage (this slice + carried decisions):**
- Migrate the single-writer `workspaces` mutations PATCH + DELETE → Tasks 3+4. ✓
- Keep POST on TS (two INSERT writers) → Global Constraints + Task 1 routing (`=/api/projects` default ts) + e2e POST→TS assertion. ✓
- FK cascade fires from Python (`foreign_keys ON`) → Task 2 `db.connect` + Task 4 cascade test. ✓
- Active-turn guard (fail-closed, exact statuses + 409 shape) → Task 4 tests (running/awaiting_approval block, terminal/failed proceed). ✓
- No phantom DB file on writes → Tasks 3+4 missing-db→404 tests. ✓
- Exact-vs-subpath routing so `GET /api/projects/:id/sessions` stays TS (fix latent slice-2 mis-route) → Task 1 + Task 5 e2e. ✓
- Deterministic `ORDER BY rowid` (carry-forward) → Task 2 order test. ✓
- Auth parity unchanged (PATCH/DELETE gated) → Task 5 401 assertion (no new auth code). ✓
- web/cli untouched; proxy out of prod path; seam proven by e2e → Task 5 + Scope note. ✓
- STATUS/roadmap updated (scope split, POST→M3 carry-forward) → Task 6. ✓

**2. Placeholder scan:** No TBD/handle-errors. Step 3/3b in Task 3 are concrete and ordered (3b supersedes the `_has_body` approach with the simpler `_json_or_empty`, which is the version the final file keeps — the implementer ends Task 3 with `_json_or_empty` only). All code blocks complete.

**3. Type/contract consistency:** `Settings(db_path, projects_root, token, dev_no_auth)` unchanged (no new field — PATCH/DELETE need only `db_path`). `connect(db_path) -> sqlite3.Connection` identical across `db.py`, `test_db.py`, and all three handler call-sites. `make_projects_patch`/`make_projects_delete`/`make_projects_get` signatures match between `projects.py` definitions and the `app.py` imports/mounts. Response shapes (`{ok}`, `{ok:false,code:"VALIDATION",message:"name required"}`, `{ok:false,code:"NOT_FOUND"}`, `{ok:false,code:"TURN_ACTIVE",message:"项目内有会话正在运行，先停止再删除"}`) are byte-identical between `projects.ts`, the Python handlers, the pytest assertions, and the e2e. The `=`-prefixed exact-key convention + `MethodUpstream {default}` shape is identical across `route-table.ts`, its tests, and the e2e tables. `_ACTIVE_TURN_STATUSES = ("queued","running","awaiting_approval")` matches the TS `inArray(turns.status, [...])`.

**Known residual risks (flagged):**
- (a) `workspaces` retains two INSERT writers (Python-deferred POST + TS `ensureWorkspace`) until M3 — this is the explicit chosen-scope tradeoff; UPDATE/DELETE are strictly single-writer (Python) after this slice, so the cascade-bearing operations are clean.
- (b) Task 5 is cross-runtime (Bun spawns uvicorn) with the documented smoke-script fallback and repo-wide 60s hook timeouts.
- (c) The DELETE cascade purges `sessions`/`turns` rows (M3 tables) as an engine side-effect of the `workspaces` FK — this is inherent to workspace ownership, guarded fail-closed by the active-turn check, and is why DELETE (not arbitrary sessions writes) is the only Python operation that touches those rows.
