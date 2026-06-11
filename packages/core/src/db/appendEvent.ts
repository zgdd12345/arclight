import { randomUUID } from "node:crypto";
import type { ArcEvent } from "@arclight/protocol";
import { eq } from "drizzle-orm";
import type { createDb } from "./client";
import { events, sessions } from "./schema";

// seq 不变式的唯一守护点（P0 §B / DEV_PLAN §2.1）：
// 单 SQLite 事务内 读 sessions.nextSeq+epoch → insert events → 写回 nextSeq/lastEventSeq。
// "yield 顺序 = 持久顺序 = SSE replay 顺序"由此成立；(session_id, seq) 唯一约束兜底。

export class StaleEpochError extends Error {
  readonly code = "STALE_EPOCH" as const;
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`stale epoch: command baseEpoch=${expected}, session epoch=${actual}`);
  }
}

export class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND" as const;
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}

/** 分配式 Omit：对 discriminated union 逐成员 Omit（普通 Omit 会塌缩成公共键交集） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 草稿事件：seq/ts/epoch 由本函数在事务内分配（epoch 以会话当前值为准） */
export type DraftEvent = DistributiveOmit<ArcEvent, "seq" | "ts" | "epoch">;

export type AppendDeps = {
  db: ReturnType<typeof createDb>["db"];
  bus?: { publish(e: ArcEvent): void };
};

export function appendEvent(
  deps: AppendDeps,
  draft: DraftEvent,
  opts: { expectedEpoch?: number } = {},
): ArcEvent {
  const { db, bus } = deps;
  const full = db.transaction((tx) => {
    const row = tx
      .select({ nextSeq: sessions.nextSeq, epoch: sessions.epoch })
      .from(sessions)
      .where(eq(sessions.id, draft.sessionId))
      .get();
    if (!row) throw new SessionNotFoundError(draft.sessionId);
    if (opts.expectedEpoch !== undefined && opts.expectedEpoch !== row.epoch) {
      throw new StaleEpochError(opts.expectedEpoch, row.epoch);
    }
    const seq = row.nextSeq;
    const event = { ...draft, seq, epoch: row.epoch, ts: Date.now() } as ArcEvent;
    tx.insert(events)
      .values({
        id: randomUUID(),
        sessionId: draft.sessionId,
        turnId: draft.turnId ?? null,
        seq,
        epoch: row.epoch,
        type: event.t,
        event,
      })
      .run();
    tx.update(sessions)
      .set({ nextSeq: seq + 1, lastEventSeq: seq })
      .where(eq(sessions.id, draft.sessionId))
      .run();
    return event;
  });
  bus?.publish(full); // 先持久化，后发布
  return full;
}
