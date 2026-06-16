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

// Scheduler 段在 Task 3 追加（与 budget 同文件）：届时在顶部补
//   import { cpus } from "node:os";
//   import { Semaphore, abortError } from "../loop/concurrency";
// 并在文件末尾落地 Scheduler / SchedulerExhaustedError / defaultConcurrency。
