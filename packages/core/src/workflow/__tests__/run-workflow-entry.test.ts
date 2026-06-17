import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowRuntime, runWorkflow, WorkflowStore } from "../index";
import type { WorkflowContext, WorkflowStorePort } from "../types";
import { dummyStore, makeCtx, scriptedProvider } from "./fixtures";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// store typed as WorkflowStorePort (non-optional) — exactOptionalPropertyTypes-safe.
function ctxFor(
  store: WorkflowStorePort,
  provider: WorkflowContext["callProvider"],
): WorkflowContext {
  const base = makeCtx({ provider });
  return { ...base, parentSessionId: "s", parentTurnId: "t", store, emit: () => ({}) as never };
}

describe("M6：公开 runWorkflow(scriptOrName, args, ctx)", () => {
  test("入口经 index 可达，且与 createWorkflowRuntime 同为公开面", () => {
    expect(typeof runWorkflow).toBe("function");
    expect(typeof createWorkflowRuntime).toBe("function");
  });

  test("内联脚本（含语法符号）→ 原样作临场合成源码执行", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "OUT", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runWorkflow(`agent("synth")`, {}, ctxFor(dummyStore, provider));
    expect(res).toMatchObject({ status: "completed", output: "OUT" });
  });

  test("slug 命名 → 从 store 载入命名脚本执行", async () => {
    const d = mkdtempSync(join(tmpdir(), "wf-entry-"));
    dirs.push(d);
    const store = new WorkflowStore(d);
    store.save("gate-circuit", `agent("build")`);
    const { provider } = scriptedProvider([
      { result: { text: "BUILT", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runWorkflow("gate-circuit", {}, ctxFor(store, provider));
    expect(res).toMatchObject({ status: "completed", output: "BUILT" });
  });

  test("slug 命名但未存 → 抛错（不把裸标识符当脚本跑，安全默认）", async () => {
    const d = mkdtempSync(join(tmpdir(), "wf-entry-"));
    dirs.push(d);
    const store = new WorkflowStore(d);
    const { provider } = scriptedProvider([]);
    await expect(runWorkflow("missing-flow", {}, ctxFor(store, provider))).rejects.toThrow(
      /no such named workflow/,
    );
  });
});
