import type { Tool } from "@arclight/protocol";
import type { ApprovalDecision, ApprovalSeam, LoopToolContext } from "../loop/types";

/**
 * 跨 subagent 审批冒泡（spec §9）。注入子 agent 的 LoopDeps.approvals。
 *
 * 把 ctx.sessionId 重绑到父会话后转发给父 ApprovalPolicy：
 *  - permission.ask 落「父会话」事件流 → 现有 web SSE 直接呈现给用户（无需新前端）；
 *  - sessionAllow 本会话白名单归父会话（整个 workflow 即一个用户会话，符合预期）；
 *  - turns.status → awaiting_approval 仍作用于 subagent 的 turn（policy 用 ctx.turnId）；
 *  - callId/turnId/signal 原样保留：决议由父层 C1 经同一 askId 回写（askId 跨层唯一键），
 *    中断信号经 ctx.signal 透传到挂起的 waitForDecision。
 *
 * 并发下多个 subagent 各自的 permission.ask 并存于主流，靠 askId 区分回灌（spec §9）。
 * 返回 loop/types.ts 既有 ApprovalDecision（allow | deny{reason,errorClass?}）——不存在 RichApprovalDecision。
 * §2.1 asyncify：本接缝纯宿主侧 Promise 转发，不回灌挂起中的 guest。
 */
export class BubblingApprovalSeam implements ApprovalSeam {
  constructor(
    private readonly parent: ApprovalSeam,
    private readonly parentSessionId: string,
  ) {}

  check(
    tool: Tool<unknown, unknown>,
    args: unknown,
    ctx: LoopToolContext,
  ): Promise<ApprovalDecision> {
    // 重绑 sessionId（产生新 ctx，不 mutate 子 ctx）；其余字段透传
    return this.parent.check(tool, args, { ...ctx, sessionId: this.parentSessionId });
  }
}
