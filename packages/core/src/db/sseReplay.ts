import type { ArcEvent } from "@arclight/protocol";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { events } from "./schema";

// SSE replay 查询层（events 表即缓冲：P0 不清理当前 session events，重启后可完整 replay）。

export function replayEvents(db: Db, sessionId: string, afterSeq: number): ArcEvent[] {
  return db
    .select({ event: events.event })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), gt(events.seq, afterSeq)))
    .orderBy(asc(events.seq))
    .all()
    .map((r) => r.event);
}

/** 最早可 replay 的 seq；无事件时为 null。afterSeq+1 < min → buffer-expired */
export function minAvailableSeq(db: Db, sessionId: string): number | null {
  const r = db
    .select({ min: sql<number | null>`min(${events.seq})` })
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .get();
  return r?.min ?? null;
}

/** 最近一次 context.compacted 的 seq；无压缩史为 null。用于 epoch-jump 判定 */
export function lastCompactedSeq(db: Db, sessionId: string): number | null {
  const r = db
    .select({ max: sql<number | null>`max(${events.seq})` })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), eq(events.type, "context.compacted")))
    .get();
  return r?.max ?? null;
}

export function formatSseFrame(e: ArcEvent): string {
  return `id: ${e.seq}\nevent: ${e.t}\ndata: ${JSON.stringify(e)}\n\n`;
}

export const HEARTBEAT_FRAME = ": heartbeat\n\n"; // 不持久化
