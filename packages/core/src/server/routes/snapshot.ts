import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { sessions } from "../../db/schema";
import { replayEvents } from "../../db/sseReplay";

// 全量重建入口（续接路径②③ 的落点 + 首屏 bootstrap）。
// slice1：snapshot = 全量事件流（client 过 reducer 重建）；slice2 起物化 messages 后改回消息态。
export function createSnapshotRoute(deps: { db: Db }) {
  const { db } = deps;
  return new Hono().get("/:id/snapshot", (c) => {
    const sessionId = c.req.param("id");
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) return c.json({ ok: false, code: "SESSION_NOT_FOUND" }, 404);
    return c.json({
      ok: true,
      sessionId,
      epoch: session.epoch,
      lastSeq: session.lastEventSeq,
      events: replayEvents(db, sessionId, 0),
    });
  });
}
