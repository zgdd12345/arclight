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
  args: { sessionId: string; turnId: string; baseEpoch: number; deltaMs?: number },
): Promise<void> {
  const { db } = deps;
  const { sessionId, turnId, baseEpoch } = args;
  const deltaMs = args.deltaMs ?? 15;
  const emit = (draft: Parameters<typeof appendEvent>[1], opts?: { expectedEpoch?: number }) =>
    appendEvent(deps, draft, opts);
  try {
    db.update(turns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(turns.id, turnId))
      .run();
    // 准入乐观锁：首个 append 以 client 声明 baseEpoch 在事务内复核 session.epoch。陈旧提交
    // （绕过路由 TOCTOU 预检）抛 StaleEpochError → 下方 catch 干净置 failed，绝不在错误 epoch 下落库。
    emit({ v: 1, t: "turn.started", sessionId, turnId }, { expectedEpoch: baseEpoch });
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
