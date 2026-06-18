// workflow 子系统对外索引——M6 收口为唯一权威对外面（汇总 M1–M6 全部公开符号）。
// 共享类型的唯一权威定义在 ./types（M0）；消费方应从 ./types import，index 仅再导出便捷别名。

// ── 值导出（按来源路径 biome 排序）──
export { BubblingApprovalSeam } from "./bubbling-approval"; // M4
export { WorkflowEvents } from "./events"; // M4
export { argsHash, canonicalJson, scriptHash, specHash } from "./hash"; // M3
export { deriveChildSignal, terminalEvent } from "./interrupt"; // M4
export { createWorkflowRunner, type WorkflowRunner } from "./launch";
export { WorkflowJournalService } from "./journal-service"; // M3
export { makeJournaledRun } from "./journaled-run"; // M3
export type { PrimitiveWiring } from "./primitives";
export {
  interpolate, // M2
  makeParallel, // M2
  makePipeline, // M2
  makeWorkflowPrimitives, // M1/M6
} from "./primitives";
export { ResumePlanner } from "./resume"; // M3
export {
  createWorkflowRuntime, // M6（F2）
  deriveChildCwd, // M6（sandbox 隔离接缝）
  runWorkflow, // M6（公开入口）
  runWorkflowScript, // M1
} from "./runtime";
export {
  BudgetExceededError, // M2
  defaultConcurrency, // M2
  Scheduler, // M2
  SchedulerExhaustedError, // M2
  TokenBudget, // M2
} from "./scheduler";
export { jsonSchemaToZod, makeStructuredOutputTool } from "./schema"; // M1
export { resolveWorkflowSource, WORKFLOW_NAME_RE, WorkflowStore } from "./store"; // M5
export { TemplateStore, type WorkflowTemplate } from "./template-store"; // M2
export { defaultSafeToolNames, RestrictedToolRegistry, runSubagent } from "./subagent"; // M1

// ── 类型再导出（权威来源 ./types）──
export type {
  AgentSpec,
  AgentStatus,
  Budget,
  CallKind,
  JournalRow,
  JsonSchema,
  LoadedWorkflow,
  PersistedRunStatus,
  RunScriptResult,
  RunStatus,
  RunSubagent,
  SpecResult,
  StageSpec,
  SubagentResult,
  WorkflowContext,
  WorkflowEventName,
  WorkflowJournalPort,
  WorkflowPrimitives,
  WorkflowResult,
  WorkflowRuntime,
  WorkflowStorePort,
} from "./types";
// WorkflowApiError + 守卫（权威 ./types；primitives 亦 re-export，此处单点取 ./types 避免 TS2308）
export {
  assertSerializableSpec,
  validateAgentSpec,
  validateStageSpec,
  WORKFLOW_EVENTS,
  WorkflowApiError,
} from "./types";
