import { describe, expect, it } from "vitest";
import { ArcEventSchema, WireEventEnvelopeSchema } from "../index";

const base = { v: 1, sessionId: "s1", seq: 1, epoch: 0, ts: 1_700_000_000_000 } as const;

describe("workflow.* 事件 schema（spec §8）", () => {
  it("接受 workflow.started", () => {
    const r = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.started",
      turnId: "t1",
      workflowId: "run-1",
      name: "gate-circuit",
    });
    expect(r.success).toBe(true);
  });

  it("接受 workflow.phase", () => {
    const r = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.phase",
      workflowId: "run-1",
      title: "校验",
    });
    expect(r.success).toBe(true);
  });

  it("接受 workflow.agent.started（payload 序号字段 = agentSeq，与信封 seq 并存）", () => {
    const r = ArcEventSchema.safeParse({
      ...base, // base 已含信封 seq:1（appendEvent 分配）
      t: "workflow.agent.started",
      workflowId: "run-1",
      agentId: "a1",
      role: "executor",
      agentSeq: 0, // ← payload 序号，不是信封 seq
    });
    expect(r.success).toBe(true);
    // 缺 agentSeq 必败（字段必填，钉死 seq→agentSeq 改名不被静默放过）
    const missing = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.agent.started",
      workflowId: "run-1",
      agentId: "a1",
      role: "executor",
    });
    expect(missing.success).toBe(false);
  });

  it("接受 workflow.agent.completed（status 限 ok|failed）", () => {
    const ok = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.agent.completed",
      workflowId: "run-1",
      agentId: "a1",
      status: "failed",
    });
    expect(ok.success).toBe(true);
    const bad = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.agent.completed",
      workflowId: "run-1",
      agentId: "a1",
      status: "cancelled",
    });
    expect(bad.success).toBe(false);
  });

  it("接受 workflow.completed", () => {
    const r = ArcEventSchema.safeParse({ ...base, t: "workflow.completed", workflowId: "run-1" });
    expect(r.success).toBe(true);
  });

  it("接受 workflow.failed，reason 区分 error|interrupted", () => {
    for (const reason of ["error", "interrupted"] as const) {
      const r = ArcEventSchema.safeParse({
        ...base,
        t: "workflow.failed",
        workflowId: "run-1",
        reason,
        message: "x",
      });
      expect(r.success).toBe(true);
    }
    const bad = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.failed",
      workflowId: "run-1",
      reason: "boom",
      message: "x",
    });
    expect(bad.success).toBe(false);
  });

  it("前向兼容：Wire 信封接受未来未知 t", () => {
    // 服务端先于客户端升级时，旧客户端必须仍接受信封并推进 maxSeq（events.ts:119-125）
    const r = WireEventEnvelopeSchema.safeParse({ ...base, t: "workflow.future_kind", any: 1 });
    expect(r.success).toBe(true);
  });
});
