// 并发原语：abort-aware FIFO 信号量 + 统一 AbortError。
// 落在 loop/（低层）——被 loop/rate-limiter.ts 与 workflow/scheduler.ts 共用，
// 避免高层 workflow/ 被低层 loop/ 反向依赖（循环依赖）。

/** 统一取消错误：name="AbortError"，便于 isAbortError 跨层识别（与 DOM AbortSignal 语义一致）。 */
export function abortError(message = "aborted"): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

type Waiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
};

/**
 * FIFO 信号量。acquire 拿到一次性 release；release 时若有等待者，直接把许可移交给队首
 * （不回弹计数，避免唤醒竞争），否则归还许可。release 幂等。
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Waiter[] = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be a positive integer, got ${permits}`);
    }
    this.permits = permits;
  }

  /** 当前空闲许可数（仅供测试/可观测）。 */
  get available(): number {
    return this.permits;
  }

  /** 当前排队等待者数（仅供测试/可观测）。 */
  get pending(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => resolve(this.makeRelease()),
        reject,
        signal,
        onAbort: () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(abortError());
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.onAbort);
        next.resolve(); // 移交许可：计数保持被占用
      } else {
        this.permits += 1;
      }
    };
  }
}
