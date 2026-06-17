# Python Core Migration — M0: Contract-First + Reverse-Proxy Seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the enabling foundation for the TS→Python strangler migration: a language-neutral protocol contract (zod→JSON Schema→pydantic) gated by cross-language golden fixtures, plus a reverse-proxy seam in front of `/api/*` that route-groups all traffic to the existing TS core today and can flip groups to a Python core later.

**Architecture:** `@arclight/protocol` (zod v4, single source of truth) emits a JSON Schema bundle; a new Python package `packages/core-py/` generates pydantic v2 models from that bundle. Shared JSON fixtures are validated by BOTH zod (TS) and pydantic (Python) — the contract gate. A new `packages/proxy/` (Bun) sits in front of `/api/*`, reads a route-group→upstream table (all → TS core at M0), and forwards requests including SSE streams.

**Tech Stack:** TypeScript/Bun, zod v4 (`z.toJSONSchema`), Python 3.12 in a dedicated conda env `arclight`, pydantic v2, `datamodel-code-generator`, pytest, Starlette (later milestones), `bun test`.

## Global Constraints

- **web/cli unchanged**: `@arclight/web`, `@arclight/cli`, `@arclight/client-core` stay TS and untouched; they call `baseUrl + /api/*` (+ SSE) via `packages/web/src/lib/arcClient.ts`. The proxy must be transparent to them.
- **workflow stays JS**: do not port `packages/core/src/workflow/`. Out of scope for all migration milestones.
- **Protocol single source of truth = zod in `@arclight/protocol`**. Python models are GENERATED, never hand-edited. JSON Schema bundle is a build artifact.
- **zod `^4.0.0`** (already pinned in `packages/protocol/package.json`); **pydantic `>=2`**; **Python `>=3.12`**; **Starlette `>=0.40`** (matches opensquilla, used from M2).
- **Python env = dedicated conda env `arclight`** (Python 3.12, already created by the controller with `pydantic pytest datamodel-code-generator ruff` installed). Run every Python command via `conda run -n arclight <cmd>`. There is NO `uv` in this environment — do not call `uv`. The package needs no install step: `packages/core-py/pyproject.toml` sets `[tool.pytest.ini_options] pythonpath = ["src"]`, so `conda run -n arclight python -m pytest` from `packages/core-py` imports `arclight_core` directly.
- **GLM via OpenAI-compatible endpoint** (bigmodel `/chat/completions`) — relevant from M2; no LLM calls in M0.
- **sandbox = subprocess + namespace isolation, no interactive TTY** — relevant from M2.
- **db transition = single arclight SQLite, drizzle is sole migration authority, Python uses raw SQL, one-writer-language-per-table** — relevant from M3.
- **Apache-2.0 attribution**: any code borrowed from `references/opensquilla` must retain its license header and be recorded in a repo `NOTICE`/`ATTRIBUTION` file. (No borrowing in M0.)
- **Frequent commits**: one commit per task minimum. Run `bun run check` before any TS commit.

---

## Milestone Decomposition (context — only M0 is planned in this doc)

| Plan | Milestone | Deliverable |
|---|---|---|
| **this doc** | **M0** | Language-neutral contract + codegen + golden fixtures + reverse-proxy seam (all → TS) |
| later | M1 | Leaf CRUD route-groups (`health→config→projects/files/grants/commands`) reimplemented in Python core, flipped one group at a time |
| later | M2 | Model gateway (borrow opensquilla `provider/`, GLM OpenAI-compat) + Python tools execution shell + sandbox (subprocess + bwrap/seatbelt) |
| later | M3 | `sessions`/loop + SSE (the heart): Python async-generator queryLoop, borrow engine submodules, epoch DB-trigger guard |
| later | M4 | Extract `workflow/` into standalone Bun service + cross-language RPC seam (`POST /internal/workflow/run` + SSE bubble) |
| later | M5 | Cut over default to Python core, remove TS core + proxy |

Each subsequent milestone gets its own plan written when its predecessor completes.

---

## File Structure (M0)

**Created:**
- `packages/protocol/scripts/emit-json-schema.ts` — emits the JSON Schema bundle from exported zod schemas.
- `packages/protocol/schema/arclight-protocol.schema.json` — generated bundle (committed artifact).
- `packages/protocol/fixtures/*.json` — shared cross-language golden fixtures.
- `packages/protocol/src/__tests__/json-schema-emit.test.ts` — asserts bundle shape.
- `packages/protocol/src/__tests__/fixtures-zod.test.ts` — TS side validates fixtures with zod.
- `packages/core-py/pyproject.toml` — Python package (uv).
- `packages/core-py/src/arclight_core/__init__.py`
- `packages/core-py/src/arclight_core/protocol/__init__.py`
- `packages/core-py/src/arclight_core/protocol/models.py` — GENERATED pydantic models.
- `packages/core-py/scripts/gen_models.py` — codegen driver (zod-emitted JSON Schema → pydantic).
- `packages/core-py/tests/test_smoke.py`
- `packages/core-py/tests/test_models_generated.py`
- `packages/core-py/tests/test_fixtures_pydantic.py` — Python side validates the SAME fixtures.
- `packages/proxy/package.json`
- `packages/proxy/src/route-table.ts` — route-group → upstream mapping.
- `packages/proxy/src/server.ts` — Bun.serve forwarding proxy (incl. SSE pass-through).
- `packages/proxy/src/__tests__/route-table.test.ts`
- `packages/proxy/src/__tests__/proxy-forward.test.ts`

**Modified:**
- `packages/protocol/package.json` — add `emit-schema` script.
- root `package.json` — add `check:py` + fold into `check`.

---

### Task 1: Scaffold the Python core package

**Files:**
- Create: `packages/core-py/pyproject.toml`
- Create: `packages/core-py/src/arclight_core/__init__.py`
- Create: `packages/core-py/tests/test_smoke.py`

**Interfaces:**
- Consumes: nothing.
- Produces: a conda-env-managed Python package importable as `arclight_core`, with `conda run -n arclight python -m pytest` working. Later tasks add modules under `src/arclight_core/`.

- [ ] **Step 1: Write the failing test**

`packages/core-py/tests/test_smoke.py`:
```python
import arclight_core


def test_package_version_present():
    assert isinstance(arclight_core.__version__, str)
    assert arclight_core.__version__
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_smoke.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'arclight_core'` (package not yet created).

- [ ] **Step 3: Write minimal implementation**

`packages/core-py/pyproject.toml`:
```toml
[project]
name = "arclight-core"
version = "0.0.0"
requires-python = ">=3.12"
dependencies = ["pydantic>=2"]

[project.optional-dependencies]
dev = ["pytest>=8", "datamodel-code-generator>=0.26", "ruff>=0.6"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/arclight_core"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

`packages/core-py/src/arclight_core/__init__.py`:
```python
__version__ = "0.0.0"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_smoke.py -v`
Expected: PASS (1 passed). (The `arclight` env already has deps; `pythonpath=["src"]` makes `arclight_core` importable with no install.)

- [ ] **Step 5: Commit**

```bash
git add packages/core-py/pyproject.toml packages/core-py/src/arclight_core/__init__.py packages/core-py/tests/test_smoke.py
git commit -m "feat(core-py): scaffold conda-managed Python package with smoke test"
```

---

### Task 2: Emit JSON Schema bundle from protocol zod schemas

**Files:**
- Create: `packages/protocol/scripts/emit-json-schema.ts`
- Create: `packages/protocol/src/__tests__/json-schema-emit.test.ts`
- Modify: `packages/protocol/package.json` (add `emit-schema` script)
- Produces artifact: `packages/protocol/schema/arclight-protocol.schema.json`

**Interfaces:**
- Consumes: exported zod schemas from `@arclight/protocol` (`ArcCommandSchema`, `ArcAckSchema`, `CapabilityProfileSchema`, and the event schemas in `events.ts`).
- Produces: `emitProtocolJsonSchema(): Record<string, unknown>` returning a JSON Schema bundle keyed by definition name under `$defs`; and a committed `schema/arclight-protocol.schema.json` file. Python codegen (Task 3) consumes this file.

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/__tests__/json-schema-emit.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { emitProtocolJsonSchema } from "../../scripts/emit-json-schema";

describe("emitProtocolJsonSchema", () => {
  test("bundle includes ArcCommand and key event defs under $defs", () => {
    const bundle = emitProtocolJsonSchema() as {
      $defs: Record<string, unknown>;
    };
    expect(bundle.$defs).toBeDefined();
    expect(bundle.$defs.ArcCommand).toBeDefined();
    expect(bundle.$defs.ArcAck).toBeDefined();
    expect(bundle.$defs.CapabilityProfile).toBeDefined();
    // a representative event
    expect(bundle.$defs.TurnCompleted).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && bun test src/__tests__/json-schema-emit.test.ts`
Expected: FAIL — cannot resolve `../../scripts/emit-json-schema`.

- [ ] **Step 3: Write minimal implementation**

`packages/protocol/scripts/emit-json-schema.ts`:
```ts
// Emits a single JSON Schema bundle from the protocol's exported zod schemas.
// zod v4 native: z.toJSONSchema. The bundle is the cross-language contract artifact.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ArcAckSchema } from "../src/ack";
import { CapabilityProfileSchema } from "../src/capability";
import { ArcCommandSchema } from "../src/commands";
import {
  ContextCompactedSchema,
  InterruptedSchema,
  MessageDeltaSchema,
  PermissionAskSchema,
  SessionErrorSchema,
  SessionStartedSchema,
  ThinkingDeltaSchema,
  ToolOutputSchema,
  ToolProgressSchema,
  ToolRequestedSchema,
  TurnCompletedSchema,
  TurnStartedSchema,
  UserMessageSchema,
} from "../src/events";

// name → zod schema. Names become $defs keys and pydantic class names.
const REGISTRY: Record<string, z.ZodType> = {
  ArcCommand: ArcCommandSchema,
  ArcAck: ArcAckSchema,
  CapabilityProfile: CapabilityProfileSchema,
  SessionStarted: SessionStartedSchema,
  TurnStarted: TurnStartedSchema,
  MessageDelta: MessageDeltaSchema,
  UserMessage: UserMessageSchema,
  ThinkingDelta: ThinkingDeltaSchema,
  ToolRequested: ToolRequestedSchema,
  ToolProgress: ToolProgressSchema,
  ToolOutput: ToolOutputSchema,
  PermissionAsk: PermissionAskSchema,
  ContextCompacted: ContextCompactedSchema,
  TurnCompleted: TurnCompletedSchema,
  SessionError: SessionErrorSchema,
  Interrupted: InterruptedSchema,
};

export function emitProtocolJsonSchema(): Record<string, unknown> {
  const $defs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(REGISTRY)) {
    $defs[name] = z.toJSONSchema(schema, { target: "draft-2020-12" });
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "ArclightProtocol",
    $defs,
  };
}

export function writeBundle(): string {
  const out = join(import.meta.dir, "..", "schema", "arclight-protocol.schema.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(emitProtocolJsonSchema(), null, 2)}\n`);
  return out;
}

if (import.meta.main) {
  const path = writeBundle();
  console.log(`wrote ${path}`);
}
```

Add to `packages/protocol/package.json` `"scripts"`:
```json
    "emit-schema": "bun run scripts/emit-json-schema.ts"
```

> If `z.toJSONSchema` rejects a specific event schema (e.g. an unrepresentable refinement), narrow REGISTRY to the schemas that emit cleanly and open a follow-up; do not hand-write JSON Schema. Verify the actual exported names against `packages/protocol/src/events.ts` before running — adjust the import list to match (the grep at plan time showed `SessionStartedSchema`, `TurnStartedSchema`, `MessageDeltaSchema`, `UserMessageSchema`, `ThinkingDeltaSchema`, `ToolRequestedSchema`, `ToolProgressSchema`, `ToolOutputSchema`, `PermissionAskSchema`, `ContextCompactedSchema`, `TurnCompletedSchema`, `SessionErrorSchema`, `InterruptedSchema`).

- [ ] **Step 4: Run test, then emit the artifact**

Run: `cd packages/protocol && bun test src/__tests__/json-schema-emit.test.ts`
Expected: PASS.
Then: `bun run emit-schema`
Expected: `wrote .../schema/arclight-protocol.schema.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/scripts/emit-json-schema.ts packages/protocol/src/__tests__/json-schema-emit.test.ts packages/protocol/package.json packages/protocol/schema/arclight-protocol.schema.json
git commit -m "feat(protocol): emit JSON Schema bundle from zod schemas"
```

---

### Task 3: Generate pydantic models from the JSON Schema bundle

**Files:**
- Create: `packages/core-py/scripts/gen_models.py`
- Create: `packages/core-py/src/arclight_core/protocol/__init__.py`
- Create (generated): `packages/core-py/src/arclight_core/protocol/models.py`
- Create: `packages/core-py/tests/test_models_generated.py`

**Interfaces:**
- Consumes: `packages/protocol/schema/arclight-protocol.schema.json` (Task 2).
- Produces: `arclight_core.protocol.models` module exposing pydantic v2 classes `ArcCommand`, `ArcAck`, `CapabilityProfile`, `TurnCompleted`, etc. (one class per `$defs` key). Later milestones import these.

- [ ] **Step 1: Write the failing test**

`packages/core-py/tests/test_models_generated.py`:
```python
def test_generated_models_import_key_classes():
    from arclight_core.protocol import models

    assert hasattr(models, "ArcCommand")
    assert hasattr(models, "ArcAck")
    assert hasattr(models, "CapabilityProfile")
    assert hasattr(models, "TurnCompleted")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-py && uv run pytest tests/test_models_generated.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'arclight_core.protocol'`.

- [ ] **Step 3: Write the codegen driver + run it**

`packages/core-py/src/arclight_core/protocol/__init__.py`:
```python
from . import models

__all__ = ["models"]
```

`packages/core-py/scripts/gen_models.py`:
```python
"""Generate pydantic v2 models from the protocol JSON Schema bundle.

Source of truth is @arclight/protocol (zod). This output is generated;
never hand-edit src/arclight_core/protocol/models.py.
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = HERE.parent.parent / "protocol" / "schema" / "arclight-protocol.schema.json"
OUT = HERE.parent / "src" / "arclight_core" / "protocol" / "models.py"


def main() -> int:
    if not SCHEMA.exists():
        # repo-root-relative fallback (monorepo layout)
        alt = HERE.parents[2] / "protocol" / "schema" / "arclight-protocol.schema.json"
        schema = alt if alt.exists() else SCHEMA
    else:
        schema = SCHEMA
    OUT.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "datamodel-codegen",
        "--input", str(schema),
        "--input-file-type", "jsonschema",
        "--output", str(OUT),
        "--output-model-type", "pydantic_v2.BaseModel",
        "--use-title-as-name",
        "--target-python-version", "3.12",
    ]
    print(" ".join(cmd))
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
```

Run codegen:
Run: `cd packages/core-py && conda run -n arclight python scripts/gen_models.py`
Expected: writes `src/arclight_core/protocol/models.py` (exit 0). (`datamodel-codegen` is on PATH inside the `arclight` env, so the subprocess call in `gen_models.py` resolves it.)

> The schema path assumes the monorepo layout `packages/protocol/schema/...` relative to `packages/core-py/`. If your checkout differs, fix the `SCHEMA`/`alt` paths — do not copy the schema file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_models_generated.py -v`
Expected: PASS. (If `datamodel-codegen` named a class differently, e.g. `ArcCommand` split into a union alias, adjust the assertion to the actual generated name and note the mapping in a comment — but prefer `--use-title-as-name` keeping `$defs` keys.)

- [ ] **Step 5: Commit**

```bash
git add packages/core-py/scripts/gen_models.py packages/core-py/src/arclight_core/protocol/__init__.py packages/core-py/src/arclight_core/protocol/models.py packages/core-py/tests/test_models_generated.py
git commit -m "feat(core-py): generate pydantic models from protocol JSON Schema"
```

---

### Task 4: Cross-language golden fixtures (the contract gate)

**Files:**
- Create: `packages/protocol/fixtures/arc-command-submit.json`
- Create: `packages/protocol/fixtures/turn-completed.json`
- Create: `packages/protocol/src/__tests__/fixtures-zod.test.ts`
- Create: `packages/core-py/tests/test_fixtures_pydantic.py`

**Interfaces:**
- Consumes: `ArcCommandSchema` / `TurnCompletedSchema` (TS) and `models.ArcCommand` / `models.TurnCompleted` (Python).
- Produces: a shared `fixtures/` directory both languages validate. Every future protocol change must keep these green on both sides. Later milestones add one fixture per new contract surface.

- [ ] **Step 1: Write the failing tests + fixtures**

`packages/protocol/fixtures/arc-command-submit.json` (must satisfy `SubmitCommandSchema` inside the `ArcCommand` discriminated union — verify field names against `packages/protocol/src/commands.ts`; `k` is the discriminator):
```json
{
  "k": "submit",
  "sessionId": "sess-1",
  "commandId": "cmd-1",
  "input": { "text": "hello", "mode": "chat" }
}
```

`packages/protocol/fixtures/turn-completed.json` (verify fields against `events.ts` `TurnCompletedSchema`):
```json
{
  "t": "turn.completed",
  "sessionId": "sess-1",
  "turnId": "turn-1",
  "status": "completed"
}
```

`packages/protocol/src/__tests__/fixtures-zod.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ArcCommandSchema } from "../commands";
import { TurnCompletedSchema } from "../events";

const dir = join(import.meta.dir, "..", "..", "fixtures");
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));

describe("fixtures validate against zod", () => {
  test("arc-command-submit", () => {
    expect(() => ArcCommandSchema.parse(load("arc-command-submit.json"))).not.toThrow();
  });
  test("turn-completed", () => {
    expect(() => TurnCompletedSchema.parse(load("turn-completed.json"))).not.toThrow();
  });
});
```

`packages/core-py/tests/test_fixtures_pydantic.py`:
```python
import json
from pathlib import Path

from arclight_core.protocol import models

FIXTURES = Path(__file__).resolve().parents[2] / "protocol" / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def test_arc_command_submit_validates():
    models.ArcCommand.model_validate(_load("arc-command-submit.json"))


def test_turn_completed_validates():
    models.TurnCompleted.model_validate(_load("turn-completed.json"))
```

- [ ] **Step 2: Run both to verify they fail (or reveal real field mismatches)**

Run: `cd packages/protocol && bun test src/__tests__/fixtures-zod.test.ts`
Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_fixtures_pydantic.py -v`
Expected: zod test likely PASSES immediately if fixtures match the schema; the Python test FAILS only if a fixture or generated model mismatches. The point of this step is to surface any field-name drift between your fixture and the real zod schema — fix the FIXTURE to match the schema (the schema is authority), not the schema.

- [ ] **Step 3: Reconcile fixtures to the real schema**

If either side rejects a fixture, open `packages/protocol/src/commands.ts` and `events.ts`, correct the fixture JSON field names/values to satisfy the zod schema exactly, re-run `bun run emit-schema` and `uv run python scripts/gen_models.py` so the pydantic side reflects the same contract.

- [ ] **Step 4: Run both to verify they pass**

Run: `cd packages/protocol && bun test src/__tests__/fixtures-zod.test.ts` → PASS
Run: `cd packages/core-py && conda run -n arclight python -m pytest tests/test_fixtures_pydantic.py -v` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/fixtures packages/protocol/src/__tests__/fixtures-zod.test.ts packages/core-py/tests/test_fixtures_pydantic.py
git commit -m "test(protocol): cross-language golden fixtures (zod + pydantic)"
```

---

### Task 5: Reverse-proxy seam (route-group → upstream, all → TS at M0)

**Files:**
- Create: `packages/proxy/package.json`
- Create: `packages/proxy/src/route-table.ts`
- Create: `packages/proxy/src/server.ts`
- Create: `packages/proxy/src/__tests__/route-table.test.ts`
- Create: `packages/proxy/src/__tests__/proxy-forward.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent seam).
- Produces:
  - `resolveUpstream(path: string, table: RouteTable): "ts" | "py"` — maps a request path to an upstream by route-group prefix.
  - `type RouteTable = Record<string, "ts" | "py">` keyed by group prefix (e.g. `"/api/health"`).
  - `makeProxy(opts: { table: RouteTable; tsUpstream: string; pyUpstream?: string }): (req: Request) => Promise<Response>` — a fetch handler that forwards to the chosen upstream, streaming the body (SSE pass-through).

- [ ] **Step 1: Write the failing route-table test**

`packages/proxy/src/__tests__/route-table.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { type RouteTable, resolveUpstream } from "../route-table";

const table: RouteTable = {
  "/api/health": "ts",
  "/api/sessions": "ts",
};

describe("resolveUpstream", () => {
  test("longest-prefix match wins", () => {
    expect(resolveUpstream("/api/health", table)).toBe("ts");
    expect(resolveUpstream("/api/sessions/abc/events", table)).toBe("ts");
  });
  test("unknown path defaults to ts", () => {
    expect(resolveUpstream("/api/unknown", table)).toBe("ts");
  });
  test("a group flipped to py routes to py", () => {
    expect(resolveUpstream("/api/health", { "/api/health": "py" })).toBe("py");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/proxy && bun test src/__tests__/route-table.test.ts`
Expected: FAIL — cannot resolve `../route-table`.

- [ ] **Step 3: Implement route-table + package.json**

`packages/proxy/package.json`:
```json
{
  "name": "@arclight/proxy",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "start": "bun run src/server.ts"
  }
}
```

`packages/proxy/src/route-table.ts`:
```ts
// Route-group → upstream. M0: every group points at "ts". Flipping a group to
// "py" (a later milestone) is a one-line edit here. Longest-prefix match decides.
export type Upstream = "ts" | "py";
export type RouteTable = Record<string, Upstream>;

export const DEFAULT_TABLE: RouteTable = {
  "/api/health": "ts",
  "/api/config": "ts",
  "/api/projects": "ts",
  "/api/files": "ts",
  "/api/grants": "ts",
  "/api/commands": "ts",
  "/api/sessions": "ts",
};

export function resolveUpstream(path: string, table: RouteTable): Upstream {
  let best = "";
  for (const prefix of Object.keys(table)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (prefix.length > best.length) best = prefix;
    }
  }
  return best ? table[best] : "ts";
}
```

- [ ] **Step 4: Run to verify route-table passes**

Run: `cd packages/proxy && bun test src/__tests__/route-table.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing forwarding test**

`packages/proxy/src/__tests__/proxy-forward.test.ts`:
```ts
import { afterAll, describe, expect, test } from "bun:test";
import { makeProxy } from "../server";

// Fake TS upstream: one plain JSON route + one SSE route.
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, via: "ts", got: req.headers.get("x-test") });
    }
    if (url.pathname === "/api/sessions/s1/events") {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: one\n\n"));
          c.enqueue(new TextEncoder().encode("data: two\n\n"));
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("nope", { status: 404 });
  },
});
const tsUpstream = `http://localhost:${upstream.port}`;
const proxy = makeProxy({ table: { "/api/health": "ts", "/api/sessions": "ts" }, tsUpstream });

afterAll(() => upstream.stop(true));

describe("proxy forwarding", () => {
  test("forwards JSON + preserves headers", async () => {
    const res = await proxy(new Request("http://proxy/api/health", { headers: { "x-test": "v" } }));
    const body = await res.json();
    expect(body).toEqual({ ok: true, via: "ts", got: "v" });
  });

  test("passes through SSE stream unbuffered", async () => {
    const res = await proxy(new Request("http://proxy/api/sessions/s1/events"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd packages/proxy && bun test src/__tests__/proxy-forward.test.ts`
Expected: FAIL — `makeProxy` not exported from `../server`.

- [ ] **Step 7: Implement the forwarding proxy**

`packages/proxy/src/server.ts`:
```ts
// Transparent reverse proxy in front of /api/*. Forwards to the upstream chosen
// by the route table, streaming the response body so SSE is never buffered.
import { DEFAULT_TABLE, type RouteTable, resolveUpstream } from "./route-table";

export type ProxyOpts = {
  table: RouteTable;
  tsUpstream: string;
  pyUpstream?: string;
};

export function makeProxy(opts: ProxyOpts): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const target = resolveUpstream(url.pathname, opts.table);
    const base = target === "py" ? opts.pyUpstream : opts.tsUpstream;
    if (!base) {
      return new Response(`no upstream configured for "${target}"`, { status: 502 });
    }
    const upstreamUrl = `${base}${url.pathname}${url.search}`;
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      // @ts-expect-error Bun supports duplex streaming bodies
      duplex: "half",
      redirect: "manual",
    };
    const res = await fetch(upstreamUrl, init);
    // Stream body straight through (SSE-safe); copy status + headers verbatim.
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

if (import.meta.main) {
  const tsUpstream = process.env.ARC_TS_UPSTREAM ?? "http://localhost:8787";
  const pyUpstream = process.env.ARC_PY_UPSTREAM;
  const port = Number(process.env.ARC_PROXY_PORT ?? 8080);
  const handler = makeProxy({ table: DEFAULT_TABLE, tsUpstream, pyUpstream });
  Bun.serve({ port, fetch: handler });
  console.log(`arclight proxy on :${port} → ts=${tsUpstream} py=${pyUpstream ?? "(unset)"}`);
}
```

- [ ] **Step 8: Run to verify forwarding passes**

Run: `cd packages/proxy && bun test`
Expected: PASS (route-table + forwarding, 5 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/proxy
git commit -m "feat(proxy): reverse-proxy seam with route table + SSE pass-through"
```

---

### Task 6: Wire Python checks into the repo check pipeline

**Files:**
- Modify: root `package.json` (`scripts`)

**Interfaces:**
- Consumes: `packages/core-py` (uv project), `packages/protocol` emit script.
- Produces: `bun run check` runs TS checks AND Python lint+tests; a fresh clone can validate both stacks with one command.

- [ ] **Step 1: Inspect the existing check script**

Run: `grep -A3 '"check"' package.json`
Expected: see the current root `check` script (TS lint/typecheck/test). Note its exact current value to extend, not replace.

- [ ] **Step 2: Add Python check script + fold into check**

In root `package.json` `"scripts"`, add:
```json
    "check:py": "cd packages/core-py && conda run -n arclight ruff check . && conda run -n arclight python -m pytest -q",
    "check:contract": "cd packages/protocol && bun run emit-schema && cd ../core-py && conda run -n arclight python scripts/gen_models.py && git diff --exit-code -- src/arclight_core/protocol/models.py ../protocol/schema"
```
Then append `&& bun run check:py` to the END of the existing `check` script value (keep everything already there; do not remove TS steps).

> `check:contract` regenerates the schema + models and fails if they drift from what's committed — this is what keeps the generated artifacts honest in CI. Adjust the `git diff` paths if your repo root differs.

- [ ] **Step 3: Run the full check**

Run: `bun run check`
Expected: existing TS checks PASS, then `check:py` runs `ruff` + `pytest` and PASSES.
Run: `bun run check:contract`
Expected: PASS (no drift — Tasks 2 & 3 already committed current artifacts).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: run Python lint/tests + contract drift gate in check"
```

---

## Self-Review

**1. Spec coverage (M0 portion of §4.1 + §10):**
- "契约优先：protocol→语言中立(OpenAPI/JSON Schema)，TS(zod)∥Python(pydantic) codegen + 黄金 fixture" → Tasks 2, 3, 4. ✓
- "反向代理 + 路由组 + SSE 透传，默认全转 TS core" → Task 5. ✓
- "Python core 包脚手架" → Task 1. ✓
- "契约黄金 fixture 双侧校验，破坏即红" → Task 4 + `check:contract` (Task 6). ✓
- M1–M5 explicitly deferred to their own plans (decomposition table). ✓

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" left. The two `>` notes (Task 2 schema-name verification, Task 3 path fallback) are explicit verification instructions with concrete fallbacks, not deferred work. ✓

**3. Type consistency:** `RouteTable`/`Upstream`/`resolveUpstream`/`makeProxy` names match across Task 5 steps and the Interfaces block. `emitProtocolJsonSchema` (Task 2) is the name consumed by its test. Generated pydantic class names (`ArcCommand`, `TurnCompleted`, …) match the `$defs` keys set by the REGISTRY in Task 2 and asserted in Tasks 3–4. ✓

**Known residual risk (flagged, not a gap):** exact zod→JSON Schema emission and `datamodel-codegen` class-naming can require small reconciliation (Tasks 2–4 steps already instruct how to reconcile against the real schema). This is inherent to first-time codegen wiring, not a plan omission.
