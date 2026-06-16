import { describe, expect, test } from "bun:test";
import { makeWorkflowPrimitives } from "../primitives";
import { runWorkflowScript } from "../runtime";
import { makeCtx, scriptedProvider } from "./fixtures";

// M1 无公开 runWorkflow（公开入口 createWorkflowRuntime/runWorkflow 归 M6）；
// 本测直接组合低层 runWorkflowScript + makeWorkflowPrimitives 验证顺序脚本跑通。
const run = (script: string, args: unknown, ctx: ReturnType<typeof makeCtx>) =>
  runWorkflowScript(script, makeWorkflowPrimitives(ctx, args));

describe("sequential script (runWorkflowScript + makeWorkflowPrimitives)", () => {
  test("runs multiple agent() calls in sequence and returns the script result", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "RESULT-A", toolCalls: [], finishReason: "stop" } },
      { result: { text: "RESULT-B", toolCalls: [], finishReason: "stop" } },
    ]);
    const phases: string[] = [];
    const ctx = makeCtx({ provider, onPhase: (t) => phases.push(t) });
    const script = `
      phase("step-1");
      const a = agent("first");
      const b = agent("second using " + a);
      ({ a, b });
    `;
    const res = await run(script, { seed: 1 }, ctx);
    expect(res).toEqual({ status: "completed", output: { a: "RESULT-A", b: "RESULT-B" } });
    expect(phases).toEqual(["step-1"]);
  });

  test("args are injected and readable in the guest", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "ok", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await run(`args.topic`, { topic: "qubits" }, makeCtx({ provider }));
    expect(res).toEqual({ status: "completed", output: "qubits" });
  });

  test("top-level throw fails the run", async () => {
    const { provider } = scriptedProvider([]);
    const res = await run(`throw new Error("script blew up")`, {}, makeCtx({ provider }));
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("script blew up");
  });
});
