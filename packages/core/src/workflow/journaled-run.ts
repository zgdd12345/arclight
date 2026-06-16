import { specHash as computeSpecHash } from "./hash";
import type { ResumePlanner } from "./resume";
import type { CallKind, WorkflowJournalPort } from "./types";

export type RunCtx = { seq: number; callKind: CallKind };

/** 实跑一个可序列化规格的子 agent；返回结构化结果或文本。真实实现是 M1 的嵌套 queryLoop。
 *  失败语义：此处 throw=真失败（供 journal 记 failed）；spec §10 的『失败→null』在 agent()/parallel 包装层归一。
 *  这是 journaling 接缝的私有抽象（承载 seq/callKind），不是 M0 RunSubagent 端口本身——
 *  M6 由 RunSubagent(spec, signal)=>Promise<SubagentResult> 适配为此回调（详见上文文档注）。*/
export type RunOneSpec = (spec: unknown, ctx: RunCtx) => Promise<unknown>;

export type JournaledRunDeps = {
  journal: WorkflowJournalPort;
  runId: string;
  planner: ResumePlanner; // 全新 run 传 new ResumePlanner([])；resume 传 prior journal
  runLive: RunOneSpec;
};

/** 每次原语调用走此封套。命中判定 + 结果回灌全在宿主同步完成，await 的 live 在 guest 恢复前 resolve，
 *  绝不在 asyncify 挂起期再入 guest（spec §2.1）。seq 由调用方按 run 内单调序传入（并行项取连续 seq）。*/
export function makeJournaledRun(deps: JournaledRunDeps): RunOneSpec {
  return async (spec, ctx) => {
    const sh = computeSpecHash(spec);
    const cached = deps.planner.consult(ctx.seq, sh);
    if (cached.hit) {
      // 补写一条 completed 行，保证本 run 自包含、可被二次 resume（避免全命中重放 journal 为空）。
      const cachedId = deps.journal.recordAgentStart({
        runId: deps.runId,
        seq: ctx.seq,
        callKind: ctx.callKind,
        specHash: sh,
      });
      deps.journal.completeAgent(cachedId, cached.result);
      return cached.result;
    }

    const agentId = deps.journal.recordAgentStart({
      runId: deps.runId,
      seq: ctx.seq,
      callKind: ctx.callKind,
      specHash: sh,
    });
    try {
      const result = await deps.runLive(spec, ctx);
      deps.journal.completeAgent(agentId, result);
      return result;
    } catch (e) {
      deps.journal.failAgent(agentId, e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
}
