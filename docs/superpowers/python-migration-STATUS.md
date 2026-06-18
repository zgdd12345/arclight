# Python Core Migration — STATUS

Living progress tracker for migrating `@arclight/core` (backend engine) from TS/Bun to Python via a strangler-fig.

**How to use:** update this file at the end of every slice (status table + delivered summary + carry-forward). It is the single "where are we" entry point. Per-slice task ledgers live in `.git/sdd/` (local, ephemeral, not committed) — this file is the durable summary.

**Design spec:** [`specs/2026-06-17-python-core-migration-design.md`](specs/2026-06-17-python-core-migration-design.md)

**Strategy (locked):** strangler-fig at the HTTP/SSE protocol boundary behind a reverse proxy; opensquilla (Apache-2.0) is reference + code donor, not a fork base. web/cli stay TS; the workflow engine stays JS as a permanent internal service. Python core rebuilt lean on arclight's own protocol + db schema.

---

## Roadmap & status

| Milestone | Scope | Status | Merge (master) | Plan |
|---|---|---|---|---|
| **M0** | Contract-first (zod→JSON Schema→pydantic) + golden fixtures + reverse-proxy seam (dormant) + Python/contract CI gates | ✅ **done** (2026-06-17) | `f676d4c` | [m0](plans/2026-06-17-python-core-migration-m0.md) |
| **M1 slice 1** | Wire gates into CI (conda) + Python Starlette `/health` (contract-matched) + proxy routes `/health`→Python + cross-runtime e2e | ✅ **done** (2026-06-18) | `751bf2f` | [m1-slice1](plans/2026-06-18-python-core-migration-m1-slice1.md) |
| **M1 slice 2** | Method-aware proxy + bearer-auth middleware + read-only `GET /api/projects` (workspaces read) + authed cross-runtime e2e | ✅ **done** (2026-06-18; +flake hotfix `e69d60d`) | `deb0478` | [m1-slice2](plans/2026-06-18-python-core-migration-m1-slice2.md) |
| **M1 slice 3** | Write-ownership transfer: **PATCH+DELETE** `/api/projects` → Python (first Python SQLite write layer, `foreign_keys ON` cascade, deterministic `ORDER BY rowid`, exact-match proxy routing). **POST deferred to M3.** | ✅ **done** (2026-06-18) | `97af0b3` | [m1-slice3](plans/2026-06-18-python-core-migration-m1-slice3.md) |
| **M1 slice 4** | Write-ownership transfer for `files`/`memories` groups | ▶ **next** | — | (to write) |
| **M2** | Model gateway (borrow opensquilla `provider/`, GLM OpenAI-compat) + Python tools execution shell + sandbox (subprocess + bwrap/seatbelt, no TTY) | ⏳ later | — | — |
| **M3** | `sessions`/loop + SSE (the heart): Python async-generator queryLoop, borrow engine submodules, epoch DB-trigger guard. **Also migrates `/api/config` + grants** (in-memory runtime, split-brain until the loop moves); **also migrates `POST /api/projects` (create) + `sessions.ts` `ensureWorkspace()`** — the two `workspaces` INSERT writers, co-migrated to restore strict one-writer-per-table for `workspaces`. | ⏳ later | — | — |
| **M4** | Extract `workflow/` into a standalone Bun service + cross-language RPC seam (`POST /internal/workflow/run` + SSE bubble) | ⏳ later | — | — |
| **M5** | Cut over default to Python core; remove TS core + proxy | ⏳ later | — | — |

Legend: ✅ done · ▶ next · ⏳ later

---

## Delivered so far

- **M0** — `packages/core-py` (conda env `arclight`, py3.12, pydantic v2); `packages/protocol` emits a JSON Schema bundle (`bun run emit-schema`) → generated pydantic models (`datamodel-codegen --disable-timestamp`); cross-language golden fixtures (zod ∥ pydantic); `packages/proxy` (Bun reverse proxy, route-group→upstream, dormant — not in the production launch path); `bun run check` runs `check:py` + `check:contract` drift gate; CI runs the gates via `setup-miniconda`.
- **M1 slice 1** — Python Starlette `GET /health` byte-matching the TS route; proxy route table corrected (TS mounts health at `/health`, not `/api/health`) and flips `/health`→Python; CI also runs `bun test packages/proxy`; cross-runtime e2e (real uvicorn behind the proxy, auto-skips when the `arclight` env is absent).
- **M1 slice 2** — method-aware proxy route table (`GET /api/projects`→Python, writes→TS); `BearerAuthMiddleware` (parity with TS loopback bearer: `/api/*` timing-safe token, 401 `{ok:false,code:"UNAUTHORIZED",message:"invalid token"}`, `/health` open, `ARCLIGHT_DEV_NO_AUTH` bypass) + `Settings` (env-loaded); read-only `GET /api/projects` reading the shared `workspaces` table (SELECT-only, missing-DB precheck so it never creates a phantom file) + TS `listAvailableDirs` parity; authed cross-runtime e2e; slice-1 e2e moved to dynamic ports.
- **M1 slice 3** — first Python SQLite write layer (`db.connect()`, `PRAGMA foreign_keys = ON`, `busy_timeout`); `PATCH /:id` rename (`workspaces.name`) and `DELETE /:id` unregister with FK cascade (sessions→turns) + fail-closed active-turn guard (409, verbatim CN message); deterministic `ORDER BY rowid` on GET (slice-2 carry-forward, resolved); exact-match proxy routing (`=`-prefixed keys) + latent slice-2 mis-route fixed (`GET /api/projects/:id/sessions` was being sent to Python, now correctly → TS). Cross-runtime e2e (5/5) proves PATCH/DELETE via real Python while `/sessions` + POST stay TS. Full Python suite green, proxy 23/23, `bun run check` clean. Independent codex review (mandatory task-end gate) caught a DELETE guard/delete TOCTOU the subagent + Opus reviews passed — fixed by wrapping the active-turn guard + delete in a single `BEGIN IMMEDIATE` txn (`db.connect` → `isolation_level=None`); also normalized a trailing-slash proxy mis-route. Re-review: PASS.

---

## Locked decisions

- **Adoption = reference + Apache-2.0 borrow, rebuild lean** (mode B). Not a fork of opensquilla (its WS-RPC transport is SSE-incompatible; it's a tightly-coupled monolith). Borrow MCP client / skills loader+injector / `provider/` / engine submodules / epoch DB-trigger / sandbox isolation.
- **web/cli stay TS, untouched**; the proxy is transparent and stays OUT of the production launch path until cut-over (seams proven by e2e).
- **workflow engine stays JS** (QuickJS) as a permanent internal Bun service over RPC — the one justified multi-language exception.
- **GLM via OpenAI-compatible endpoint** (bigmodel `/chat/completions`), per opensquilla `provider/`; the Anthropic-compat path is dropped for the Python core (TS core keeps it during the transition).
- **sandbox = subprocess + bwrap/seatbelt namespace isolation, no interactive TTY** (node-pty dropped; confirmed no TTY dependency).
- **db transition = single arclight SQLite, drizzle is sole migration authority, Python uses raw SQL, one-writer-language-per-table** (Python read-only until a group's writes transfer).
- **`/api/config` + `/api/.../grants` deferred to M3** — they read/write in-memory runtime state shared with the not-yet-migrated TS loop; migrating earlier would split-brain.

---

## Carry-forward (must address at the named point)

- **★ M3 HARD PREREQUISITE:** the Python auth uses Starlette `BaseHTTPMiddleware`, which **buffers responses and breaks SSE/`text/event-stream`**. It MUST be swapped to **pure ASGI middleware before the sessions/events (SSE) slice**, or streaming silently breaks.
- **M3:** until M3, `workspaces` has two INSERT writers — Python's `POST /api/projects` (create) was deliberately deferred (stays TS this whole milestone) and `sessions.ts` `ensureWorkspace()`; co-migrate both INSERT paths in M3 to restore strict one-writer-per-table for `workspaces`.
- **Cross-runtime e2e fragility (lesson):** suites that `conda run` uvicorn have ~5-7s cold start; the whole `bun test packages/proxy` run needs explicit generous hook timeouts (currently 60s) or hooks flake under contention and leak uvicorn. To clean a leaked uvicorn, kill by PID or `ps … | grep '[u]vicorn'` — **never `pkill -f "arclight_core.server.app"` from a shell whose own command contains that string (self-match → exit 144).**
- **Deferred minors (non-blocking):** auth empty-token-open when `ARCLIGHT_TOKEN` unset (parity with TS; prod always sets a token); `available` sort is codepoint order vs TS `localeCompare` (cosmetic picker ordering for mixed-case names).

---

## Pointers

- Background / earlier phases: workflow infra (阶段0b) + ToolSource (阶段0a) shipped pre-migration — see [`specs/2026-06-16-workflow-infrastructure-design.md`](specs/2026-06-16-workflow-infrastructure-design.md) and [`specs/2026-06-15-parallel-modules-quantum-design.md`](specs/2026-06-15-parallel-modules-quantum-design.md). The original "阶段1 MCP ∥ skills" is being subsumed by the Python migration's borrow plan.
- opensquilla reference checkout: `references/opensquilla` (Apache-2.0).
