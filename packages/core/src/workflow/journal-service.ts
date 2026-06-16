import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { workflowAgents, workflowRuns } from "../db/schema";
import type { CallKind, JournalRow, RunStatus, WorkflowJournalPort } from "./types";

// M3 私有输入别名（非 M0 契约符号；逐字段等同 WorkflowJournalPort 内联形状）。
export type StartRunInput = {
  sessionId: string;
  scriptHash: string;
  argsHash: string;
  args: Record<string, unknown>;
};

export type RecordAgentStartInput = {
  runId: string;
  seq: number;
  callKind: CallKind;
  specHash: string;
  subTurnId?: string;
};

/** M0 `WorkflowJournalPort` 的唯一实现。构造接 Db + 可注入时钟（与 ApprovalService 同构，
 *  落 started_at/finished_at；非 guest 确定性桩——后者是 M6 runtime 的事）。 */
export class WorkflowJournalService implements WorkflowJournalPort {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  startRun(input: StartRunInput): string {
    const runId = randomUUID();
    this.db
      .insert(workflowRuns)
      .values({
        id: runId,
        sessionId: input.sessionId,
        scriptHash: input.scriptHash,
        argsHash: input.argsHash,
        args: input.args,
        status: "running",
        startedAt: new Date(this.now()),
      })
      .run();
    return runId;
  }

  // RunStatus = completed | failed | interrupted（M0；已不含 running，无需 Exclude）。
  finishRun(runId: string, status: RunStatus, error?: string): void {
    this.db
      .update(workflowRuns)
      .set({ status, error: error ?? null, finishedAt: new Date(this.now()) })
      .where(eq(workflowRuns.id, runId))
      .run();
  }

  recordAgentStart(input: RecordAgentStartInput): string {
    const id = randomUUID();
    this.db
      .insert(workflowAgents)
      .values({
        id,
        runId: input.runId,
        seq: input.seq,
        callKind: input.callKind,
        specHash: input.specHash,
        status: "running",
        subTurnId: input.subTurnId ?? null,
        startedAt: new Date(this.now()),
      })
      .run();
    return id;
  }

  completeAgent(agentId: string, result: unknown): void {
    this.db
      .update(workflowAgents)
      .set({ status: "completed", resultJson: result ?? null, finishedAt: new Date(this.now()) })
      .where(eq(workflowAgents.id, agentId))
      .run();
  }

  failAgent(agentId: string, error: string): void {
    this.db
      .update(workflowAgents)
      .set({ status: "failed", error, finishedAt: new Date(this.now()) })
      .where(eq(workflowAgents.id, agentId))
      .run();
  }

  /** resume 入口：按 (scriptHash, argsHash) 找最近一次 run。不按 status 过滤——
   *  崩溃 run 卡 'running' 也要能续；部分续跑由 loadJournal 只重放 completed 行实现。*/
  findResumableRun(scriptHash: string, argsHash: string): { runId: string } | null {
    const row = this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.scriptHash, scriptHash), eq(workflowRuns.argsHash, argsHash)))
      .orderBy(desc(workflowRuns.startedAt))
      .limit(1)
      .get();
    return row ? { runId: row.id } : null;
  }

  /** 读出 prior run 的 journal，按 seq 升序——ResumePlanner 的输入。 */
  loadJournal(runId: string): JournalRow[] {
    return this.db
      .select({
        seq: workflowAgents.seq,
        specHash: workflowAgents.specHash,
        status: workflowAgents.status,
        resultJson: workflowAgents.resultJson,
      })
      .from(workflowAgents)
      .where(eq(workflowAgents.runId, runId))
      .orderBy(workflowAgents.seq)
      .all();
  }
}
