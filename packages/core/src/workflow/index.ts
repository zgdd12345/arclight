// workflow 子系统对外索引。
// 纪律（M0）：各里程碑只【追加】导出本里程碑产物——按 biome import 排序就地插入（绝不 clobber 既有导出）；
// 完整公开面（如 M6 的 createWorkflowRuntime / runWorkflow）由 M6 汇总。
// 共享类型的唯一权威定义在 ./types（M0）——消费方应从 ./types import，index 仅再导出便捷别名。

// ── M1 产物（runtime / subagent / primitives / schema）──
export { makeWorkflowPrimitives } from "./primitives";
export { runWorkflowScript } from "./runtime";
export { jsonSchemaToZod, makeStructuredOutputTool } from "./schema";

// ── M5：命名 workflow 持久层 + 命名/临场合成解析（spec §3） ──
export { resolveWorkflowSource, WORKFLOW_NAME_RE, WorkflowStore } from "./store";

export { defaultSafeToolNames, RestrictedToolRegistry, runSubagent } from "./subagent";

// 低层 runWorkflowScript 消费者所需的类型别名 + M5 公开面消费的共享类型（M0 唯一权威）。
// 注：公开入口 runWorkflow(scriptOrName, args, ctx: WorkflowContext) 与 createWorkflowRuntime
//     由 M6 追加导出——M6 实现体为 createWorkflowRuntime(ctx).execute(resolveWorkflowSource(...), args)。
export type {
  LoadedWorkflow,
  RunScriptResult,
  WorkflowContext,
  WorkflowPrimitives,
  WorkflowResult,
  WorkflowRuntime,
  WorkflowStorePort,
} from "./types";
