import { describe, expect, test } from "bun:test";
import {
  BudgetExceededError,
  defaultConcurrency,
  Scheduler,
  SchedulerExhaustedError,
  TokenBudget,
} from "../scheduler";
import type { Budget } from "../types";

describe("TokenBudget", () => {
  test("charge / spent / remaining / exhausted", () => {
    const b = new TokenBudget(100);
    expect(b.remaining()).toBe(100);
    b.charge(30);
    expect(b.spent()).toBe(30);
    expect(b.remaining()).toBe(70);
    expect(b.exhausted()).toBe(false);
    b.charge(70);
    expect(b.exhausted()).toBe(true);
    expect(b.remaining()).toBe(0);
  });

  test("structurally 满足 M0 Budget（total 公开 + spent/remaining 方法）", () => {
    const b: Budget = new TokenBudget(100); // 编译期钉死 implements Budget
    expect(b.total).toBe(100);
    expect(b.spent()).toBe(0);
    expect(b.remaining()).toBe(100);
  });

  test("耗尽后 assertAvailable 抛 BudgetExceededError", () => {
    const b = new TokenBudget(10);
    b.charge(10);
    expect(() => b.assertAvailable()).toThrow(BudgetExceededError);
  });

  test("非法 total / 负 charge 抛错", () => {
    expect(() => new TokenBudget(0)).toThrow();
    const b = new TokenBudget(10);
    expect(() => b.charge(-1)).toThrow();
  });
});

const liveSignal = () => new AbortController().signal;

describe("Scheduler", () => {
  test("submit 运行任务并返回值，记录 admittedCount", async () => {
    const s = new Scheduler({ signal: liveSignal(), maxConcurrent: 4 });
    const out = await s.submit(async () => 42);
    expect(out).toBe(42);
    expect(s.admittedCount).toBe(1);
  });

  test("并发受 maxConcurrent 限制（峰值不超）", async () => {
    const s = new Scheduler({ signal: liveSignal(), maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const gate: Array<() => void> = [];
    const make = () =>
      s.submit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((res) => gate.push(res));
        active -= 1;
      });
    const ps = [make(), make(), make(), make()];
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(2);
    // 多轮放行，吸收 release→移交许可后新启动的任务
    for (let i = 0; i < 6; i++) {
      while (gate.length) gate.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(ps);
    expect(peak).toBe(2);
  });

  test("已 abort 的 run signal → submit 拒绝，任务不运行", async () => {
    const ac = new AbortController();
    ac.abort();
    const s = new Scheduler({ signal: ac.signal });
    let ran = false;
    await expect(
      s.submit(async () => {
        ran = true;
      }),
    ).rejects.toThrow("aborted");
    expect(ran).toBe(false);
  });

  test("budget 耗尽 → submit 拒绝（BudgetExceededError），任务不运行", async () => {
    const budget = new TokenBudget(10);
    budget.charge(10);
    const s = new Scheduler({ signal: liveSignal(), budget });
    let ran = false;
    await expect(
      s.submit(async () => {
        ran = true;
      }),
    ).rejects.toThrow(BudgetExceededError);
    expect(ran).toBe(false);
  });

  test("maxAgentsPerRun backstop", async () => {
    const s = new Scheduler({ signal: liveSignal(), maxConcurrent: 8, maxAgentsPerRun: 2 });
    await s.submit(async () => 1);
    await s.submit(async () => 2);
    await expect(s.submit(async () => 3)).rejects.toThrow(SchedulerExhaustedError);
  });

  test("defaultConcurrency 在 [1,16] 内", () => {
    const n = defaultConcurrency();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(16);
  });

  test("task 抛错时 permit 正确释放，后续任务可进入", async () => {
    const s = new Scheduler({ signal: liveSignal(), maxConcurrent: 1 });
    await expect(
      s.submit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await s.submit(async () => "ok");
    expect(result).toBe("ok");
  });

  test("submit 把 signal 传给 task", async () => {
    const sig = liveSignal();
    const s = new Scheduler({ signal: sig });
    let received: AbortSignal | undefined;
    await s.submit(async (signal) => {
      received = signal;
      return 0;
    });
    expect(received).toBe(sig);
  });
});
