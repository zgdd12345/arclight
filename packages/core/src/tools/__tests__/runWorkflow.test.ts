import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@arclight/protocol";
import type { LoopToolContext } from "../../loop/types";
import type { WorkflowResult } from "../../workflow";
import { WorkflowStore } from "../../workflow";
import { RUN_WORKFLOW_TOOL_NAME, runWorkflowTool } from "../builtin/runWorkflow";
import { makeExecuteTool } from "../registry";

const tool = runWorkflowTool as unknown as Tool<unknown, unknown>;

const dirs: string[] = [];
function freshStore(): WorkflowStore {
  const d = mkdtempSync(join(tmpdir(), "wf-tool-"));
  dirs.push(d);
  return new WorkflowStore(d);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 假 launch：M6 per-call 接缝 (source, args, toolCtx) => Promise<WorkflowResult>。
function spyLaunch() {
  const calls: { source: string; args: unknown; sessionId: string; signalAborted: boolean }[] = [];
  const launch = (source: string, args: Record<string, unknown>, toolCtx: LoopToolContext) => {
    calls.push({
      source,
      args,
      sessionId: toolCtx.sessionId,
      signalAborted: toolCtx.signal.aborted,
    });
    return Promise.resolve<WorkflowResult>({ status: "completed", output: { ran: source } });
  };
  return { launch, calls };
}

function ctx(signal: AbortSignal): LoopToolContext {
  return { sessionId: "s", turnId: "t", callId: "c", cwd: "/tmp", signal, emitProgress: () => {} };
}

describe("run_workflow 工具：临场合成入口（spec §1/§12.5/§14）", () => {
  test("meta 非 safe/read → classify 永不 auto-allow（防子 agent 静默自起 workflow，§10/§1）", () => {
    expect(runWorkflowTool.meta.name).toBe(RUN_WORKFLOW_TOOL_NAME);
    expect(runWorkflowTool.meta.isReadOnly).toBe(false);
    expect(runWorkflowTool.meta.riskTier).not.toBe("safe");
    expect(runWorkflowTool.meta.executesShellCommands).toBe(false);
  });

  test("inline script → 经 makeExecuteTool 注入 workflows，launch 收到内联源码 + 父会话 ctx", async () => {
    const { launch, calls } = spyLaunch();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, launch } });
    const out = await execute(
      tool,
      { script: "await agent('synth'); return 1;", args: { seed: 1 } },
      ctx(new AbortController().signal),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.preview).toContain("completed");
    expect(calls[0]?.source).toBe("await agent('synth'); return 1;");
    expect(calls[0]?.args).toEqual({ seed: 1 });
    expect(calls[0]?.sessionId).toBe("s"); // 父会话 ctx 透传（事件绑父会话靠它）
  });

  test("script + saveAs → 先持久化再运行（命名复用）", async () => {
    const { launch } = spyLaunch();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, launch } });
    await execute(
      tool,
      { script: "return 42;", saveAs: "kept-flow" },
      ctx(new AbortController().signal),
    );
    expect(store.has("kept-flow")).toBe(true);
    expect(store.load("kept-flow").source).toBe("return 42;");
  });

  test("name 指定已存 workflow → launch 收到存储源码", async () => {
    const { launch, calls } = spyLaunch();
    const store = freshStore();
    store.save("gate-circuit", "STORED_SRC");
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, launch } });
    await execute(tool, { name: "gate-circuit" }, ctx(new AbortController().signal));
    expect(calls[0]?.source).toBe("STORED_SRC");
  });

  test("name 不存在 → VALIDATION envelope（可重试，LLM 改入参）", async () => {
    const { launch } = spyLaunch();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, launch } });
    const out = await execute(tool, { name: "ghost" }, ctx(new AbortController().signal));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.envelope.error_class).toBe("VALIDATION");
      expect(out.envelope.retry_allowed).toBe(true);
    }
  });

  test("name 非 slug（含空格/大写）→ zod 边界 VALIDATION（可重试，非 EXEC_FAILED）", async () => {
    const { launch } = spyLaunch();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, launch } });
    const out = await execute(tool, { name: "Invalid Name" }, ctx(new AbortController().signal));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.envelope.error_class).toBe("VALIDATION");
      expect(out.envelope.retry_allowed).toBe(true);
    }
  });

  test("同时给 name 和 script → schema refine 拒绝（VALIDATION）", async () => {
    const { launch } = spyLaunch();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, launch } });
    const out = await execute(
      tool,
      { name: "a", script: "return 1;" },
      ctx(new AbortController().signal),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.envelope.error_class).toBe("VALIDATION");
  });

  test("未注入 workflows → INTERNAL envelope", async () => {
    const execute = makeExecuteTool({ sandbox: {} as never }); // 无 workflows
    const out = await execute(tool, { script: "return 1;" }, ctx(new AbortController().signal));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.envelope.error_class).toBe("INTERNAL");
  });
});
