# Python Core Migration — M1 Slice 1: CI Gate + Python Health Server Behind the Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the M0 contract gate into CI, stand up a Python Starlette server serving the lowest-risk endpoint (`/health`) with a byte-compatible contract, correct the proxy route table to the real paths and route `/health` → Python, and prove the cross-runtime seam end-to-end — all without changing the production launch path.

**Architecture:** A new `arclight_core.server` Starlette app exposes `GET /health` returning the same JSON the TS Hono route returns. The M0 Bun proxy's route table is corrected (TS mounts health at `/health`, not `/api/health`) and flips the `/health` group to the Python upstream while every `/api/*` group stays on TS. A cross-runtime e2e test boots the real Python app under uvicorn behind the real proxy to prove transparency. CI gains a conda step running the Python + contract gates.

**Tech Stack:** Python 3.12 (conda env `arclight`), Starlette + uvicorn, httpx (TestClient), pytest; TypeScript/Bun proxy; GitHub Actions + `conda-incubator/setup-miniconda`.

## Global Constraints

- **web/cli unchanged; proxy transparent.** This slice does NOT route production client traffic through the proxy and does NOT touch `serve.ts`, dev scripts, or the web `baseUrl`. The proxy stays out of the production launch path; production cut-over is a later deliberate slice.
- **`/health` is OPEN (no auth).** The TS server mounts it at `/health` (not under `/api`); `/api/*` requires a bearer token. This slice serves only `/health`, so NO auth middleware is built here — auth parity is deferred to the config slice (the first `/api/*` group).
- **Health contract is exact.** The Python response MUST be a JSON object with EXACTLY these keys: `ok` (bool `true`), `service` (string `"arclight-core"`), `version` (string `"0.0.1"`), `uptimeMs` (integer ≥ 0). Source of truth: `packages/core/src/server/routes/health.ts`.
- **Python env = conda env `arclight`** (Python 3.12), already created. Run Python via `conda run -n arclight <cmd>`. **No `uv`.** New deps (`starlette`, `uvicorn`, `httpx`) are installed into the env by the controller before the relevant task; tasks must not assume `pip install` network access mid-task.
- **Protocol single source of truth = zod**; pydantic models are generated (unchanged here).
- **conda is the CI Python toolchain** (`conda-incubator/setup-miniconda`), mirroring local; `datamodel-code-generator` pinned `==0.64.0`.
- **Commits exclude the unrelated dirty `bun.lock`** — always `git add <explicit paths>`, never `git add -A`.
- Run `bun run check` before any TS commit; run the focused Python tests via `conda run -n arclight python -m pytest`.

---

## Scope note (what this slice deliberately does NOT do)

- Does not serve any `/api/*` group from Python (config/projects/files/grants/commands/sessions stay on TS).
- Does not build auth, DB access, or SSE in Python (no `/api` or session route here).
- Does not insert the proxy into the real client path. The seam is proven by an e2e test that boots the components directly.

These are later slices, each with its own plan.

---

## File Structure

**Created:**
- `packages/core-py/src/arclight_core/server/__init__.py` — server subpackage marker.
- `packages/core-py/src/arclight_core/server/app.py` — Starlette app factory + `/health` handler.
- `packages/core-py/tests/test_server_health.py` — TestClient contract test.
- `packages/proxy/src/__tests__/e2e-health.test.ts` — cross-runtime end-to-end seam test.

**Modified:**
- `.github/workflows/ci.yml` — add conda setup + contract/Python gate steps.
- `packages/core-py/pyproject.toml` — add `starlette`, `uvicorn` runtime deps; `httpx` dev dep.
- `packages/proxy/src/route-table.ts` — correct `/api/health` → `/health`; flip `/health` → `"py"`.
- `packages/proxy/src/__tests__/route-table.test.ts` — update expectations for the corrected table.

---

### Task 1: Wire the contract + Python gates into CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: existing `package.json` scripts `check:py` and `check:contract` (from M0), which invoke `conda run -n arclight ...` and `bun run emit-schema`.
- Produces: a CI that runs both gates on every push/PR. No code symbols.

- [ ] **Step 1: Read the current workflow**

Run: `cat .github/workflows/ci.yml`
Note the single `check` job: it does `actions/checkout`, `oven-sh/setup-bun`, `bun install`, a node-pty rebuild, then biome/tsc/vitest/test:core/smoke steps. You will APPEND conda setup + two gate steps to this same job (it already has bun + `bun install`).

- [ ] **Step 2: Add conda setup + gate steps to the `check` job**

Edit `.github/workflows/ci.yml`. After the existing last step (`- name: Native smoke test` / `run: bun run smoke`), append these steps (same indentation as the other steps, inside `jobs.check.steps`):

```yaml
      - name: Set up conda (Python gate)
        uses: conda-incubator/setup-miniconda@v3
        with:
          python-version: "3.12"
          activate-environment: arclight
          auto-activate-base: false
      - name: Install Python deps
        shell: bash -el {0}
        run: pip install "pydantic>=2" "pytest>=8" "datamodel-code-generator==0.64.0" "ruff>=0.6" "starlette" "uvicorn" "httpx"
      - name: Contract drift gate
        shell: bash -el {0}
        run: bun run check:contract
      - name: Python checks
        shell: bash -el {0}
        run: bun run check:py
```

Rationale: `shell: bash -el {0}` is required so the activated conda env is on PATH; `bun run check:contract`/`check:py` then resolve both `bun` (from setup-bun earlier in the job) and `conda run -n arclight`.

- [ ] **Step 3: Validate the workflow YAML parses**

Run: `conda run -n arclight python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"`
Expected: `yaml ok` (no exception). This catches indentation/syntax errors locally; the workflow itself is exercised by GitHub on push.

- [ ] **Step 4: Confirm the exact commands the job runs are green locally**

Run: `bun run check:contract && bun run check:py`
Expected: `check:contract` prints no drift (exit 0); `check:py` runs ruff (`All checks passed!`) and pytest (all passing). These are the same commands the CI steps invoke.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run contract drift + Python gates via conda (setup-miniconda)"
```

---

### Task 2: Python Starlette server with `/health`

**Files:**
- Create: `packages/core-py/src/arclight_core/server/__init__.py`
- Create: `packages/core-py/src/arclight_core/server/app.py`
- Create: `packages/core-py/tests/test_server_health.py`
- Modify: `packages/core-py/pyproject.toml`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `arclight_core.server.app.create_app() -> starlette.applications.Starlette` — app factory mounting `GET /health`.
  - `arclight_core.server.app.app` — a module-level `Starlette` instance (`create_app()`), used by uvicorn as `arclight_core.server.app:app` (Task 4 consumes this import path).
  - `GET /health` returns `{"ok": true, "service": "arclight-core", "version": "0.0.1", "uptimeMs": <int>}`.

- [ ] **Step 1: Add runtime deps to pyproject**

Edit `packages/core-py/pyproject.toml`. Change the `[project]` `dependencies` line from `dependencies = ["pydantic>=2"]` to:
```toml
dependencies = ["pydantic>=2", "starlette", "uvicorn"]
```
And add `"httpx"` to the dev extra so the `[project.optional-dependencies]` `dev` list becomes:
```toml
dev = ["pytest>=8", "datamodel-code-generator==0.64.0", "ruff>=0.6", "httpx"]
```
(The controller has already installed `starlette`, `uvicorn`, `httpx` into the `arclight` env, so no install step is needed to run the tests.)

- [ ] **Step 2: Write the failing contract test**

`packages/core-py/tests/test_server_health.py`:
```python
from starlette.testclient import TestClient

from arclight_core.server.app import create_app


def test_health_matches_ts_contract():
    client = TestClient(create_app())
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    # Exact key set — the TS Hono route returns precisely these four.
    assert set(body.keys()) == {"ok", "service", "version", "uptimeMs"}
    assert body["ok"] is True
    assert body["service"] == "arclight-core"
    assert body["version"] == "0.0.1"
    assert isinstance(body["uptimeMs"], int)
    assert body["uptimeMs"] >= 0
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_server_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'arclight_core.server'`.

- [ ] **Step 4: Implement the server**

`packages/core-py/src/arclight_core/server/__init__.py`:
```python
```
(empty file — package marker)

`packages/core-py/src/arclight_core/server/app.py`:
```python
"""Arclight core HTTP server (Python). M1 slice 1: only GET /health.

Contract source of truth: packages/core/src/server/routes/health.ts —
returns {ok, service, version, uptimeMs}. /health is OPEN (no auth);
/api/* (added in later slices) will require a bearer token.
"""
import time

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

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


def create_app() -> Starlette:
    return Starlette(routes=[Route("/health", _health, methods=["GET"])])


app = create_app()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_server_health.py -v`
Expected: PASS (1 passed).

- [ ] **Step 6: Confirm ruff is clean on the new module**

Run: `cd packages/core-py && conda run -n arclight ruff check .`
Expected: `All checks passed!`

- [ ] **Step 7: Commit**

```bash
git add packages/core-py/pyproject.toml packages/core-py/src/arclight_core/server/__init__.py packages/core-py/src/arclight_core/server/app.py packages/core-py/tests/test_server_health.py
git commit -m "feat(core-py): Starlette server with /health matching TS contract"
```

---

### Task 3: Correct the proxy route table and flip `/health` → Python

**Files:**
- Modify: `packages/proxy/src/route-table.ts`
- Modify: `packages/proxy/src/__tests__/route-table.test.ts`

**Interfaces:**
- Consumes: `resolveUpstream(path, table)` and `RouteTable` / `DEFAULT_TABLE` (from M0).
- Produces: an updated `DEFAULT_TABLE` where the health group key is `/health` (mapped to `"py"`) and the `/api/*` groups remain `"ts"`. `resolveUpstream` logic is unchanged.

- [ ] **Step 1: Update the route-table test to the corrected paths**

Edit `packages/proxy/src/__tests__/route-table.test.ts`. Replace its body with:
```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE, type RouteTable, resolveUpstream } from "../route-table";

const table: RouteTable = {
  "/health": "py",
  "/api/sessions": "ts",
};

describe("resolveUpstream", () => {
  test("longest-prefix match wins", () => {
    expect(resolveUpstream("/health", table)).toBe("py");
    expect(resolveUpstream("/api/sessions/abc/events", table)).toBe("ts");
  });
  test("unknown path defaults to ts", () => {
    expect(resolveUpstream("/api/unknown", table)).toBe("ts");
  });
  test("a sibling path does not false-match a shorter prefix", () => {
    // "/healthcheck" must NOT match the "/health" group
    expect(resolveUpstream("/healthcheck", { "/health": "py" })).toBe("ts");
  });
});

describe("DEFAULT_TABLE", () => {
  test("health group is /health and routes to py", () => {
    expect(DEFAULT_TABLE["/health"]).toBe("py");
    expect(DEFAULT_TABLE["/api/health"]).toBeUndefined();
  });
  test("all /api/* groups still route to ts", () => {
    for (const [prefix, up] of Object.entries(DEFAULT_TABLE)) {
      if (prefix.startsWith("/api/")) expect(up).toBe("ts");
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/proxy && bun test src/__tests__/route-table.test.ts`
Expected: FAIL — `DEFAULT_TABLE["/health"]` is undefined and `DEFAULT_TABLE["/api/health"]` is still `"ts"` (M0 table used the wrong path).

- [ ] **Step 3: Correct the DEFAULT_TABLE**

Edit `packages/proxy/src/route-table.ts`. Replace the `DEFAULT_TABLE` definition with (note: `/api/health` removed, `/health` added as `"py"`; the TS server mounts health at `/health`, open, not under `/api`):
```ts
export const DEFAULT_TABLE: RouteTable = {
  "/health": "py",
  "/api/config": "ts",
  "/api/projects": "ts",
  "/api/files": "ts",
  "/api/grants": "ts",
  "/api/commands": "ts",
  "/api/sessions": "ts",
};
```
Leave `resolveUpstream` and the `Upstream`/`RouteTable` types unchanged.

- [ ] **Step 4: Run the proxy suite to verify it passes**

Run: `cd packages/proxy && bun test`
Expected: PASS — route-table tests green AND the existing forward/SSE tests (`proxy-forward.test.ts`) still pass (they construct their own tables and are unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/route-table.ts packages/proxy/src/__tests__/route-table.test.ts
git commit -m "fix(proxy): correct health route to /health and flip it to py upstream"
```

---

### Task 4: Cross-runtime end-to-end seam test (real Python behind the proxy)

**Files:**
- Create: `packages/proxy/src/__tests__/e2e-health.test.ts`

**Interfaces:**
- Consumes: `makeProxy` (from `../server`), the real `arclight_core.server.app:app` (Task 2) run under uvicorn, and `DEFAULT_TABLE` semantics (Task 3).
- Produces: an automated proof that a request for `/health` through the proxy is served by the real Python app, while `/api/*` reaches the TS upstream — with no production launch changes.

- [ ] **Step 1: Write the failing e2e test**

`packages/proxy/src/__tests__/e2e-health.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeProxy } from "../server";

// Boot the REAL Python health app under uvicorn on an ephemeral-but-fixed port,
// plus a fake TS upstream, and route through the real proxy handler.
const PY_PORT = 8791;
const repoRoot = new URL("../../../../", import.meta.url).pathname; // packages/proxy/src/__tests__ -> repo root

let py: ReturnType<typeof Bun.spawn> | undefined;
let tsUpstreamServer: ReturnType<typeof Bun.serve> | undefined;

async function waitForPython(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`python health server did not become ready at ${url}`);
}

beforeAll(async () => {
  py = Bun.spawn(
    [
      "conda", "run", "-n", "arclight",
      "python", "-m", "uvicorn",
      "arclight_core.server.app:app",
      "--port", String(PY_PORT),
      "--app-dir", "packages/core-py/src",
    ],
    { cwd: repoRoot, stdout: "ignore", stderr: "ignore" },
  );
  await waitForPython(`http://localhost:${PY_PORT}/health`);

  tsUpstreamServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/config") return Response.json({ via: "ts" });
      return new Response("nope", { status: 404 });
    },
  });
});

afterAll(() => {
  py?.kill();
  tsUpstreamServer?.stop(true);
});

describe("cross-runtime seam", () => {
  test("/health is served by the real Python app through the proxy", async () => {
    const proxy = makeProxy({
      table: { "/health": "py", "/api/config": "ts" },
      tsUpstream: `http://localhost:${tsUpstreamServer!.port}`,
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
    const res = await proxy(new Request("http://proxy/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("arclight-core"); // came from the Python app
  });

  test("/api/* still reaches the TS upstream through the proxy", async () => {
    const proxy = makeProxy({
      table: { "/health": "py", "/api/config": "ts" },
      tsUpstream: `http://localhost:${tsUpstreamServer!.port}`,
      pyUpstream: `http://localhost:${PY_PORT}`,
    });
    const res = await proxy(new Request("http://proxy/api/config"));
    expect(await res.json()).toEqual({ via: "ts" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails (then passes once wired)**

Run: `cd /mnt/data/fsm/project/arclightagent/arclight && bun test packages/proxy/src/__tests__/e2e-health.test.ts`
First run before Task 2/3 are present would fail; since they ARE present, this should PASS. Expected: 2 pass. If uvicorn fails to start, run the boot command manually to see the error:
`conda run -n arclight python -m uvicorn arclight_core.server.app:app --port 8791 --app-dir packages/core-py/src` then `curl localhost:8791/health`.

> If the cross-runtime spawn proves flaky in this environment (port races, uvicorn cold-start > 20s, or process teardown issues), DO NOT paper over it with retries that hide failures. Report DONE_WITH_CONCERNS describing the flakiness; the fallback is to deliver the same proof as a runnable script `packages/proxy/scripts/smoke-health.sh` (boot uvicorn, run proxy, curl, assert, teardown) plus the captured passing output in the report.

- [ ] **Step 3: Verify the proxy suite is green as a whole**

Run: `cd packages/proxy && bun test`
Expected: PASS — route-table, proxy-forward, and e2e-health suites all green.

- [ ] **Step 4: Commit**

```bash
git add packages/proxy/src/__tests__/e2e-health.test.ts
git commit -m "test(proxy): cross-runtime e2e — /health served by real Python through proxy"
```

---

## Self-Review

**1. Spec coverage (M1 slice-1 portion of spec §4.1 + §8 + terminal-review Issue 1):**
- Terminal-review Issue 1 (gate not in CI) → Task 1. ✓
- "Python Starlette server" + first low-risk endpoint (`/health`) → Task 2. ✓
- "反向代理实际接线，/health → Python，其余 → TS" → Task 3 (route correction + flip) + Task 4 (proves the proxy actually bridges to the real Python server). ✓
- "证明 web/cli 不受影响" → guaranteed by scope (proxy not in production path; `serve.ts`/web `baseUrl` untouched — Global Constraints + Scope note) and demonstrated transparency in Task 4. ✓
- Later groups (config, CRUD, sessions) explicitly deferred to their own slices (Scope note). ✓

**2. Placeholder scan:** No "TBD/handle errors/etc." The two `>`-quoted notes (Task 4 flakiness fallback) give a concrete fallback deliverable, not deferred work. All code blocks are complete.

**3. Type/contract consistency:** `create_app()` / module-level `app` (Task 2) match the uvicorn import path `arclight_core.server.app:app` used in Task 4. The health key set `{ok, service, version, uptimeMs}` is identical across the TS source, the Python handler, and the pytest assertion. `DEFAULT_TABLE`/`resolveUpstream`/`RouteTable` names match M0 and Task 3. `makeProxy({table, tsUpstream, pyUpstream})` signature in Task 4 matches the M0 `ProxyOpts`.

**Known residual risk (flagged, not a gap):** Task 4 is a cross-runtime (Bun spawning a Python uvicorn) test; its fallback to a smoke script is specified inline. Task 1's CI YAML can only be validated locally (parse + run the same commands); GitHub exercises it on push.
