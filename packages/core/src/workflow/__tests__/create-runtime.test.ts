// DIVERGENCE from task spec: the task spec's guest scripts use top-level `await`
// (`await agent(...)` / `await parallel(...)` / `await workflow(...)`). QuickJS global eval mode
// treats `await` as an identifier (not a keyword), so top-level `await` is a SyntaxError
// ("expecting ';'"). Asyncify makes agent/parallel/workflow synchronous from the guest's
// perspective (same precedent as runtime-primitives.test.ts / primitives-wiring.test.ts).
// Scripts here therefore use NO await — semantics are identical.
import { describe, expect, test } from "bun:test";
import { createWorkflowRuntime, deriveChildCwd } from "../runtime";
import type {
  AgentStatus,
  CallKind,
  RunStatus,
  WorkflowContext,
  WorkflowJournalPort,
} from "../types";
import { dummyStore, makeCtx, scriptedProvider } from "./fixtures";

// ── in-memory journal（实现 M0 WorkflowJournalPort，Task 7 换真 sqlite）──
function fakeJournal() {
  const rows: {
    runId: string;
    seq: number;
    callKind: CallKind;
    specHash: string;
    status: AgentStatus;
    result: unknown;
  }[] = [];
  const runs: { runId: string; status: RunStatus | "running"; error?: string }[] = [];
  let n = 0;
  const j: WorkflowJournalPort = {
    startRun: (i) => {
      const runId = `run-${++n}`;
      runs.push({ runId, status: "running" });
      void i;
      return runId;
    },
    finishRun: (runId, status, error) => {
      const r = runs.find((x) => x.runId === runId);
      if (r) {
        r.status = status;
        if (error) r.error = error;
      }
    },
    recordAgentStart: (i) => {
      const id = `a-${rows.length}`;
      rows.push({
        runId: i.runId,
        seq: i.seq,
        callKind: i.callKind,
        specHash: i.specHash,
        status: "running",
        result: null,
      });
      return id;
    },
    completeAgent: (id, result) => {
      const r = rows[Number(id.slice(2))];
      if (r) {
        r.status = "completed";
        r.result = result;
      }
    },
    failAgent: (id, error) => {
      const r = rows[Number(id.slice(2))];
      if (r) {
        r.status = "failed";
        r.result = error;
      }
    },
    findResumableRun: () => null,
    loadJournal: () => [],
  };
  return { j, rows, runs };
}

// 把 emit spy 收集的事件类型序列拿出来
function ctxWithEvents(over: Partial<WorkflowContext> = {}): {
  ctx: WorkflowContext;
  ts: () => string[];
} {
  const { provider } = scriptedProvider([]);
  const base = makeCtx({ provider });
  const types: string[] = [];
  const ctx: WorkflowContext = {
    ...base,
    parentSessionId: "s-parent",
    parentTurnId: "t-parent",
    emit: (d) => {
      types.push(d.t as string);
      return { ...d, seq: types.length, ts: 0, epoch: 0 } as never;
    },
    store: dummyStore,
    ...over,
  };
  return { ctx, ts: () => types };
}

describe("M6 F2：createWorkflowRuntime —— 集成运行时", () => {
  test("agent() 入池 + journal 落行 + workflow.* 事件序列正确", async () => {
    const { j, rows } = fakeJournal();
    const { ctx, ts } = ctxWithEvents({
      journal: j,
      // provider 回显 prompt
      callProvider: scriptedProvider([
        { result: { text: "RA", toolCalls: [], finishReason: "stop" } },
      ]).provider,
    });
    const rt = createWorkflowRuntime(ctx);
    const res = await rt.execute(`agent("hello")`, { seed: 1 });
    expect(res.status).toBe("completed");
    expect(res.output).toBe("RA");
    // journal：一行 agent，seq 0，completed
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 0, callKind: "agent", status: "completed", result: "RA" });
    // 事件：started → agent.started → agent.completed → completed
    expect(ts()).toEqual([
      "workflow.started",
      "workflow.agent.started",
      "workflow.agent.completed",
      "workflow.completed",
    ]);
  });

  test("phase() 经 createWorkflowRuntime 接线发 workflow.phase 事件（spec §8）", async () => {
    const { ctx, ts } = ctxWithEvents(); // 无 journal、无 agent 调用：只验 phase 接线
    const rt = createWorkflowRuntime(ctx);
    const res = await rt.execute(`phase("校验"); 1`, {});
    expect(res).toMatchObject({ status: "completed", output: 1 });
    expect(ts()).toEqual(["workflow.started", "workflow.phase", "workflow.completed"]);
  });

  test("parallel() 真并发 + 单调 agentSeq（数组序 0,1）+ 两条 parallel-item journal 行", async () => {
    const { j, rows } = fakeJournal();
    // 按 prompt 决定结果，避免脚本化 provider 的轮次竞争
    const provider = (() => {
      return async function* (messages: { role: string; content?: string }[]) {
        const user = messages.find((m) => m.role === "user");
        const p = (user as { content?: string })?.content ?? "?";
        return { text: `R-${p}`, toolCalls: [], finishReason: "stop" } as never;
      };
    })();
    const { ctx } = ctxWithEvents({ journal: j, callProvider: provider as never });
    const rt = createWorkflowRuntime(ctx);
    const res = await rt.execute(
      `const rs = parallel([{ prompt: "a" }, { prompt: "b" }]); rs.join(",")`,
      {},
    );
    expect(res).toMatchObject({ status: "completed", output: "R-a,R-b" });
    const parallelRows = rows
      .filter((r) => r.callKind === "parallel-item")
      .sort((x, y) => x.seq - y.seq);
    expect(parallelRows.map((r) => r.seq)).toEqual([0, 1]); // 数组序确定
    expect(parallelRows.every((r) => r.status === "completed")).toBe(true);
  });

  test("脚本顶层 throw → failed + workflow.failed{reason:error}", async () => {
    const { ctx, ts } = ctxWithEvents();
    const rt = createWorkflowRuntime(ctx);
    const res = await rt.execute(`throw new Error("boom")`, {});
    expect(res.status).toBe("failed");
    expect(res.error).toContain("boom");
    expect(ts()).toContain("workflow.failed");
  });

  test("ctx.signal 预 abort → interrupted（signal.aborted 优先于脚本完成态）", async () => {
    const ac = new AbortController();
    ac.abort();
    const { ctx } = ctxWithEvents({ signal: ac.signal });
    const rt = createWorkflowRuntime(ctx);
    const res = await rt.execute(`1 + 1`, {});
    expect(res.status).toBe("interrupted");
  });

  test("workflow() 一层内联：载命名脚本、单层递归跑、depth>1 抛错", async () => {
    const store = {
      ...dummyStore,
      has: (n: string) => n === "child",
      load: (n: string) => {
        if (n === "child") return { name: n, source: `agent("inner")`, scriptHash: "h" };
        throw new Error(`no such workflow: ${n}`);
      },
    };
    const { ctx } = ctxWithEvents({
      store,
      // 内层仅一次 provider 调用（inner agent("inner")）；用脚本化 provider 保持 lint 干净（含 yield）。
      callProvider: scriptedProvider([
        { result: { text: "INNER", toolCalls: [], finishReason: "stop" } },
      ]).provider,
    });
    const rt = createWorkflowRuntime(ctx);
    const ok = await rt.execute(`workflow("child")`, {});
    expect(ok.status).toBe("completed");
    expect(ok.output).toBe("INNER");

    // depth 守卫：在 depth=1 的 ctx 上再调 workflow() → 抛错 → 脚本 failed
    const deep = createWorkflowRuntime({ ...ctx, depth: 1 });
    const bad = await deep.execute(`workflow("child")`, {});
    expect(bad.status).toBe("failed");
    expect(bad.error).toMatch(/one level|nesting/);
  });
});

describe("M6 F2：TokenBudget 共享记账 — onUsage 穿透 + nested workflow 预算共享", () => {
  test("onUsage → budget.charge: provider usage 累计到 budget，超限后第二次 agent 被 BudgetExceeded 拦截", async () => {
    // Budget = 5 tokens; first agent charges 6 (3 input + 3 output).
    // Second agent hits scheduler.submit → assertAvailable() (6 >= 5) → BudgetExceededError.
    // This proves the onUsage → chargeUsage → budget.charge chain is wired end-to-end.
    const { ctx } = ctxWithEvents({
      budgetTotal: 5,
      callProvider: scriptedProvider([
        {
          result: {
            text: "first-done",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 3, outputTokens: 3 }, // 6 total > budget 5
          },
        },
      ]).provider,
    });
    const rt = createWorkflowRuntime(ctx);
    const res = await rt.execute(`agent("first"); agent("second")`, {});
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/budget/i);
  });

  test("nested workflow() shares parent TokenBudget (no 2× overspend fix)", async () => {
    // Budget = 5 tokens; outer agent charges 6 → budget exhausted.
    // workflow("child") spawns a child runtime via createWorkflowRuntime with sharedBudget: budget,
    // so the child sees the SAME instance (spent=6 >= total=5) and rejects the inner agent.
    // Without the fix (fresh budget in child), the inner agent would succeed with a new 0/5 budget.
    const childSource = `agent("inner")`;
    const store = {
      ...dummyStore,
      has: (n: string) => n === "child",
      load: (n: string) => {
        if (n !== "child") throw new Error(`no such workflow: ${n}`);
        return { name: "child", source: childSource, scriptHash: "child-hash" };
      },
    };
    const { ctx } = ctxWithEvents({
      budgetTotal: 5,
      store,
      callProvider: scriptedProvider([
        {
          result: {
            text: "outer-done",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 3, outputTokens: 3 }, // 6 total > budget 5
          },
        },
        // second step is never reached: inner agent is blocked by the shared exhausted budget
      ]).provider,
    });
    const rt = createWorkflowRuntime(ctx);
    // outer agent charges 6 tokens; workflow("child") → inner agent hits the shared budget
    const res = await rt.execute(`agent("outer"); workflow("child")`, {});
    expect(res.status).toBe("failed");
    // error is either direct "budget exhausted" or the sub-workflow wrapper around it
    expect(res.error).toMatch(/budget|sub-workflow/i);
  });
});

describe("M6 F2：deriveChildCwd —— per-subagent sandbox 隔离接缝（spec §6）", () => {
  test("默认继承父 cwd；isolation:'worktree' 派生独立 cwd（并发两子互不相同）", () => {
    const { ctx } = ctxWithEvents({ cwd: "/repo" });
    expect(deriveChildCwd(ctx, { prompt: "a" })).toBe("/repo");
    const c1 = deriveChildCwd(ctx, { prompt: "a", isolation: "worktree" });
    const c2 = deriveChildCwd(ctx, { prompt: "b", isolation: "worktree" });
    expect(c1).not.toBe("/repo");
    expect(c1).toContain("/repo");
    expect(c1).not.toBe(c2); // 并发子 agent 各自独立工作区接缝
  });
});
