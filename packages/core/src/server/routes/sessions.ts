import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { sessions, usage, workspaces } from "../../db/schema";

export function createSessionsRoute(deps: { db: Db; repoPath: string; arclightDir: string }) {
  const { db, repoPath, arclightDir } = deps;

  function ensureWorkspace(): string {
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

  return new Hono()
    .post("/", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { id?: string; title?: string };
      const id = body.id ?? randomUUID();
      const workspaceId = ensureWorkspace();
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
    });
}
