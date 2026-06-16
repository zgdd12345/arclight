// workflow 子系统对外索引。
// 纪律（M0）：各里程碑只【追加】导出本里程碑产物——按 biome import 排序就地插入（绝不 clobber 既有导出）；
// 完整公开面（如 M6 的 createWorkflowRuntime / runWorkflow）由 M6 汇总。
// 共享类型的唯一权威定义在 ./types（M0）——消费方应从 ./types import，index 仅再导出便捷别名。

// ── M1 产物（runtime / subagent / primitives / schema）──
export { makeWorkflowPrimitives } from "./primitives";
export { runWorkflowScript } from "./runtime";
export { jsonSchemaToZod, makeStructuredOutputTool } from "./schema";
export { defaultSafeToolNames, RestrictedToolRegistry, runSubagent } from "./subagent";

// 低层 runWorkflowScript 消費者所需的类型别名（权威来源仍是 ./types）。
export type { RunScriptResult, WorkflowPrimitives } from "./types";
