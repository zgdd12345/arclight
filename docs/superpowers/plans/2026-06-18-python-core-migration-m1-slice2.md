# Python Core Migration — M1 Slice 2: First DB-backed `/api` group (read-only `GET /api/projects`) + bearer auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the first DB-backed `/api` endpoint — read-only `GET /api/projects` — to the Python server, introducing a bearer-auth middleware (matching the TS loopback bearer) and read-only SQLite access to arclight's `workspaces` table, with a method-aware proxy that routes only `GET /api/projects` to Python while every other method/group stays on TS — proving the seam with no split-brain and no write-ownership transfer.

**Architecture:** A method-aware route table lets the proxy send `GET /api/projects` to the Python upstream while `POST/PATCH/DELETE /api/projects` and all other `/api/*` stay TS. The Python Starlette app gains a bearer-auth middleware (gates `/api/*`, leaves `/health` open) and a read-only `GET /api/projects` handler that reads the shared `.arclight/arclight.sqlite` `workspaces` table (TS remains the sole writer — WAL makes cross-language reads safe) and replicates the TS filesystem scan for unregistered dirs. A cross-runtime e2e boots the real Python server (seeded DB + temp project dirs) behind the proxy and asserts the byte-shape contract through an authenticated request.

**Tech Stack:** Python 3.12 (conda env `arclight`), Starlette + uvicorn, stdlib `sqlite3` (read-only discipline) + `hmac` (timing-safe compare), pytest + httpx2 TestClient; TypeScript/Bun proxy.

## Global Constraints

- **web/cli unchanged; proxy transparent; proxy NOT in the production launch path.** No edits to `serve.ts`, dev scripts, or the web `baseUrl`. The seam is proven by the e2e, not by routing production traffic.
- **No split-brain.** This slice migrates ONLY read traffic for one group. TS remains the sole writer of every table (one-writer-language-per-table). `/api/config` and `/api/.../grants` are NOT migrated (they are in-memory runtime state shared with the not-yet-migrated TS loop — deferred to M3).
- **Auth parity (exact).** `/health` is OPEN. Every `/api/*` request requires `Authorization: Bearer <token>`, compared **timing-safe**. On mismatch return HTTP 401 with body `{"ok": false, "code": "UNAUTHORIZED", "message": "invalid token"}`. `ARCLIGHT_DEV_NO_AUTH=1` bypasses auth entirely (test/dev only). Source of truth: `packages/core/src/server/middleware/auth.ts`.
- **`GET /api/projects` contract (exact).** Response JSON: `{"ok": true, "projectsRoot": "<abs>", "projects": [{"workspaceId": "<id>", "name": "<name>", "repoPath": "<repo_path>"}], "available": [{"name": "<dir>"}]}`. `projects` comes from the `workspaces` table (`id`→`workspaceId`, `name`, `repo_path`→`repoPath`). `available` is the sorted list of immediate subdirectories of `projectsRoot` that are NOT hidden (no leading `.`), NOT symlinks, ARE directories, and are NOT already registered (registered = `abspath(repo_path)` of each workspace). `projectsRoot` is `abspath(projects_root)`. Source of truth: `packages/core/src/server/routes/projects.ts` (`createProjectsRoute` GET `/` + `listAvailableDirs`).
- **Python reads the shared DB read-only.** DB file: `<repo>/.arclight/arclight.sqlite` (table `workspaces`). Python opens it and runs SELECT only — never writes, never migrates (drizzle stays the migration authority). Set `busy_timeout`.
- **Python env = conda env `arclight`** (Python 3.12); run via `conda run -n arclight`; **no `uv`**. New runtime deps already covered (starlette/uvicorn installed); stdlib `sqlite3`/`hmac` need nothing new.
- **API keys never appear in any response.** (Not produced here; a standing rule.)
- **Commits exclude the unrelated dirty `bun.lock`** — always `git add <explicit paths>`, never `git add -A`.
- Run `bun run check` before any TS commit; run focused Python tests via `conda run -n arclight python -m pytest`.

---

## Scope note (what this slice deliberately does NOT do)

- Does NOT migrate `POST/PATCH/DELETE /api/projects` (workspaces writes stay TS — no write-ownership transfer this slice).
- Does NOT migrate `/api/config`, `/api/.../grants` (in-memory runtime, split-brain until M3), or any loop-core group (`sessions`/`commands`/`files`/`snapshot` — M3).
- Does NOT add a Python DB write layer or run migrations from Python.

---

## File Structure

**Created:**
- `packages/core-py/src/arclight_core/server/settings.py` — `Settings` dataclass + `from_env()` loader (db path, projects root, token, dev_no_auth).
- `packages/core-py/src/arclight_core/server/auth.py` — `BearerAuthMiddleware`.
- `packages/core-py/src/arclight_core/server/projects.py` — workspaces read + `list_available_dirs` + the `GET /api/projects` handler.
- `packages/core-py/tests/test_auth.py`
- `packages/core-py/tests/test_projects.py`
- `packages/proxy/src/__tests__/e2e-projects.test.ts` — cross-runtime e2e for authed `GET /api/projects`.

**Modified:**
- `packages/core-py/src/arclight_core/server/app.py` — `create_app(settings=None)`; mount `/api/projects` GET; install auth middleware.
- `packages/proxy/src/route-table.ts` — method-aware `RouteTable`; flip `GET /api/projects` → `"py"`.
- `packages/proxy/src/server.ts` — pass the request method to `resolveUpstream`.
- `packages/proxy/src/__tests__/route-table.test.ts` — method-aware cases.
- `packages/proxy/src/__tests__/e2e-health.test.ts` — dynamic port (the slice-1 follow-up).

---

### Task 1: Method-aware proxy route table

**Files:**
- Modify: `packages/proxy/src/route-table.ts`
- Modify: `packages/proxy/src/server.ts`
- Modify: `packages/proxy/src/__tests__/route-table.test.ts`

**Interfaces:**
- Consumes: existing `Upstream` type, `makeProxy` in `server.ts`.
- Produces:
  - `type MethodUpstream = Partial<Record<"GET" | "POST" | "PATCH" | "PUT" | "DELETE", Upstream>> & { default: Upstream }`
  - `type RouteTable = Record<string, Upstream | MethodUpstream>` (a value may be a plain `Upstream` OR a per-method map with a required `default`).
  - `resolveUpstream(path: string, table: RouteTable, method?: string): Upstream` — longest-prefix match; if the matched value is a `MethodUpstream`, pick `value[method]` else `value.default`; if it's a plain `Upstream`, return it (method ignored). Unknown path → `"ts"`.

- [ ] **Step 1: Update the route-table test for method-aware routing**

Replace `packages/proxy/src/__tests__/route-table.test.ts` with:
```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE, type RouteTable, resolveUpstream } from "../route-table";

describe("resolveUpstream — plain entries", () => {
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

describe("resolveUpstream — method-aware entries", () => {
  const table: RouteTable = {
    "/api/projects": { GET: "py", default: "ts" },
  };
  test("GET routes to py, other methods to default ts", () => {
    expect(resolveUpstream("/api/projects", table, "GET")).toBe("py");
    expect(resolveUpstream("/api/projects", table, "POST")).toBe("ts");
    expect(resolveUpstream("/api/projects/ws1/sessions", table, "GET")).toBe("py");
    expect(resolveUpstream("/api/projects/ws1", table, "DELETE")).toBe("ts");
  });
  test("missing method falls back to default", () => {
    expect(resolveUpstream("/api/projects", table, "PUT")).toBe("ts");
  });
});

describe("DEFAULT_TABLE", () => {
  test("GET /api/projects → py, writes → ts", () => {
    expect(resolveUpstream("/api/projects", DEFAULT_TABLE, "GET")).toBe("py");
    expect(resolveUpstream("/api/projects", DEFAULT_TABLE, "POST")).toBe("ts");
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
Expected: FAIL — `resolveUpstream` has no method param / `MethodUpstream` not exported / `DEFAULT_TABLE["/api/projects"]` is still a plain `"ts"`.

- [ ] **Step 3: Implement method-aware routing**

Replace the contents of `packages/proxy/src/route-table.ts` with:
```ts
// Route-group → upstream. Values are either a plain Upstream (all methods) or a
// per-method map with a required `default`. Longest-prefix match decides the
// group; method then selects within a method-map. Flipping a group/method is a
// one-line edit here.
export type Upstream = "ts" | "py";
export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type MethodUpstream = Partial<Record<Method, Upstream>> & { default: Upstream };
export type RouteTable = Record<string, Upstream | MethodUpstream>;

export const DEFAULT_TABLE: RouteTable = {
  "/health": "py",
  "/api/projects": { GET: "py", default: "ts" },
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

export function resolveUpstream(path: string, table: RouteTable, method = "GET"): Upstream {
  let best = "";
  for (const prefix of Object.keys(table)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (prefix.length > best.length) best = prefix;
    }
  }
  if (!best) return "ts";
  const v = table[best];
  if (isMethodUpstream(v)) {
    return v[method as Method] ?? v.default;
  }
  return v;
}
```

- [ ] **Step 4: Thread the method through `makeProxy`**

In `packages/proxy/src/server.ts`, the handler calls `resolveUpstream(url.pathname, opts.table)`. Change that call to pass the request method:
```ts
    const target = resolveUpstream(url.pathname, opts.table, req.method);
```
(No other change in `server.ts`.)

- [ ] **Step 5: Run the full proxy suite**

Run: `cd packages/proxy && bun test`
Expected: PASS — route-table (method-aware) green; the existing `proxy-forward` and `e2e-health` suites still pass (they pass explicit tables / the health entry stays a plain `"py"`, and `makeProxy` now passes a method that plain entries ignore).

- [ ] **Step 6: Commit**

```bash
git add packages/proxy/src/route-table.ts packages/proxy/src/server.ts packages/proxy/src/__tests__/route-table.test.ts
git commit -m "feat(proxy): method-aware route table; GET /api/projects → py"
```

---

### Task 2: Python settings + bearer-auth middleware

**Files:**
- Create: `packages/core-py/src/arclight_core/server/settings.py`
- Create: `packages/core-py/src/arclight_core/server/auth.py`
- Modify: `packages/core-py/src/arclight_core/server/app.py`
- Create: `packages/core-py/tests/test_auth.py`

**Interfaces:**
- Consumes: the Starlette `app` from slice 1 (`app.py`).
- Produces:
  - `arclight_core.server.settings.Settings` — frozen dataclass with fields `db_path: str`, `projects_root: str`, `token: str`, `dev_no_auth: bool`.
  - `arclight_core.server.settings.from_env() -> Settings` — reads `ARCLIGHT_DB_PATH`, `ARCLIGHT_PROJECTS_ROOT`, `ARCLIGHT_TOKEN`, `ARCLIGHT_DEV_NO_AUTH` (default `""`/`""`/`""`/`False`).
  - `arclight_core.server.auth.BearerAuthMiddleware` — Starlette middleware: `/health` and any non-`/api/` path pass through; `/api/*` requires `Authorization: Bearer <token>` (timing-safe via `hmac.compare_digest`); 401 JSON `{"ok": false, "code": "UNAUTHORIZED", "message": "invalid token"}` on mismatch; bypass entirely when `dev_no_auth` is true.
  - `create_app(settings: Settings | None = None) -> Starlette` — when `settings` is None, loads `from_env()`; installs `BearerAuthMiddleware(token=settings.token, dev_no_auth=settings.dev_no_auth)`; `/health` still works.

- [ ] **Step 1: Write the failing auth test**

`packages/core-py/tests/test_auth.py`:
```python
from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings


def _client(token="secret", dev_no_auth=False):
    s = Settings(db_path="/nonexistent.sqlite", projects_root="/tmp", token=token, dev_no_auth=dev_no_auth)
    return TestClient(create_app(s))


def test_health_is_open_without_token():
    r = _client().get("/health")
    assert r.status_code == 200


def test_api_requires_bearer_token():
    r = _client().get("/api/projects")  # no Authorization header
    assert r.status_code == 401
    assert r.json() == {"ok": False, "code": "UNAUTHORIZED", "message": "invalid token"}


def test_api_rejects_wrong_token():
    r = _client().get("/api/projects", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_dev_no_auth_bypasses():
    # dev_no_auth lets the request through to the route layer (which may 500 on the
    # missing DB, but must NOT 401). Assert it is not a 401.
    r = _client(dev_no_auth=True).get("/api/projects")
    assert r.status_code != 401
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_auth.py -v`
Expected: FAIL — `arclight_core.server.settings` / `create_app(settings)` signature don't exist yet.

- [ ] **Step 3: Implement settings + middleware + wire into app**

`packages/core-py/src/arclight_core/server/settings.py`:
```python
"""Server settings, loaded from env in production or injected in tests."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    db_path: str
    projects_root: str
    token: str
    dev_no_auth: bool


def from_env() -> Settings:
    return Settings(
        db_path=os.environ.get("ARCLIGHT_DB_PATH", ""),
        projects_root=os.environ.get("ARCLIGHT_PROJECTS_ROOT", ""),
        token=os.environ.get("ARCLIGHT_TOKEN", ""),
        dev_no_auth=os.environ.get("ARCLIGHT_DEV_NO_AUTH", "") == "1",
    )
```

`packages/core-py/src/arclight_core/server/auth.py`:
```python
"""Bearer auth middleware. Parity with packages/core/src/server/middleware/auth.ts:
/health and non-/api paths are open; /api/* requires Authorization: Bearer <token>,
compared timing-safe. ARCLIGHT_DEV_NO_AUTH bypass handled via dev_no_auth flag.
"""
import hmac

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


class BearerAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, token: str, dev_no_auth: bool = False):
        super().__init__(app)
        self._token = token
        self._dev_no_auth = dev_no_auth

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if self._dev_no_auth or not path.startswith("/api/"):
            return await call_next(request)
        header = request.headers.get("authorization", "")
        got = header[len("Bearer ") :] if header.startswith("Bearer ") else ""
        if not hmac.compare_digest(got, self._token):
            return JSONResponse(
                {"ok": False, "code": "UNAUTHORIZED", "message": "invalid token"},
                status_code=401,
            )
        return await call_next(request)
```

Update `packages/core-py/src/arclight_core/server/app.py` to accept settings and install the middleware. Replace the file body with:
```python
"""Arclight core HTTP server (Python). M1: GET /health (open) + GET /api/projects (auth).

Contract sources of truth:
- /health  : packages/core/src/server/routes/health.ts
- auth     : packages/core/src/server/middleware/auth.ts
- /api/projects : packages/core/src/server/routes/projects.ts
"""
import time

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .auth import BearerAuthMiddleware
from .settings import Settings, from_env

_SERVICE = "arclight-core"
_VERSION = "0.0.1"
_STARTED_AT = time.monotonic()


async def _health(_request: Request) -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "service": _SERVICE,
            "version": _VERSION,
            "uptimeMs": int((time.monotonic() - _STARTED_AT) * 1000),
        }
    )


def create_app(settings: Settings | None = None) -> Starlette:
    settings = settings or from_env()
    # Imported here so /health-only apps (slice 1 tests) don't require the projects deps path.
    from .projects import make_projects_get

    routes = [
        Route("/health", _health, methods=["GET"]),
        Route("/api/projects", make_projects_get(settings), methods=["GET"]),
    ]
    middleware = [
        Middleware(BearerAuthMiddleware, token=settings.token, dev_no_auth=settings.dev_no_auth),
    ]
    return Starlette(routes=routes, middleware=middleware)


app = create_app()
```

> `make_projects_get(settings)` is implemented in Task 3. For Task 2 to run its auth tests RED→GREEN before Task 3 exists, add a temporary stub at the top of Task 3 — but since tasks execute in order, create a minimal `projects.py` now containing only a stub `make_projects_get` that returns a handler raising `RuntimeError`. The auth tests never reach the handler (401 before routing, or dev_no_auth path asserts only "not 401"). Concretely, create `packages/core-py/src/arclight_core/server/projects.py` with:
> ```python
> def make_projects_get(settings):
>     async def _handler(request):
>         raise RuntimeError("implemented in Task 3")
>     return _handler
> ```
> Task 3 replaces this file wholesale.

- [ ] **Step 4: Run the auth test to verify it passes**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_auth.py -v`
Expected: PASS (4 passed). The `dev_no_auth` test reaches the stub handler which raises → Starlette returns 500, and the test only asserts `!= 401`, so it passes.

- [ ] **Step 5: Confirm slice-1 health test + ruff still green**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_server_health.py tests/test_auth.py -q && conda run -n arclight ruff check .`
Expected: all pass; ruff `All checks passed!`. (The slice-1 `test_server_health.py` calls `create_app()` with no args — still valid since `settings` defaults to `from_env()`, and `/health` needs no token.)

- [ ] **Step 6: Commit**

```bash
git add packages/core-py/src/arclight_core/server/settings.py packages/core-py/src/arclight_core/server/auth.py packages/core-py/src/arclight_core/server/app.py packages/core-py/src/arclight_core/server/projects.py packages/core-py/tests/test_auth.py
git commit -m "feat(core-py): settings + bearer-auth middleware (parity with TS); app takes Settings"
```

---

### Task 3: Read-only `GET /api/projects` (workspaces read + available-dirs scan)

**Files:**
- Modify (replace the Task-2 stub): `packages/core-py/src/arclight_core/server/projects.py`
- Create: `packages/core-py/tests/test_projects.py`

**Interfaces:**
- Consumes: `Settings` (db_path, projects_root) from Task 2.
- Produces:
  - `arclight_core.server.projects.list_available_dirs(projects_root: str, registered: set[str]) -> list[dict]` — sorted `[{"name": <dir>}]` of immediate subdirs of `projects_root` that are not hidden, not symlinks, are directories, and whose `abspath` is not in `registered`.
  - `arclight_core.server.projects.make_projects_get(settings: Settings)` — returns an async Starlette handler for `GET /api/projects` producing the exact contract JSON.

- [ ] **Step 1: Write the failing contract test**

`packages/core-py/tests/test_projects.py`:
```python
import os
import sqlite3

from starlette.testclient import TestClient

from arclight_core.server.app import create_app
from arclight_core.server.settings import Settings


def _seed_db(path):
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, "
        "name TEXT NOT NULL, repo_path TEXT NOT NULL, arclight_dir TEXT, "
        "current_session_id TEXT, default_branch TEXT, head_sha TEXT, "
        "created_at INTEGER, updated_at INTEGER)"
    )
    conn.execute(
        "INSERT INTO workspaces (id, name, repo_path, arclight_dir) VALUES (?,?,?,?)",
        ("ws1", "alpha", "/projects/alpha", "/projects/alpha/.arclight"),
    )
    conn.commit()
    conn.close()


def _client(tmp_path):
    db = tmp_path / "arclight.sqlite"
    _seed_db(str(db))
    root = tmp_path / "projects"
    root.mkdir()
    (root / "alpha").mkdir()          # registered (repo_path points here once abspath'd? no — repo_path is /projects/alpha)
    (root / "beta").mkdir()           # available
    (root / ".hidden").mkdir()        # skipped (hidden)
    (root / "afile").write_text("x")  # skipped (not a dir)
    s = Settings(db_path=str(db), projects_root=str(root), token="t", dev_no_auth=True)
    return TestClient(create_app(s)), str(root)


def test_projects_contract(tmp_path):
    client, root = _client(tmp_path)
    r = client.get("/api/projects")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["projectsRoot"] == os.path.abspath(root)
    assert body["projects"] == [{"workspaceId": "ws1", "name": "alpha", "repoPath": "/projects/alpha"}]
    # alpha dir is under root but its abspath != the workspace repo_path (/projects/alpha),
    # so it is NOT registered-by-path and appears in available alongside beta; hidden + file excluded.
    names = [d["name"] for d in body["available"]]
    assert names == ["alpha", "beta"]
    assert all(not n.startswith(".") for n in names)


def test_available_excludes_registered(tmp_path):
    # When a workspace repo_path resolves to a dir under root, that dir is excluded from available.
    db = tmp_path / "arclight.sqlite"
    root = tmp_path / "projects"
    root.mkdir()
    (root / "gamma").mkdir()
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO workspaces (id, name, repo_path) VALUES (?,?,?)",
        ("ws2", "gamma", str(root / "gamma")),
    )
    conn.commit()
    conn.close()
    s = Settings(db_path=str(db), projects_root=str(root), token="t", dev_no_auth=True)
    body = TestClient(create_app(s)).get("/api/projects").json()
    assert [d["name"] for d in body["available"]] == []  # gamma is registered → excluded
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_projects.py -v`
Expected: FAIL — the Task-2 stub handler raises `RuntimeError` (500), so the contract assertions fail.

- [ ] **Step 3: Implement the projects reader + handler**

Replace `packages/core-py/src/arclight_core/server/projects.py` wholesale with:
```python
"""Read-only GET /api/projects. Parity with packages/core/src/server/routes/projects.ts
(GET / handler + listAvailableDirs). Reads the shared SQLite workspaces table; TS remains
the sole writer (one-writer-per-table). Never writes, never migrates.
"""
import os
import sqlite3

from starlette.requests import Request
from starlette.responses import JSONResponse

from .settings import Settings


def _read_workspaces(db_path: str) -> list[dict]:
    # Read-only by discipline: SELECT only, never write/migrate. busy_timeout for WAL contention.
    conn = sqlite3.connect(db_path, timeout=5.0)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT id, name, repo_path FROM workspaces").fetchall()
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
        projects = _read_workspaces(settings.db_path)
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
```

- [ ] **Step 4: Run the contract test to verify it passes**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_projects.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Full Python suite + ruff green**

Run: `cd packages/core-py && conda run -n arclight python -m pytest -q && conda run -n arclight ruff check .`
Expected: all Python tests pass (health + auth + projects + the protocol/model tests); ruff clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core-py/src/arclight_core/server/projects.py packages/core-py/tests/test_projects.py
git commit -m "feat(core-py): read-only GET /api/projects (workspaces read + available-dirs scan)"
```

---

### Task 4: Proxy flip e2e (authed `GET /api/projects` via real Python) + dynamic-port follow-up

**Files:**
- Create: `packages/proxy/src/__tests__/e2e-projects.test.ts`
- Modify: `packages/proxy/src/__tests__/e2e-health.test.ts` (dynamic port — the slice-1 follow-up)

**Interfaces:**
- Consumes: `makeProxy` + method-aware `resolveUpstream` (Task 1); the real Python `arclight_core.server.app:app` with `/api/projects` (Tasks 2-3); `arclightEnvAvailable()` skip-guard pattern from `e2e-health.test.ts`.
- Produces: an automated proof that an authenticated `GET /api/projects` through the proxy is served by the real Python server reading a seeded SQLite, while `POST /api/projects` still routes to TS.

- [ ] **Step 1: Convert the slice-1 e2e to a dynamic port (follow-up)**

In `packages/proxy/src/__tests__/e2e-health.test.ts`, replace the fixed `const PY_PORT = 8791;` with a dynamically-allocated free port grabbed before spawn:
```ts
// Grab a free port by opening an ephemeral listener and immediately closing it.
function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop();
  return p;
}
const PY_PORT = freePort();
```
The existing `--port String(PY_PORT)` spawn arg and the `pkill -f "...--port ${PY_PORT}"` teardown already interpolate `PY_PORT`, so they pick up the dynamic value with no further change. Keep the `E2E_AVAILABLE` skip-guard and the gated hooks exactly as they are.

- [ ] **Step 2: Run the health e2e to confirm the dynamic port works**

Run: `cd /mnt/data/fsm/project/arclightagent/arclight && bun test packages/proxy/src/__tests__/e2e-health.test.ts`
Expected: PASS (2 pass) on a dynamically chosen port; then `ss -tlnp 2>/dev/null | grep "${PY_PORT}" || echo "no leak"` — but since the port varies, just confirm `pgrep -f "arclight_core.server.app:app" || echo "no leak"` → `no leak`.

- [ ] **Step 3: Write the failing projects e2e**

`packages/proxy/src/__tests__/e2e-projects.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
if (!E2E_AVAILABLE) console.warn("[e2e-projects] skipping: conda env 'arclight' or arclight_core not importable");

const PY_PORT = freePort();
const TOKEN = "test-token-123";
let py: ReturnType<typeof Bun.spawn> | undefined;
let tsUpstream: ReturnType<typeof Bun.serve> | undefined;
let workdir: string;

async function waitForPython(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status === 200 || r.status === 401) return; // server up (401 = auth gate reached)
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`python server did not become ready at ${url}`);
}

beforeAll(async () => {
  if (!E2E_AVAILABLE) return;
  // Seed a SQLite workspaces table + a projects root with one available dir.
  workdir = mkdtempSync(join(tmpdir(), "arc-e2e-proj-"));
  const dbPath = join(workdir, "arclight.sqlite");
  const projectsRoot = join(workdir, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(join(projectsRoot, "beta"));
  const seed = Bun.spawnSync(
    ["conda", "run", "-n", "arclight", "python", "-c",
      `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL)"); c.execute("INSERT INTO workspaces (id,name,repo_path) VALUES ('ws1','alpha','/projects/alpha')"); c.commit(); c.close()`,
      dbPath],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (seed.exitCode !== 0) throw new Error(`seed failed: ${seed.stderr}`);

  py = Bun.spawn(
    ["conda", "run", "-n", "arclight", "python", "-m", "uvicorn",
      "arclight_core.server.app:app", "--port", String(PY_PORT), "--app-dir", "packages/core-py/src"],
    {
      cwd: repoRoot,
      env: { ...process.env, ARCLIGHT_DB_PATH: dbPath, ARCLIGHT_PROJECTS_ROOT: projectsRoot, ARCLIGHT_TOKEN: TOKEN },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await waitForPython(`http://localhost:${PY_PORT}/health`);

  tsUpstream = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/api/projects") {
        return Response.json({ via: "ts-write" });
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

describe.skipIf(!E2E_AVAILABLE)("cross-runtime seam: GET /api/projects", () => {
  function proxy() {
    return makeProxy({
      table: { "/api/projects": { GET: "py", default: "ts" } },
      tsUpstream: `http://localhost:${tsUpstream!.port}`,
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
  }

  test("authed GET is served by the real Python server", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects", { headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; projects: { name: string }[]; available: { name: string }[] };
    expect(body.ok).toBe(true);
    expect(body.projects).toEqual([{ workspaceId: "ws1", name: "alpha", repoPath: "/projects/alpha" }]);
    expect(body.available.map((d) => d.name)).toContain("beta");
  });

  test("missing token is rejected by Python auth (401)", async () => {
    const res = await proxy()(new Request("http://proxy/api/projects"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("UNAUTHORIZED");
  });

  test("POST /api/projects still routes to TS", async () => {
    const res = await proxy()(
      new Request("http://proxy/api/projects", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
    expect(await res.json()).toEqual({ via: "ts-write" });
  });
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /mnt/data/fsm/project/arclightagent/arclight && bun test packages/proxy/src/__tests__/e2e-projects.test.ts`
Expected: PASS (3 pass) where the env is present. If uvicorn fails to read the DB, run the seed + boot manually to debug:
`conda run -n arclight ARCLIGHT_DB_PATH=/tmp/x.sqlite ARCLIGHT_PROJECTS_ROOT=/tmp ARCLIGHT_TOKEN=t python -m uvicorn arclight_core.server.app:app --port <p> --app-dir packages/core-py/src` then `curl -H "Authorization: Bearer t" localhost:<p>/api/projects`.

> Same cross-runtime-flakiness fallback as slice 1: if the spawn proves unreliable, report DONE_WITH_CONCERNS and deliver the proof as a `packages/proxy/scripts/smoke-projects.sh` script with captured output, rather than failure-hiding retries.

- [ ] **Step 5: Whole proxy suite + leak check**

Run: `cd packages/proxy && bun test`
Expected: PASS — route-table, proxy-forward, e2e-health (dynamic port), e2e-projects all green.
Then: `pgrep -f "arclight_core.server.app:app" || echo "no leak"` → `no leak`.

- [ ] **Step 6: Commit**

```bash
git add packages/proxy/src/__tests__/e2e-projects.test.ts packages/proxy/src/__tests__/e2e-health.test.ts
git commit -m "test(proxy): e2e authed GET /api/projects via real Python; dynamic e2e ports"
```

---

## Self-Review

**1. Spec coverage (this slice + carried decisions):**
- First DB-backed `/api` migration, read-only, split-brain-free → Tasks 1+3+4. ✓
- Bearer auth parity (`/api/*` gated, `/health` open, timing-safe, 401 shape, devNoAuth) → Task 2. ✓
- Python read-only SQLite access to the shared `workspaces` table (TS sole writer) → Task 3. ✓
- Proxy method-aware so writes stay TS (no write-ownership transfer) → Task 1. ✓
- web/cli untouched; proxy out of production path; seam proven by e2e → Task 4 + Scope note. ✓
- Slice-1 fixed-port follow-up resolved → Task 4 Step 1. ✓
- `/api/config` + grants explicitly deferred (split-brain) → Scope note. ✓

**2. Placeholder scan:** No TBD/handle-errors. The Task-2 `>` note (temporary `make_projects_get` stub, replaced wholesale in Task 3) is concrete and ordered, not deferred work. The Task-4 `>` note gives a concrete fallback deliverable. All code blocks complete.

**3. Type/contract consistency:** `Settings(db_path, projects_root, token, dev_no_auth)` is identical across settings.py, auth/app wiring, and all three test files. `make_projects_get(settings)` signature matches between the app.py mount (Task 2), the stub (Task 2), and the real impl (Task 3). `create_app(settings=None)` is back-compatible with slice-1's `create_app()` (health test). The `MethodUpstream` `{GET, default}` shape is identical in route-table.ts, its tests, and both e2e tables. The `GET /api/projects` JSON keys (`ok/projectsRoot/projects[workspaceId,name,repoPath]/available[name]`) match the TS source, the Python handler, the pytest, and the e2e assertion.

**Known residual risks (flagged):** (a) Python `sorted(key=name)` vs TS `localeCompare` can differ for non-ASCII dir names — acceptable for typical repo dirs; noted. (b) Task 4 is cross-runtime (Bun spawns uvicorn) with the documented smoke-script fallback. (c) The Python handler opens a normal sqlite3 connection and only SELECTs (read-only by discipline, not by `mode=ro`, to avoid WAL-readonly open pitfalls) — the one-writer-per-table rule is preserved because Python never issues writes.
