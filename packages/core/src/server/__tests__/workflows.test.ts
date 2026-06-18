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
    expect(runCalls[0]?.turnId).toBe(body.turnId);

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
