import { describe, expect, test } from "bun:test";
import { type ArcEvent, ArcEventSchema } from "@arclight/protocol";
import type { DraftEvent } from "../../db/appendEvent";
import { WorkflowEvents } from "../events";

// runner 注入的 emit 同型夹具（seq/epoch/ts 由 appendEvent 事务内分配，此处用 fake 计数）
function makeEmit() {
  const events: ArcEvent[] = [];
  let seq = 0;
  const emit = (draft: DraftEvent): ArcEvent => {
    const e = { ...draft, seq: ++seq, epoch: 0, ts: 1_700_000_000_000 + seq } as ArcEvent;
    events.push(e);
    return e;
  };
  return { events, emit };
}

describe("WorkflowEvents：旁路发射 workflow.*（spec §8）", () => {
  test("六类事件按调用顺序经 emit 落库，绑父会话 + workflowId", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, {
      sessionId: "s-parent",
      turnId: "t-parent",
      workflowId: "run-1",
    });

    w.started("gate-circuit");
    w.phase("校验");
    w.agentStarted({ agentId: "a1", role: "executor", agentSeq: 0 });
    w.agentCompleted({ agentId: "a1", status: "ok" });
    w.completed();

    expect(events.map((e) => e.t)).toEqual([
      "workflow.started",
      "workflow.phase",
      "workflow.agent.started",
      "workflow.agent.completed",
      "workflow.completed",
    ]);
    // 全部绑父会话（落主流 SSE），且 seq 单调
    for (const e of events) {
      expect(e.sessionId).toBe("s-parent");
      expect(e.turnId).toBe("t-parent");
    }
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("started/agentStarted 负载字段与 §8 schema 端到端自洽（agentSeq 非 seq）", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    w.started("demo");
    w.agentStarted({ agentId: "a9", role: "reviewer", agentSeq: 2 });
    // 用真实 protocol schema 复核，钉死字段名（防 workflowId/role/agentSeq 漂移）
    for (const e of events) {
      expect(ArcEventSchema.safeParse(e).success).toBe(true);
    }
    expect(events[0]).toMatchObject({ t: "workflow.started", workflowId: "run-1", name: "demo" });
    expect(events[1]).toMatchObject({
      t: "workflow.agent.started",
      agentId: "a9",
      role: "reviewer",
      agentSeq: 2,
    });
  });

  test("failed 区分 error/interrupted（spec §10 两条终态）", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    w.failed("interrupted", "user aborted");
    w.failed("error", "top-level throw");
    expect(events[0]).toMatchObject({ t: "workflow.failed", reason: "interrupted" });
    expect(events[1]).toMatchObject({ t: "workflow.failed", reason: "error" });
    expect(ArcEventSchema.safeParse(events[0]).success).toBe(true);
    expect(ArcEventSchema.safeParse(events[1]).success).toBe(true);
  });
});
