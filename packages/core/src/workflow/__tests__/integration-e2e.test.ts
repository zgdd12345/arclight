// M6 Task 7 — 端到端集成（capstone）：guest parallel([...]) 经 *真* createWorkflowRuntime
// （真 Scheduler + 真 WorkflowJournalService/sqlite + 真 WorkflowEvents + 真 QuickJS）跑通。
// 只有 provider 是脚本化替身（合法接缝）；其余全用真实模块——证明 F1（guest parallel → 真调度扇出）
// + F2（M1–M4 组合）+ journal/events/resume 端到端成立。
//
// DIVERGENCE from task spec: task spec's guest script uses top-level `await`
// (`const rs = await parallel([...])`). QuickJS global eval mode treats `await` as an
// identifier (not a keyword), so top-level `await` is a SyntaxError ("expecting ';'").
// Asyncify makes parallel() synchronous from the guest's perspective, so the script uses
// NO await — semantics are identical (same precedent as create-runtime.test.ts /
// primitives-wiring.test.ts / runtime-primitives.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArcEvent } from "@arclight/protocol";
import { eq } from "drizzle-orm";
import type { DraftEvent } from "../../db/appendEvent";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, workflowAgents, workflowRuns, workspaces } from "../../db/schema";
import type { CallProvider, LlmMessage } from "../../loop/types";
import { makeExecuteTool, ToolRegistry } from "../../tools/registry";
import { WorkflowJournalService } from "../journal-service";
import { createWorkflowRuntime } from "../runtime";
import type { WorkflowContext } from "../types";
import { allowAllApprovals, dummySandbox, dummyStore } from "./fixtures";

// prompt-keyed provider（避免脚本化 provider 在并发下的轮次竞争）；记录 provider 调用次数
// （验 resume 零 live —— 命中重放绝不起真 provider 调用）。
function promptProvider(counter: { calls: number }): CallProvider {
  return async function* (messages) {
    counter.calls += 1;
    const user = (messages as LlmMessage[]).find((m) => m.role === "user");
    const p = user && "content" in user ? user.content : "?";
    return { text: `R-${p}`, toolCalls: [], finishReason: "stop" };
  };
}

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-e2e-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces)
    .values({ id: "w1", name: "t", repoPath: "/r", arclightDir: "/r/.arclight" })
    .run();
  db.insert(sessions).values({ id: "s-parent", workspaceId: "w1" }).run();
});
afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeWfCtx(
  provider: CallProvider,
  events: ArcEvent[],
  journal: WorkflowJournalService,
): WorkflowContext {
  let n = 0;
  let seq = 0;
  return {
    parentSessionId: "s-parent",
    parentTurnId: "t-parent",
    cwd: "/r",
    signal: new AbortController().signal,
    callProvider: provider,
    registry: new ToolRegistry(),
    approvals: allowAllApprovals,
    executeTool: makeExecuteTool({ sandbox: dummySandbox }),
    emit: (draft: DraftEvent) => {
      const e = { ...draft, seq: ++seq, ts: 0, epoch: 0 } as ArcEvent;
      events.push(e);
      return e;
    },
    store: dummyStore,
    journal,
    newId: () => `id-${++n}`,
    maxConcurrent: 4,
  };
}

// 见文件头 DIVERGENCE：guest 侧 parallel 经 asyncify 同步返回，无需也不可顶层 await。
const SCRIPT = `const rs = parallel([{ prompt: "a" }, { prompt: "b" }]); rs.length`;

describe("M6 e2e：parallel + 真 Scheduler + 真 journal + 事件序列 + resume", () => {
  test("首跑：结果=2，journal 落 1 run + 2 parallel-item 行（seq 0/1），事件序列正确", async () => {
    const counter = { calls: 0 };
    const events: ArcEvent[] = [];
    const journal = new WorkflowJournalService(db);
    const ctx = makeWfCtx(promptProvider(counter), events, journal);

    const res = await createWorkflowRuntime(ctx).execute(SCRIPT, { seed: 1 });
    expect(res).toMatchObject({ status: "completed", output: 2 });
    // F1+F2 机械证明：两个子 agent 各经真 Scheduler 跑了一次真 provider 调用（非桩）。
    expect(counter.calls).toBe(2);

    // journal：1 个 run（completed）
    const runs = db.select().from(workflowRuns).all();
    expect(runs).toHaveLength(1);
    const run0 = runs[0];
    if (!run0) throw new Error("expected exactly one workflow_runs row");
    expect(run0.status).toBe("completed");
    // 2 个 parallel-item agent 行，seq 0/1（数组序），completed
    const agents = db.select().from(workflowAgents).where(eq(workflowAgents.runId, run0.id)).all();
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.seq).sort()).toEqual([0, 1]);
    expect(agents.every((a) => a.callKind === "parallel-item" && a.status === "completed")).toBe(
      true,
    );

    // 事件序列：started → agent.started×2 → agent.completed×2 → completed
    const types = events.map((e) => e.t);
    expect(types[0]).toBe("workflow.started");
    expect(types[types.length - 1]).toBe("workflow.completed");
    expect(types.filter((t) => t === "workflow.agent.started")).toHaveLength(2);
    expect(types.filter((t) => t === "workflow.agent.completed")).toHaveLength(2);
    // agent.started 的 agentSeq 覆盖 {0,1}（= journal seq = 数组序）
    const seqs = events
      .filter((e) => e.t === "workflow.agent.started")
      .map((e) => (e as { agentSeq: number }).agentSeq)
      .sort();
    expect(seqs).toEqual([0, 1]);
  });

  test("resume：相同 scriptHash+args 重跑 → 全命中、零 live provider 调用、结果一致", async () => {
    const first = { calls: 0 };
    const journal = new WorkflowJournalService(db);
    const r1 = await createWorkflowRuntime(makeWfCtx(promptProvider(first), [], journal)).execute(
      SCRIPT,
      { seed: 1 },
    );
    expect(r1).toMatchObject({ status: "completed", output: 2 });
    expect(first.calls).toBe(2);

    // 二次跑：同 script + 同 args → findResumableRun 命中 → ResumePlanner 全命中前缀 → 零 live
    const second = { calls: 0 };
    const r2 = await createWorkflowRuntime(makeWfCtx(promptProvider(second), [], journal)).execute(
      SCRIPT,
      { seed: 1 },
    );
    expect(r2).toMatchObject({ status: "completed", output: 2 });
    expect(second.calls).toBe(0); // resume 命中：不起 live 子跑（机械证明缓存重放）
    // 两次跑各落一个 run（含可再 resume 的补写 completed 行）
    expect(db.select().from(workflowRuns).all()).toHaveLength(2);
  });

  test("args 变化 → 不命中，重新 live（确定性键 = scriptHash + argsHash）", async () => {
    const c1 = { calls: 0 };
    const journal = new WorkflowJournalService(db);
    await createWorkflowRuntime(makeWfCtx(promptProvider(c1), [], journal)).execute(SCRIPT, {
      seed: 1,
    });
    const c2 = { calls: 0 };
    await createWorkflowRuntime(makeWfCtx(promptProvider(c2), [], journal)).execute(SCRIPT, {
      seed: 2,
    });
    expect(c2.calls).toBe(2); // argsHash 变 → findResumableRun 不命中 → 全 live
  });
});
