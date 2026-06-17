import { cpus } from "node:os";
import { abortError, Semaphore } from "../loop/concurrency";
import type { Budget } from "./types"; // M0 唯一权威类型源

// ── token budget（跨整个 run 共享记账，硬上限）────────────────────────────────
export class BudgetExceededError extends Error {
  constructor(
    readonly total: number,
    readonly spent: number,
  ) {
    super(`token budget exhausted: spent ${spent} >= total ${total}`);
    this.name = "BudgetExceededError";
  }
}

/** implements M0 Budget：total/spent()/remaining() 即 guest 可见只读视图，额外提供 charge/assertAvailable/exhausted。 */
export class TokenBudget implements Budget {
  private used = 0;
  /** M0 Budget.total：guest 只读视图可见的上限（公开 readonly）。 */
  readonly total: number;

  constructor(total: number) {
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error(`TokenBudget total must be a positive finite number, got ${total}`);
    }
    this.total = total;
  }

  spent(): number {
    return this.used;
  }

  remaining(): number {
    return Math.max(0, this.total - this.used);
  }

  exhausted(): boolean {
    return this.used >= this.total;
  }

  /** 准入闸：已耗尽则抛 BudgetExceededError（agent()/scheduler 据此实现 §6/§10 硬上限）。 */
  assertAvailable(): void {
    if (this.exhausted()) throw new BudgetExceededError(this.total, this.used);
  }

  /** 累计已花 token（由 subagent 的 queryLoop onUsage 回调驱动：input+output）。 */
  charge(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new Error(`TokenBudget.charge expects a non-negative finite number, got ${tokens}`);
    }
    this.used += tokens;
  }
}

// ── 并发池 + backstop ───────────────────────────────────────────────────────
export class SchedulerExhaustedError extends Error {
  constructor(readonly maxAgentsPerRun: number) {
    super(`workflow run exceeded maxAgentsPerRun backstop (${maxAgentsPerRun})`);
    this.name = "SchedulerExhaustedError";
  }
}

export type SchedulerOpts = {
  /** run-level 取消信号（沿现有 AbortSignal 链路，spec §10 中断扇出）。 */
  signal: AbortSignal;
  /** 并发上限，默认 min(16, cores-2)，下限 1。 */
  maxConcurrent?: number;
  /** 单 run 累计 agent 上限（防失控 backstop），默认 256。 */
  maxAgentsPerRun?: number;
  /** 共享 token budget（可选）；准入时做硬上限预检。类型为最小结构接口（Scheduler 仅调用 assertAvailable），
   *  允许传入 TokenBudget 或满足该接缝的共享实例（例如来自 WorkflowContext.sharedBudget）。 */
  budget?: { assertAvailable(): void };
};

/** spec §6：默认并发上限 min(16, cores-2)，下限 1。 */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

export class Scheduler {
  private readonly sem: Semaphore;
  private readonly maxAgents: number;
  private admitted = 0;

  constructor(private readonly opts: SchedulerOpts) {
    this.sem = new Semaphore(opts.maxConcurrent ?? defaultConcurrency());
    this.maxAgents = opts.maxAgentsPerRun ?? 256;
  }

  /** 已准入（含已完成）的 agent 计数（仅供测试/可观测）。 */
  get admittedCount(): number {
    return this.admitted;
  }

  get pending(): number {
    return this.sem.pending;
  }

  /**
   * 提交一个 agent 任务入池排队。准入顺序：abort → backstop → budget → 信号量槽。
   * abort / backstop / budget 三类为 run-fatal，在 task 运行前抛出（由调用方决定冒泡）。
   */
  async submit<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.opts.signal.aborted) throw abortError();
    if (this.admitted >= this.maxAgents) throw new SchedulerExhaustedError(this.maxAgents);
    this.opts.budget?.assertAvailable();
    this.admitted += 1;

    const release = await this.sem.acquire(this.opts.signal);
    try {
      // 获槽后二次检查：排队等待期间 abort / budget 可能已变化（硬上限不可跳过）
      if (this.opts.signal.aborted) {
        release();
        throw abortError();
      }
      this.opts.budget?.assertAvailable();
      return await task(this.opts.signal);
    } finally {
      release();
    }
  }
}
