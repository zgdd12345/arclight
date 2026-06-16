// provider 共享限流：所有 session / subagent 共用同一实例（spec §6 真并行前提）。
// 两道闸：① 并发槽（同时在飞的 provider 流上限）② RPM 令牌桶（按端点请求速率）。
// 接入点见 provider-manager.ts（构造期 wrap callProvider 稳定委托，Task 5）。
//
// TPM 不在此前置闸：精确 token 仅响应回来后（ProviderResult.usage）已知，请求前不可靠，
// 改由 workflow 层 TokenBudget（onUsage 事后记账 + 准入预检）治理。
// 429 退避重试沿用 query-loop.ts:98 既有指数退避（区分 retryable）；本器只做前置节流。
import { abortError, Semaphore } from "./concurrency";
import type { CallProvider } from "./types";

export type RateLimiterOpts = {
  /** 同时在飞的 provider 流上限，默认 8（与 LoopDeps.readConcurrency 同量级）。 */
  maxConcurrent?: number;
  /** 每分钟请求数上限（令牌桶，突发容量 = rpm）；0/缺省 = 不限速。 */
  rpm?: number;
  /** 注入时钟（ms），测试用。 */
  now?: () => number;
  /** 注入 sleep，测试用。 */
  sleep?: (ms: number) => Promise<void>;
};

export class SharedRateLimiter {
  private readonly sem: Semaphore;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private last: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RateLimiterOpts = {}) {
    this.sem = new Semaphore(Math.max(1, opts.maxConcurrent ?? 8));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const rpm = opts.rpm ?? 0;
    if (rpm > 0) {
      this.capacity = rpm;
      this.refillPerMs = rpm / 60_000;
      this.tokens = rpm;
    } else {
      this.capacity = Number.POSITIVE_INFINITY;
      this.refillPerMs = Number.POSITIVE_INFINITY;
      this.tokens = Number.POSITIVE_INFINITY;
    }
    this.last = this.now();
  }

  private refill(): void {
    if (this.refillPerMs === Number.POSITIVE_INFINITY) return;
    const t = this.now();
    const elapsed = t - this.last;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.last = t;
  }

  /** 获取一次发起许可：先占并发槽，再等 RPM 令牌。返回释放并发槽的 release。 */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    const release = await this.sem.acquire(signal);
    try {
      for (;;) {
        if (signal?.aborted) throw abortError();
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return release;
        }
        const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
        await this.sleep(waitMs);
      }
    } catch (e) {
      release();
      throw e;
    }
  }

  /** 包装 CallProvider：发起前过两道闸，流结束/中断时释放并发槽。 */
  wrap(provider: CallProvider): CallProvider {
    // async generator 内无法直接引用 this，用局部 self 避免 noThisInStatic 规则
    const self = this;
    return async function* wrapped(messages, tools, signal) {
      const release = await self.acquire(signal);
      try {
        return yield* provider(messages, tools, signal);
      } finally {
        release();
      }
    };
  }
}
