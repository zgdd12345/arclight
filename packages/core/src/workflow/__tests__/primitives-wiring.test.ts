// DIVERGENCE from task spec: task spec's guest scripts use `await parallel(...)` / `await agent(...)`.
// QuickJS global eval mode treats `await` as an identifier (not a keyword) so top-level `await`
// is a SyntaxError ("expecting ';'"). Asyncify makes __parallel/__agent synchronous from the
// guest's perspective (same as existing runtime-primitives.test.ts). Scripts here use NO await.
import { describe, expect, test } from "bun:test";
import { makeWorkflowPrimitives, type PrimitiveWiring } from "../primitives";
import { runWorkflowScript } from "../runtime";
import { Scheduler, TokenBudget } from "../scheduler";
import type { AgentSpec, CallKind, RunSubagent } from "../types";
import { makeCtx, scriptedProvider } from "./fixtures";

const liveSignal = () => new AbortController().signal;

// 测试用最小 wiring：run 直接回显 prompt（无 journal/事件，那些在 Task 4 端到端验证）。
function testWiring(run: RunSubagent, total = 1000): PrimitiveWiring {
  return {
    scheduler: new Scheduler({ signal: liveSignal(), maxConcurrent: 4 }),
    run,
    workflow: async (name) => `wf:${name}`,
    budget: new TokenBudget(total),
    bindSeqs: () => {}, // 本 Task 不验 seq 落库（Task 7 e2e 验）
  };
}

describe("M6 F1-b：makeWorkflowPrimitives 接 wiring（闭合 F1）", () => {
  test("guest parallel([...specs]) 经真实 Scheduler + 宿主 Promise.all 跑通（保序）", async () => {
    const { provider } = scriptedProvider([]);
    const run: RunSubagent = async (spec) => ({ ok: true, value: spec.prompt.toUpperCase() });
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), { seed: 1 }, testWiring(run));
    const res = await runWorkflowScript(
      `const rs = parallel([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }]); rs.join("-")`,
      prims,
    );
    expect(res).toEqual({ status: "completed", output: "A-B-C" });
  });

  test("失败项 → null（subagent 普通失败不拖垮整体，spec §10）", async () => {
    const { provider } = scriptedProvider([]);
    const run: RunSubagent = async (spec) =>
      spec.prompt === "bad"
        ? { ok: false, status: "failed", error: "x" }
        : { ok: true, value: spec.prompt };
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}, testWiring(run));
    const res = await runWorkflowScript(
      `const rs = parallel([{ prompt: "ok" }, { prompt: "bad" }]); JSON.stringify(rs)`,
      prims,
    );
    expect(res.status).toBe("completed");
    expect(JSON.parse((res as { output: string }).output)).toEqual(["ok", null]);
  });

  test("budget 全局在 guest 内可读（total/remaining）", async () => {
    const { provider } = scriptedProvider([]);
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}, testWiring(run, 500));
    const res = await runWorkflowScript(`budget.total + ":" + budget.remaining()`, prims);
    expect(res).toEqual({ status: "completed", output: "500:500" });
  });

  test("agent() 经 wiring 入池（scheduler.submit）跑通", async () => {
    const { provider } = scriptedProvider([]);
    const run: RunSubagent = async (s) => ({ ok: true, value: `R:${s.prompt}` });
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}, testWiring(run));
    const res = await runWorkflowScript(`agent("hi")`, prims);
    expect(res).toEqual({ status: "completed", output: "R:hi" });
  });

  test("无 wiring（M1 顺序路径）→ parallel 仍抛错桩 → 归一为 failed", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "t", toolCalls: [], finishReason: "stop" } },
    ]);
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}); // 2 参，无 wiring
    const res = await runWorkflowScript(`parallel([{ prompt: "a" }])`, prims);
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("not wired");
  });

  test("bindSeqs 在 parallel 调度前同步按数组序预分配连续 seq（resume 确定性）", async () => {
    const { provider } = scriptedProvider([]);
    const order: { spec: AgentSpec; kind: CallKind }[] = [];
    const wiring = testWiring(async (s) => ({ ok: true, value: s.prompt }));
    wiring.bindSeqs = (specs, kind) => {
      for (const s of specs) order.push({ spec: s, kind });
    };
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}, wiring);
    await runWorkflowScript(`parallel([{ prompt: "a" }, { prompt: "b" }])`, prims);
    // bindSeqs 收到的是数组序的两个 parallel-item 规格（同步、挂起前）
    expect(order.map((o) => o.spec.prompt)).toEqual(["a", "b"]);
    expect(order.every((o) => o.kind === "parallel-item")).toBe(true);
  });
});
