// biome-ignore-all lint/suspicious/noTemplateCurlyInString: intentional ${...} test inputs for interpolate()
import { describe, expect, test } from "bun:test";
import { interpolate, makePipeline, WorkflowApiError } from "../primitives";
import { Scheduler } from "../scheduler";
import type { RunSubagent, StageSpec } from "../types";

const liveSignal = () => new AbortController().signal;

describe("interpolate", () => {
  test("${item}/${index}/${prev.path} 点路径取值", () => {
    expect(interpolate("hi ${item}", { item: "x", index: 0, prev: null })).toBe("hi x");
    expect(interpolate("#${index}", { item: "x", index: 2, prev: null })).toBe("#2");
    expect(interpolate("p=${prev.name}", { item: null, index: 0, prev: { name: "z" } })).toBe(
      "p=z",
    );
  });
  test("对象值 → JSON.stringify", () => {
    expect(interpolate("${item}", { item: { a: 1 }, index: 0, prev: null })).toBe('{"a":1}');
  });
  test("undefined 取值抛 WorkflowApiError", () => {
    expect(() => interpolate("${prev.x}", { item: null, index: 0, prev: null })).toThrow(
      WorkflowApiError,
    );
  });
  test("拒绝任意表达式（非法路径段）", () => {
    expect(() => interpolate("${item.length - 1}", { item: "ab", index: 0, prev: null })).toThrow(
      WorkflowApiError,
    );
    expect(() => interpolate("${item()}", { item: "ab", index: 0, prev: null })).toThrow(
      WorkflowApiError,
    );
  });
  test("__proto__ 顶层段被拒（own-property guard）", () => {
    expect(() => interpolate("${__proto__}", { item: "x", index: 0, prev: null })).toThrow(
      WorkflowApiError,
    );
  });
  test("item.__proto__ 嵌套段被拒（own-property guard）", () => {
    expect(() =>
      interpolate("${item.__proto__}", { item: { a: 1 }, index: 0, prev: null }),
    ).toThrow(WorkflowApiError);
  });
  test("空占位符 ${} 抛 WorkflowApiError", () => {
    expect(() => interpolate("${}", { item: "x", index: 0, prev: null })).toThrow(WorkflowApiError);
  });
  test("回归：${index}=0（falsy own 值）正常插值为 '0'", () => {
    expect(interpolate("#${index}", { item: "x", index: 0, prev: null })).toBe("#0");
  });
});

describe("pipeline", () => {
  test("单 stage 等价 map", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    const out = await makePipeline(new Scheduler({ signal: liveSignal(), maxConcurrent: 8 }), run)(
      ["a", "b"],
      { prompt: "do ${item}" },
    );
    expect(out).toEqual(["do a", "do b"]);
  });

  test("多 stage：prev 串联", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: `${s.prompt}!` });
    const out = await makePipeline(new Scheduler({ signal: liveSignal(), maxConcurrent: 8 }), run)(
      ["x"],
      { prompt: "s1:${item}" },
      { prompt: "s2:${prev}" },
    );
    // s1 → "s1:x!" ; s2 prompt="s2:s1:x!" → "s2:s1:x!!"
    expect(out).toEqual(["s2:s1:x!!"]);
  });

  test("无 barrier：item 间并发，不按 stage 全局对齐", async () => {
    const order: string[] = [];
    const gates: Record<string, Array<() => void>> = {};
    const wait = (key: string) =>
      new Promise<void>((r) => {
        const existing = gates[key];
        if (existing) {
          existing.push(r);
        } else {
          gates[key] = [r];
        }
      });
    const run: RunSubagent = async (s) => {
      order.push(s.prompt);
      await wait(s.prompt);
      return { ok: true, value: s.prompt };
    };
    const p = makePipeline(new Scheduler({ signal: liveSignal(), maxConcurrent: 8 }), run)(
      ["A", "B"],
      { prompt: "s1-${item}" },
      { prompt: "s2-${item}" },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect([...order].sort()).toEqual(["s1-A", "s1-B"]); // 两 item 的 stage1 都已起跑
    gates["s1-A"]?.shift()?.(); // 放行 A 的 stage1 → A 进 stage2（B 仍卡 stage1）
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toContain("s2-A");
    expect(order).not.toContain("s2-B"); // 无 barrier
    for (let i = 0; i < 6; i++) {
      for (const k of Object.keys(gates)) while (gates[k]?.length) gates[k]?.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await p;
  });

  test("per-item 失败隔离：某 item 某 stage 失败/抛错 → 该 item null，其余完成", async () => {
    const run: RunSubagent = async (s) => {
      if (s.prompt === "s2-bad") return { ok: false, status: "failed", error: "x" };
      if (s.prompt === "s1-throw") throw new Error("boom");
      return { ok: true, value: s.prompt };
    };
    const out = await makePipeline(new Scheduler({ signal: liveSignal(), maxConcurrent: 8 }), run)(
      ["good", "bad", "throw"],
      { prompt: "s1-${item}" },
      { prompt: "s2-${item}" },
    );
    // good: s1-good→s2-good="s2-good" ; bad: s2-bad 失败→null ; throw: s1-throw 抛→null(跳 s2)
    expect(out).toEqual(["s2-good", null, null]);
  });

  test("空 stages 抛 WorkflowApiError", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    await expect(makePipeline(new Scheduler({ signal: liveSignal() }), run)(["a"])).rejects.toThrow(
      WorkflowApiError,
    );
  });

  test("§2.1 闭包 stage 被拒", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    const bad = [{ prompt: "p", transform: () => {} }] as unknown as StageSpec[];
    await expect(
      makePipeline(new Scheduler({ signal: liveSignal() }), run)(["a"], ...bad),
    ).rejects.toThrow(WorkflowApiError);
  });

  test("run-fatal（abort）冒泡", async () => {
    const ac = new AbortController();
    ac.abort();
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    await expect(
      makePipeline(new Scheduler({ signal: ac.signal }), run)(["a"], { prompt: "${item}" }),
    ).rejects.toThrow("aborted");
  });
});
