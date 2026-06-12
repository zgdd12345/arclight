import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Db } from "../../db/client";
import { sessions } from "../../db/schema";
import {
  formatSseFrame,
  HEARTBEAT_FRAME,
  lastCompactedSeq,
  minAvailableSeq,
  replayEvents,
} from "../../db/sseReplay";
import type { EventBus } from "../../events/bus";

// C2: GET /api/sessions/:id/events?afterSeq=N&epoch=E（P0 §235 续接语义）
// ① afterSeq 仍可 replay → 200，补帧后转实时    ② 缺口（事件已清理）→ 409 buffer-expired
// ③ 请求 epoch 旧且 afterSeq 早于最近 compacted → 409 epoch-jump（cache 前缀失效，增量无意义）
// 心跳为 SSE 注释帧，不持久化。

export function createEventsRoute(deps: { db: Db; bus: EventBus; heartbeatMs?: number }) {
  const { db, bus } = deps;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  return new Hono().get("/:id/events", (c) => {
    const sessionId = c.req.param("id");
    const afterSeq = Number(c.req.query("afterSeq") ?? "0");
    const reqEpoch = c.req.query("epoch") !== undefined ? Number(c.req.query("epoch")) : undefined;

    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) return c.json({ ok: false, code: "SESSION_NOT_FOUND" }, 404);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      return c.json({ ok: false, code: "VALIDATION", message: "afterSeq must be int >= 0" }, 400);
    }
    // epoch 提供但非法（NaN/非整数/负）→ 400，绝不让 NaN<epoch=false 静默跳过 epoch-jump
    if (reqEpoch !== undefined && (!Number.isInteger(reqEpoch) || reqEpoch < 0)) {
      return c.json({ ok: false, code: "VALIDATION", message: "epoch must be int >= 0" }, 400);
    }

    const snapshotUrl = `/api/sessions/${sessionId}/snapshot`;
    // ③ epoch-jump
    if (reqEpoch !== undefined && reqEpoch < session.epoch) {
      const compactedAt = lastCompactedSeq(db, sessionId);
      if (compactedAt !== null) {
        if (afterSeq < compactedAt) {
          return c.json({ reason: "epoch-jump", snapshotUrl }, 409);
        }
      } else {
        // BUG4 读侧兜底：epoch 已进却无 context.compacted 行（崩溃半完成态/历史脏数据）。
        // 旧实现因 compactedAt==null 直接漏判，客户端永久卡 STALE_EPOCH。
        // 降级用 minAvailableSeq 作压缩边界：书签早于最早可用帧即强制 epoch-jump 重建。
        const min = minAvailableSeq(db, sessionId);
        if (min === null || afterSeq < min) {
          return c.json({ reason: "epoch-jump", snapshotUrl }, 409);
        }
      }
    }
    // ② buffer-expired：请求点之后的第一帧已不可得
    const min = minAvailableSeq(db, sessionId);
    if (min !== null && afterSeq + 1 < min) {
      return c.json({ reason: "buffer-expired", snapshotUrl }, 409);
    }

    return streamSSE(c, async (stream) => {
      let live = true;
      let maxSent = afterSeq;
      // 队列元素携带类型化 seq：避免 regex 解析 wire format 的脆弱性；
      // 心跳用哨兵 seq=-1（不参与去重，直接透传）。
      const queue: Array<{ seq: number; frame: string }> = [];
      let wake: (() => void) | null = null;

      // 先订阅后 replay：窗口期事件进队列，凭 seq 去重，无缝隙
      const unsubscribe = bus.subscribe(sessionId, (e) => {
        queue.push({ seq: e.seq, frame: formatSseFrame(e) });
        wake?.();
      });
      stream.onAbort(() => {
        live = false;
        unsubscribe();
        wake?.();
      });

      // 订阅之后的一切都进 try/finally——replay 阶段 stream.write 抛错也必 unsubscribe（防 listener 泄漏）
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        for (const e of replayEvents(db, sessionId, afterSeq)) {
          await stream.write(formatSseFrame(e));
          maxSent = e.seq;
        }

        heartbeat = setInterval(() => {
          queue.push({ seq: -1, frame: HEARTBEAT_FRAME });
          wake?.();
        }, heartbeatMs);

        while (live) {
          while (queue.length > 0) {
            const item = queue.shift();
            if (item === undefined) break;
            // 实时帧凭类型化 seq 去重（replay 与订阅窗口可能重叠）；
            // seq=-1 为心跳哨兵，不参与去重，直接透传。
            if (item.seq >= 0) {
              if (item.seq <= maxSent) continue;
              maxSent = item.seq;
            }
            await stream.write(item.frame);
          }
          if (!live) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });
}
