import { describe, expect, test } from "bun:test";
import { runWorkflowScript } from "../runtime";
import type { WorkflowPrimitives } from "../types";

// WorkflowPrimitives 是 M0 全集（8 字段）。M1 runtime 仅绑定 agent/log/phase/args 四个 guest 全局；
// parallel/pipeline/workflow/budget 在此仅为满足契约类型的桩（M1 不向 guest 暴露，注入归 M6）。
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

describe("workflow runtime (QuickJS asyncify)", () => {
  test("evaluates a script and returns its final expression", async () => {
    const res = await runWorkflowScript("1 + 2", stubPrimitives());
    expect(res).toEqual({ status: "completed", output: 3 });
  });

  test("guest cannot reach host globals (fs/net/process)", async () => {
    const script = `JSON.stringify({
      process: typeof process,
      fetch: typeof fetch,
      require: typeof require,
      Bun: typeof Bun,
      agent: typeof agent,
    })`;
    const res = await runWorkflowScript(script, stubPrimitives());
    expect(res.status).toBe("completed");
    const probe = JSON.parse((res as { output: string }).output);
    expect(probe).toEqual({
      process: "undefined",
      fetch: "undefined",
      require: "undefined",
      Bun: "undefined",
      agent: "function",
    });
  });

  test("Date.now is stubbed to throw (determinism)", async () => {
    const res = await runWorkflowScript("Date.now()", stubPrimitives());
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("Date.now");
  });

  test("Math.random is stubbed to throw (determinism)", async () => {
    const res = await runWorkflowScript("Math.random()", stubPrimitives());
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("Math.random");
  });

  // asyncify 设计原则：newAsyncifiedFunction 使宿主 async 在 guest 侧表现为同步调用
  // (WASM 经 asyncify 挂起期间宿主 async 完整运行，无需 guest 用 await)。
  // QuickJS-ng global eval 模式不支持 top-level await（SyntaxError），与 asyncify 单挂起语义一致。
  test("agent() primitive is injected and callable (single asyncify suspend)", async () => {
    let seen = "";
    const res = await runWorkflowScript(
      `const r = agent("hello", { label: "x" }); r.echo`,
      stubPrimitives({
        agent: async (prompt, opts) => {
          seen = `${prompt}:${opts?.label}`;
          return { echo: (prompt as string).toUpperCase() };
        },
      }),
    );
    expect(seen).toBe("hello:x");
    expect(res).toEqual({ status: "completed", output: "HELLO" });
  });

  test("guest syntax error is normalized to a structured failure", async () => {
    const res = await runWorkflowScript("const = ;", stubPrimitives());
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error.length).toBeGreaterThan(0);
  });

  test("top-level throw is normalized to a structured failure", async () => {
    const res = await runWorkflowScript(`throw new Error("boom")`, stubPrimitives());
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("boom");
  });
});
