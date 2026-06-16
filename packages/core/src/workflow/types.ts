import type { ArcEvent } from "@arclight/protocol";
import { z } from "zod";
import type { DraftEvent } from "../db/appendEvent";
import type { ApprovalSeam, CallProvider, LoopDeps, ToolRegistryLike } from "../loop/types";

/* ──────────────────────────────────────────────────────────────────────────
 * M0 · workflow 子系统的唯一权威共享类型契约。
 * 所有跨里程碑共享类型集中于此；各里程碑只 import，禁止重复定义/本地重声明。
 * 接地真实 API：@arclight/protocol(ArcEvent)、db/appendEvent(DraftEvent)、
 * loop/types(CallProvider / ApprovalSeam / ToolRegistryLike / LoopDeps)——均已实测存在。
 * ────────────────────────────────────────────────────────────────────────── */

// ── 1. JSON Schema（结构化，非 Record）──────────────────────────────────────
// 权威形状 = 结构化。schema.ts(M1 jsonSchemaToZod) 消费此形；M2 不得再用 Record<string,unknown>。
export type JsonSchema = {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

/** JsonSchema 的 zod 运行时校验（bridge 边界校验 guest 传入的 schema 字段用）。 */
export const JsonSchemaZ: z.ZodTypeAny = z.lazy(() =>
  z.object({
    type: z.enum(["string", "number", "integer", "boolean", "array", "object"]).optional(),
    enum: z.array(z.string()).optional(),
    items: JsonSchemaZ.optional(),
    properties: z.record(z.string(), JsonSchemaZ).optional(),
    required: z.array(z.string()).optional(),
  }),
);

// ── 2. 规格类型 AgentSpec / StageSpec（spec §4）──────────────────────────────
// AgentSpec 唯一定义（M1 subagent.ts / M2 types.ts 的重复声明 → 删除，改 import）。
export type AgentSpec = {
  prompt: string;
  schema?: JsonSchema; // 提供则强制结构化返回（zod 校验，不匹配 retry）
  tools?: string[]; // 该 subagent 可见工具白名单（默认继承受限集）
  model?: string; // 模型覆盖（M1 记录但不应用，热切换需 M2 限流配套）
  label?: string;
  phase?: string;
  isolation?: "worktree"; // 仅并发写文件时按需（M2/M6）
};

// StageSpec：pipeline 的声明式阶段规格（AgentSpec 的子集；无 label/phase/isolation）。首见 M2。
// Pick 形式确保与 AgentSpec 字段同步，不会悄悄漂移。
export type StageSpec = Pick<AgentSpec, "prompt" | "schema" | "tools" | "model">;

// ── 3. subagent 结果（统一一种形态）─────────────────────────────────────────
// SpecResult：subagent 最终产物——结构化对象（有 schema）或纯文本（无 schema），须 JSON 可序列化。
export type SpecResult = string | Record<string, unknown>;

// 统一 SubagentResult：成功 → value；失败 → status 区分 failed/interrupted（+ 可选 error）。
//   · M1 agent()：res.ok ? res.value : null（spec §10 失败归一为 null）
//   · M2 parallel/pipeline：r.ok ? r.value : null（不读 status）
//   · run-fatal（abort / budget 硬上限 / backstop）由 scheduler 抛错冒泡，不经此型。
export type SubagentResult =
  | { ok: true; value: SpecResult }
  | { ok: false; status: "failed" | "interrupted"; error?: string };

// ── 4. RunSubagent 注入端口（统一签名）──────────────────────────────────────
// 唯一共享端口：(spec, signal) → Promise<SubagentResult>。
// makeParallel/makePipeline(M2) 与 makeJournaledRun(M3) 消费此端口；单测注入 fake，无需 QuickJS/真 provider。
// 注：M1 低层实现 runSubagent(spec, ctx: WorkflowContext) 不是此端口本身；
//     M6 装配时按调用派生 signal 适配为 RunSubagent：
//       const run: RunSubagent = (spec, signal) => runSubagent(spec, { ...ctx, signal });
export type RunSubagent = (spec: AgentSpec, signal: AbortSignal) => Promise<SubagentResult>;

// ── 5. 状态词表 + run 结果 ───────────────────────────────────────────────────
// 统一终态词表：completed | failed | interrupted（M5 的 'cancelled' → 'interrupted'）。
export type RunStatus = "completed" | "failed" | "interrupted";
// 持久化加一个中间态 'running'（workflow_runs.status / workflow_agents 用，M3 schema）。
export type PersistedRunStatus = RunStatus | "running";

// runWorkflowScript(M1 低层 QuickJS eval) 的结果：仅 completed/failed
// （中断在编排层归一为 run 级 interrupted；脚本 eval 本身不产 interrupted）。
export type RunScriptResult =
  | { status: "completed"; output: unknown }
  | { status: "failed"; error: string };

// runWorkflow(M6 公开入口) 的 run 级结果：用完整 RunStatus 词表。
export type WorkflowResult = {
  status: RunStatus;
  output?: unknown;
  error?: string;
};

// ── 6. Budget 形状（spec §4 全局 budget）─────────────────────────────────────
// guest 可见的只读视图：{ total, spent(), remaining() }。
// 宿主侧 TokenBudget(M2 scheduler.ts) 实现此面 + charge()/assertAvailable()/exhausted()。
export type Budget = {
  total: number;
  spent(): number;
  remaining(): number;
};

// ── 7. WorkflowPrimitives（注入 guest 的原语契约，spec §4 全集）───────────────
// 含 agent/parallel/pipeline/workflow/phase/log/args/budget。
// runtime.ts 据此在 PRELUDE 绑 __agent/__parallel/__pipeline/__workflow + budget 全局；
// makeWorkflowPrimitives 据此装配。M1 阶段未接线者以抛错/no-op 桩占位，M6 接线为真实实现。
export type WorkflowPrimitives = {
  args: unknown;
  agent: (prompt: string, opts?: Omit<AgentSpec, "prompt">) => Promise<SpecResult | null>;
  parallel: (specs: AgentSpec[]) => Promise<(SpecResult | null)[]>;
  pipeline: (items: unknown[], ...stages: StageSpec[]) => Promise<(SpecResult | null)[]>;
  workflow: (name: string, args?: unknown) => Promise<unknown>; // 内联子 workflow，仅一层
  phase: (title: string) => void;
  log: (msg: string) => void;
  budget: Budget;
};

// ── 8. 持久层 / journal 结构化端口（避免 M0→M3/M5 反向 import）─────────────────
export type LoadedWorkflow = { name: string; source: string; scriptHash: string };

/** WorkflowStore 端口（实现 = M5 store.ts WorkflowStore）。 */
export type WorkflowStorePort = {
  has(name: string): boolean;
  load(name: string): LoadedWorkflow;
  save(name: string, source: string): { name: string; scriptHash: string };
  list(): string[];
};

export type CallKind = "agent" | "parallel-item" | "pipeline-item";
export type AgentStatus = "running" | "completed" | "failed";
export type JournalRow = {
  seq: number;
  specHash: string;
  status: AgentStatus;
  resultJson: unknown;
};

/** WorkflowJournal 端口（实现 = M3 journal-service.ts WorkflowJournalService）。 */
export type WorkflowJournalPort = {
  startRun(input: {
    sessionId: string;
    scriptHash: string;
    argsHash: string;
    args: Record<string, unknown>;
  }): string;
  finishRun(runId: string, status: RunStatus, error?: string): void;
  recordAgentStart(input: {
    runId: string;
    seq: number;
    callKind: CallKind;
    specHash: string;
    subTurnId?: string;
  }): string;
  completeAgent(agentId: string, result: unknown): void;
  failAgent(agentId: string, error: string): void;
  findResumableRun(scriptHash: string, argsHash: string): { runId: string } | null;
  loadJournal(runId: string): JournalRow[];
};

// ── 9. WorkflowContext（唯一统一上下文）──────────────────────────────────────
// 合并 M1 WorkflowContext（构造 subagent 全部依赖）+ M5 WorkflowRunContext（run 所需）。
// runSubagent(spec, ctx)(M1) 与 createWorkflowRuntime(ctx)(M6) 共用此一类型。
export type WorkflowContext = {
  // 父会话身份（事件绑父会话；子 agent 派生子 session/turn/cwd）
  parentSessionId: string;
  parentTurnId: string;
  cwd: string;
  /** run 级取消信号（父 interrupt 链路）。每个 subagent 由 deriveChildSignal(M4) 再派生。 */
  signal: AbortSignal;

  // 构造 subagent 的全部依赖（M1）
  callProvider: CallProvider;
  registry: ToolRegistryLike;
  approvals: ApprovalSeam;
  executeTool: LoopDeps["executeTool"];
  /** appendEvent 包装（绑父会话）：WorkflowEvents 与子 queryLoop 共用。 */
  emit: (draft: DraftEvent) => ArcEvent;
  maxRetries?: number;
  maxReflections?: number;
  newId?: () => string;

  // 同步进度原语出口（phase / log）
  onPhase?: (title: string) => void;
  onLog?: (msg: string) => void;
  /** usage 回传钩子（M6 接线）：subagent queryLoop 每轮 provider usage 经此回传；
   *  createWorkflowRuntime 接 budget.charge(input+output)（spec §6 token budget 记账）。 */
  onUsage?: LoopDeps["onUsage"];

  // run 编排所需（M3/M5/M6）；M1/M2 不提供，M6 装配时注入
  store?: WorkflowStorePort;
  journal?: WorkflowJournalPort;
  /** 跨 run 共享 token budget 上限（token 数）。 */
  budgetTotal?: number;
  maxConcurrent?: number;
  maxAgentsPerRun?: number;
  /** 内联子 workflow 一层嵌套深度守卫（spec §1/§4：仅一层）。顶层 = 0。 */
  depth?: number;
};

// ── 10. runtime 端口（M6 createWorkflowRuntime 产出）──────────────────────────
// ctx 在 createWorkflowRuntime(ctx) 时捕获；execute 只接 per-run 的 source/args。
export type WorkflowRuntime = {
  execute(source: string, args: unknown): Promise<WorkflowResult>;
};

// ── 11. WorkflowEvent 名称常量（spec §8；protocol 字面量的单一引用点）──────────
// 注意：workflow.agent.started 的序号字段名 = agentSeq（非 seq）——避免与事件信封 seq 冲突
// （DraftEvent = Omit<ArcEvent,'seq'|'ts'|'epoch'>，seq 由 appendEvent 单点分配）。
export const WORKFLOW_EVENTS = {
  started: "workflow.started",
  phase: "workflow.phase",
  agentStarted: "workflow.agent.started",
  agentCompleted: "workflow.agent.completed",
  completed: "workflow.completed",
  failed: "workflow.failed",
} as const;
export type WorkflowEventName = (typeof WORKFLOW_EVENTS)[keyof typeof WORKFLOW_EVENTS];

// ── 12. guest 误用归一错误 + §2.1 可序列化守卫（M2 parallel/pipeline 复用）─────
export class WorkflowApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowApiError";
  }
}

/** §2.1 asyncify 守卫：规格必须可序列化（禁 guest 闭包），否则挂起期会迫使再入 guest。递归检查嵌套对象。 */
export function assertSerializableSpec(s: unknown, where: string): void {
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    throw new WorkflowApiError(`${where}: spec must be a plain object`);
  }
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (typeof v === "function") {
      throw new WorkflowApiError(
        `${where}: field "${k}" is a closure — forbidden under QuickJS asyncify (spec §2.1)`,
      );
    }
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      assertSerializableSpec(v, `${where}.${k}`);
    }
  }
}

export function validateAgentSpec(s: unknown, where: string): AgentSpec {
  assertSerializableSpec(s, where);
  const spec = s as Record<string, unknown>;
  if (typeof spec.prompt !== "string" || spec.prompt.length === 0) {
    throw new WorkflowApiError(`${where}: spec.prompt must be a non-empty string`);
  }
  if (spec.tools !== undefined && !Array.isArray(spec.tools)) {
    throw new WorkflowApiError(`${where}: spec.tools must be a string[]`);
  }
  if (spec.schema !== undefined) {
    const r = JsonSchemaZ.safeParse(spec.schema);
    if (!r.success) throw new WorkflowApiError(`${where}: spec.schema is not a valid JsonSchema`);
  }
  return spec as unknown as AgentSpec;
}

export function validateStageSpec(s: unknown, where: string): StageSpec {
  validateAgentSpec(s, where); // 复用 prompt 必填 + tools/schema 校验 + 闭包守卫
  const spec = s as Record<string, unknown>;
  // 返回仅含 StageSpec 字段的新对象，排除 AgentSpec 独有字段（isolation/label/phase 等）
  const result: Partial<StageSpec> = { prompt: spec.prompt as string };
  if (spec.schema !== undefined) result.schema = spec.schema as JsonSchema;
  if (spec.tools !== undefined) result.tools = spec.tools as string[];
  if (spec.model !== undefined) result.model = spec.model as string;
  return result as StageSpec;
}
