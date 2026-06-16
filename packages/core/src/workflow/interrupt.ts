import type { WorkflowEvents } from "./events";
import type { RunStatus } from "./types";

/**
 * 为单个在飞 subagent 派生信号（spec §10 中断扇出）。
 * signal = AbortSignal.any([parentSignal, local.signal])：
 *  - 父 AgentRunner interrupt（runner.ts:501 ac.abort）→ parentSignal 触发 → 级联中断本 subagent；
 *  - scheduler 单独取消本 agent（限流/budget/失败收敛）→ 调返回的 abort()。
 * 任一触发即中断 subagent 的 queryLoop（query-loop.ts:43/96 见 signal.aborted → 返回 interrupted）。
 *
 * Bun 原生支持 AbortSignal.any（已验证）。
 */
export function deriveChildSignal(parentSignal: AbortSignal): {
  signal: AbortSignal;
  abort: () => void;
} {
  const local = new AbortController();
  const signal = AbortSignal.any([parentSignal, local.signal]);
  return { signal, abort: () => local.abort() };
}

/**
 * run 收口：把终态映射为 §8 终态事件（spec §10）。终态词表 = M0 RunStatus（completed|failed|interrupted）。
 *  completed   → workflow.completed
 *  interrupted → workflow.failed{reason:"interrupted"}（AbortSignal 扇出后 run 置 interrupted）
 *  failed      → workflow.failed{reason:"error"}（脚本顶层 throw）
 * journal 物理状态写入由 M3 的 journal setter 负责，本函数只发事件（不引用未建表的状态列）。
 */
export function terminalEvent(events: WorkflowEvents, outcome: RunStatus, message = ""): void {
  if (outcome === "completed") {
    events.completed();
  } else if (outcome === "interrupted") {
    events.failed("interrupted", message || "workflow interrupted");
  } else {
    events.failed("error", message || "workflow failed");
  }
}
