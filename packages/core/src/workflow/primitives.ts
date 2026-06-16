import { runSubagent } from "./subagent";
// 共享契约类型自 M0；WorkflowApiError 亦自 M0。命名导入按 biome 排序（WorkflowApiError 在 WorkflowContext 之前）。
import {
  type AgentSpec,
  type Budget,
  WorkflowApiError,
  type WorkflowContext,
  type WorkflowPrimitives,
} from "./types";

// M1 边界：parallel/pipeline/workflow 的调度实现属 M2（scheduler），向 guest 注入属 M6。
// 此处以抛错桩占位满足 M0 WorkflowPrimitives 全集类型——M1 runtime PRELUDE 不绑这些 guest 全局，
// 故正常路径触不到；若误触（M6 接线前）则显式抛错而非静默。
function notUntilM6(name: string): () => never {
  return () => {
    throw new WorkflowApiError(`${name}() is not wired until M6 (scheduler/budget injection)`);
  };
}

// budget no-op：M2 TokenBudget 实现真实计量；M1 仅占位（spent/remaining 恒 0）。
const noopBudget: Budget = { total: 0, spent: () => 0, remaining: () => 0 };

export function makeWorkflowPrimitives(ctx: WorkflowContext, args: unknown): WorkflowPrimitives {
  return {
    args,
    log: (msg) => ctx.onLog?.(msg),
    phase: (title) => ctx.onPhase?.(title),
    agent: async (prompt, opts) => {
      const spec: AgentSpec = { prompt, ...(opts ?? {}) };
      const res = await runSubagent(spec, ctx);
      // 失败 → null（spec §10；guest 可 .filter(Boolean)）；成功 → 统一 value（无 text/data 二分）。
      return res.ok ? res.value : null;
    },
    parallel: notUntilM6("parallel"),
    pipeline: notUntilM6("pipeline"),
    workflow: notUntilM6("workflow"),
    budget: noopBudget,
  };
}
