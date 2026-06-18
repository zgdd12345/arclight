import { describe, expect, test } from "bun:test";
import { createWorkflowRunner } from "../launch";

describe("createWorkflowRunner", () => {
  test("maps the calling LoopToolContext onto the WorkflowContext", async () => {
    let captured: { source: string; args: unknown; ctx: Record<string, unknown> } | undefined;
    const fakeRun = (async (source: string, args: unknown, ctx: Record<string, unknown>) => {
      captured = { source, args, ctx };
      return { status: "completed", output: { ok: 1 } };
    }) as never;

    const callProvider = (async () => ({})) as never;
    const registry = { kind: "registry" } as never;
    const approvals = { kind: "approvals" } as never;
    const executeTool = (async () => ({ ok: true })) as never;
    const store = { kind: "store" } as never;
    const journal = { kind: "journal" } as never;
    const runner = createWorkflowRunner(
      {
        db: { kind: "db" } as never,
        bus: { kind: "bus" } as never,
        callProvider,
        registry,
        approvals,
        executeTool,
        store,
        journal,
      },
      fakeRun,
    );

    const signal = new AbortController().signal;
    const toolCtx = {
      sessionId: "S",
      turnId: "T",
      callId: "C",
      cwd: "/repo",
      signal,
      emitProgress: () => {},
    };
    const res = await runner("agent('x')", { seed: 1 }, toolCtx as never);

    expect(res).toEqual({ status: "completed", output: { ok: 1 } });
    expect(captured?.source).toBe("agent('x')");
    expect(captured?.args).toEqual({ seed: 1 });
    // parent identity comes from the calling toolCtx (not crossed)
    expect(captured?.ctx.parentSessionId).toBe("S");
    expect(captured?.ctx.parentTurnId).toBe("T");
    expect(captured?.ctx.cwd).toBe("/repo");
    expect(captured?.ctx.signal).toBe(signal);
    // run dependencies come from the factory deps
    expect(captured?.ctx.callProvider).toBe(callProvider);
    expect(captured?.ctx.registry).toBe(registry);
    expect(captured?.ctx.approvals).toBe(approvals);
    expect(captured?.ctx.executeTool).toBe(executeTool);
    expect(captured?.ctx.store).toBe(store);
    expect(captured?.ctx.journal).toBe(journal);
    expect(typeof captured?.ctx.emit).toBe("function");
  });
});
