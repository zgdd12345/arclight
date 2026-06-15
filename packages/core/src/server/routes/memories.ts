import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { memories } from "../../db/schema";

// 记忆管理（仿 ChatGPT Memory）：跨会话长期偏好/事实的增删改查。
// 启用项由 runner 在每 turn 注入上下文前缀；停用保留但不注入。

const MAX_CONTENT = 500;

export function createMemoriesRoute(deps: { db: Db }) {
  const { db } = deps;

  return new Hono()
    .get("/", (c) => {
      const rows = db.select().from(memories).orderBy(desc(memories.createdAt)).all();
      return c.json({
        ok: true,
        memories: rows.map((r) => ({
          id: r.id,
          content: r.content,
          enabled: r.enabled,
          createdAt: r.createdAt?.getTime() ?? 0,
        })),
      });
    })
    .post("/", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { content?: string };
      const content = (body.content ?? "").trim().slice(0, MAX_CONTENT);
      if (!content) {
        return c.json({ ok: false, code: "VALIDATION", message: "content required" }, 400);
      }
      const id = randomUUID();
      db.insert(memories).values({ id, content }).run();
      return c.json({ ok: true, id }, 201);
    })
    .patch("/:id", async (c) => {
      const id = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) as {
        content?: string;
        enabled?: boolean;
      };
      const row = db.select({ id: memories.id }).from(memories).where(eq(memories.id, id)).get();
      if (!row) return c.json({ ok: false, code: "NOT_FOUND" }, 404);
      const patch: { content?: string; enabled?: boolean; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (body.content !== undefined) {
        const content = body.content.trim().slice(0, MAX_CONTENT);
        if (!content) {
          return c.json({ ok: false, code: "VALIDATION", message: "content required" }, 400);
        }
        patch.content = content;
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return c.json({ ok: false, code: "VALIDATION", message: "enabled 须为布尔" }, 400);
        }
        patch.enabled = body.enabled;
      }
      db.update(memories).set(patch).where(eq(memories.id, id)).run();
      return c.json({ ok: true });
    })
    .delete("/:id", (c) => {
      const id = c.req.param("id");
      const row = db.select({ id: memories.id }).from(memories).where(eq(memories.id, id)).get();
      if (!row) return c.json({ ok: false, code: "NOT_FOUND" }, 404);
      db.delete(memories).where(eq(memories.id, id)).run();
      return c.json({ ok: true });
    });
}
