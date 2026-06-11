import type { ArcEvent } from "@arclight/protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce, reduceBatch, type ThreadMsg } from "../reducer";

let seqCounter = 0;
const ev = <T extends Record<string, unknown>>(t: string, fields: T, seq?: number) =>
  ({
    v: 1,
    t,
    sessionId: "s1",
    seq: seq ?? ++seqCounter,
    epoch: 0,
    ts: 1_700_000_000_000,
    ...fields,
  }) as unknown as ArcEvent;

const delta = (messageId: string, text: string, seq?: number) =>
  ev("message.delta", { messageId, role: "assistant", delta: text, turnId: "t1" }, seq);

describe("SessionReducer 三纪律", () => {
  it("纪律：seq <= maxSeq 的重放帧静默丢弃（状态引用不变）", () => {
    const s1 = reduce(initialState("s1"), delta("m1", "hello", 5));
    const s2 = reduce(s1, delta("m1", "REPLAY", 5));
    expect(s2).toBe(s1); // 同一引用，零重渲染
    const s3 = reduce(s1, delta("m1", "OLD", 3));
    expect(s3).toBe(s1);
  });

  it("纪律：未知事件类型静默忽略但仍推进 maxSeq（forward-compat）", () => {
    const s = reduce(initialState("s1"), ev("future.event", { mystery: true }, 7));
    expect(s.messages).toEqual([]);
    expect(s.maxSeq).toBe(7);
  });

  it("纪律：part 级不可变更新——delta 只替换末尾 text part 引用，其余 part 共享", () => {
    seqCounter = 0;
    let s = reduce(initialState("s1"), ev("turn.started", { turnId: "t1" }));
    s = reduce(s, delta("m1", "你好"));
    s = reduce(
      s,
      ev("tool.requested", {
        callId: "c1",
        name: "read_file",
        argsPreview: "a.ts",
        riskTier: "safe",
        riskClass: "read",
        turnId: "t1",
      }),
    );
    const beforeMsg = s.messages[0] as ThreadMsg;
    const beforeText = beforeMsg.parts[0];
    const beforeTool = beforeMsg.parts[1];
    // tool part 之后的新 delta 开新 text part（保持 text→tool→text 呈现顺序），
    // 已有 part 引用全部共享——assistant-ui 只重渲染新增 part
    const s2 = reduce(s, delta("m1", "，世界"));
    const afterMsg = s2.messages[0] as ThreadMsg;
    expect(afterMsg).not.toBe(beforeMsg); // 消息引用更新
    expect(afterMsg.parts[0]).toBe(beforeText); // 未变 part 引用共享
    expect(afterMsg.parts[1]).toBe(beforeTool);
    expect(afterMsg.parts).toHaveLength(3);
    expect((afterMsg.parts[2] as { text: string }).text).toBe("，世界");
    // 连续 delta 则原地延长末尾 text part
    const s3 = reduce(s2, delta("m1", "！"));
    const m3 = s3.messages[0] as ThreadMsg;
    expect(m3.parts).toHaveLength(3);
    expect((m3.parts[2] as { text: string }).text).toBe("，世界！");
  });
});

describe("SessionReducer 事件语义", () => {
  it("完整 turn 生命周期：started → delta×N → completed", () => {
    seqCounter = 0;
    let s = initialState("s1");
    s = reduce(s, ev("turn.started", { turnId: "t1" }));
    expect(s.turn).toEqual({ id: "t1", status: "running" });
    s = reduceBatch(s, [delta("m1", "A"), delta("m1", "B"), delta("m1", "C")]);
    expect(s.messages).toHaveLength(1);
    expect((s.messages[0]?.parts[0] as { text: string }).text).toBe("ABC");
    s = reduce(s, ev("turn.completed", { turnId: "t1", status: "completed" }));
    expect(s.turn.status).toBe("completed");
  });

  it("tool 链：requested → progress 累积 → output 落 preview + spillRef", () => {
    seqCounter = 0;
    let s = reduce(initialState("s1"), ev("turn.started", { turnId: "t1" }));
    s = reduce(
      s,
      ev("tool.requested", {
        callId: "c1",
        name: "bash",
        argsPreview: "ls",
        riskTier: "confirm",
        riskClass: "write",
        turnId: "t1",
      }),
    );
    s = reduce(s, ev("tool.progress", { callId: "c1", stream: "stdout", chunk: "a.ts\n" }));
    s = reduce(s, ev("tool.progress", { callId: "c1", stream: "stdout", chunk: "b.ts\n" }));
    s = reduce(
      s,
      ev("tool.output", {
        callId: "c1",
        status: "ok",
        preview: "a.ts\nb.ts",
        spillRef: "artifact://x",
      }),
    );
    const tool = s.messages[0]?.parts.find((p) => p.type === "tool");
    expect(tool).toMatchObject({
      status: "ok",
      progress: "a.ts\nb.ts\n",
      outputPreview: "a.ts\nb.ts",
      spillRef: "artifact://x",
    });
  });

  it("permission.ask 入 pendingApprovals", () => {
    seqCounter = 0;
    const s = reduce(
      initialState("s1"),
      ev("permission.ask", {
        askId: "a1",
        callId: "c1",
        risk: "high",
        cls: "irreversible",
        action: "bash",
        detail: { command: "rm -rf build/" },
        expiresAt: 1_700_000_060_000,
      }),
    );
    expect(s.pendingApprovals).toHaveLength(1);
    expect(s.pendingApprovals[0]?.askId).toBe("a1");
  });

  it("context.compacted / 带更高 epoch 的事件推进 epoch（只增不减）", () => {
    seqCounter = 0;
    let s = reduce(initialState("s1"), ev("turn.started", { turnId: "t1" }));
    const compacted = {
      ...ev("context.compacted", { summarySeq: 1 }),
      epoch: 3,
    } as unknown as ArcEvent;
    s = reduce(s, compacted);
    expect(s.epoch).toBe(3);
    const older = { ...delta("m1", "x"), epoch: 1 } as unknown as ArcEvent;
    s = reduce(s, older);
    expect(s.epoch).toBe(3); // 不回退
  });

  it("session.error 落 lastError（5 键 envelope 的 user_message）", () => {
    seqCounter = 0;
    const s = reduce(
      initialState("s1"),
      ev("session.error", {
        error: {
          status: "error",
          tool: "provider",
          error_class: "INTERNAL",
          user_message: "provider exhausted retries",
          retry_allowed: false,
        },
      }),
    );
    expect(s.lastError).toBe("provider exhausted retries");
  });
});
