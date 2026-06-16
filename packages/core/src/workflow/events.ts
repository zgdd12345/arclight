import type { ArcEvent } from "@arclight/protocol";
import type { DraftEvent } from "../db/appendEvent";
import { WORKFLOW_EVENTS } from "./types";

/** 发射上下文：绑父会话（落主流 SSE）+ 本次 workflow run。turnId = 发起 workflow 的父 turn。 */
export type WorkflowEventsCtx = {
  sessionId: string; // 父会话 id（workflow.* 落主流靠它）
  turnId?: string; // 发起 workflow 的父 turn（可选）
  workflowId: string; // workflow_runs.id（runId）
};

/**
 * workflow.* 宿主侧发射器（spec §8）。所有事件经注入的 emit（= WorkflowContext.emit = appendEvent 包装，
 * M0 §9）持久化 + bus 扇出，即「进度帧旁路」——绝不经 queryLoop 主叙事 yield。emit 与 query-loop.ts
 * 的闭包同型（seq/epoch/ts 由 appendEvent 事务内分配，调用方不得自带：DraftEvent 已 Omit 三者）。
 *
 * 事件名经 M0 常量 WORKFLOW_EVENTS 引用（单一真相源），protocol schema 字面量同源于 spec §8。
 *
 * §2.1 asyncify：发射在宿主侧完成，不回灌挂起中的 QuickJS guest。
 */
export class WorkflowEvents {
  constructor(
    private readonly emit: (draft: DraftEvent) => ArcEvent,
    private readonly ctx: WorkflowEventsCtx,
  ) {}

  private base() {
    return {
      v: 1 as const,
      sessionId: this.ctx.sessionId,
      ...(this.ctx.turnId !== undefined ? { turnId: this.ctx.turnId } : {}),
      workflowId: this.ctx.workflowId,
    };
  }

  started(name: string): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.started, name });
  }

  phase(title: string): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.phase, title });
  }

  agentStarted(a: { agentId: string; role: string; agentSeq: number }): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.agentStarted, ...a });
  }

  agentCompleted(a: { agentId: string; status: "ok" | "failed" }): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.agentCompleted, ...a });
  }

  completed(): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.completed });
  }

  failed(reason: "error" | "interrupted", message: string): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.failed, reason, message });
  }
}
