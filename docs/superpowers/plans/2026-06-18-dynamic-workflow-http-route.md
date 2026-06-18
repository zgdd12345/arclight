# Dynamic Workflow HTTP Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing QuickJS JS-workflow engine over HTTP so a caller can run a dynamically-designed (or named/template) workflow, each run isolated in its own ephemeral session + turn.

**Architecture:** The agent-synthesizes-a-script capability already exists via the `run_workflow` tool (`script` param). This plan adds (1) a reusable `createWorkflowRunner` factory extracted from `serve.ts` so the `WorkflowContext` assembly is shared, (2) a `TemplateStore` + read-only template endpoints so a designing agent can fetch reference workflows, and (3) a `POST /api/workflows/run` route that creates an ephemeral session+turn per request and executes the workflow through the shared runner. Workflow lifecycle events stream to that ephemeral session's SSE via the existing `appendEvent` path.

**Tech Stack:** TypeScript, Hono (HTTP), Drizzle (SQLite), Bun test runner, QuickJS WASM workflow runtime (`packages/core/src/workflow`).

## Global Constraints

- Test runner for `packages/core`: **`bun test`** (test files import from `"bun:test"`). Run targeted tests with `bun test <path>`.
- TypeScript `exactOptionalPropertyTypes` is on — never pass `undefined` for an optional field; spread it conditionally (`...(x !== undefined ? { x } : {})`).
- Route convention (mirror `packages/core/src/server/routes/memories.ts`): `createXxxRoute(deps)` returns a `new Hono()`; success → `c.json({ ok: true, ... })`; failure → `c.json({ ok: false, code: "VALIDATION" | "NOT_FOUND", message }, <status>)`.
- All `/api/*` routes sit behind `bearerAuth`; tests pass `devNoAuth: true` to `createApp` to bypass.
- Workflow name slug rule (verbatim): `WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/`.
- `WorkflowResult` terminal vocabulary: `status: "completed" | "failed" | "interrupted"` (no `cancelled`).
- `turns.status` enum: `"queued" | "running" | "awaiting_approval" | "completed" | "failed" | "interrupted"`.
- `sessions.workspaceId` is a non-null FK to `workspaces.id` (cascade delete) — an ephemeral session MUST reference an existing workspace row.
- Commit message trailer (every commit): end with
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Gu3fCkKcwsz2BDPsK4z8Sq
  ```

---

## File Structure

- **Create** `packages/core/src/workflow/launch.ts` — `createWorkflowRunner(deps)` factory: assembles a `WorkflowContext` from a per-call `LoopToolContext` and returns the `launch(source, args, toolCtx)` closure. Single source of truth for `WorkflowContext` wiring (consumed by both `serve.ts` tool injection and the new route).
- **Create** `packages/core/src/workflow/template-store.ts` — `TemplateStore` class: read-only access to reference workflows under `.arclight/workflows/templates/`.
- **Create** `packages/core/src/server/workspace.ts` — `ensureWorkspace(db, repoPath, arclightDir)` shared helper (extracted from `sessions.ts` so both the sessions route and the new workflows route share one implementation, no duplication).
- **Create** `packages/core/src/server/routes/workflows.ts` — `createWorkflowsRoute(deps)`: `GET /templates`, `GET /templates/:name`, `POST /run`.
- **Create** `packages/core/src/workflow/__tests__/launch.test.ts` — unit test for the factory closure shape.
- **Create** `packages/core/src/workflow/__tests__/template-store.test.ts` — unit test for `TemplateStore`.
- **Create** `packages/core/src/server/__tests__/workflows.test.ts` — HTTP integration test for the route (stubbed runner).
- **Modify** `packages/core/src/server/routes/sessions.ts:33-45` — replace the in-closure `ensureWorkspace` with the shared helper.
- **Modify** `packages/core/src/serve.ts:80-126` — replace the inline `launchWorkflow` closure with `createWorkflowRunner(...)`; pass the runner + stores into `createApp`.
- **Modify** `packages/core/src/server/app.ts:22-36` (AppDeps) and `:138` (mount) — accept and mount the workflows route.
- **Modify** `packages/core/src/workflow/index.ts` — export `createWorkflowRunner`, `TemplateStore`.

---

## Task 1: Extract `createWorkflowRunner` factory (refactor, no behavior change)

**Files:**
- Create: `packages/core/src/workflow/launch.ts`
- Create (test): `packages/core/src/workflow/__tests__/launch.test.ts`
- Modify: `packages/core/src/serve.ts:80-106`
- Modify: `packages/core/src/workflow/index.ts`

**Interfaces:**
- Consumes: `runWorkflow` (`runtime.ts:435`), `appendEvent` (`db/appendEvent.ts:39`), `WorkflowContext` (`types.ts:158`), `LoopToolContext` (`loop/types.ts:74`), `WorkflowStore` (`store.ts:22`), `WorkflowJournalService` (`journal-service.ts:25`).
- Produces:
  ```typescript
  // packages/core/src/workflow/launch.ts
  export type WorkflowRunner = (
    source: string,
    args: Record<string, unknown>,
    toolCtx: LoopToolContext,
  ) => Promise<WorkflowResult>;

  export function createWorkflowRunner(deps: {
    db: Db;
    bus: EventBus;
    callProvider: WorkflowContext["callProvider"];
    registry: WorkflowContext["registry"];
    approvals: WorkflowContext["approvals"];
    executeTool: WorkflowContext["executeTool"];
    store: WorkflowStore;
    journal: WorkflowJournalService;
  }): WorkflowRunner;
  ```

- [ ] **Step 1: Write the failing test**

The factory's whole job is to map a per-call `LoopToolContext` onto a `WorkflowContext` (the bug-prone part: it is easy to cross `parentSessionId`/`parentTurnId` or drop `signal`). We assert that mapping by mocking the `runWorkflow` import and capturing the `ctx` it receives. `mock.module` must be set up before the dynamic `import("../launch")` so the factory binds the mock.

```typescript
// packages/core/src/workflow/__tests__/launch.test.ts
import { describe, expect, mock, test } from "bun:test";

describe("createWorkflowRunner", () => {
  test("maps the calling LoopToolContext onto the WorkflowContext", async () => {
    let captured: { source: string; args: unknown; ctx: Record<string, unknown> } | undefined;
    mock.module("../runtime", () => ({
      runWorkflow: async (source: string, args: unknown, ctx: Record<string, unknown>) => {
        captured = { source, args, ctx };
        return { status: "completed", output: { ok: 1 } };
      },
    }));
    const { createWorkflowRunner } = await import("../launch");

    const callProvider = (async () => ({})) as never;
    const registry = { kind: "registry" } as never;
    const approvals = { kind: "approvals" } as never;
    const executeTool = (async () => ({ ok: true })) as never;
    const store = { kind: "store" } as never;
    const journal = { kind: "journal" } as never;
    const runner = createWorkflowRunner({
      db: { kind: "db" } as never,
      bus: { kind: "bus" } as never,
      callProvider,
      registry,
      approvals,
      executeTool,
      store,
      journal,
    });

    const signal = new AbortController().signal;
    const toolCtx = {
      sessionId: "S",
      turnId: "T",
      callId: "C",
      cwd: "/repo",
      signal,
      emitProgress: () => {},
    };
    const res = await runner("agent('x')", { seed: 1 }, toolCtx as never);

    expect(res).toEqual({ status: "completed", output: { ok: 1 } });
    expect(captured?.source).toBe("agent('x')");
    expect(captured?.args).toEqual({ seed: 1 });
    // parent identity comes from the calling toolCtx (not crossed)
    expect(captured?.ctx.parentSessionId).toBe("S");
    expect(captured?.ctx.parentTurnId).toBe("T");
    expect(captured?.ctx.cwd).toBe("/repo");
    expect(captured?.ctx.signal).toBe(signal);
    // run dependencies come from the factory deps
    expect(captured?.ctx.callProvider).toBe(callProvider);
    expect(captured?.ctx.registry).toBe(registry);
    expect(captured?.ctx.approvals).toBe(approvals);
    expect(captured?.ctx.executeTool).toBe(executeTool);
    expect(captured?.ctx.store).toBe(store);
    expect(captured?.ctx.journal).toBe(journal);
    expect(typeof captured?.ctx.emit).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/workflow/__tests__/launch.test.ts`
Expected: FAIL — `Cannot find module "../launch"`.

- [ ] **Step 3: Write the factory**

```typescript
// packages/core/src/workflow/launch.ts
import { appendEvent } from "../db/appendEvent";
import type { Db } from "../db/client";
import type { EventBus } from "../events/bus";
import type { LoopToolContext } from "../loop/types";
import { runWorkflow } from "./runtime";
import type { WorkflowJournalService } from "./journal-service";
import type { WorkflowStore } from "./store";
import type { WorkflowContext, WorkflowResult } from "./types";

/** Per-call launch seam: builds a WorkflowContext from the calling LoopToolContext
 *  (parent session/turn/cwd/signal) and runs the workflow. Events bind to the parent
 *  session via appendEvent → main SSE stream (spec §8). Shared by serve.ts tool
 *  injection and the HTTP /api/workflows/run route so the context assembly never drifts. */
export type WorkflowRunner = (
  source: string,
  args: Record<string, unknown>,
  toolCtx: LoopToolContext,
) => Promise<WorkflowResult>;

export function createWorkflowRunner(deps: {
  db: Db;
  bus: EventBus;
  callProvider: WorkflowContext["callProvider"];
  registry: WorkflowContext["registry"];
  approvals: WorkflowContext["approvals"];
  executeTool: WorkflowContext["executeTool"];
  store: WorkflowStore;
  journal: WorkflowJournalService;
}): WorkflowRunner {
  return (source, args, toolCtx) =>
    runWorkflow(source, args, {
      parentSessionId: toolCtx.sessionId,
      parentTurnId: toolCtx.turnId,
      cwd: toolCtx.cwd,
      signal: toolCtx.signal,
      callProvider: deps.callProvider,
      registry: deps.registry,
      approvals: deps.approvals,
      executeTool: deps.executeTool,
      emit: (draft) => appendEvent({ db: deps.db, bus: deps.bus }, draft),
      store: deps.store,
      journal: deps.journal,
    });
}
```

- [ ] **Step 4: Export from the workflow barrel**

In `packages/core/src/workflow/index.ts`, add alongside the existing exports:

```typescript
export { createWorkflowRunner, type WorkflowRunner } from "./launch";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/src/workflow/__tests__/launch.test.ts`
Expected: PASS.

- [ ] **Step 6: Replace the inline closure in `serve.ts`**

In `packages/core/src/serve.ts`, replace the `launchWorkflow` block at lines 88-106:

```typescript
  // per-call 启动接缝：据本次 run_workflow 调用的 LoopToolContext 装 WorkflowContext 并 runWorkflow。
  const launchWorkflow = (
    source: string,
    args: Record<string, unknown>,
    toolCtx: import("./loop/types").LoopToolContext,
  ) =>
    runWorkflow(source, args, {
      parentSessionId: toolCtx.sessionId,
      parentTurnId: toolCtx.turnId,
      cwd: toolCtx.cwd,
      signal: toolCtx.signal,
      callProvider: providerManager.callProvider,
      registry,
      approvals,
      executeTool: subagentExecuteTool,
      emit: (draft) => appendEvent({ db, bus }, draft),
      store: workflowStore,
      journal: workflowJournal,
    });
```

with:

```typescript
  // per-call 启动接缝（createWorkflowRunner，workflow/launch.ts）：tool 注入与 HTTP route 共用同一 WorkflowContext 装配。
  const launchWorkflow = createWorkflowRunner({
    db,
    bus,
    callProvider: providerManager.callProvider,
    registry,
    approvals,
    executeTool: subagentExecuteTool,
    store: workflowStore,
    journal: workflowJournal,
  });
```

Then add `createWorkflowRunner` to the existing `@arclight/core`-internal workflow import in `serve.ts` (the line that imports `runWorkflow`, `WorkflowStore`, etc. from `"./workflow"`). If `runWorkflow` is now unused in `serve.ts`, drop it from that import.

- [ ] **Step 7: Run the existing workflow + serve suites to confirm no behavior change**

Run: `bun test packages/core/src/workflow packages/core/src/server`
Expected: PASS (all pre-existing tests green — this task is behavior-preserving).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/workflow/launch.ts \
        packages/core/src/workflow/__tests__/launch.test.ts \
        packages/core/src/workflow/index.ts \
        packages/core/src/serve.ts
git commit -m "refactor(workflow): extract createWorkflowRunner factory from serve

Shared WorkflowContext assembly for the run_workflow tool and the upcoming
HTTP route. No behavior change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Gu3fCkKcwsz2BDPsK4z8Sq"
```

---

## Task 2: `TemplateStore` (read-only reference workflows)

**Files:**
- Create: `packages/core/src/workflow/template-store.ts`
- Create (test): `packages/core/src/workflow/__tests__/template-store.test.ts`
- Modify: `packages/core/src/workflow/index.ts`

**Interfaces:**
- Consumes: `WORKFLOW_NAME_RE` (`store.ts:18`), Node `fs`.
- Produces:
  ```typescript
  export type WorkflowTemplate = { name: string; source: string };
  export class TemplateStore {
    constructor(arclightDir: string); // reads <arclightDir>/workflows/templates
    list(): string[];                 // template names (slug), sorted
    has(name: string): boolean;
    load(name: string): WorkflowTemplate; // throws "no such template: <name>" if missing
  }
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/workflow/__tests__/template-store.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TemplateStore } from "../template-store";

describe("TemplateStore", () => {
  let arclightDir: string;
  let templatesDir: string;

  beforeEach(() => {
    arclightDir = mkdtempSync(join(tmpdir(), "arclight-tmpl-"));
    templatesDir = join(arclightDir, "workflows", "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "fanout-review.workflow.js"), "const r = agent('x'); r;", "utf8");
    writeFileSync(join(templatesDir, "two-stage.workflow.js"), "phase('a'); agent('b');", "utf8");
  });
  afterEach(() => rmSync(arclightDir, { recursive: true, force: true }));

  test("list returns sorted template names without suffix", () => {
    const store = new TemplateStore(arclightDir);
    expect(store.list()).toEqual(["fanout-review", "two-stage"]);
  });

  test("load returns name + source", () => {
    const store = new TemplateStore(arclightDir);
    expect(store.load("fanout-review")).toEqual({
      name: "fanout-review",
      source: "const r = agent('x'); r;",
    });
  });

  test("has is false for missing or invalid names", () => {
    const store = new TemplateStore(arclightDir);
    expect(store.has("two-stage")).toBe(true);
    expect(store.has("missing")).toBe(false);
    expect(store.has("Bad Name")).toBe(false);
  });

  test("load throws for a missing template", () => {
    const store = new TemplateStore(arclightDir);
    expect(() => store.load("missing")).toThrow("no such template: missing");
  });

  test("list returns [] when templates dir does not exist", () => {
    const empty = mkdtempSync(join(tmpdir(), "arclight-empty-"));
    expect(new TemplateStore(empty).list()).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/workflow/__tests__/template-store.test.ts`
Expected: FAIL — `Cannot find module "../template-store"`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/workflow/template-store.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_NAME_RE } from "./store";

const SUFFIX = ".workflow.js";

export type WorkflowTemplate = { name: string; source: string };

/** Read-only reference workflows shipped under <arclightDir>/workflows/templates/.
 *  Surfaced to a designing agent so it can model a new dynamic workflow on a known-good
 *  shape. Distinct from WorkflowStore (which holds runnable saved workflows). */
export class TemplateStore {
  private readonly dir: string;

  constructor(arclightDir: string) {
    this.dir = join(arclightDir, "workflows", "templates");
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(SUFFIX))
      .map((f) => f.slice(0, -SUFFIX.length))
      .filter((n) => WORKFLOW_NAME_RE.test(n))
      .sort();
  }

  has(name: string): boolean {
    if (!WORKFLOW_NAME_RE.test(name)) return false;
    return existsSync(join(this.dir, `${name}${SUFFIX}`));
  }

  load(name: string): WorkflowTemplate {
    if (!WORKFLOW_NAME_RE.test(name)) throw new Error(`no such template: ${name}`);
    const path = join(this.dir, `${name}${SUFFIX}`);
    if (!existsSync(path)) throw new Error(`no such template: ${name}`);
    return { name, source: readFileSync(path, "utf8") };
  }
}
```

- [ ] **Step 4: Export from the workflow barrel**

In `packages/core/src/workflow/index.ts`, add:

```typescript
export { TemplateStore, type WorkflowTemplate } from "./template-store";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/src/workflow/__tests__/template-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workflow/template-store.ts \
        packages/core/src/workflow/__tests__/template-store.test.ts \
        packages/core/src/workflow/index.ts
git commit -m "feat(workflow): TemplateStore for reference workflows

Read-only access to .arclight/workflows/templates/*.workflow.js so a
designing agent can fetch known-good workflow shapes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Gu3fCkKcwsz2BDPsK4z8Sq"
```

---

## Task 3: Extract shared `ensureWorkspace` helper

**Files:**
- Create: `packages/core/src/server/workspace.ts`
- Create (test): `packages/core/src/server/__tests__/workspace.test.ts`
- Modify: `packages/core/src/server/routes/sessions.ts:33-45,68`

**Interfaces:**
- Consumes: Drizzle table `workspaces` (`db/schema.ts`), `Db` (`db/client.ts`).
- Produces:
  ```typescript
  // packages/core/src/server/workspace.ts
  export function ensureWorkspace(db: Db, repoPath: string, arclightDir: string): string;
  // returns the id of the existing workspace whose repoPath matches, else inserts and returns a new id
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/server/__tests__/workspace.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { workspaces } from "../../db/schema";
import { ensureWorkspace } from "../workspace";

describe("ensureWorkspace", () => {
  let dir: string;
  let conn: ReturnType<typeof createDb>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arclight-ws-"));
    const arclightDir = join(dir, ".arclight");
    const { dbPath } = runMigrations(arclightDir);
    conn = createDb(dbPath);
  });
  afterEach(() => {
    conn.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("inserts a workspace row on first call, returns its id", () => {
    const arclightDir = join(dir, ".arclight");
    const id = ensureWorkspace(conn.db, dir, arclightDir);
    const row = conn.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    expect(row?.repoPath).toBe(dir);
  });

  test("is idempotent — same repoPath returns the same id", () => {
    const arclightDir = join(dir, ".arclight");
    const a = ensureWorkspace(conn.db, dir, arclightDir);
    const b = ensureWorkspace(conn.db, dir, arclightDir);
    expect(b).toBe(a);
    expect(conn.db.select().from(workspaces).all()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/server/__tests__/workspace.test.ts`
Expected: FAIL — `Cannot find module "../workspace"`.

- [ ] **Step 3: Write the helper**

```typescript
// packages/core/src/server/workspace.ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { workspaces } from "../db/schema";

/** 默认工作区兜底：按 repoPath 查现有 workspace 行，缺则插入并返回新 id。
 *  会话（含工作流临时会话）的 workspaceId 是非空 FK，须挂到存在的 workspace 行。 */
export function ensureWorkspace(db: Db, repoPath: string, arclightDir: string): string {
  const existing = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.repoPath, repoPath))
    .get();
  if (existing) return existing.id;
  const id = randomUUID();
  db.insert(workspaces)
    .values({ id, name: repoPath.split("/").at(-1) ?? "repo", repoPath, arclightDir })
    .run();
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/server/__tests__/workspace.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `sessions.ts` to use the shared helper**

In `packages/core/src/server/routes/sessions.ts`, delete the local `ensureWorkspace` closure (lines 33-45) and add an import at the top:

```typescript
import { ensureWorkspace } from "../workspace";
```

Then change the only call site (line 68) from `ensureWorkspace()` to `ensureWorkspace(db, repoPath, arclightDir)`. Note `repoPath` and `arclightDir` are already destructured from `deps` at line 30.

- [ ] **Step 6: Run the sessions suite to confirm no behavior change**

Run: `bun test packages/core/src/server`
Expected: PASS (sessions route tests green — refactor is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/server/workspace.ts \
        packages/core/src/server/__tests__/workspace.test.ts \
        packages/core/src/server/routes/sessions.ts
git commit -m "refactor(server): extract shared ensureWorkspace helper

Shared by the sessions route and the upcoming workflows route so the
default-workspace fallback has one implementation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Gu3fCkKcwsz2BDPsK4z8Sq"
```

---

## Task 4: `createWorkflowsRoute` — ephemeral-session HTTP route

**Files:**
- Create: `packages/core/src/server/routes/workflows.ts`
- Create (test): `packages/core/src/server/__tests__/workflows.test.ts`

**Interfaces:**
- Consumes: `WorkflowRunner` (Task 1), `TemplateStore` (Task 2), `ensureWorkspace` (Task 3), `WorkflowStore` (`store.ts:22`), `resolveWorkflowSource` + `WORKFLOW_NAME_RE` (`store.ts`), `LoopToolContext` (`loop/types.ts:74`), Drizzle tables `sessions`, `turns` (`db/schema.ts`), `Db` (`db/client.ts`).
- Produces:
  ```typescript
  export function createWorkflowsRoute(deps: {
    db: Db;
    repoPath: string;
    arclightDir: string;
    run: WorkflowRunner;
    store: WorkflowStore;
    templates: TemplateStore;
  }): Hono;
  ```
  Routes (all under the mount prefix `/api/workflows`):
  - `GET /templates` → `{ ok: true, templates: string[] }`
  - `GET /templates/:name` → `{ ok: true, name, source }` | `404 { ok:false, code:"NOT_FOUND" }`
  - `POST /run` body `{ script?: string; name?: string; args?: Record<string,unknown>; saveAs?: string }` → `{ ok: true, status, output?, error?, sessionId, turnId }` | `400 VALIDATION`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/server/__tests__/workflows.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, turns } from "../../db/schema";
import { EventBus } from "../../events/bus";
import { TemplateStore, WorkflowStore } from "../../workflow";
import type { WorkflowRunner } from "../../workflow";
import { createWorkflowsRoute } from "../routes/workflows";
import { Hono } from "hono";

describe("workflows route (HTTP)", () => {
  let dir: string;
  let arclightDir: string;
  let conn: ReturnType<typeof createDb>;
  let app: Hono;
  let runCalls: Array<{ source: string; args: unknown; sessionId: string; turnId: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arclight-wf-"));
    arclightDir = join(dir, ".arclight");
    const { dbPath } = runMigrations(arclightDir);
    conn = createDb(dbPath);
    runCalls = [];
    // Stub runner: record args, return a canned terminal result (no real provider).
    const run: WorkflowRunner = async (source, args, toolCtx) => {
      runCalls.push({ source, args, sessionId: toolCtx.sessionId, turnId: toolCtx.turnId });
      return { status: "completed", output: { ran: true } };
    };
    const templatesDir = join(arclightDir, "workflows", "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "seed.workflow.js"), "agent('hi');", "utf8");

    const route = createWorkflowsRoute({
      db: conn.db,
      repoPath: dir,
      arclightDir,
      run,
      store: new WorkflowStore(arclightDir),
      templates: new TemplateStore(arclightDir),
    });
    app = new Hono();
    app.route("/api/workflows", route);
  });
  afterEach(() => {
    conn.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("GET /templates lists template names", async () => {
    const res = await app.fetch(new Request("http://x/api/workflows/templates"));
    const body = (await res.json()) as { ok: boolean; templates: string[] };
    expect(res.status).toBe(200);
    expect(body.templates).toEqual(["seed"]);
  });

  test("GET /templates/:name returns source; 404 when missing", async () => {
    const ok = await app.fetch(new Request("http://x/api/workflows/templates/seed"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).source).toBe("agent('hi');");
    const miss = await app.fetch(new Request("http://x/api/workflows/templates/nope"));
    expect(miss.status).toBe(404);
  });

  test("POST /run with inline script: ephemeral session+turn, runner invoked, turn completed", async () => {
    const res = await app.fetch(
      new Request("http://x/api/workflows/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "agent('do work');", args: { seed: 1 } }),
      }),
    );
    const body = (await res.json()) as {
      ok: boolean; status: string; output: unknown; sessionId: string; turnId: string;
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("completed");
    expect(body.output).toEqual({ ran: true });

    // runner saw the inline source + the ephemeral ids
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.source).toBe("agent('do work');");
    expect(runCalls[0]?.args).toEqual({ seed: 1 });
    expect(runCalls[0]?.sessionId).toBe(body.sessionId);

    // session + turn rows exist; turn moved to completed
    const sess = conn.db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get();
    expect(sess).toBeDefined();
    const turn = conn.db.select().from(turns).where(eq(turns.id, body.turnId)).get();
    expect(turn?.status).toBe("completed");
  });

  test("POST /run rejects when neither script nor name given", async () => {
    const res = await app.fetch(
      new Request("http://x/api/workflows/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: {} }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION");
  });

  test("POST /run rejects when both script and name given", async () => {
    const res = await app.fetch(
      new Request("http://x/api/workflows/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "agent('x');", name: "seed" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/server/__tests__/workflows.test.ts`
Expected: FAIL — `Cannot find module "../routes/workflows"`.

- [ ] **Step 3: Write the route**

```typescript
// packages/core/src/server/routes/workflows.ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { sessions, turns } from "../../db/schema";
import type { LoopToolContext } from "../../loop/types";
import { resolveWorkflowSource, WORKFLOW_NAME_RE } from "../../workflow";
import type { TemplateStore, WorkflowRunner, WorkflowStore } from "../../workflow";
import { ensureWorkspace } from "../workspace";

type RunBody = {
  script?: string;
  name?: string;
  args?: Record<string, unknown>;
  saveAs?: string;
};

// turns.status 终态 ← WorkflowResult.status（词表对齐，无 cancelled）。
const TERMINAL = { completed: "completed", failed: "failed", interrupted: "interrupted" } as const;

export function createWorkflowsRoute(deps: {
  db: Db;
  repoPath: string;
  arclightDir: string;
  run: WorkflowRunner;
  store: WorkflowStore;
  templates: TemplateStore;
}) {
  const { db, repoPath, arclightDir, run, store, templates } = deps;

  return new Hono()
    .get("/templates", (c) => c.json({ ok: true, templates: templates.list() }))
    .get("/templates/:name", (c) => {
      const name = c.req.param("name");
      if (!templates.has(name)) return c.json({ ok: false, code: "NOT_FOUND" }, 404);
      const t = templates.load(name);
      return c.json({ ok: true, name: t.name, source: t.source });
    })
    .post("/run", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as RunBody;

      // 恰好二选一（对齐 run_workflow 工具）。
      if ((body.script === undefined) === (body.name === undefined)) {
        return c.json(
          { ok: false, code: "VALIDATION", message: "provide exactly one of `script` or `name`" },
          400,
        );
      }
      if (body.saveAs !== undefined && body.script === undefined) {
        return c.json({ ok: false, code: "VALIDATION", message: "`saveAs` requires `script`" }, 400);
      }
      if (body.name !== undefined && !WORKFLOW_NAME_RE.test(body.name)) {
        return c.json({ ok: false, code: "VALIDATION", message: "invalid workflow name" }, 400);
      }

      // 解析源码：script 直用（saveAs 则持久化）；name 经 store 收口（不存在→VALIDATION）。
      let source: string;
      try {
        if (body.script !== undefined) {
          if (body.saveAs !== undefined) store.save(body.saveAs, body.script);
          source = body.script;
        } else {
          source = resolveWorkflowSource(body.name as string, store);
        }
      } catch (e) {
        return c.json(
          { ok: false, code: "VALIDATION", message: e instanceof Error ? e.message : "invalid request" },
          400,
        );
      }

      // 每次请求自建临时会话+turn：工作流独立于任何聊天会话；事件经 appendEvent 落该会话 SSE。
      const sessionId = randomUUID();
      const turnId = randomUUID();
      const workspaceId = ensureWorkspace(db, repoPath, arclightDir);
      db.insert(sessions).values({ id: sessionId, workspaceId, title: `workflow:${turnId}` }).run();
      db.insert(turns)
        .values({
          id: turnId,
          sessionId,
          commandId: randomUUID(),
          status: "running",
          input: { script: body.script, name: body.name, args: body.args ?? {} },
          startedAt: new Date(),
        })
        .run();

      // HTTP 触发无 turn 上下文：自造 LoopToolContext。无中断端点（v1），signal 仅占位。
      const ac = new AbortController();
      const toolCtx: LoopToolContext = {
        sessionId,
        turnId,
        callId: randomUUID(),
        cwd: repoPath,
        signal: ac.signal,
        emitProgress: () => {},
      };

      try {
        const result = await run(source, body.args ?? {}, toolCtx);
        db.update(turns)
          .set({ status: TERMINAL[result.status], completedAt: new Date() })
          .where(eq(turns.id, turnId))
          .run();
        return c.json({
          ok: result.status === "completed",
          status: result.status,
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
          sessionId,
          turnId,
        });
      } catch (e) {
        db.update(turns).set({ status: "failed", completedAt: new Date() }).where(eq(turns.id, turnId)).run();
        return c.json(
          { ok: false, code: "INTERNAL", message: e instanceof Error ? e.message : "workflow run failed", sessionId, turnId },
          500,
        );
      }
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/server/__tests__/workflows.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/server/routes/workflows.ts \
        packages/core/src/server/__tests__/workflows.test.ts
git commit -m "feat(server): POST /api/workflows/run with ephemeral session+turn

GET /templates[/:name] for reference workflows; POST /run creates a
dedicated session+turn per request and executes via the shared runner.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Gu3fCkKcwsz2BDPsK4z8Sq"
```

---

## Task 5: Wire the route into `createApp` + `serve.ts`

**Files:**
- Modify: `packages/core/src/server/app.ts:22-36` (AppDeps), `:11-20` (imports), `:138` (mount)
- Modify: `packages/core/src/serve.ts:80-147`
- Modify (test): `packages/core/src/server/__tests__/workflows.test.ts` — add one end-to-end assertion through `createApp` with `devNoAuth`.

**Interfaces:**
- Consumes: `createWorkflowsRoute` (Task 4), `WorkflowRunner` (Task 1), `WorkflowStore`/`TemplateStore` (Task 2), existing `createApp` deps.
- Produces: `/api/workflows/*` reachable on the live server; `AppDeps` gains optional `workflowRunner`, `workflowStore`, `templateStore`.

- [ ] **Step 1: Write the failing test (route reachable through createApp + auth)**

Append to `packages/core/src/server/__tests__/workflows.test.ts`:

```typescript
describe("workflows route via createApp", () => {
  test("mounted under /api with bearer auth bypassed by devNoAuth", async () => {
    const { createApp } = await import("../app");
    const dir = mkdtempSync(join(tmpdir(), "arclight-wfapp-"));
    const arclightDir = join(dir, ".arclight");
    const { dbPath } = runMigrations(arclightDir);
    const conn = createDb(dbPath);
    const run: WorkflowRunner = async () => ({ status: "completed", output: 1 });
    const app = createApp({
      repoPath: dir,
      arclightDir,
      db: conn.db,
      bus: new EventBus(),
      token: "t",
      devNoAuth: true,
      workflowRunner: run,
      workflowStore: new WorkflowStore(arclightDir),
      templateStore: new TemplateStore(arclightDir),
    });
    const res = await app.fetch(new Request("http://x/api/workflows/templates"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    conn.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/server/__tests__/workflows.test.ts`
Expected: FAIL — `createApp` does not accept `workflowRunner` / route not mounted (404 on `/api/workflows/templates`).

- [ ] **Step 3: Extend `AppDeps` and mount the route in `app.ts`**

Add the import near the other route imports (after line 20):

```typescript
import { createWorkflowsRoute } from "./routes/workflows";
import type { WorkflowRunner } from "../workflow";
import type { TemplateStore, WorkflowStore } from "../workflow";
```

Add to the `AppDeps` type (inside the `{ ... }` ending at line 36):

```typescript
  workflowRunner?: WorkflowRunner; // 动态工作流 HTTP 入口（serve 注入；缺省不挂 /api/workflows）
  workflowStore?: WorkflowStore;
  templateStore?: TemplateStore;
```

Mount the route inside `createApp`, after the memories route (line 138), guarded on all three deps being present:

```typescript
  if (deps.workflowRunner && deps.workflowStore && deps.templateStore) {
    api.route(
      "/workflows",
      createWorkflowsRoute({
        db: deps.db,
        repoPath: deps.repoPath,
        arclightDir: deps.arclightDir,
        run: deps.workflowRunner,
        store: deps.workflowStore,
        templates: deps.templateStore,
      }),
    );
  }
```

- [ ] **Step 4: Inject the deps in `serve.ts`**

In `packages/core/src/serve.ts`, construct the `TemplateStore` next to `workflowStore` (after line 81):

```typescript
  const templateStore = new TemplateStore(arclightDir);
```

Add `TemplateStore` to the `"./workflow"` import. Then extend the `createApp({ ... })` call (lines 135-147) with:

```typescript
    workflowRunner: launchWorkflow,
    workflowStore,
    templateStore,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/src/server/__tests__/workflows.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full core server + workflow suites**

Run: `bun test packages/core/src/server packages/core/src/workflow`
Expected: PASS (no regressions).

- [ ] **Step 7: Typecheck**

Run: `bunx tsc --noEmit -p packages/core/tsconfig.json` (or the repo's typecheck script if different — check `packages/core/package.json`).
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/server/app.ts \
        packages/core/src/serve.ts \
        packages/core/src/server/__tests__/workflows.test.ts
git commit -m "feat(server): mount /api/workflows and inject runner/stores in serve

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Gu3fCkKcwsz2BDPsK4z8Sq"
```

---

## Self-Review

**1. Spec coverage** (against the clarified requirements):
- "HTTP route triggers a workflow" → Task 4 `POST /api/workflows/run` + Task 5 mount. ✓
- "Route creates an ephemeral session" → Task 4 inserts `sessions` + `turns` rows per request, ensures workspace FK via the Task 3 helper. ✓
- "Agent designs the workflow dynamically (inline script)" → `POST /run` accepts `script`; reuses existing inline-source path. ✓
- "Templates for the agent to reference" → Task 2 `TemplateStore` + Task 4 `GET /templates[/:name]`. ✓
- "Don't duplicate WorkflowContext wiring" → Task 1 `createWorkflowRunner` shared by tool + route. ✓
- "Don't duplicate the workspace-FK fallback" → Task 3 `ensureWorkspace` shared by sessions + workflows routes. ✓
- Named/saved workflow execution + `saveAs` persistence → `POST /run` `name`/`saveAs`. ✓

**2. Placeholder scan:** No `TBD`/"handle errors appropriately"/"similar to". Every code step is complete and copy-paste ready. ✓

**3. Type consistency:**
- `WorkflowRunner = (source, args, toolCtx) => Promise<WorkflowResult>` defined in Task 1, consumed identically in Tasks 4 and 5. ✓
- `ensureWorkspace(db, repoPath, arclightDir): string` defined in Task 3, called with the same arg order in Task 3's `sessions.ts` refactor and Task 4's route. ✓
- `createWorkflowsRoute` deps `{ db, repoPath, arclightDir, run, store, templates }` — same field names in Task 4 definition, Task 4 test, and Task 5 mount. ✓
- `TERMINAL` maps `WorkflowResult.status` ("completed"|"failed"|"interrupted") onto the `turns.status` enum — both vocabularies verified against `db/schema.ts` and `types.ts`. ✓
- `LoopToolContext` fields (`sessionId, turnId, callId, cwd, signal, emitProgress`) match `loop/types.ts:74` exactly. ✓

**Known v1 scope cuts (intentional, YAGNI — flag to reviewer):**
- No interrupt/abort endpoint; the `AbortController` is a placeholder (workflows still honor their own internal timeouts/budgets).
- Ephemeral sessions are not auto-deleted — kept so emitted events remain inspectable. A reaper/TTL is a follow-up if they accumulate.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-18-dynamic-workflow-http-route.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
