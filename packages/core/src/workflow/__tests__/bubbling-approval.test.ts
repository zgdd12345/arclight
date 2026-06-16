import { describe, expect, test } from "bun:test";
import type { Tool } from "@arclight/protocol";
import type { ApprovalDecision, ApprovalSeam, LoopToolContext } from "../../loop/types";
import { BubblingApprovalSeam } from "../bubbling-approval";

const fakeTool = { meta: { name: "bash" } } as unknown as Tool<unknown, unknown>;

function childCtx(): LoopToolContext {
  return {
    sessionId: "s-child",
    turnId: "t-child",
    callId: "call-1",
    cwd: "/repo",
    signal: new AbortController().signal,
    emitProgress: () => {},
  };
}

describe("BubblingApprovalSeam：subagent 审批冒泡到父会话（spec §9）", () => {
  test("ctx.sessionId 重绑父会话；turnId/callId/signal 保留；allow 透传", async () => {
    let received: LoopToolContext | undefined;
    const parent: ApprovalSeam = {
      check: async (_t, _a, ctx) => {
        received = ctx;
        return { decision: "allow" };
      },
    };
    const ctx = childCtx();
    const seam = new BubblingApprovalSeam(parent, "s-parent");

    const d = await seam.check(fakeTool, { command: "ls" }, ctx);

    expect(d).toEqual({ decision: "allow" });
    expect(received?.sessionId).toBe("s-parent"); // 落主流靠它
    expect(received?.turnId).toBe("t-child"); // subagent turn 仍转 awaiting_approval
    expect(received?.callId).toBe("call-1"); // 决议回灌按 callId/askId 关联
    expect(received?.signal).toBe(ctx.signal); // 中断信号透传
  });

  test("deny（含 errorClass）原样透传——loop 据此封 envelope 回灌子 LLM", async () => {
    const denial: ApprovalDecision = {
      decision: "deny",
      reason: "user denied",
      errorClass: "APPROVAL_DENIED",
    };
    const parent: ApprovalSeam = { check: async () => denial };
    const seam = new BubblingApprovalSeam(parent, "s-parent");
    const d = await seam.check(fakeTool, { command: "rm -rf /" }, childCtx());
    expect(d).toEqual(denial);
  });

  test("不改写原 ctx 对象（重绑产生新对象，子 ctx 不被污染）", async () => {
    const parent: ApprovalSeam = { check: async () => ({ decision: "allow" }) };
    const ctx = childCtx();
    const seam = new BubblingApprovalSeam(parent, "s-parent");
    await seam.check(fakeTool, {}, ctx);
    expect(ctx.sessionId).toBe("s-child"); // 原 ctx 未被 mutate
  });
});
