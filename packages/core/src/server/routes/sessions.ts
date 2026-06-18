import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { checkpoints, sessions, turns, usage, workspaces } from "../../db/schema";
import { DEFAULT_EFFECTIVE_WINDOW } from "../../loop/compaction";
import { ensureWorkspace } from "../workspace";

/** 会话是否有活跃 turn（queued/running/awaiting_approval）——删除前守卫，fail-closed。 */
export function hasActiveTurn(db: Db, sessionId: string): boolean {
  return (
    db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.sessionId, sessionId),
          inArray(turns.status, ["queued", "running", "awaiting_approval"]),
        ),
      )
      .get() !== undefined
  );
}

export function createSessionsRoute(deps: {
  db: Db;
  repoPath: string;
  arclightDir: string;
  effectiveWindow?: number; // 上下文压缩窗口（须与 runner 一致；缺省 = DEFAULT）
}) {
  const { db, repoPath, arclightDir } = deps;
  const effectiveWindow = deps.effectiveWindow ?? DEFAULT_EFFECTIVE_WINDOW;

  return (
    new Hono()
      .post("/", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          id?: string;
          title?: string;
          workspaceId?: string;
        };
        const id = body.id ?? randomUUID();
        // 指定项目则挂到该 workspace（校验存在）；缺省回退默认 --repo 工作区。
        let workspaceId: string;
        if (body.workspaceId) {
          const ws = db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, body.workspaceId))
            .get();
          if (!ws)
            return c.json({ ok: false, code: "VALIDATION", message: "workspace not found" }, 400);
          workspaceId = ws.id;
        } else {
          workspaceId = ensureWorkspace(db, repoPath, arclightDir);
        }
        const dup = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get();
        if (dup) return c.json({ ok: false, code: "VALIDATION", message: "session exists" }, 409);
        db.insert(sessions)
          .values({ id, workspaceId, title: body.title ?? null })
          .run();
        return c.json({ ok: true, sessionId: id, workspaceId, epoch: 0 }, 201);
      })
      .get("/:id", (c) => {
        const row = db
          .select()
          .from(sessions)
          .where(eq(sessions.id, c.req.param("id")))
          .get();
        if (!row) return c.json({ ok: false, code: "SESSION_NOT_FOUND" }, 404);
        return c.json({
          ok: true,
          sessionId: row.id,
          status: row.status,
          epoch: row.epoch,
          lastEventSeq: row.lastEventSeq,
        });
      })
      // 重命名会话：body { title }
      .patch("/:id", async (c) => {
        const id = c.req.param("id");
        const body = (await c.req.json().catch(() => ({}))) as { title?: string };
        const title = (body.title ?? "").trim().slice(0, 80);
        if (!title)
          return c.json({ ok: false, code: "VALIDATION", message: "title required" }, 400);
        const row = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get();
        if (!row) return c.json({ ok: false, code: "SESSION_NOT_FOUND" }, 404);
        db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id)).run();
        return c.json({ ok: true });
      })
      // 删除会话：events/turns/tool_calls/usage 经 FK 级联清除（PRAGMA foreign_keys=ON）。
      // 活跃 turn 一律 409 拒绝（fail-closed：先停止再删，不做隐式中断）。
      .delete("/:id", (c) => {
        const id = c.req.param("id");
        const row = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get();
        if (!row) return c.json({ ok: false, code: "SESSION_NOT_FOUND" }, 404);
        if (hasActiveTurn(db, id)) {
          return c.json(
            { ok: false, code: "TURN_ACTIVE", message: "会话正在运行，先停止再删除" },
            409,
          );
        }
        db.delete(sessions).where(eq(sessions.id, id)).run();
        return c.json({ ok: true });
      })
      .get("/:id/usage", (c) => {
        // 成本可观测（DoD #7）：session 累计 token + cost。展示用，不做 quota 强制。
        const r = db
          .select({
            inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}), 0)`,
            costUsdMicros: sql<number>`coalesce(sum(${usage.costUsdMicros}), 0)`,
          })
          .from(usage)
          .where(eq(usage.sessionId, c.req.param("id")))
          .get();
        return c.json({
          ok: true,
          inputTokens: r?.inputTokens ?? 0,
          outputTokens: r?.outputTokens ?? 0,
          costUsdMicros: r?.costUsdMicros ?? 0,
        });
      })
      // 上下文余量：上次 turn 结束记录的 contextTokens vs 压缩窗口。展示用。
      .get("/:id/context-usage", (c) => {
        const row = db
          .select({ contextTokens: sessions.contextTokens })
          .from(sessions)
          .where(eq(sessions.id, c.req.param("id")))
          .get();
        if (!row) return c.json({ ok: false, code: "SESSION_NOT_FOUND" }, 404);
        return c.json({
          ok: true,
          currentTokens: row.contextTokens,
          effectiveWindow,
        });
      })
      // 检查点时间线（/undo /redo 可视化）：本 session 的 shadow-git 检查点，旧→新。
      // 只读展示；恢复经 /undo /redo 命令（不暴露任意 ref 跳转，避免游标语义歧义）。
      .get("/:id/checkpoints", (c) => {
        const rows = db
          .select({
            id: checkpoints.id,
            ref: checkpoints.ref,
            label: checkpoints.label,
            changedFiles: checkpoints.changedFiles,
            turnId: checkpoints.turnId,
            createdAt: checkpoints.createdAt,
          })
          .from(checkpoints)
          .where(eq(checkpoints.sessionId, c.req.param("id")))
          .orderBy(sql`rowid`)
          .all();
        return c.json({
          ok: true,
          checkpoints: rows.map((r) => ({
            id: r.id,
            ref: r.ref,
            label: r.label,
            changedFiles: r.changedFiles ?? [],
            turnId: r.turnId,
            createdAt: r.createdAt?.getTime() ?? 0,
          })),
        });
      })
  );
}
