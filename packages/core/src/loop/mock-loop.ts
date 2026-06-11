import { eq } from "drizzle-orm";
import { appendEvent } from "../db/appendEvent";
import type { Db } from "../db/client";
import { turns } from "../db/schema";
import type { EventBus } from "../events/bus";

// slice1 占位流水线：submit → turn.started → message.delta×N → turn.completed。
// 唯一职责是给 SSE 续接闭环提供真实事件流；slice2 由 queryLoop()（pi 结构控制反转重写）整体替换。

const CANNED =
  "收到。这是 slice1 的事件流脊柱演示：本回复被切成多个 delta 逐帧推送，" +
  "断线后凭 afterSeq 续接不丢不重。真实 provider 接入在 slice2。";

export async function runMockTurn(
  deps: { db: Db; bus: EventBus },
  args: { sessionId: string; turnId: string; deltaMs?: number },
): Promise<void> {
  const { db } = deps;
  const { sessionId, turnId } = args;
  const deltaMs = args.deltaMs ?? 15;
  const emit = (draft: Parameters<typeof appendEvent>[1]) => appendEvent(deps, draft);
  try {
    db.update(turns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(turns.id, turnId))
      .run();
    emit({ v: 1, t: "turn.started", sessionId, turnId });
    const messageId = `m-${turnId}`;
    const step = Math.ceil(CANNED.length / 6);
    for (let i = 0; i < CANNED.length; i += step) {
      await Bun.sleep(deltaMs);
      emit({
        v: 1,
        t: "message.delta",
        sessionId,
        turnId,
        messageId,
        role: "assistant",
        delta: CANNED.slice(i, i + step),
      });
    }
    emit({ v: 1, t: "turn.completed", sessionId, turnId, status: "completed" });
    db.update(turns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(turns.id, turnId))
      .run();
  } catch {
    db.update(turns).set({ status: "failed" }).where(eq(turns.id, turnId)).run();
  }
}
