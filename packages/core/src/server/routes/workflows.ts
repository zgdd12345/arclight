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
      if (!templates.has(name)) return c.json({ ok: false, code: "NOT_FOUND", message: "template not found" }, 404);
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
      // Guard: mirror the tool's zod Input — script must be a non-empty string, args must be an
      // object, saveAs must be a non-empty string. body is cast from unknown JSON so these can
      // diverge from the declared RunBody type at runtime; widen to unknown to keep TS happy.
      if (body.script !== undefined) {
        const v: unknown = body.script;
        if (typeof v !== "string" || v.length === 0) {
          return c.json({ ok: false, code: "VALIDATION", message: "script must be a non-empty string" }, 400);
        }
      }
      if (body.args !== undefined) {
        const v: unknown = body.args;
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          return c.json({ ok: false, code: "VALIDATION", message: "args must be an object" }, 400);
        }
      }
      if (body.saveAs !== undefined) {
        const v: unknown = body.saveAs;
        if (typeof v !== "string" || v.length === 0) {
          return c.json({ ok: false, code: "VALIDATION", message: "saveAs must be a non-empty string" }, 400);
        }
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
