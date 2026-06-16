// NOTE: QuickJS global eval mode treats `await` as an identifier (not a keyword),
// so top-level `await` in guest scripts is a SyntaxError ("expecting ';'").
// asyncify makes __parallel/__pipeline/__workflow synchronous from the guest's
// perspective (exactly like __agent in M1), so no `await` is needed.
// Guest scripts below call parallel/pipeline/workflow WITHOUT await.
import { describe, expect, test } from "bun:test";
import { runWorkflowScript } from "../runtime";
import type { WorkflowPrimitives } from "../types";

function stubPrimitives(over: Partial<WorkflowPrimitives> = {}): WorkflowPrimitives {
  return {
    args: over.args ?? {},
    agent: over.agent ?? (async () => "stub"),
    log: over.log ?? (() => {}),
    phase: over.phase ?? (() => {}),
    parallel: over.parallel ?? (async () => []),
    pipeline: over.pipeline ?? (async () => []),
    workflow: over.workflow ?? (async () => null),
    budget: over.budget ?? { total: 0, spent: () => 0, remaining: () => 0 },
  };
}

describe("M6 F1-a：guest 全集绑定（parallel/pipeline/workflow/budget）", () => {
  test("四个新原语 + budget 全局在 guest 内可见且类型正确", async () => {
    const res = await runWorkflowScript(
      `JSON.stringify({
         parallel: typeof parallel,
         pipeline: typeof pipeline,
         workflow: typeof workflow,
         budget: typeof budget,
         total: budget.total,
         remaining: budget.remaining(),
       })`,
      stubPrimitives({ budget: { total: 42, spent: () => 35, remaining: () => 7 } }),
    );
    expect(res.status).toBe("completed");
    expect(JSON.parse((res as { output: string }).output)).toEqual({
      parallel: "function",
      pipeline: "function",
      workflow: "function",
      budget: "object",
      total: 42,
      remaining: 7,
    });
  });

  test("parallel([...]) 经 __parallel 一次挂起，规格 JSON 进、结果 JSON 出", async () => {
    const seen: unknown[] = [];
    const res = await runWorkflowScript(
      `const rs = parallel([{ prompt: "a" }, { prompt: "b" }]); rs.join(",")`,
      stubPrimitives({
        parallel: async (specs) => {
          seen.push(specs);
          return specs.map((s) => s.prompt.toUpperCase());
        },
      }),
    );
    expect(res).toEqual({ status: "completed", output: "A,B" });
    expect(seen).toEqual([[{ prompt: "a" }, { prompt: "b" }]]); // 宿主收到的是可序列化规格
  });

  test("pipeline(items, ...stages) 经 __pipeline 一次挂起（items+stages 同帧 marshal）", async () => {
    const res = await runWorkflowScript(
      `const rs = pipeline(["x", "y"], { prompt: "s1-\${item}" }, { prompt: "s2" }); rs.length`,
      stubPrimitives({
        pipeline: async (items, ...stages) =>
          items.map((_, i) => `${(items as string[])[i]}#${stages.length}`),
      }),
    );
    expect(res).toEqual({ status: "completed", output: 2 });
  });

  test("workflow(name, args) 经 __workflow 一次挂起（name + args JSON）", async () => {
    const res = await runWorkflowScript(
      `const r = workflow("child", { n: 1 }); JSON.stringify(r)`,
      stubPrimitives({ workflow: async (name, a) => ({ name, a }) }),
    );
    expect(res.status).toBe("completed");
    expect(JSON.parse((res as { output: string }).output)).toEqual({ name: "child", a: { n: 1 } });
  });

  test("无参 new Date() 抛错；new Date(args.now) 可用（spec §7 确定性源经 args 注入）", async () => {
    const guarded = await runWorkflowScript(
      `(() => { try { new Date(); return "no-throw"; } catch (e) { return String(e.message); } })()`,
      stubPrimitives(),
    );
    expect(guarded.status).toBe("completed");
    expect((guarded as { output: string }).output).toContain("new Date()");

    const fromArgs = await runWorkflowScript(
      `new Date(args.now).getTime()`,
      stubPrimitives({ args: { now: 1_700_000_000_000 } }),
    );
    expect(fromArgs).toEqual({ status: "completed", output: 1_700_000_000_000 });
  });

  test("回归：Date.now / Math.random 仍被桩抛错（M1 不破）", async () => {
    const d = await runWorkflowScript(`Date.now()`, stubPrimitives());
    expect(d.status).toBe("failed");
    expect((d as { error: string }).error).toContain("Date.now");
    const r = await runWorkflowScript(`Math.random()`, stubPrimitives());
    expect(r.status).toBe("failed");
    expect((r as { error: string }).error).toContain("Math.random");
  });
});
