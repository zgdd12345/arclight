import { describe, expect, test } from "bun:test";
import { BudgetExceededError, TokenBudget } from "../scheduler";
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
