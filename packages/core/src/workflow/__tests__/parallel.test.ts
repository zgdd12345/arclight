import { describe, expect, test } from "bun:test";
import { makeParallel, WorkflowApiError } from "../primitives";
import { Scheduler, TokenBudget } from "../scheduler";
import type { AgentSpec, RunSubagent, SubagentResult } from "../types";

const liveSignal = () => new AbortController().signal;

describe("parallel", () => {
  test("真并发：4 specs 同时在临界区（峰值=4，≤池上限）", async () => {
    let active = 0;
    let peak = 0;
    const gate: Array<() => void> = [];
    const run: RunSubagent = async (spec) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => gate.push(r));
      active -= 1;
      return { ok: true, value: spec.prompt };
    };
    const sched = new Scheduler({ signal: liveSignal(), maxConcurrent: 4 });
    const parallel = makeParallel(sched, run);
    const p = parallel([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }, { prompt: "d" }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(4);
    while (gate.length) gate.shift()?.();
    expect(await p).toEqual(["a", "b", "c", "d"]); // 保序
  });

  test("失败项 → null（普通失败 + 意外 throw），其余不受影响", async () => {
    const run: RunSubagent = async (spec) => {
      if (spec.prompt === "fail") return { ok: false, status: "failed", error: "boom" };
      if (spec.prompt === "throw") throw new Error("unexpected");
      return { ok: true, value: { echoed: spec.prompt } };
    };
    const sched = new Scheduler({ signal: liveSignal(), maxConcurrent: 8 });
    const out = await makeParallel(
      sched,
      run,
    )([{ prompt: "x" }, { prompt: "fail" }, { prompt: "throw" }, { prompt: "y" }]);
    expect(out).toEqual([{ echoed: "x" }, null, null, { echoed: "y" }]);
  });

  test("run-fatal（abort）冒泡，不被吞成 null", async () => {
    const ac = new AbortController();
    ac.abort();
    const run: RunSubagent = async () => ({ ok: true, value: "x" });
    const parallel = makeParallel(new Scheduler({ signal: ac.signal }), run);
    await expect(parallel([{ prompt: "a" }])).rejects.toThrow("aborted");
  });

  test("run-fatal（budget 耗尽）冒泡", async () => {
    const budget = new TokenBudget(5);
    budget.charge(5);
    const run: RunSubagent = async () => ({ ok: true, value: "x" });
    const parallel = makeParallel(new Scheduler({ signal: liveSignal(), budget }), run);
    await expect(parallel([{ prompt: "a" }])).rejects.toThrow("budget");
  });

  test("§2.1 asyncify 守卫：闭包字段被拒（不可序列化）", async () => {
    const run: RunSubagent = async () => ({ ok: true, value: "x" });
    const parallel = makeParallel(new Scheduler({ signal: liveSignal() }), run);
    const bad = [{ prompt: "a", onResult: () => {} }] as unknown as AgentSpec[];
    await expect(parallel(bad)).rejects.toThrow(WorkflowApiError);
  });

  test("非数组 specs / 空 prompt 抛 WorkflowApiError", async () => {
    const run: RunSubagent = async () => ({ ok: true, value: "x" }) as SubagentResult;
    const parallel = makeParallel(new Scheduler({ signal: liveSignal() }), run);
    await expect(parallel("nope" as unknown as AgentSpec[])).rejects.toThrow(WorkflowApiError);
    await expect(parallel([{ prompt: "" }])).rejects.toThrow(WorkflowApiError);
  });

  test("§2.1 单挂起：结果完全物化为纯数组（无 Promise / 无 guest 再入）", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    const out = await makeParallel(
      new Scheduler({ signal: liveSignal(), maxConcurrent: 2 }),
      run,
    )([{ prompt: "a" }, { prompt: "b" }]);
    expect(Array.isArray(out)).toBe(true);
    for (const v of out) expect(v instanceof Promise).toBe(false);
  });
});
