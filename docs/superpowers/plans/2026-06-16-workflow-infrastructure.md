# Workflow 编排基础设施 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按里程碑、逐 Task 执行。每个里程碑(M0–M6)是独立可测交付；每个 Task 走 RED→GREEN→VERIFY→COMMIT，是执行追踪单元。**执行前务必先读文末「已知收尾项与风险」**。

**Goal:** 给 arclight 建一套 Claude-Code 式动态 workflow 编排基建——用 QuickJS(wasm) 隔离执行的 JS 脚本编排一组 subagent，关卡=代码控制流，含真并行与 resume。

**Architecture:** 隔离引擎 QuickJS-emscripten(QuickJS-ng asyncify，Bun/JSC 上唯一兼具真隔离+async 宿主注入+确定性的方案)。原语 agent()/parallel()/pipeline()/workflow() 由宿主实现并注入 guest；受 asyncify 单挂起约束，parallel/pipeline 收可序列化 agent 规格(非 guest 闭包)，真并发发生在宿主侧 Promise.all。subagent = 嵌套 queryLoop(独立 state/受限工具集/schema 强制结构化返回)。全部落在 packages/core/src/workflow/，归 agent core。

**Tech Stack:** TypeScript + Bun + bun:test；drizzle(sqlite)；zod；quickjs-emscripten + @jitl/quickjs-ng-wasmfile-release-asyncify；复用现有 queryLoop/ToolRegistry/ApprovalSeam/SandboxService/ProviderManager/protocol 事件。

**权威 spec:** docs/superpowers/specs/2026-06-16-workflow-infrastructure-design.md（§1–§15）

**里程碑与依赖:** M0(共享契约 workflow/types.ts，全员先 import) → M1(runtime+agent) → M2(真并行+限流) → (M3 journal/resume ∥ M4 事件/审批/中断) → M5(store+动态合成) → **M6(运行时集成，缝合 M1–M4、闭合 guest 原语注入与 createWorkflowRuntime 两处关键)**。量子(外部阶段2)需 M0+M1+M2+M6(+M4)。


---

## 里程碑 M0：共享类型契约（`workflow/types.ts`）

> 关联 spec：`docs/superpowers/specs/2026-06-16-workflow-infrastructure-design.md` §4（原语 API）/ §5（subagent 执行模型）/ §7（journal/resume 状态）/ §8（事件）/ §10（失败语义）。
>
> **存在理由（对抗式评审结论）**：M1–M5 各自就近声明了同名类型，产生**重复定义与签名漂移**——
> `runWorkflow`/`WorkflowContext`/`JsonSchema`/`SubagentResult`/`RunSubagent`/`WorkflowPrimitives`/状态词表在不同里程碑互不兼容。
> M0 把**所有跨里程碑共享的类型集中定义在一处** `packages/core/src/workflow/types.ts`，作为唯一权威来源（single source of truth）。
> 下游里程碑（M1–M6）**只 import，禁止重复定义/本地重声明**同名类型。
>
> **里程碑边界**
> - 本里程碑只交付 `packages/core/src/workflow/types.ts`（纯类型 + 必要的 zod/运行时守卫）与其单测。
> - **不**新增任何 runtime 行为、**不**改 `index.ts`（导出由各里程碑只追加、M6 汇总）、**不**接线 QuickJS / scheduler / journal。
> - M0 是依赖链最前端：`M0 → M1 → M2 → M3/M4 → M5 → M6`。故 `types.ts` **不得 import** 尚未存在的 `store.ts`(M5)/`journal-service.ts`(M3)/`scheduler.ts`(M2)——对这些用**结构化端口类型**（port），实现类在各自里程碑 structurally 满足。
> - 接地真实 API（已实测存在，勿臆造）：`@arclight/protocol`(`ArcEvent`)、`db/appendEvent.ts`(`DraftEvent`)、`loop/types.ts`(`CallProvider`/`ApprovalSeam`/`ToolRegistryLike`/`LoopDeps`)。
>
> **开工前**（当前在默认分支 `master`，先切工作分支）：
> ```bash
> git switch -c feat/workflow-m0-shared-types
> ```
> 测试运行器：`packages/core` 用 `bun:test`（`vitest.config.ts` 显式排除 core）。测试置于 `packages/core/src/workflow/__tests__/`。

---

### Task 1：创建 `workflow/types.ts`（共享类型 + zod/守卫）

**交付**：`packages/core/src/workflow/types.ts` —— 全部共享类型的唯一权威定义，外加 `WorkflowApiError` + `assertSerializableSpec`/`validateAgentSpec`/`validateStageSpec` 运行时守卫（被 M2 `parallel`/`pipeline` 复用）+ `JsonSchemaZ` zod 校验。

#### 1.1 RED — 先写失败测试

新建 `packages/core/src/workflow/__tests__/types.test.ts`：
```ts
import { describe, expect, test } from "bun:test";
import {
  type AgentSpec,
  assertSerializableSpec,
  type Budget,
  JsonSchemaZ,
  type RunStatus,
  type StageSpec,
  type SubagentResult,
  validateAgentSpec,
  validateStageSpec,
  WORKFLOW_EVENTS,
  WorkflowApiError,
} from "../types";

describe("M0 共享类型契约：守卫", () => {
  test("validateAgentSpec 接受合法规格并保留字段", () => {
    const spec = validateAgentSpec({ prompt: "do it", label: "x" }, "test");
    expect(spec.prompt).toBe("do it");
  });

  test("validateAgentSpec 拒绝空/缺失 prompt", () => {
    expect(() => validateAgentSpec({ prompt: "" }, "test")).toThrow(WorkflowApiError);
    expect(() => validateAgentSpec({}, "test")).toThrow(WorkflowApiError);
  });

  test("§2.1 守卫：闭包字段被拒（不可序列化）", () => {
    expect(() => validateAgentSpec({ prompt: "p", onDone: () => {} }, "test")).toThrow(
      WorkflowApiError,
    );
    expect(() => assertSerializableSpec({ cb: () => {} }, "test")).toThrow(WorkflowApiError);
  });

  test("validateAgentSpec 拒绝非对象", () => {
    expect(() => validateAgentSpec("nope", "test")).toThrow(WorkflowApiError);
    expect(() => validateAgentSpec(null, "test")).toThrow(WorkflowApiError);
  });

  test("validateStageSpec 复用 prompt 必填 + 闭包守卫", () => {
    expect(validateStageSpec({ prompt: "s" }, "stage").prompt).toBe("s");
    expect(() => validateStageSpec({ prompt: "" }, "stage")).toThrow(WorkflowApiError);
  });
});

describe("M0 共享类型契约：JsonSchema 结构化 + zod", () => {
  test("JsonSchemaZ 接受结构化 schema、拒绝坏 type", () => {
    const ok = JsonSchemaZ.safeParse({
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail"] },
        score: { type: "number" },
      },
      required: ["verdict"],
    });
    expect(ok.success).toBe(true);
    expect(JsonSchemaZ.safeParse({ type: "weird" }).success).toBe(false);
  });
});

describe("M0 共享类型契约：WorkflowEvent 名称常量（spec §8）", () => {
  test("六个事件名固定不漂移", () => {
    expect(WORKFLOW_EVENTS).toEqual({
      started: "workflow.started",
      phase: "workflow.phase",
      agentStarted: "workflow.agent.started",
      agentCompleted: "workflow.agent.completed",
      completed: "workflow.completed",
      failed: "workflow.failed",
    });
  });
});

describe("M0 共享类型契约：类型层（编译期）钉死形态", () => {
  test("SubagentResult / Budget / RunStatus / AgentSpec / StageSpec 形态自洽", () => {
    const ok: SubagentResult = { ok: true, value: "text" };
    const okObj: SubagentResult = { ok: true, value: { a: 1 } };
    const fail: SubagentResult = { ok: false, status: "interrupted" };
    const budget: Budget = { total: 100, spent: () => 10, remaining: () => 90 };
    const status: RunStatus = "interrupted";
    const a: AgentSpec = { prompt: "p", schema: { type: "string" }, isolation: "worktree" };
    const s: StageSpec = { prompt: "p", model: "glm-4.6" };
    expect(ok.ok && okObj.ok && !fail.ok).toBe(true);
    expect(budget.total).toBe(100);
    expect(status).toBe("interrupted");
    expect(a.prompt + s.prompt).toBe("pp");
  });
});
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/types.test.ts
```
预期失败：`Cannot find module '../types'`（`types.ts` 尚未创建）。

#### 1.2 GREEN — 实现 `workflow/types.ts`

新建 `packages/core/src/workflow/types.ts`：
```ts
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
export const JsonSchemaZ: z.ZodType<JsonSchema> = z.lazy(() =>
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
export type StageSpec = {
  prompt: string;
  schema?: JsonSchema;
  tools?: string[];
  model?: string;
};

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
export type JournalRow = { seq: number; specHash: string; status: AgentStatus; resultJson: unknown };

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

  // run 编排所需（M3/M5/M6）
  store: WorkflowStorePort;
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

/** §2.1 asyncify 守卫：规格必须可序列化（禁 guest 闭包），否则挂起期会迫使再入 guest。 */
export function assertSerializableSpec(s: unknown, where: string): void {
  if (typeof s !== "object" || s === null) {
    throw new WorkflowApiError(`${where}: spec must be a plain object`);
  }
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (typeof v === "function") {
      throw new WorkflowApiError(
        `${where}: field "${k}" must be serializable — closures are forbidden under QuickJS asyncify single-suspend (spec §2.1)`,
      );
    }
  }
}

export function validateAgentSpec(s: unknown, where: string): AgentSpec {
  assertSerializableSpec(s, where);
  const spec = s as Record<string, unknown>;
  if (typeof spec.prompt !== "string" || spec.prompt.length === 0) {
    throw new WorkflowApiError(`${where}: spec.prompt must be a non-empty string`);
  }
  return spec as unknown as AgentSpec;
}

export function validateStageSpec(s: unknown, where: string): StageSpec {
  validateAgentSpec(s, where); // StageSpec ⊂ AgentSpec：复用 prompt 必填 + 闭包守卫
  return s as unknown as StageSpec;
}
```

#### 1.3 VERIFY
```bash
bun test packages/core/src/workflow/__tests__/types.test.ts   # 预期全绿
bun run typecheck                                              # tsc --noEmit，0 error
bun run check                                                  # biome check .，0 error
```
> 若 `JsonSchemaZ` 的 `z.lazy` 递归注解在本仓 zod 版本下报类型不可赋值，按 RED 失败定位微调（可退化为 `z.ZodTypeAny` 注解，校验语义不变）——测试是契约，实现向测试收敛。

#### 1.4 COMMIT
```bash
git add packages/core/src/workflow/types.ts packages/core/src/workflow/__tests__/types.test.ts
git commit -m "feat(workflow): M0 共享类型契约 workflow/types.ts（唯一权威定义 + 守卫）

集中定义跨里程碑共享类型，消除 M1–M5 重复与签名漂移：
WorkflowPrimitives/AgentSpec/StageSpec/JsonSchema(结构化)/SubagentResult(统一)/
RunSubagent(统一签名)/WorkflowContext(统一)/RunStatus(completed|failed|interrupted)/
Budget/WORKFLOW_EVENTS + WorkflowApiError/序列化守卫。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### 下游里程碑改用 M0（谁定义、谁 import）

| 类型 / 符号 | 定义处（唯一） | 下游 import（不再本地声明） | 漂移修复 |
|---|---|---|---|
| `JsonSchema`（结构化） | **M0 types.ts** | M1 `schema.ts`/`subagent.ts`、M2 | M2 的 `Record<string,unknown>` 删除，改结构化 import |
| `AgentSpec` | **M0 types.ts** | M1 `subagent.ts`/`primitives.ts`、M2、M6 | M1+M2 双重声明删除 |
| `StageSpec` | **M0 types.ts** | M2 `primitives.ts`、M6 | 首见即在 M0 |
| `SpecResult` | **M0 types.ts** | M2 `primitives.ts` | — |
| `SubagentResult` | **M0 types.ts** | M1 `subagent.ts`、M2 `primitives.ts`、M6 | 统一为 `{ok:true;value}`/`{ok:false;status;error?}`；**M1 成功分支改 `value`（不再 text/data 二分）；M2 fake 失败补 `status:"failed"`** |
| `RunSubagent` | **M0 types.ts** | M2 `primitives.ts`（makeParallel/makePipeline）、M3 `journaled-run.ts`、M6 | 统一 `(spec, signal)=>Promise<SubagentResult>`；M1 实现 `runSubagent(spec,ctx)` 由 M6 适配为此端口 |
| `WorkflowPrimitives` | **M0 types.ts** | M1 `runtime.ts`/`primitives.ts`、M6 | M1 局部声明删除；补 parallel/pipeline/workflow/budget（M1 桩、M6 接线）|
| `WorkflowContext` | **M0 types.ts** | M1 `subagent.ts`、M6 `runtime.ts` | 合并 M1 `WorkflowContext` + M5 `WorkflowRunContext`；`parentSignal`→`signal`；删除 M5 ctx 内 `runtime` 字段（由 createWorkflowRuntime 产出）|
| `WorkflowRuntime` | **M0 types.ts** | M5 `registry.ts`/`runWorkflow.ts`、M6 `runtime.ts` | M5 三参 `execute(s,a,ctx)`→两参 `execute(s,a)`（ctx 在 createWorkflowRuntime 捕获）|
| `RunStatus`/`PersistedRunStatus`/`AgentStatus`/`CallKind`/`JournalRow` | **M0 types.ts** | M3 `journal-service.ts`/`schema.ts`/`resume.ts`、M4 `interrupt.ts` | M3 局部 `RunStatus`/`CallKind`/`JournalRow` 删除；M4 `RunOutcome` = `RunStatus`；M5 `'cancelled'`→`'interrupted'` |
| `RunScriptResult` | **M0 types.ts** | M1 `runtime.ts`/`index.ts` | M1 局部声明删除 |
| `WorkflowResult` | **M0 types.ts** | M5 `index.ts`/`runWorkflow.ts`、M6 | M5 局部声明删除；`'cancelled'`→`'interrupted'` |
| `Budget` | **M0 types.ts** | M2 `scheduler.ts`（TokenBudget implements）、M6 | TokenBudget 须 structurally 满足 Budget |
| `WorkflowStorePort` | **M0 types.ts** | M5 `store.ts`（WorkflowStore satisfies）、M6 | — |
| `WorkflowJournalPort` | **M0 types.ts** | M3 `journal-service.ts`（satisfies）、M6 | — |
| `WORKFLOW_EVENTS`/`WorkflowEventName` | **M0 types.ts** | M4 `events.ts` | 事件名单点引用 |
| `WorkflowApiError`/`assertSerializableSpec`/`validateAgentSpec`/`validateStageSpec` | **M0 types.ts** | M2 `primitives.ts`（**须 `export { WorkflowApiError } from "../types"` 再导出**，使 M2 既有测试的 `import { WorkflowApiError } from "../primitives"` 仍解析）| M2 内联守卫删除，改 import |

**index.ts 纪律**：各里程碑只**追加**导出，`index.ts` 由 M6 汇总（M0 不建/不改 index）。

**另两处具体 bug（在各自里程碑修，非 M0 定义，但契约在此钉死）**
- `RichApprovalDecision` 不存在：M4 `bubbling-approval.ts` 及其测试改用 `loop/types.ts` 既有 `ApprovalDecision`（`loop/types.ts:59-65`，无 `RichApprovalDecision`）。
- `workflow.agent.started` 序号字段：protocol(M4) 与 `WorkflowEvents.agentStarted` 用 **`agentSeq`** 而非 `seq`（信封 `seq` 由 `appendEvent` 单点分配，不可被事件载荷字段覆盖）。

---

### M0 验收清单
- [ ] `packages/core/src/workflow/types.ts` 单文件定义全部共享类型 + zod(`JsonSchemaZ`) + 守卫（`WorkflowApiError`/`assertSerializableSpec`/`validateAgentSpec`/`validateStageSpec`）。
- [ ] `types.test.ts` 全绿；`bun run typecheck` 0 error；`bun run check` 干净。
- [ ] `types.ts` **不 import** 尚未存在的 `store.ts`/`journal-service.ts`/`scheduler.ts`/`runtime.ts`（仅结构化端口）。
- [ ] 状态词表统一 `completed|failed|interrupted`（无 `cancelled`）；`SubagentResult` 单一形态；`JsonSchema` 结构化；`RunSubagent` 单一签名。
- [ ] 下游里程碑（M1–M6）均改为从 `./types` import，无任何本地重复声明（评审核对上表）。

---

## 里程碑 M1：runtime + agent()

> 目标（spec §12.1）：QuickJS(wasm, QuickJS-ng asyncify) 实例 + 注入 `agent()`（嵌套 `queryLoop` + schema 结构化返回）+ `Date/random` 桩；**顺序脚本能跑通**。
>
> **里程碑边界（非占位，明确作用域）**
> - **共享类型一律 import 自 `packages/core/src/workflow/types.ts`（M0 唯一权威来源）。本里程碑绝不重复定义/本地重声明** `AgentSpec` / `JsonSchema` / `SubagentResult` / `WorkflowContext` / `WorkflowPrimitives` / `RunSubagent` / `RunScriptResult` / `SpecResult` 等任何契约符号——只从 `./types` 引入。
> - 本里程碑交付 `core/src/workflow/` 下 `runtime.ts` / `subagent.ts` / `primitives.ts` / `schema.ts` / `index.ts`。`types.ts`(M0) 已存在（前置依赖）；`scheduler.ts`(M2) / `journal-service.ts`(M3) / `events.ts`(M4) / `store.ts`(M5) 不在本里程碑。
> - **公开入口归 M6**：M1 **不定义** 与 M5/M6 冲突的公开 `runWorkflow`，也不定义 `createWorkflowRuntime`。M1 只保留**低层** `runWorkflowScript(script, primitives)`（QuickJS eval 壳）+ `makeWorkflowPrimitives(ctx, args)`（原语装配）；二者由 M6 的 `createWorkflowRuntime(ctx)` 串成 `WorkflowRuntime.execute(source, args)` 公开面。
> - **M1 只实现 `agent` / `log` / `phase` / `args` 四个原语**（真实接线）。`WorkflowPrimitives` 是 M0 全集（含 `parallel`/`pipeline`/`workflow`/`budget`）——M1 以**抛错桩**（`parallel`/`pipeline`/`workflow`）+ **no-op `budget`** 占位满足契约类型；其调度实现属 M2（`makeParallel`/`makePipeline`/`TokenBudget`），向 guest 的**注入与 PRELUDE 绑定属 M6**。M1 的 `runtime.ts` PRELUDE 只绑 `agent`/`log`/`phase`/`args` 四个 guest 全局。
> - **asyncify 单挂起约束（§2.1）**：M1 唯一 async 原语是 `agent()`，一次调用 = 一次 wasm 挂起；宿主在挂起期内完整跑完嵌套 `queryLoop`，**绝不回调 guest**。`parallel/pipeline`（必须收可序列化规格、非 guest 闭包；守卫 `assertSerializableSpec`/`validateAgentSpec` 已在 M0 `types.ts` 定义）调度实现推后 M2、guest 注入推后 M6。
> - **宿主↔guest 跨界一律走「字符串」**：对象在 guest 内用 `JSON` 编解码，宿主侧只用 `newString/getString`，零手工 handle 构造（避免 marshalling 脆弱性，且严格满足单挂起）。
> - **持久化边界**：M1 的 `emit`（`(draft: DraftEvent) => ArcEvent`）由调用方注入（测试用 spy）；子会话行落库（`journal`）属 M3，`workflow.*` 事件接线属 M4。
> - **确定性桩范围**：M1 桩 `Date.now`/`Math.random`（抛错）。无参 `new Date()` 禁用后、经 `args` 注入时间/种子的**接线属 M6**（`createWorkflowRuntime` 装配 args 时一并注入确定性源）。
> - `AgentSpec.model` / `isolation` 字段（M0 `AgentSpec` 定义）保留（前向兼容 §4），M1 记录但不应用（模型热切换需 M2 共享限流配套；worktree 隔离 M2/M6）。
>
> **开工前**：M1 前置依赖 M0（`workflow/types.ts` 必须已存在）。从含 M0 的基线切工作分支：
> ```bash
> git switch -c feat/workflow-m1-runtime-agent
> ```
> 测试运行器为 `bun:test`（`packages/core` 已被 `vitest.config.ts` 排除）。测试置于 `packages/core/src/workflow/__tests__/`。
>
> **从 `__tests__` 引 M0 共享类型用 `../types`；从同级 `*.ts` 引用 `./types`。下游只 import，绝不本地重声明。**

---

## Task 1：QuickJS asyncify 运行时骨架（`runtime.ts`）

**交付**：加依赖 + `runWorkflowScript(script, primitives)`：加载 asyncify wasm 变体、注入 M1 四原语（`agent` 异步 / `log`/`phase` 同步 / `args`）、桩 `Date.now`/`Math.random`、执行脚本、错误归一为结构化失败（`RunScriptResult`，自 M0）、句柄/上下文/运行时全释放。隔离性（guest 触不到 fs/net/process）由 QuickJS wasm 默认无宿主 API 天然保证，用测试断言钉住。`WorkflowPrimitives`/`RunScriptResult` 均 **import 自 `./types`，不在 `runtime.ts` 内声明**。

### 1.1 RED — 先写失败测试

加依赖（在 `packages/core` 工作区）：
```bash
bun add quickjs-emscripten @jitl/quickjs-ng-wasmfile-release-asyncify --cwd=packages/core
```
（二者落 `packages/core/package.json` 的 `dependencies`。）

新建 `packages/core/src/workflow/__tests__/runtime.test.ts`：
```ts
import { describe, expect, test } from "bun:test";
import { runWorkflowScript } from "../runtime";
import type { WorkflowPrimitives } from "../types";

// WorkflowPrimitives 是 M0 全集（8 字段）。M1 runtime 仅绑定 agent/log/phase/args 四个 guest 全局；
// parallel/pipeline/workflow/budget 在此仅为满足契约类型的桩（M1 不向 guest 暴露，注入归 M6）。
function stubPrimitives(over: Partial<WorkflowPrimitives> = {}): WorkflowPrimitives {
  return {
    args: over.args ?? {},
    agent: over.agent ?? (async () => "stub"),
    log: over.log ?? (() => {}),
    phase: over.phase ?? (() => {}),
    parallel: over.parallel ?? (async () => []),
    pipeline: over.pipeline ?? (async () => []),
    workflow: over.workflow ?? (async () => null),
    budget: over.budget ?? { total: 0, spent: () => 0, remaining: () => 0 },
  };
}

describe("workflow runtime (QuickJS asyncify)", () => {
  test("evaluates a script and returns its final expression", async () => {
    const res = await runWorkflowScript("1 + 2", stubPrimitives());
    expect(res).toEqual({ status: "completed", output: 3 });
  });

  test("guest cannot reach host globals (fs/net/process)", async () => {
    const script = `JSON.stringify({
      process: typeof process,
      fetch: typeof fetch,
      require: typeof require,
      Bun: typeof Bun,
      agent: typeof agent,
    })`;
    const res = await runWorkflowScript(script, stubPrimitives());
    expect(res.status).toBe("completed");
    const probe = JSON.parse((res as { output: string }).output);
    expect(probe).toEqual({
      process: "undefined",
      fetch: "undefined",
      require: "undefined",
      Bun: "undefined",
      agent: "function",
    });
  });

  test("Date.now is stubbed to throw (determinism)", async () => {
    const res = await runWorkflowScript("Date.now()", stubPrimitives());
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("Date.now");
  });

  test("Math.random is stubbed to throw (determinism)", async () => {
    const res = await runWorkflowScript("Math.random()", stubPrimitives());
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("Math.random");
  });

  test("async agent() primitive is injected and awaited (single asyncify suspend)", async () => {
    let seen = "";
    const res = await runWorkflowScript(
      `const r = await agent("hello", { label: "x" }); r.echo`,
      stubPrimitives({
        agent: async (prompt, opts) => {
          seen = `${prompt}:${opts?.label}`;
          return { echo: prompt.toUpperCase() };
        },
      }),
    );
    expect(seen).toBe("hello:x");
    expect(res).toEqual({ status: "completed", output: "HELLO" });
  });

  test("guest syntax error is normalized to a structured failure", async () => {
    const res = await runWorkflowScript("const = ;", stubPrimitives());
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error.length).toBeGreaterThan(0);
  });

  test("top-level throw is normalized to a structured failure", async () => {
    const res = await runWorkflowScript(`throw new Error("boom")`, stubPrimitives());
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("boom");
  });
});
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/runtime.test.ts
```
预期失败：`Cannot find module '../runtime'`（`runtime.ts` 尚未创建；`../types` 已由 M0 提供）。

### 1.2 GREEN — 实现 `runtime.ts`

新建 `packages/core/src/workflow/runtime.ts`：
```ts
import variant from "@jitl/quickjs-ng-wasmfile-release-asyncify";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSAsyncWASMModule,
  type QuickJSHandle,
} from "quickjs-emscripten";
// 共享契约类型自 M0 单一权威来源；runtime.ts 绝不本地重声明。
import type { RunScriptResult, WorkflowPrimitives } from "./types";

// 异步 wasm 模块按进程缓存：asyncify 变体加载一次复用（与 provider-manager 单例同构）。
let modulePromise: Promise<QuickJSAsyncWASMModule> | undefined;
function getAsyncModule(): Promise<QuickJSAsyncWASMModule> {
  if (!modulePromise) modulePromise = newQuickJSAsyncWASMModuleFromVariant(variant);
  return modulePromise;
}

// 友好原语 + 确定性桩。所有宿主↔guest 跨界只走「字符串」，对象在 guest 内 JSON 编解码——
// 宿主侧零手工 handle 构造（marshalling 鲁棒），且 __agent 一次挂起内宿主跑完嵌套 queryLoop，
// 期间绝不回调 guest（满足 §2.1 asyncify 单挂起约束）。
// M1 只绑 agent/log/phase/args；parallel/pipeline/workflow + budget 全局的 PRELUDE 绑定归 M6。
const PRELUDE = `
globalThis.args = JSON.parse(__argsJson);
globalThis.log = (m) => { __log(String(m)); };
globalThis.phase = (t) => { __phase(String(t)); };
globalThis.agent = async (prompt, opts) =>
  JSON.parse(await __agent(String(prompt), JSON.stringify(opts === undefined ? null : opts)));
Date.now = () => { throw new Error("Date.now() is forbidden in workflow scripts; pass time via args"); };
Math.random = () => { throw new Error("Math.random() is forbidden in workflow scripts; pass a seed via args"); };
`;

// M1 仅消费 primitives 的 args/agent/log/phase 四个字段；parallel/pipeline/workflow/budget
// 由 M6 扩展 PRELUDE 时接线（届时本函数追加对应 __parallel/__pipeline/__workflow 绑定 + budget 全局）。
function installPrimitives(context: QuickJSAsyncContext, p: WorkflowPrimitives): void {
  const argsJson = context.newString(JSON.stringify(p.args ?? null));
  context.setProp(context.global, "__argsJson", argsJson);
  argsJson.dispose();

  const logFn = context.newFunction("__log", (h) => {
    p.log(context.getString(h));
  });
  context.setProp(context.global, "__log", logFn);
  logFn.dispose();

  const phaseFn = context.newFunction("__phase", (h) => {
    p.phase(context.getString(h));
  });
  context.setProp(context.global, "__phase", phaseFn);
  phaseFn.dispose();

  const agentFn = context.newAsyncifiedFunction("__agent", async (promptH, optsH) => {
    const prompt = context.getString(promptH);
    const optsJson = context.getString(optsH); // guest 始终传 JSON 字符串
    const opts = optsJson === "null" ? undefined : (JSON.parse(optsJson) as Record<string, unknown>);
    const result = await p.agent(prompt, opts);
    return context.newString(JSON.stringify(result ?? null));
  });
  context.setProp(context.global, "__agent", agentFn);
  agentFn.dispose();
}

export async function runWorkflowScript(
  script: string,
  primitives: WorkflowPrimitives,
): Promise<RunScriptResult> {
  const mod = await getAsyncModule();
  const runtime = mod.newRuntime();
  const context = runtime.newContext();
  try {
    installPrimitives(context, primitives);
    // 注入序 + 确定性桩：同步 eval（无 await）。prelude 为可信代码。
    context.unwrapResult(context.evalCode(PRELUDE)).dispose();

    let valueHandle: QuickJSHandle;
    try {
      valueHandle = context.unwrapResult(await context.evalCodeAsync(script));
    } catch (e) {
      // 语法错误 / guest 顶层 throw 归一为结构化失败（unwrapResult 抛 QuickJSError）
      return { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    const output = context.dump(valueHandle) as unknown;
    valueHandle.dispose();
    return { status: "completed", output };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
```

### 1.3 VERIFY
```bash
bun run typecheck
bun run check
bun test packages/core/src/workflow/__tests__/runtime.test.ts
```
预期：类型/lint 通过；7 个 test 全绿。

> 若某条因 `quickjs-emscripten` 实际 API 细节（如顶层 await 在 `evalCodeAsync` 的求值模式 / 完成值返回）需微调，由 RED 失败定位——测试是契约，实现向测试收敛。

### 1.4 COMMIT
```bash
git add packages/core/package.json packages/core/src/workflow/runtime.ts \
        packages/core/src/workflow/__tests__/runtime.test.ts
git commit -m "feat(workflow): QuickJS asyncify runtime + 原语注入 + 确定性桩

共享类型 import 自 workflow/types.ts(M0)；runtime 仅绑 agent/log/phase/args，
parallel/pipeline/workflow/budget 的 guest 注入归 M6。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2：`agent()` 落地——嵌套 queryLoop（`subagent.ts`）

**交付**：`runSubagent(spec, ctx)` 跑一个嵌套 `queryLoop`：派生子 `sessionId`/`turnId`、独立消息历史（system 角色提示 + user prompt，**不见父历史**）、受限工具集（`RestrictedToolRegistry`）、`AbortSignal.any` 父中断级联、完成后从 `state.messages` 末尾投影最终文本。**结果用 M0 统一 `SubagentResult`**：成功 → `{ ok: true, value }`（无 schema 时 `value` 为最终文本字符串）；失败 → `{ ok: false, status, error? }`。**`AgentSpec`/`SubagentResult`/`WorkflowContext` 全部 import 自 `./types`，本文件绝不重复定义。** schema 分支在 Task 4 接入（`value` = 校验后的结构化对象）。

> `runSubagent(spec, ctx)` 是 M1 的低层签名（读 `ctx.signal` 为 run 级父信号，再派生子信号）；M6 装配时按调用派生 signal 适配为 M0 `RunSubagent` 端口：`const run: RunSubagent = (spec, signal) => runSubagent(spec, { ...ctx, signal });`。

### 2.1 RED — 测试夹具 + 失败测试

新建 `packages/core/src/workflow/__tests__/fixtures.ts`：
```ts
import type { ArcEvent } from "@arclight/protocol";
import type { DraftEvent } from "../../db/appendEvent";
import type {
  ApprovalSeam,
  CallProvider,
  LlmMessage,
  ProviderResult,
  ProviderStreamPart,
} from "../../loop/types";
import type { SandboxService } from "../../sandbox/service";
import { makeExecuteTool, ToolRegistry } from "../../tools/registry";
// 共享契约类型自 M0；__tests__ 用 ../types。
import type { WorkflowContext, WorkflowStorePort } from "../types";

export type Step = { parts?: ProviderStreamPart[]; result: ProviderResult };

// 脚本化 provider：每轮消费一个 step；记录每次调用收到的 messages（用于隔离断言）。
export function scriptedProvider(steps: Step[]): { provider: CallProvider; calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = [];
  let i = 0;
  const provider: CallProvider = async function* (messages, _tools, _signal) {
    calls.push(messages as LlmMessage[]);
    const step = steps[i++] ?? { result: { text: "", toolCalls: [], finishReason: "stop" } };
    for (const part of step.parts ?? []) yield part;
    return step.result;
  };
  return { provider, calls };
}

// StructuredOutput.execute 不触达 sandbox；此桩仅满足 makeExecuteTool 的依赖形状。
export const dummySandbox = {
  backend: "docker-fallback",
  probe: async () => ({ available: false }),
  run: async () => {
    throw new Error("sandbox not used in workflow unit tests");
  },
  cancel: async () => {},
} as unknown as SandboxService;

export const allowAllApprovals: ApprovalSeam = {
  async check() {
    return { decision: "allow" };
  },
};

// WorkflowContext.store 是必填字段（M0），但 runSubagent(M1) 不触达 store——给一个抛错桩满足类型。
export const dummyStore: WorkflowStorePort = {
  has: () => false,
  load: (name) => {
    throw new Error(`workflow store not used in M1 unit tests: ${name}`);
  },
  save: (name) => ({ name, scriptHash: "" }),
  list: () => [],
};

export function emitSpy(): { emit: WorkflowContext["emit"]; events: ArcEvent[] } {
  const events: ArcEvent[] = [];
  let seq = 0;
  const emit: WorkflowContext["emit"] = (draft: DraftEvent) => {
    const stamped = { ...draft, seq: ++seq, ts: Date.now(), epoch: 0 } as ArcEvent;
    events.push(stamped);
    return stamped;
  };
  return { emit, events };
}

export function makeCtx(opts: {
  provider: CallProvider;
  registry?: WorkflowContext["registry"];
  executeTool?: WorkflowContext["executeTool"];
  signal?: AbortSignal; // run 级父信号（M0 WorkflowContext.signal）
  maxReflections?: number;
  onPhase?: (t: string) => void;
  onLog?: (m: string) => void;
}): WorkflowContext {
  let n = 0;
  return {
    parentSessionId: "parent-s",
    parentTurnId: "parent-t",
    cwd: "/tmp/wf-test",
    signal: opts.signal ?? new AbortController().signal,
    callProvider: opts.provider,
    registry: opts.registry ?? new ToolRegistry(),
    approvals: allowAllApprovals,
    executeTool: opts.executeTool ?? makeExecuteTool({ sandbox: dummySandbox }),
    emit: emitSpy().emit,
    store: dummyStore,
    maxRetries: 0,
    maxReflections: opts.maxReflections ?? 3,
    newId: () => `wfid-${++n}`,
    onPhase: opts.onPhase,
    onLog: opts.onLog,
  };
}
```

> 说明：`fixtures.ts` 的 `../../loop/types` import **不含 `LoopDeps`**——夹具不直接引用该类型（`executeTool` 经 `WorkflowContext["executeTool"]` 投影，自 `../types`）。挂一个未用的 `LoopDeps` 会触发 biome `lint/correctness/noUnusedImports`（warning），徒增噪音，故删去。

新建 `packages/core/src/workflow/__tests__/subagent.test.ts`：
```ts
import { describe, expect, test } from "bun:test";
import { runSubagent } from "../subagent";
import { makeCtx, scriptedProvider } from "./fixtures";

describe("runSubagent (nested queryLoop)", () => {
  test("returns the final assistant text as value on completion", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "the answer", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "compute" }, makeCtx({ provider }));
    expect(res).toEqual({ ok: true, value: "the answer" });
  });

  test("context isolation: child sees only its own system + user messages", async () => {
    const { provider, calls } = scriptedProvider([
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    await runSubagent({ prompt: "do the thing", label: "planner" }, makeCtx({ provider }));
    expect(calls).toHaveLength(1);
    const msgs = calls[0]!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]).toMatchObject({ role: "user", content: "do the thing" });
    // 子不见父历史/身份：消息内不出现父 session/turn 标识（parentSessionId="parent-s" / parentTurnId="parent-t"）。
    // 注：角色提示里含 "parent conversation" 字样，故须按标识符（parent-s/parent-t）精确匹配，不能裸搜 "parent"。
    expect(msgs.some((m) => "content" in m && /parent-[st]/.test(m.content))).toBe(false);
  });

  test("parent interrupt cascades to the child (returns interrupted)", async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, calls } = scriptedProvider([
      { result: { text: "should not run", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "x" }, makeCtx({ provider, signal: ac.signal }));
    expect(res).toEqual({ ok: false, status: "interrupted" });
    expect(calls).toHaveLength(0); // 预中断 → queryLoop 起步即返回 interrupted，provider 不被调用
  });
});
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/subagent.test.ts
```
预期失败：`Cannot find module '../subagent'`。

### 2.2 GREEN — 实现 `subagent.ts`

新建 `packages/core/src/workflow/subagent.ts`：
```ts
import { randomUUID } from "node:crypto";
import type { Tool } from "@arclight/protocol";
import { queryLoop } from "../loop/query-loop";
import type {
  LlmMessage,
  LoopDeps,
  LoopState,
  ProviderToolSchema,
  ToolRegistryLike,
} from "../loop/types";
// 共享契约类型自 M0 单一权威来源；subagent.ts 绝不本地重声明 AgentSpec/SubagentResult/WorkflowContext。
import type { AgentSpec, SubagentResult, WorkflowContext } from "./types";

// 受限工具集：ToolRegistryLike 子集视图 + 可注入额外工具(StructuredOutput)。loop 零改动。
export class RestrictedToolRegistry implements ToolRegistryLike {
  private readonly allow: Set<string>;
  constructor(
    private readonly base: ToolRegistryLike,
    allow: Iterable<string>,
    private readonly extra: Tool<unknown, unknown>[] = [],
  ) {
    this.allow = new Set(allow);
  }
  schemas(): ProviderToolSchema[] {
    const baseSchemas = this.base.schemas().filter((s) => this.allow.has(s.name));
    const extraSchemas = this.extra.map((t) => ({
      name: t.meta.name,
      description: t.meta.description,
      inputSchema: t.inputSchema,
    }));
    return [...baseSchemas, ...extraSchemas];
  }
  get(name: string): Tool<unknown, unknown> | undefined {
    const injected = this.extra.find((t) => t.meta.name === name);
    if (injected) return injected;
    return this.allow.has(name) ? this.base.get(name) : undefined;
  }
}

// 默认安全子集：只读且 safe 的工具（无白名单时给一个稳妥默认）。
export function defaultSafeToolNames(registry: ToolRegistryLike): string[] {
  return registry
    .schemas()
    .map((s) => s.name)
    .filter((name) => {
      const t = registry.get(name);
      return !!t && t.meta.isReadOnly && t.meta.riskTier === "safe";
    });
}

function defaultRolePrompt(spec: AgentSpec): string {
  const lines = [
    spec.label ? `You are the "${spec.label}" subagent.` : "You are a subagent.",
    "You run in an isolated context: you cannot see the parent conversation, its history, or its files.",
    "Use only the tools provided to accomplish the task described in the user message.",
  ];
  if (spec.schema) {
    lines.push(
      "When you have the final answer, call the StructuredOutput tool exactly once with a payload matching its input schema, then send a short closing message and stop.",
    );
  }
  return lines.join(" ");
}

function finalAssistantText(messages: LlmMessage[]): string {
  // queryLoop 完成时把最终 assistant 文本 append 进 state.messages（query-loop.ts:146）。
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && !("toolCalls" in m)) return m.content;
  }
  return "";
}

export async function runSubagent(spec: AgentSpec, ctx: WorkflowContext): Promise<SubagentResult> {
  const newId = ctx.newId ?? (() => randomUUID());
  const sessionId = `wf-${newId()}`;
  const turnId = `wf-${newId()}`;
  const childAc = new AbortController();
  // 父 interrupt 级联：任一中断即切断 provider 流 + 工具执行（queryLoop signal 单路）。
  // ctx.signal 为 run 级父信号（M0 WorkflowContext.signal）。
  const signal = AbortSignal.any([ctx.signal, childAc.signal]);

  const allow = spec.tools ?? defaultSafeToolNames(ctx.registry);
  const registry = new RestrictedToolRegistry(ctx.registry, allow);

  const messages: LlmMessage[] = [
    { role: "system", content: defaultRolePrompt(spec) },
    { role: "user", content: spec.prompt },
  ];
  const state: LoopState = { sessionId, turnId, cwd: ctx.cwd, messages };
  const deps: LoopDeps = {
    emit: ctx.emit,
    callProvider: ctx.callProvider,
    registry,
    approvals: ctx.approvals,
    executeTool: ctx.executeTool,
    signal,
    maxRetries: ctx.maxRetries ?? 3,
    maxReflections: ctx.maxReflections ?? 3,
  };

  try {
    const gen = queryLoop(state, deps);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    if (r.value.status !== "completed") return { ok: false, status: r.value.status };
    return { ok: true, value: finalAssistantText(state.messages) };
  } finally {
    childAc.abort(); // 释放 AbortSignal.any 监听器
  }
}
```

### 2.3 VERIFY
```bash
bun run typecheck
bun run check
bun test packages/core/src/workflow/__tests__/subagent.test.ts
```
预期：3 个 test 全绿。

### 2.4 COMMIT
```bash
git add packages/core/src/workflow/subagent.ts \
        packages/core/src/workflow/__tests__/fixtures.ts \
        packages/core/src/workflow/__tests__/subagent.test.ts
git commit -m "feat(workflow): agent() 落地——嵌套 queryLoop + 上下文隔离 + 中断级联

结果用 M0 统一 SubagentResult({ok:true;value})；类型 import 自 ./types。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3：原语装配 + M1 导出（`primitives.ts` + `index.ts`）

**交付**：`makeWorkflowPrimitives(ctx, args)` 返回 M0 **全集** `WorkflowPrimitives`——M1 接线 `agent`（成功→`value`，失败→`null`，spec §10）/`log`/`phase`/`args`；`parallel`/`pipeline`/`workflow` 为**抛错桩**、`budget` 为 **no-op**（注入与真实实现归 M6/M2，作用域已标注）。`index.ts` **只追加导出 M1 产物**（按 biome import 排序就地插入，不 clobber），并标注最终公开面（`createWorkflowRuntime`/`runWorkflow` 等）由 M6 汇总。**M1 不定义公开 `runWorkflow`**——本任务的集成测试直接组合低层 `runWorkflowScript(script, makeWorkflowPrimitives(ctx, args))` 验证顺序脚本跑通：多 `agent()` 串行、`args` 可读、`phase` 回调触发、顶层 throw → failed。

### 3.1 RED — 失败测试

新建 `packages/core/src/workflow/__tests__/run-workflow.test.ts`：
```ts
import { describe, expect, test } from "bun:test";
import { makeWorkflowPrimitives } from "../primitives";
import { runWorkflowScript } from "../runtime";
import { makeCtx, scriptedProvider } from "./fixtures";

// M1 无公开 runWorkflow（公开入口 createWorkflowRuntime/runWorkflow 归 M6）；
// 本测直接组合低层 runWorkflowScript + makeWorkflowPrimitives 验证顺序脚本跑通。
const run = (script: string, args: unknown, ctx: ReturnType<typeof makeCtx>) =>
  runWorkflowScript(script, makeWorkflowPrimitives(ctx, args));

describe("sequential script (runWorkflowScript + makeWorkflowPrimitives)", () => {
  test("runs multiple agent() calls in sequence and returns the script result", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "RESULT-A", toolCalls: [], finishReason: "stop" } },
      { result: { text: "RESULT-B", toolCalls: [], finishReason: "stop" } },
    ]);
    const phases: string[] = [];
    const ctx = makeCtx({ provider, onPhase: (t) => phases.push(t) });
    const script = `
      phase("step-1");
      const a = await agent("first");
      const b = await agent("second using " + a);
      ({ a, b });
    `;
    const res = await run(script, { seed: 1 }, ctx);
    expect(res).toEqual({ status: "completed", output: { a: "RESULT-A", b: "RESULT-B" } });
    expect(phases).toEqual(["step-1"]);
  });

  test("args are injected and readable in the guest", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "ok", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await run(`args.topic`, { topic: "qubits" }, makeCtx({ provider }));
    expect(res).toEqual({ status: "completed", output: "qubits" });
  });

  test("top-level throw fails the run", async () => {
    const { provider } = scriptedProvider([]);
    const res = await run(`throw new Error("script blew up")`, {}, makeCtx({ provider }));
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("script blew up");
  });
});
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/run-workflow.test.ts
```
预期失败：`Cannot find module '../primitives'`。

### 3.2 GREEN — 实现 `primitives.ts` + `index.ts`

新建 `packages/core/src/workflow/primitives.ts`：
```ts
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
```

新建 `packages/core/src/workflow/index.ts`（本步**暂不导出** `./schema`——`schema.ts` 在 Task 4 创建，提前引用会令 `bun run typecheck` 因 `Cannot find module './schema'` 失败；该导出在 Task 4 按 biome 排序就地插入）：
```ts
// workflow 子系统对外索引。
// 纪律（M0）：各里程碑只【追加】导出本里程碑产物——按 biome import 排序就地插入（绝不 clobber 既有导出）；
// 完整公开面（如 M6 的 createWorkflowRuntime / runWorkflow）由 M6 汇总。
// 共享类型的唯一权威定义在 ./types（M0）——消费方应从 ./types import，index 仅再导出便捷别名。

// ── M1 产物（runtime / subagent / primitives；schema 导出于 Task 4 同里程碑内就地插入）──
export { makeWorkflowPrimitives } from "./primitives";
export { runWorkflowScript } from "./runtime";
export { defaultSafeToolNames, RestrictedToolRegistry, runSubagent } from "./subagent";

// 低层 runWorkflowScript 消费者所需的类型别名（权威来源仍是 ./types）。
export type { RunScriptResult, WorkflowPrimitives } from "./types";
```

### 3.3 VERIFY
```bash
bun run typecheck
bun run check
bun test packages/core/src/workflow/__tests__/run-workflow.test.ts
```
预期：类型/lint 通过（`index.ts` 本步不引用尚未存在的 `./schema`）；3 个 test 全绿。

> 注：`./schema` 的 `jsonSchemaToZod`/`makeStructuredOutputTool` 在 Task 4 创建。biome `assist/source/organizeImports` 把 `export ... from` 也按来源路径排序，故该导出在 Task 4 落地 `schema.ts` 后**就地插入** `./runtime` 与 `./subagent` 之间（仍满足「只追加、不 clobber」纪律——「追加」指语义上新增导出，非文本末尾硬塞）。Task 3 与 Task 4 在同一里程碑内连续完成，M1 收口时 index 齐全。

### 3.4 COMMIT
```bash
git add packages/core/src/workflow/primitives.ts packages/core/src/workflow/index.ts \
        packages/core/src/workflow/__tests__/run-workflow.test.ts
git commit -m "feat(workflow): 原语装配 + M1 导出（顺序脚本跑通；公开入口归 M6）

makeWorkflowPrimitives 返回 M0 WorkflowPrimitives 全集：M1 接线 agent/log/phase/args，
parallel/pipeline/workflow 抛错桩 + budget no-op（注入归 M6）。index 仅追加 M1 产物。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4：schema 强制结构化返回（`schema.ts` + `subagent.ts` 扩展 + `index.ts` 收口）

**交付**：`jsonSchemaToZod`（M0 `JsonSchema` → zod）+ `makeStructuredOutputTool`（把目标 schema 放 `inputSchema`，`execute` 捕获 `parsed.data`）。`runSubagent` 在 `spec.schema` 存在时注入 `StructuredOutput` 工具并返回 `{ ok: true, value: <校验后的结构化对象> }`。schema 不匹配由 `makeExecuteTool` 的 `inputSchema.safeParse` 失败 → **retryable `VALIDATION` 信封**（registry.ts:65-69）回灌 → 模型重试，天然复用现有反射闭环。**`JsonSchema` import 自 `./types`，不在 `schema.ts`/`subagent.ts` 内声明。** 本任务同时把 `./schema` 导出就地插入 `index.ts`，收口 M1 公开面。

### 4.1 RED — 失败测试

新建 `packages/core/src/workflow/__tests__/schema.test.ts`：
```ts
import { describe, expect, test } from "bun:test";
import { jsonSchemaToZod } from "../schema";
import { runSubagent } from "../subagent";
import type { JsonSchema } from "../types";
import { makeCtx, scriptedProvider } from "./fixtures";

const reviewSchema: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "revised"] },
    score: { type: "number" },
  },
  required: ["verdict", "score"],
};

describe("jsonSchemaToZod", () => {
  test("accepts valid object, rejects missing required + bad enum", () => {
    const zod = jsonSchemaToZod(reviewSchema);
    expect(zod.safeParse({ verdict: "pass", score: 9 }).success).toBe(true);
    expect(zod.safeParse({ verdict: "nope", score: 9 }).success).toBe(false);
    expect(zod.safeParse({ verdict: "pass" }).success).toBe(false);
  });
});

describe("runSubagent structured return", () => {
  test("returns validated data as value when the model calls StructuredOutput", async () => {
    const { provider } = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [
            { callId: "c1", name: "StructuredOutput", rawArgs: { verdict: "pass", score: 9 } },
          ],
          finishReason: "tool-calls",
        },
      },
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "review", schema: reviewSchema }, makeCtx({ provider }));
    expect(res).toEqual({ ok: true, value: { verdict: "pass", score: 9 } });
  });

  test("schema mismatch yields a retryable VALIDATION envelope; model retries then succeeds", async () => {
    const { provider } = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [{ callId: "c1", name: "StructuredOutput", rawArgs: { verdict: "maybe" } }],
          finishReason: "tool-calls",
        },
      },
      {
        result: {
          text: "",
          toolCalls: [
            { callId: "c2", name: "StructuredOutput", rawArgs: { verdict: "revised", score: 4 } },
          ],
          finishReason: "tool-calls",
        },
      },
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "review", schema: reviewSchema }, makeCtx({ provider }));
    expect(res).toEqual({ ok: true, value: { verdict: "revised", score: 4 } });
  });

  test("finishing without calling StructuredOutput is a failure", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "I refuse", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "review", schema: reviewSchema }, makeCtx({ provider }));
    expect(res.ok).toBe(false);
  });
});
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/schema.test.ts
```
预期失败：`Cannot find module '../schema'`，且 `runSubagent` 尚未处理 schema 分支。

### 4.2 GREEN — 新建 `schema.ts`

新建 `packages/core/src/workflow/schema.ts`：
```ts
import { type Tool, ToolMetaSchema } from "@arclight/protocol";
import { z } from "zod";
// JsonSchema 自 M0 单一权威来源；schema.ts 绝不本地重声明。
import type { JsonSchema } from "./types";

// 最小 JSON Schema → zod（M1 覆盖 object/string+enum/number/integer/boolean/array）。
export function jsonSchemaToZod(s: JsonSchema): z.ZodType {
  switch (s.type) {
    case "string":
      return s.enum && s.enum.length > 0 ? z.enum(s.enum as [string, ...string[]]) : z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(s.items ? jsonSchemaToZod(s.items) : z.unknown());
    case "object": {
      const required = new Set(s.required ?? []);
      const shape: Record<string, z.ZodType> = {};
      for (const [key, prop] of Object.entries(s.properties ?? {})) {
        const child = jsonSchemaToZod(prop);
        shape[key] = required.has(key) ? child : child.optional();
      }
      return z.object(shape);
    }
    default:
      return z.unknown();
  }
}

// StructuredOutput 工具：目标 schema 放 inputSchema —— makeExecuteTool 对 inputSchema 做 safeParse，
// 不匹配回 retryable VALIDATION 信封（registry.ts:65-69），驱动模型重试。execute 捕获已校验 data。
export function makeStructuredOutputTool(
  schema: z.ZodType,
  onCapture: (data: unknown) => void,
): Tool<unknown, unknown> {
  return {
    meta: ToolMetaSchema.parse({
      name: "StructuredOutput",
      description:
        "Return the final structured result for this task. Call exactly once with a payload matching the schema.",
      isReadOnly: true,
      isConcurrencySafe: true,
      riskTier: "safe",
      riskClass: "read",
      timeoutMs: 5_000,
      maxResultSizeBytes: 65_536,
    }),
    inputSchema: schema as z.ZodType<unknown>,
    outputSchema: z.object({ ok: z.literal(true) }) as z.ZodType<unknown>,
    async execute(input) {
      onCapture(input);
      return { ok: true };
    },
    toModelOutput: () => "Structured output recorded. Send a short closing message and stop.",
  };
}
```

### 4.3 GREEN — 扩展 `subagent.ts` + 收口 `index.ts`

对 `packages/core/src/workflow/subagent.ts` 做三处精确改动 (a)/(b)/(c)，再对 `index.ts` 做一处追加 (d)。

**(a) 增加 import**（按 biome `assist/source/organizeImports` 排序：相对路径 `../loop/*` 在 `./schema` 之前、`./schema` 在 `./types` 之前——故置于 `} from "../loop/types";` 之后、`./types` 的 import 之前）。改动后 `subagent.ts` 的 import 块为：
```ts
import { randomUUID } from "node:crypto";
import type { Tool } from "@arclight/protocol";
import { queryLoop } from "../loop/query-loop";
import type {
  LlmMessage,
  LoopDeps,
  LoopState,
  ProviderToolSchema,
  ToolRegistryLike,
} from "../loop/types";
import { jsonSchemaToZod, makeStructuredOutputTool } from "./schema";
// 共享契约类型自 M0 单一权威来源；subagent.ts 绝不本地重声明 AgentSpec/SubagentResult/WorkflowContext。
import type { AgentSpec, SubagentResult, WorkflowContext } from "./types";
```
> 误把 `./schema` 放在 `import { queryLoop } ...` 之后（`../loop/types` 之前）会令 biome 报 `Sort these imports.`（error），`bun run check` 失败。

**(b)** 把 `runSubagent` 内构建受限注册表的两行：
```ts
  const allow = spec.tools ?? defaultSafeToolNames(ctx.registry);
  const registry = new RestrictedToolRegistry(ctx.registry, allow);
```
替换为：
```ts
  const allow = spec.tools ?? defaultSafeToolNames(ctx.registry);
  let captured: unknown;
  const extra: Tool<unknown, unknown>[] = [];
  if (spec.schema) {
    const zodSchema = jsonSchemaToZod(spec.schema);
    extra.push(
      makeStructuredOutputTool(zodSchema, (data) => {
        captured = data;
      }),
    );
  }
  const registry = new RestrictedToolRegistry(ctx.registry, allow, extra);
```

**(c)** 把完成分支：
```ts
    if (r.value.status !== "completed") return { ok: false, status: r.value.status };
    return { ok: true, value: finalAssistantText(state.messages) };
```
替换为：
```ts
    if (r.value.status !== "completed") return { ok: false, status: r.value.status };
    if (spec.schema) {
      if (captured === undefined) {
        return {
          ok: false,
          status: "failed",
          error: "subagent finished without calling StructuredOutput",
        };
      }
      return { ok: true, value: captured as Record<string, unknown> };
    }
    return { ok: true, value: finalAssistantText(state.messages) };
```

**(d) 收口 `index.ts`**：把 `./schema` 导出按 biome 排序**就地插入** `./runtime` 与 `./subagent` 之间（`"runtime" < "schema" < "subagent"`）。`index.ts` 最终形态：
```ts
// workflow 子系统对外索引。
// 纪律（M0）：各里程碑只【追加】导出本里程碑产物——按 biome import 排序就地插入（绝不 clobber 既有导出）；
// 完整公开面（如 M6 的 createWorkflowRuntime / runWorkflow）由 M6 汇总。
// 共享类型的唯一权威定义在 ./types（M0）——消费方应从 ./types import，index 仅再导出便捷别名。

// ── M1 产物（runtime / subagent / primitives / schema）──
export { makeWorkflowPrimitives } from "./primitives";
export { runWorkflowScript } from "./runtime";
export { jsonSchemaToZod, makeStructuredOutputTool } from "./schema";
export { defaultSafeToolNames, RestrictedToolRegistry, runSubagent } from "./subagent";

// 低层 runWorkflowScript 消费者所需的类型别名（权威来源仍是 ./types）。
export type { RunScriptResult, WorkflowPrimitives } from "./types";
```

> 注：`makeCtx` 默认 `executeTool = makeExecuteTool({ sandbox: dummySandbox })`，即用**真实**单工具执行壳，故 `inputSchema` 校验失败的 retryable `VALIDATION` 回灌与反射闭环为真实路径（非 mock）。`captured` 的类型经 `as Record<string, unknown>` 收敛为 M0 `SpecResult` 的对象分支。

### 4.4 VERIFY
```bash
bun run typecheck
bun run check
bun test packages/core/src/workflow/__tests__/schema.test.ts
# 全里程碑回归
bun test packages/core/src/workflow/__tests__/
```
预期：类型/lint 通过（`index.ts` 现引用的 `./schema` 已存在）；schema 套件 4 个 test 全绿；workflow 目录全部测试（runtime 7 + subagent 3 + run-workflow 3 + schema 4 = 17）全绿。

### 4.5 COMMIT
```bash
git add packages/core/src/workflow/schema.ts packages/core/src/workflow/subagent.ts \
        packages/core/src/workflow/index.ts \
        packages/core/src/workflow/__tests__/schema.test.ts
git commit -m "feat(workflow): schema 强制结构化返回（StructuredOutput + jsonSchemaToZod + retry）

JsonSchema import 自 ./types(M0)；成功分支统一返回 { ok:true; value }。
index.ts 就地插入 ./schema 导出收口 M1 公开面。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## M1 验收清单（对照 spec §14）
- 契约纪律：`runtime.ts`/`subagent.ts`/`primitives.ts`/`schema.ts` 全部 **import 自 `./types`（M0）**，无任何 `AgentSpec`/`JsonSchema`/`SubagentResult`/`WorkflowContext`/`WorkflowPrimitives`/`RunScriptResult` 的本地重声明 ✓。
- runtime：脚本只能触达注入原语（`process`/`fetch`/`require`/`Bun` 全 `undefined`）✓；`Date.now`/`Math.random` 被桩抛错 ✓；语法/运行错误归一为结构化失败 ✓（Task 1）。仅绑 `agent`/`log`/`phase`/`args` 四个 guest 全局 ✓。
- agent()：上下文隔离（子不见父历史/身份，messages 仅 system+user，按 `parent-s`/`parent-t` 标识符断言不泄漏）✓；`schema` 校验失败 retry ✓；结果用 M0 统一 `SubagentResult` —— 成功 `{ ok:true; value }`（文本或结构化对象），失败 `{ ok:false; status; error? }` ✓（Task 2/4）。
- 顺序脚本跑通：多 `agent()` 串行 + `args` 注入 + `phase` 回调 + 顶层 throw → failed ✓（Task 3，直接组合 `runWorkflowScript`+`makeWorkflowPrimitives`，无公开 `runWorkflow`）。
- 边界标注：公开入口（`createWorkflowRuntime`/`runWorkflow`）归 M6 ✓；`parallel`/`pipeline`/`workflow` 抛错桩 + `budget` no-op（调度实现 M2、guest 注入 M6）✓；`Date`/seed 经 args 注入接线归 M6 ✓；journal 落库 M3、`workflow.*` 事件 M4 ✓。
- `index.ts` 只追加导出 M1 产物（按 biome import 排序就地插入），最终公开面由 M6 汇总、不 clobber ✓。
- asyncify 单挂起：M1 唯一 async 原语 `agent()`，宿主挂起期内跑完嵌套 queryLoop 且不回调 guest ✓。
- 工具链卫生：`bun run typecheck`（tsc）/ `bun run check`（biome：含 `organizeImports` 导入/导出排序断言）逐 Task 干净；无未用 import、无导入排序违例。

---

## 里程碑 M2：真并行 + 调度限流（TDD 任务段，修正版）

> 关联 spec：`docs/superpowers/specs/2026-06-16-workflow-infrastructure-design.md` §4 / §6 / §2.1 / §10。
> 本段为 spec §12 实施顺序中的 **M2**：`scheduler`（并发池 + provider 共享限流 + budget）→ `parallel()` → `pipeline()`。

## 前置约定（M0/M1 假定产物 + 本里程碑边界）

- **测试运行器**：`packages/core` 用 `bun:test`（`vitest.config.ts` 显式排除 core，仅覆盖 protocol/client-core/web）。测试文件放同目录 `__tests__/*.test.ts`，`import { describe, expect, test } from "bun:test"`。全量回归用仓内既有脚本 `bun run test:core`（= `bun test packages/core tests`，覆盖 `packages/core` 单测 + 顶层 `tests/` 集成测）。
- **隔离引擎归属**：QuickJS(wasm, QuickJS-ng asyncify) 实例的创建、`Date/Math.random` 桩、`newAsyncifiedFunction` 把宿主原语 marshal 进 guest，均属 **M1 `workflow/runtime.ts`** 职责。本里程碑 M2 只产出**宿主侧纯 TS 逻辑**（信号量 / 限流 / 调度 / `parallel` / `pipeline` 工厂），由 M1 的 runtime 接缝注入 guest。**M2 不新增任何 npm 依赖**（`quickjs-emscripten` 是 M1 的依赖）。
- **M0 已建（唯一权威类型源）**：`workflow/types.ts` —— 跨里程碑共享类型的**唯一权威定义**：`JsonSchema`（结构化，非 `Record`）/ `AgentSpec` / `StageSpec` / `SpecResult` / `SubagentResult`（统一形态）/ `RunSubagent`（统一签名 `(spec, signal)=>Promise<SubagentResult>`）/ `Budget` / `WorkflowApiError` / `assertSerializableSpec` / `validateAgentSpec` / `validateStageSpec`。**M2 一律 `import { ... } from "./types"`，绝不重复定义/本地重声明任何共享类型或守卫。**
- **M1 已建**：`workflow/runtime.ts`（含注入接缝）、`workflow/subagent.ts`（导出 `runSubagent`）、`workflow/primitives.ts`（含 `agent()`；其中已 `import { WorkflowApiError } from "./types"`，并 `export { WorkflowApiError } from "./types"`）。M2 仅向 `primitives.ts` **追加** `makeParallel`/`makePipeline`/`interpolate`，向 `loop/concurrency.ts`、`loop/rate-limiter.ts`、`workflow/scheduler.ts` 落地宿主侧并发逻辑——**不向 `workflow/types.ts` 追加任何类型**（共享类型已在 M0 冻结）。
- **失败语义分层**（spec §10 vs §6）：普通 subagent 失败 → `null`；run-fatal（中断 / token budget 硬上限 / backstop）→ 冒泡到脚本顶层（不吞成 `null`）。统一 `SubagentResult` 形态（M0）：
  ```ts
  type SubagentResult =
    | { ok: true; value: SpecResult }
    | { ok: false; status: "failed" | "interrupted"; error?: string };
  ```
  消费方 `parallel`/`pipeline` 一律 `r.ok ? r.value : null`（**不读 `status`**）；run-fatal 由 scheduler **抛错**冒泡，不经 `SubagentResult` 编码。
- **起始建分支**（当前在 `master` 默认分支，不直接提交）：

```bash
git switch -c feat/workflow-m2-parallel-scheduler
```

每个 Task：失败测试先行（RED）→ 最小实现（GREEN）→ `bun test` 通过 + `tsc --noEmit` + `biome check .`（REFACTOR/VERIFY）→ 单次 commit。

---

## Task 1：abort-aware FIFO 信号量 `Semaphore`（并发地基）

**目标**：并发原语地基。放 `loop/concurrency.ts`（低层），被 `loop/rate-limiter.ts`（Task 4）与 `workflow/scheduler.ts`（Task 3、5）共用，避免 `loop/` 反向依赖 `workflow/`。

### RED — 先写失败测试

`packages/core/src/loop/__tests__/concurrency.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { Semaphore, abortError, isAbortError } from "../concurrency";

describe("Semaphore", () => {
  test("许可耗尽前 acquire 立即返回，耗尽后排队", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);

    let third = false;
    const p3 = sem.acquire().then((rel) => {
      third = true;
      return rel;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(sem.pending).toBe(1);

    r1(); // 释放 → 直接移交给排队者
    const r3 = await p3;
    expect(third).toBe(true);
    r3();
  });

  test("release 幂等：重复调用不漏放许可", async () => {
    const sem = new Semaphore(1);
    const rel = await sem.acquire();
    rel();
    rel();
    expect(sem.available).toBe(1);
  });

  test("等待中被 abort → reject AbortError，且不漏许可", async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const ac = new AbortController();
    const p = sem.acquire(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(sem.pending).toBe(0);
    held();
    expect(sem.available).toBe(1);
  });

  test("已 abort 的 signal 直接 reject，不占许可", async () => {
    const sem = new Semaphore(1);
    const ac = new AbortController();
    ac.abort();
    await expect(sem.acquire(ac.signal)).rejects.toThrow("aborted");
    expect(sem.available).toBe(1);
  });

  test("非法许可数抛错", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  test("abortError / isAbortError", () => {
    const e = abortError();
    expect(e.name).toBe("AbortError");
    expect(isAbortError(e)).toBe(true);
    expect(isAbortError(new Error("x"))).toBe(false);
  });
});
```

跑测：

```bash
bun test packages/core/src/loop/__tests__/concurrency.test.ts
```

**预期失败**：`error: Cannot find module '../concurrency' from '.../__tests__/concurrency.test.ts'`（模块尚不存在）。

### GREEN — 实现

`packages/core/src/loop/concurrency.ts`：

```ts
// 并发原语：abort-aware FIFO 信号量 + 统一 AbortError。
// 落在 loop/（低层）——被 loop/rate-limiter.ts 与 workflow/scheduler.ts 共用，
// 避免高层 workflow/ 被低层 loop/ 反向依赖（循环依赖）。

/** 统一取消错误：name="AbortError"，便于 isAbortError 跨层识别（与 DOM AbortSignal 语义一致）。 */
export function abortError(message = "aborted"): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

type Waiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
};

/**
 * FIFO 信号量。acquire 拿到一次性 release；release 时若有等待者，直接把许可移交给队首
 * （不回弹计数，避免唤醒竞争），否则归还许可。release 幂等。
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Waiter[] = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be a positive integer, got ${permits}`);
    }
    this.permits = permits;
  }

  /** 当前空闲许可数（仅供测试/可观测）。 */
  get available(): number {
    return this.permits;
  }

  /** 当前排队等待者数（仅供测试/可观测）。 */
  get pending(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => resolve(this.makeRelease()),
        reject,
        signal,
        onAbort: () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(abortError());
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.onAbort);
        next.resolve(); // 移交许可：计数保持被占用
      } else {
        this.permits += 1;
      }
    };
  }
}
```

### VERIFY + COMMIT

```bash
bun test packages/core/src/loop/__tests__/concurrency.test.ts   # 6 个用例全绿
tsc --noEmit
biome check .
git add packages/core/src/loop/concurrency.ts packages/core/src/loop/__tests__/concurrency.test.ts
git commit -m "$(cat <<'EOF'
feat(core/workflow): abort-aware 信号量 Semaphore (M2-1)

并发地基:FIFO 信号量 + 统一 AbortError,供 rate-limiter / scheduler 共用。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：`TokenBudget`（跨 run 共享 token 记账，硬上限；implements M0 `Budget`）

**目标**：spec §6/§10 的 token budget——跨整个 run 共享记账，到顶后 `agent()`/准入抛错。放 `workflow/scheduler.ts`。**契约**（M0）：`TokenBudget` 须 structurally 满足 `Budget`（`{ total: number; spent(): number; remaining(): number }`），再额外提供 `charge()/assertAvailable()/exhausted()`。

### RED

`packages/core/src/workflow/__tests__/scheduler.test.ts`（先只写 TokenBudget 段，Task 3 再追加 Scheduler 段）：

```ts
import { describe, expect, test } from "bun:test";
import { BudgetExceededError, TokenBudget } from "../scheduler";
import type { Budget } from "../types";

describe("TokenBudget", () => {
  test("charge / spent / remaining / exhausted", () => {
    const b = new TokenBudget(100);
    expect(b.remaining()).toBe(100);
    b.charge(30);
    expect(b.spent()).toBe(30);
    expect(b.remaining()).toBe(70);
    expect(b.exhausted()).toBe(false);
    b.charge(70);
    expect(b.exhausted()).toBe(true);
    expect(b.remaining()).toBe(0);
  });

  test("structurally 满足 M0 Budget（total 公开 + spent/remaining 方法）", () => {
    const b: Budget = new TokenBudget(100); // 编译期钉死 implements Budget
    expect(b.total).toBe(100);
    expect(b.spent()).toBe(0);
    expect(b.remaining()).toBe(100);
  });

  test("耗尽后 assertAvailable 抛 BudgetExceededError", () => {
    const b = new TokenBudget(10);
    b.charge(10);
    expect(() => b.assertAvailable()).toThrow(BudgetExceededError);
  });

  test("非法 total / 负 charge 抛错", () => {
    expect(() => new TokenBudget(0)).toThrow();
    const b = new TokenBudget(10);
    expect(() => b.charge(-1)).toThrow();
  });
});
```

跑测：

```bash
bun test packages/core/src/workflow/__tests__/scheduler.test.ts
```

**预期失败**：`error: Cannot find module '../scheduler'`（`workflow/scheduler.ts` 不存在；`../types` 已由 M0 建，可解析）。

### GREEN

`packages/core/src/workflow/scheduler.ts`（本 Task 只落地 budget 段；Scheduler 段 Task 3 追加到同文件）。顶部仅引入本段真正用到的 `Budget`——并发相关 import（`node:os` 的 `cpus`、`../loop/concurrency` 的 `Semaphore`/`abortError`）留到 Task 3 用到时再补，本文件因此**零未用 import、可独立编译**：

```ts
import type { Budget } from "./types"; // M0 唯一权威类型源

// ── token budget（跨整个 run 共享记账，硬上限）────────────────────────────────
export class BudgetExceededError extends Error {
  constructor(
    readonly total: number,
    readonly spent: number,
  ) {
    super(`token budget exhausted: spent ${spent} >= total ${total}`);
    this.name = "BudgetExceededError";
  }
}

/** implements M0 Budget：total/spent()/remaining() 即 guest 可见只读视图，额外提供 charge/assertAvailable/exhausted。 */
export class TokenBudget implements Budget {
  private used = 0;
  /** M0 Budget.total：guest 只读视图可见的上限（公开 readonly）。 */
  readonly total: number;

  constructor(total: number) {
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error(`TokenBudget total must be a positive finite number, got ${total}`);
    }
    this.total = total;
  }

  spent(): number {
    return this.used;
  }

  remaining(): number {
    return Math.max(0, this.total - this.used);
  }

  exhausted(): boolean {
    return this.used >= this.total;
  }

  /** 准入闸：已耗尽则抛 BudgetExceededError（agent()/scheduler 据此实现 §6/§10 硬上限）。 */
  assertAvailable(): void {
    if (this.exhausted()) throw new BudgetExceededError(this.total, this.used);
  }

  /** 累计已花 token（由 subagent 的 queryLoop onUsage 回调驱动：input+output）。 */
  charge(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new Error(`TokenBudget.charge expects a non-negative finite number, got ${tokens}`);
    }
    this.used += tokens;
  }
}

// Scheduler 段在 Task 3 追加（与 budget 同文件）：届时在顶部补
//   import { cpus } from "node:os";
//   import { Semaphore, abortError } from "../loop/concurrency";
// 并在文件末尾落地 Scheduler / SchedulerExhaustedError / defaultConcurrency。
```

> 注：本 Task 只落地 budget 段，故 `scheduler.ts` 顶部仅 `import type { Budget }`——不预引入尚未使用的 `cpus`/`Semaphore`/`abortError`（Task 3 落地 Scheduler 时再补真实使用）。因此本文件无未用符号，无需任何 `void` 占位，`tsc --noEmit`（`tsconfig.base.json` 含 `verbatimModuleSyntax`/`strict`）与 `biome check .` 均干净；`Budget` 经 `implements` 已被使用。本草稿按"逐 Task 文件可独立编译"组织。

### VERIFY + COMMIT

```bash
bun test packages/core/src/workflow/__tests__/scheduler.test.ts   # TokenBudget 4 个用例全绿
tsc --noEmit
biome check .
git add packages/core/src/workflow/scheduler.ts packages/core/src/workflow/__tests__/scheduler.test.ts
git commit -m "$(cat <<'EOF'
feat(core/workflow): TokenBudget 跨 run 共享记账与硬上限 (M2-2)

implements M0 Budget(total/spent/remaining);exhausted + assertAvailable 准入闸
(BudgetExceededError);charge 由 subagent onUsage 驱动。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：`Scheduler`（并发池 + budget 准入 + backstop + abort）

**目标**：spec §6 并发池——信号量默认 `min(16, cores-2)`；每个 agent 入池排队；budget 准入预检；单 run 累计 agent 上限 backstop；run-level abort。

### RED — 追加到 `scheduler.test.ts`

```ts
// 追加到 packages/core/src/workflow/__tests__/scheduler.test.ts 顶部 import：
import {
  Scheduler,
  SchedulerExhaustedError,
  defaultConcurrency,
  // BudgetExceededError, TokenBudget 已在 Task 2 引入
} from "../scheduler";

const liveSignal = () => new AbortController().signal;

describe("Scheduler", () => {
  test("submit 运行任务并返回值，记录 admittedCount", async () => {
    const s = new Scheduler({ signal: liveSignal(), maxConcurrent: 4 });
    const out = await s.submit(async () => 42);
    expect(out).toBe(42);
    expect(s.admittedCount).toBe(1);
  });

  test("并发受 maxConcurrent 限制（峰值不超）", async () => {
    const s = new Scheduler({ signal: liveSignal(), maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const gate: Array<() => void> = [];
    const make = () =>
      s.submit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((res) => gate.push(res));
        active -= 1;
      });
    const ps = [make(), make(), make(), make()];
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(2);
    // 多轮放行，吸收 release→移交许可后新启动的任务
    for (let i = 0; i < 6; i++) {
      while (gate.length) gate.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(ps);
    expect(peak).toBe(2);
  });

  test("已 abort 的 run signal → submit 拒绝，任务不运行", async () => {
    const ac = new AbortController();
    ac.abort();
    const s = new Scheduler({ signal: ac.signal });
    let ran = false;
    await expect(
      s.submit(async () => {
        ran = true;
      }),
    ).rejects.toThrow("aborted");
    expect(ran).toBe(false);
  });

  test("budget 耗尽 → submit 拒绝（BudgetExceededError），任务不运行", async () => {
    const budget = new TokenBudget(10);
    budget.charge(10);
    const s = new Scheduler({ signal: liveSignal(), budget });
    let ran = false;
    await expect(
      s.submit(async () => {
        ran = true;
      }),
    ).rejects.toThrow(BudgetExceededError);
    expect(ran).toBe(false);
  });

  test("maxAgentsPerRun backstop", async () => {
    const s = new Scheduler({ signal: liveSignal(), maxConcurrent: 8, maxAgentsPerRun: 2 });
    await s.submit(async () => 1);
    await s.submit(async () => 2);
    await expect(s.submit(async () => 3)).rejects.toThrow(SchedulerExhaustedError);
  });

  test("defaultConcurrency 在 [1,16] 内", () => {
    const n = defaultConcurrency();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(16);
  });
});
```

跑测：

```bash
bun test packages/core/src/workflow/__tests__/scheduler.test.ts
```

**预期失败**：`SyntaxError`/`error: Export named 'Scheduler' not found in module '../scheduler'`（`Scheduler`/`SchedulerExhaustedError`/`defaultConcurrency` 未导出）。

### GREEN — 在 `scheduler.ts` 顶部补并发 import，文件末尾追加真实实现

在 Task 2 的 `import type { Budget } from "./types";` 之上补两行 import（现已真实使用 → 无未用 import）：

```ts
import { cpus } from "node:os";
import { Semaphore, abortError } from "../loop/concurrency";
```

随后在文件末尾追加：

```ts
// ── 并发池 + backstop ───────────────────────────────────────────────────────
export class SchedulerExhaustedError extends Error {
  constructor(readonly maxAgentsPerRun: number) {
    super(`workflow run exceeded maxAgentsPerRun backstop (${maxAgentsPerRun})`);
    this.name = "SchedulerExhaustedError";
  }
}

export type SchedulerOpts = {
  /** run-level 取消信号（沿现有 AbortSignal 链路，spec §10 中断扇出）。 */
  signal: AbortSignal;
  /** 并发上限，默认 min(16, cores-2)，下限 1。 */
  maxConcurrent?: number;
  /** 单 run 累计 agent 上限（防失控 backstop），默认 256。 */
  maxAgentsPerRun?: number;
  /** 共享 token budget（可选）；准入时做硬上限预检。 */
  budget?: TokenBudget;
};

/** spec §6：默认并发上限 min(16, cores-2)，下限 1。 */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

export class Scheduler {
  private readonly sem: Semaphore;
  private readonly maxAgents: number;
  private admitted = 0;

  constructor(private readonly opts: SchedulerOpts) {
    this.sem = new Semaphore(opts.maxConcurrent ?? defaultConcurrency());
    this.maxAgents = opts.maxAgentsPerRun ?? 256;
  }

  /** 已准入（含已完成）的 agent 计数（仅供测试/可观测）。 */
  get admittedCount(): number {
    return this.admitted;
  }

  get pending(): number {
    return this.sem.pending;
  }

  /**
   * 提交一个 agent 任务入池排队。准入顺序：abort → backstop → budget → 信号量槽。
   * abort / backstop / budget 三类为 run-fatal，在 task 运行前抛出（由调用方决定冒泡）。
   */
  async submit<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.opts.signal.aborted) throw abortError();
    if (this.admitted >= this.maxAgents) throw new SchedulerExhaustedError(this.maxAgents);
    this.opts.budget?.assertAvailable();
    this.admitted += 1;

    const release = await this.sem.acquire(this.opts.signal);
    try {
      return await task(this.opts.signal);
    } finally {
      release();
    }
  }
}
```

> 准入序要点：`abort`/`backstop`/`SchedulerExhaustedError`/`budget.assertAvailable()` 三类 run-fatal 在 `this.sem.acquire` 之前同步/抢先抛出，task 闭包根本不运行——保证 run-fatal 不被 `parallel`/`pipeline` 的 per-item try/catch 吞成 `null`（spec §10）。

### VERIFY + COMMIT

```bash
bun test packages/core/src/workflow/__tests__/scheduler.test.ts   # TokenBudget+Scheduler 全绿
tsc --noEmit
biome check .
git add packages/core/src/workflow/scheduler.ts packages/core/src/workflow/__tests__/scheduler.test.ts
git commit -m "$(cat <<'EOF'
feat(core/workflow): Scheduler 并发池 + budget 准入 + backstop (M2-3)

信号量默认 min(16,cores-2);submit 准入序 abort→backstop→budget→槽;
run-fatal 在 task 运行前抛出。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：`SharedRateLimiter`（provider 共享限流：并发槽 + RPM 令牌桶）

**目标**：spec §6 "真并行不撞墙的前提"。进程单例，跨 session/subagent 共享。两道闸：① 并发槽（同时在飞 provider 流上限）② RPM 令牌桶（按端点请求速率）。放 `loop/rate-limiter.ts`（接口实况 provider 接入点 A）。

> **TPM 取舍**（非占位，写入注释）：精确 token 数仅在响应回来后（`ProviderResult.usage`）已知，请求前不可靠，故 TPM 不做请求前置闸，改由 workflow 层 `TokenBudget`（onUsage 事后记账 + 准入预检）治理。撞限 429 退避重试沿用 `query-loop.ts:98` 既有指数退避（区分 `retryable`）；本限流器只做**前置节流**。

### RED

`packages/core/src/loop/__tests__/rate-limiter.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { SharedRateLimiter } from "../rate-limiter";
import type { CallProvider, ProviderResult } from "../types";

describe("SharedRateLimiter", () => {
  test("并发槽限制在飞流数", async () => {
    const rl = new SharedRateLimiter({ maxConcurrent: 1 });
    const r1 = await rl.acquire();
    let second = false;
    const p2 = rl.acquire().then((rel) => {
      second = true;
      return rel;
    });
    await Promise.resolve();
    expect(second).toBe(false);
    r1();
    const r2 = await p2;
    expect(second).toBe(true);
    r2();
  });

  test("RPM 令牌桶：突发耗尽后按速率等待（注入时钟+sleep）", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const rl = new SharedRateLimiter({
      maxConcurrent: 10,
      rpm: 60, // 1 token/sec → refill 1/1000ms，突发容量 60
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < 60; i++) (await rl.acquire())(); // 抽干令牌桶
    expect(sleeps).toHaveLength(0);
    (await rl.acquire())(); // 第 61 个需等约 1000ms
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
  });

  test("acquire 中 abort → reject 且释放并发槽", async () => {
    const rl = new SharedRateLimiter({ maxConcurrent: 1 });
    const ac = new AbortController();
    ac.abort();
    await expect(rl.acquire(ac.signal)).rejects.toThrow("aborted");
    const rel = await rl.acquire(); // 槽未泄漏
    expect(rel).toBeDefined();
    rel();
  });

  test("wrap：发起前过闸（占槽），流期间持槽，流结束后释放", async () => {
    const rl = new SharedRateLimiter({ maxConcurrent: 1 });
    const fakeResult: ProviderResult = { text: "ok", toolCalls: [], finishReason: "stop" };
    let releaseProvider: () => void = () => {};
    const provider: CallProvider = async function* () {
      await new Promise<void>((r) => {
        releaseProvider = r;
      });
      return fakeResult;
    };
    const wrapped = rl.wrap(provider);
    const gen = wrapped([], [], new AbortController().signal);
    const pending = gen.next(); // 进入：占并发槽，provider 卡在 gate
    await new Promise((r) => setTimeout(r, 5));

    let got = false;
    const p2 = rl.acquire().then((rel) => {
      got = true;
      return rel;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toBe(false); // 槽被 wrap 持有

    releaseProvider();
    const res = await pending;
    expect(res.done).toBe(true);
    expect(res.value).toEqual(fakeResult);

    const rel2 = await p2; // 流结束 → 槽释放 → 第二个 acquire 解阻
    expect(got).toBe(true);
    rel2();
  });
});
```

跑测：

```bash
bun test packages/core/src/loop/__tests__/rate-limiter.test.ts
```

**预期失败**：`error: Cannot find module '../rate-limiter'`。

### GREEN

`packages/core/src/loop/rate-limiter.ts`：

```ts
// provider 共享限流：所有 session / subagent 共用同一实例（spec §6 真并行前提）。
// 两道闸：① 并发槽（同时在飞的 provider 流上限）② RPM 令牌桶（按端点请求速率）。
// 接入点见 provider-manager.ts（构造期 wrap callProvider 稳定委托，Task 5）。
//
// TPM 不在此前置闸：精确 token 仅响应回来后（ProviderResult.usage）已知，请求前不可靠，
// 改由 workflow 层 TokenBudget（onUsage 事后记账 + 准入预检）治理。
// 429 退避重试沿用 query-loop.ts:98 既有指数退避（区分 retryable）；本器只做前置节流。
import { Semaphore, abortError } from "./concurrency";
import type { CallProvider } from "./types";

export type RateLimiterOpts = {
  /** 同时在飞的 provider 流上限，默认 8（与 LoopDeps.readConcurrency 同量级）。 */
  maxConcurrent?: number;
  /** 每分钟请求数上限（令牌桶，突发容量 = rpm）；0/缺省 = 不限速。 */
  rpm?: number;
  /** 注入时钟（ms），测试用。 */
  now?: () => number;
  /** 注入 sleep，测试用。 */
  sleep?: (ms: number) => Promise<void>;
};

export class SharedRateLimiter {
  private readonly sem: Semaphore;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private last: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RateLimiterOpts = {}) {
    this.sem = new Semaphore(Math.max(1, opts.maxConcurrent ?? 8));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const rpm = opts.rpm ?? 0;
    if (rpm > 0) {
      this.capacity = rpm;
      this.refillPerMs = rpm / 60_000;
      this.tokens = rpm;
    } else {
      this.capacity = Number.POSITIVE_INFINITY;
      this.refillPerMs = Number.POSITIVE_INFINITY;
      this.tokens = Number.POSITIVE_INFINITY;
    }
    this.last = this.now();
  }

  private refill(): void {
    if (this.refillPerMs === Number.POSITIVE_INFINITY) return;
    const t = this.now();
    const elapsed = t - this.last;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.last = t;
  }

  /** 获取一次发起许可：先占并发槽，再等 RPM 令牌。返回释放并发槽的 release。 */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    const release = await this.sem.acquire(signal);
    try {
      for (;;) {
        if (signal?.aborted) throw abortError();
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return release;
        }
        const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
        await this.sleep(waitMs);
      }
    } catch (e) {
      release();
      throw e;
    }
  }

  /** 包装 CallProvider：发起前过两道闸，流结束/中断时释放并发槽。 */
  wrap(provider: CallProvider): CallProvider {
    // biome-ignore lint/complexity/noThisInStatic: 需在 async generator 内引用实例
    const self = this;
    return async function* wrapped(messages, tools, signal) {
      const release = await self.acquire(signal);
      try {
        return yield* provider(messages, tools, signal);
      } finally {
        release();
      }
    };
  }
}
```

### VERIFY + COMMIT

```bash
bun test packages/core/src/loop/__tests__/rate-limiter.test.ts   # 4 个用例全绿
tsc --noEmit
biome check .
git add packages/core/src/loop/rate-limiter.ts packages/core/src/loop/__tests__/rate-limiter.test.ts
git commit -m "$(cat <<'EOF'
feat(core/loop): SharedRateLimiter provider 共享限流 (M2-4)

并发槽 + RPM 令牌桶(注入时钟可测);wrap 透传 ProviderResult,流期持槽、
结束释放;TPM 交 workflow 层 TokenBudget 治理(注释说明)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5：把 `SharedRateLimiter` 接入 `ProviderManager`（进程单例共享）

**目标**：provider 接入点 A——`ProviderManager.callProvider` 稳定委托外包一层共享限流，所有 session/subagent 透明复用。**向后兼容**：新增可选第三参（`serve.ts:62` 现有两参调用不破）。

### RED

`packages/core/src/loop/__tests__/provider-manager-ratelimit.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { ProviderManager } from "../provider-manager";
import type { CallProvider } from "../types";

const PROFILE = { apiKey: "test-key", model: "glm-4.6", systemPrompt: "x", thinking: false };
const TMP_DIR = "/tmp/arclight-m2-nonexistent"; // 构造不写盘（仅 update() 才持久化）

describe("ProviderManager × SharedRateLimiter 接线", () => {
  test("传入 rateLimiter 时 callProvider 走 wrap(base)", () => {
    let wrapCalls = 0;
    let captured: CallProvider | undefined;
    const sentinel: CallProvider = async function* () {
      return { text: "", toolCalls: [], finishReason: "stop" };
    };
    const fakeLimiter = {
      wrap(base: CallProvider): CallProvider {
        wrapCalls += 1;
        captured = base;
        return sentinel;
      },
    };
    const pm = new ProviderManager(PROFILE, TMP_DIR, fakeLimiter);
    expect(wrapCalls).toBe(1);
    expect(typeof captured).toBe("function"); // 被 wrap 的是稳定委托
    expect(pm.callProvider).toBe(sentinel); // callProvider 即包装结果
  });

  test("不传 rateLimiter 时 callProvider 为稳定委托（向后兼容）", () => {
    const pm = new ProviderManager(PROFILE, TMP_DIR);
    expect(typeof pm.callProvider).toBe("function");
  });
});
```

跑测：

```bash
bun test packages/core/src/loop/__tests__/provider-manager-ratelimit.test.ts
```

**预期失败**：`expect(received).toBe(expected)` —— `pm.callProvider` 不是 `sentinel`（当前构造未消费第三参，`wrap` 从未被调用，`wrapCalls===0`）。

### GREEN — 改 `provider-manager.ts` 构造

`packages/core/src/loop/provider-manager.ts` 顶部 import 已含 `CallProvider`（`import type { CallProvider } from "./types"`，行 5）。替换构造函数（现行 49-56）：

```ts
  constructor(
    profile: ProviderProfile,
    private readonly arclightDir: string,
    /** 进程级共享限流（spec §6）；缺省则 callProvider = 裸稳定委托（向后兼容）。
     *  用结构化类型而非 import SharedRateLimiter，保持 provider-manager 解耦、易测。 */
    rateLimiter?: { wrap(provider: CallProvider): CallProvider },
  ) {
    this.profile = profile;
    this.provider = makeCallProvider(profile);
    const base: CallProvider = (messages, tools, signal) => this.provider(messages, tools, signal);
    this.callProvider = rateLimiter ? rateLimiter.wrap(base) : base;
  }
```

> 说明：`base` 闭包每次调 `this.provider`（热切换稳定委托不变），`update()` 重建 `this.provider` 后包装层透明生效——与原注释"runner 拿到的是稳定委托"的语义一致。`callProvider` 在 provider-manager 中声明为 `readonly`，仍可在构造体内一次性赋值。

### 运行时接线（`serve.ts`）

`packages/core/src/serve.ts`：在 `SandboxRouter` 之后、`ProviderManager` 构造之前新建进程单例限流器，并作为第三参传入。

import 段追加：

```ts
import { SharedRateLimiter } from "./loop/rate-limiter";
```

`const sandbox = new SandboxRouter();`（serve.ts:47）之后追加：

```ts
  // provider 共享限流：进程单例，跨所有 session / subagent 共用（spec §6 真并行前提）。
  const sharedRateLimiter = new SharedRateLimiter({ maxConcurrent: 8 });
```

`new ProviderManager(...)`（serve.ts:62-71）第二参 `arclightDir`（serve.ts:70）之后追加第三参：

```ts
  const providerManager = new ProviderManager(
    {
      apiKey: config.anthropicApiKey,
      model: config.model,
      systemPrompt: CODE_AGENT_SYSTEM_PROMPT,
      thinking: config.thinking,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    },
    arclightDir,
    sharedRateLimiter,
  );
```

### VERIFY + COMMIT

```bash
bun test packages/core/src/loop/__tests__/provider-manager-ratelimit.test.ts   # 2 绿
bun run test:core   # 全量 core 回归(= bun test packages/core tests)，确认 serve/runner 接线无破
tsc --noEmit
biome check .
git add packages/core/src/loop/provider-manager.ts packages/core/src/serve.ts \
        packages/core/src/loop/__tests__/provider-manager-ratelimit.test.ts
git commit -m "$(cat <<'EOF'
feat(core/loop): ProviderManager 接入 SharedRateLimiter (M2-5)

构造新增可选 rateLimiter(结构化类型,向后兼容);serve.ts 建进程单例,
跨 session/subagent 共享限流。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6：`parallel(specs)` 原语（barrier，宿主 Promise.all 真并发）

**目标**：spec §4/§10——barrier 真并发；失败项 → `null`；run-fatal 冒泡。**§2.1 守卫**：收"可序列化规格"而非 guest 闭包（闭包字段 → `WorkflowApiError`）；单次 `Promise.all` 全跑完再一次性回灌，挂起期零 guest 再入。

### 共享类型来源（M0，勿重声明）

`parallel`/`pipeline` 用到的 `AgentSpec` / `StageSpec` / `SpecResult` / `SubagentResult` / `RunSubagent` / `JsonSchema`，以及守卫 `WorkflowApiError` / `assertSerializableSpec` / `validateAgentSpec` / `validateStageSpec`，**已由 M0 在 `workflow/types.ts` 冻结**。本 Task **不**向 `types.ts` 追加/重声明任何类型或守卫，全部 `import { ... } from "./types"`。

统一 `SubagentResult` 形态（M0）：

```ts
type SubagentResult =
  | { ok: true; value: SpecResult }
  | { ok: false; status: "failed" | "interrupted"; error?: string };
```

消费方一律 `r.ok ? r.value : null`（**不读 `status`**）；测试里的 fake 失败必须带 `status:"failed"`（M0 契约）。run-fatal（abort / budget / backstop）由 `scheduler.submit` 抛错，经 `Promise.all` 冒泡，不经 `SubagentResult`。

### RED

`packages/core/src/workflow/__tests__/parallel.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { WorkflowApiError, makeParallel } from "../primitives";
import { Scheduler, TokenBudget } from "../scheduler";
import type { AgentSpec, RunSubagent, SubagentResult } from "../types";

const liveSignal = () => new AbortController().signal;

describe("parallel", () => {
  test("真并发：4 specs 同时在临界区（峰值=4，≤池上限）", async () => {
    let active = 0;
    let peak = 0;
    const gate: Array<() => void> = [];
    const run: RunSubagent = async (spec) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => gate.push(r));
      active -= 1;
      return { ok: true, value: spec.prompt };
    };
    const sched = new Scheduler({ signal: liveSignal(), maxConcurrent: 4 });
    const parallel = makeParallel(sched, run);
    const p = parallel([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }, { prompt: "d" }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(4);
    while (gate.length) gate.shift()?.();
    expect(await p).toEqual(["a", "b", "c", "d"]); // 保序
  });

  test("失败项 → null（普通失败 + 意外 throw），其余不受影响", async () => {
    const run: RunSubagent = async (spec) => {
      if (spec.prompt === "fail") return { ok: false, status: "failed", error: "boom" };
      if (spec.prompt === "throw") throw new Error("unexpected");
      return { ok: true, value: { echoed: spec.prompt } };
    };
    const sched = new Scheduler({ signal: liveSignal(), maxConcurrent: 8 });
    const out = await makeParallel(sched, run)([
      { prompt: "x" },
      { prompt: "fail" },
      { prompt: "throw" },
      { prompt: "y" },
    ]);
    expect(out).toEqual([{ echoed: "x" }, null, null, { echoed: "y" }]);
  });

  test("run-fatal（abort）冒泡，不被吞成 null", async () => {
    const ac = new AbortController();
    ac.abort();
    const run: RunSubagent = async () => ({ ok: true, value: "x" });
    const parallel = makeParallel(new Scheduler({ signal: ac.signal }), run);
    await expect(parallel([{ prompt: "a" }])).rejects.toThrow("aborted");
  });

  test("run-fatal（budget 耗尽）冒泡", async () => {
    const budget = new TokenBudget(5);
    budget.charge(5);
    const run: RunSubagent = async () => ({ ok: true, value: "x" });
    const parallel = makeParallel(new Scheduler({ signal: liveSignal(), budget }), run);
    await expect(parallel([{ prompt: "a" }])).rejects.toThrow("budget");
  });

  test("§2.1 asyncify 守卫：闭包字段被拒（不可序列化）", async () => {
    const run: RunSubagent = async () => ({ ok: true, value: "x" });
    const parallel = makeParallel(new Scheduler({ signal: liveSignal() }), run);
    const bad = [{ prompt: "a", onResult: () => {} }] as unknown as AgentSpec[];
    await expect(parallel(bad)).rejects.toThrow(WorkflowApiError);
  });

  test("非数组 specs / 空 prompt 抛 WorkflowApiError", async () => {
    const run: RunSubagent = async () => ({ ok: true, value: "x" }) as SubagentResult;
    const parallel = makeParallel(new Scheduler({ signal: liveSignal() }), run);
    await expect(parallel("nope" as unknown as AgentSpec[])).rejects.toThrow(WorkflowApiError);
    await expect(parallel([{ prompt: "" }])).rejects.toThrow(WorkflowApiError);
  });

  test("§2.1 单挂起：结果完全物化为纯数组（无 Promise / 无 guest 再入）", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    const out = await makeParallel(new Scheduler({ signal: liveSignal(), maxConcurrent: 2 }), run)([
      { prompt: "a" },
      { prompt: "b" },
    ]);
    expect(Array.isArray(out)).toBe(true);
    for (const v of out) expect(v instanceof Promise).toBe(false);
  });
});
```

跑测：

```bash
bun test packages/core/src/workflow/__tests__/parallel.test.ts
```

**预期失败**：`error: Export named 'makeParallel' not found in module '../primitives'`（`makeParallel` 未追加；`WorkflowApiError` 已由 M1 从 `primitives` re-export）。`AgentSpec`/`RunSubagent`/`SubagentResult` 已由 M0 在 `types.ts` 定义，import 可解析。

### GREEN — 追加到 `workflow/primitives.ts`（M1 已建，含 `agent()`）

守卫与错误类型**一律来自 M0 的 `./types`**，本 Task 不再本地定义 `WorkflowApiError` / `assertSerializableSpec` / `validateAgentSpec`。**导入纪律**：`primitives.ts` 内对 `./types` **只保留一处** `import`——把本 Task 新增的具名项**并入 M1 已有的 `... from "./types"` 那一行**（M1 为 `agent()` 已 `import { WorkflowApiError } from "./types"`），勿新建第二条 `import ... from "./types"`：

```ts
// 追加到 packages/core/src/workflow/primitives.ts（新增模块 import 各一条）：
import { isAbortError } from "../loop/concurrency";
import { BudgetExceededError, type Scheduler, SchedulerExhaustedError } from "./scheduler";

// ↓ 把这些具名项并入 M1 已有的 `... from "./types"` 那一行（合并后形如）：
import {
  type AgentSpec,
  type RunSubagent,
  type SpecResult,
  validateAgentSpec, // M0 守卫（含 §2.1 闭包拒绝 + 非空 prompt）
  WorkflowApiError, // 值用途：parallel 非数组抛错；interpolate 抛错（Task 7）。M1 已引入此绑定。
} from "./types";

// M0 契约要求 primitives.ts 须 `export { WorkflowApiError } from "./types"`，
// 使测试 `import { WorkflowApiError } from "../primitives"` 可解析。
// 【M1 primitives.ts 已含该 re-export】——本 Task 复用，**不重复导出同名**（重复 → tsc TS2308）。
// 仅当实际 M1 未 re-export 时，才在此补：export { WorkflowApiError } from "./types";

/** run-fatal：必须冒泡到脚本顶层（中断 / budget 硬上限 / backstop），不可被吞成 null。 */
function isFatal(e: unknown): boolean {
  return (
    e instanceof BudgetExceededError || e instanceof SchedulerExhaustedError || isAbortError(e)
  );
}

/**
 * parallel：barrier，宿主侧 Promise.all 真并发。
 * §2.1 单挂起：specs 是已 marshal 的纯数据（无 guest 闭包），全部并发跑完后一次性回灌，
 * 期间绝不再入 guest。单项 subagent 失败 → null（不拖垮整体）；run-fatal → 抛出。
 *
 * guest 绑定（M1 runtime.ts）：ctx.newAsyncifiedFunction("parallel", marshal(makeParallel(...)))
 *   —— 整个 Promise.all 在一次 asyncify 挂起内完成，resolve 后一次性把纯数组回灌 guest。
 */
export function makeParallel(scheduler: Scheduler, runSubagent: RunSubagent) {
  return async function parallel(specs: AgentSpec[]): Promise<(SpecResult | null)[]> {
    if (!Array.isArray(specs)) {
      throw new WorkflowApiError("parallel(specs): specs must be an array of AgentSpec");
    }
    const validated = specs.map((s, i) => validateAgentSpec(s, `parallel[${i}]`));
    return Promise.all(
      validated.map((spec) =>
        scheduler.submit(async (signal): Promise<SpecResult | null> => {
          try {
            const r = await runSubagent(spec, signal);
            return r.ok ? r.value : null; // 统一 SubagentResult：失败分支不读 status（spec §10）
          } catch (e) {
            if (isFatal(e)) throw e; // 中断 / budget / backstop 冒泡
            return null; // 其余 subagent 内部错 → null（spec §10）
          }
        }),
      ),
    );
  };
}
```

> `validated.map` 是同步遍历，闭包/空 prompt 由 M0 `validateAgentSpec` 在 `Promise.all` 之前同步 throw → `async` 函数返回 rejected promise。`scheduler.submit` 自身的准入失败（abort/budget/backstop）在 task 运行前 reject，经 `Promise.all` 直接冒泡（不进 task 内 try/catch），故 run-fatal 不被吞。

### VERIFY + COMMIT

```bash
bun test packages/core/src/workflow/__tests__/parallel.test.ts   # 7 个用例全绿
tsc --noEmit
biome check .
git add packages/core/src/workflow/primitives.ts \
        packages/core/src/workflow/__tests__/parallel.test.ts
git commit -m "$(cat <<'EOF'
feat(core/workflow): parallel() 真并发原语 (M2-6)

宿主 Promise.all 真并发;失败项→null,run-fatal 冒泡;守卫复用 M0
(validateAgentSpec/WorkflowApiError),单次挂起全跑完一次性回灌(零 guest 再入)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> 注：`workflow/types.ts` 不在本 Task 的 `git add` 内——M2 全程不改 M0 冻结的共享类型文件。

---

## Task 7：`pipeline(items, ...stages)` 原语（无 barrier 流水线 + 声明式插值）

**目标**：spec §4/§10/§15——无 barrier（item 间并发，不按 stage 全局对齐）；某 item 某 stage 失败/抛错 → 该 item `null` 并跳过其余 stage；`${prev}/${item}/${index}` 由**宿主**声明式 path-get 插值（无 guest 再入），**拒绝任意表达式**（仅点路径）。`StageSpec` 与 `validateStageSpec` 同样 **来自 M0 `./types`**。

### RED

`packages/core/src/workflow/__tests__/pipeline.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { WorkflowApiError, interpolate, makePipeline } from "../primitives";
import { Scheduler } from "../scheduler";
import type { RunSubagent, StageSpec } from "../types";

const liveSignal = () => new AbortController().signal;

describe("interpolate", () => {
  test("${item}/${index}/${prev.path} 点路径取值", () => {
    expect(interpolate("hi ${item}", { item: "x", index: 0, prev: null })).toBe("hi x");
    expect(interpolate("#${index}", { item: "x", index: 2, prev: null })).toBe("#2");
    expect(interpolate("p=${prev.name}", { item: null, index: 0, prev: { name: "z" } })).toBe(
      "p=z",
    );
  });
  test("对象值 → JSON.stringify", () => {
    expect(interpolate("${item}", { item: { a: 1 }, index: 0, prev: null })).toBe('{"a":1}');
  });
  test("undefined 取值抛 WorkflowApiError", () => {
    expect(() => interpolate("${prev.x}", { item: null, index: 0, prev: null })).toThrow(
      WorkflowApiError,
    );
  });
  test("拒绝任意表达式（非法路径段）", () => {
    expect(() => interpolate("${item.length - 1}", { item: "ab", index: 0, prev: null })).toThrow(
      WorkflowApiError,
    );
    expect(() => interpolate("${item()}", { item: "ab", index: 0, prev: null })).toThrow(
      WorkflowApiError,
    );
  });
});

describe("pipeline", () => {
  test("单 stage 等价 map", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    const out = await makePipeline(new Scheduler({ signal: liveSignal(), maxConcurrent: 8 }), run)(
      ["a", "b"],
      { prompt: "do ${item}" },
    );
    expect(out).toEqual(["do a", "do b"]);
  });

  test("多 stage：prev 串联", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: `${s.prompt}!` });
    const out = await makePipeline(new Scheduler({ signal: liveSignal(), maxConcurrent: 8 }), run)(
      ["x"],
      { prompt: "s1:${item}" },
      { prompt: "s2:${prev}" },
    );
    // s1 → "s1:x!" ; s2 prompt="s2:s1:x!" → "s2:s1:x!!"
    expect(out).toEqual(["s2:s1:x!!"]);
  });

  test("无 barrier：item 间并发，不按 stage 全局对齐", async () => {
    const order: string[] = [];
    const gates: Record<string, Array<() => void>> = {};
    const wait = (key: string) =>
      new Promise<void>((r) => {
        (gates[key] ??= []).push(r);
      });
    const run: RunSubagent = async (s) => {
      order.push(s.prompt);
      await wait(s.prompt);
      return { ok: true, value: s.prompt };
    };
    const p = makePipeline(new Scheduler({ signal: liveSignal(), maxConcurrent: 8 }), run)(
      ["A", "B"],
      { prompt: "s1-${item}" },
      { prompt: "s2-${item}" },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect([...order].sort()).toEqual(["s1-A", "s1-B"]); // 两 item 的 stage1 都已起跑
    gates["s1-A"]?.shift()?.(); // 放行 A 的 stage1 → A 进 stage2（B 仍卡 stage1）
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toContain("s2-A");
    expect(order).not.toContain("s2-B"); // 无 barrier
    for (let i = 0; i < 6; i++) {
      for (const k of Object.keys(gates)) while (gates[k]?.length) gates[k]?.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await p;
  });

  test("per-item 失败隔离：某 item 某 stage 失败/抛错 → 该 item null，其余完成", async () => {
    const run: RunSubagent = async (s) => {
      if (s.prompt === "s2-bad") return { ok: false, status: "failed", error: "x" };
      if (s.prompt === "s1-throw") throw new Error("boom");
      return { ok: true, value: s.prompt };
    };
    const out = await makePipeline(new Scheduler({ signal: liveSignal(), maxConcurrent: 8 }), run)(
      ["good", "bad", "throw"],
      { prompt: "s1-${item}" },
      { prompt: "s2-${item}" },
    );
    // good: s1-good→s2-good="s2-good" ; bad: s2-bad 失败→null ; throw: s1-throw 抛→null(跳 s2)
    expect(out).toEqual(["s2-good", null, null]);
  });

  test("空 stages 抛 WorkflowApiError", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    await expect(
      makePipeline(new Scheduler({ signal: liveSignal() }), run)(["a"]),
    ).rejects.toThrow(WorkflowApiError);
  });

  test("§2.1 闭包 stage 被拒", async () => {
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    const bad = [{ prompt: "p", transform: () => {} }] as unknown as StageSpec[];
    await expect(
      makePipeline(new Scheduler({ signal: liveSignal() }), run)(["a"], ...bad),
    ).rejects.toThrow(WorkflowApiError);
  });

  test("run-fatal（abort）冒泡", async () => {
    const ac = new AbortController();
    ac.abort();
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    await expect(
      makePipeline(new Scheduler({ signal: ac.signal }), run)(["a"], { prompt: "${item}" }),
    ).rejects.toThrow("aborted");
  });
});
```

跑测：

```bash
bun test packages/core/src/workflow/__tests__/pipeline.test.ts
```

**预期失败**：`error: Export named 'makePipeline' not found in module '../primitives'`（`makePipeline`/`interpolate` 未追加；`StageSpec`/`RunSubagent` 已由 M0 定义，import 可解析）。

### GREEN — 继续追加到 `workflow/primitives.ts`

把 `StageSpec` 与 `validateStageSpec`（M0 守卫，复用 prompt 必填 + 闭包守卫）**并入 `primitives.ts` 中那条唯一的 `from "./types"` import 行**（M1 建、Task 6 已并入具名项）——`primitives.ts` 内对 `./types` 始终只保留一处 import：

```ts
// primitives.ts 顶部对 ./types 的具名 import 最终形态（M1 + Task 6 + Task 7 合并，单行）：
import {
  type AgentSpec,
  type RunSubagent,
  type SpecResult,
  type StageSpec,
  validateAgentSpec,
  validateStageSpec,
  WorkflowApiError,
} from "./types";
```

随后追加 `makePipeline` / `runItemThroughStages` / `interpolate`（`validateStageSpec` 不再本地定义，直接用 M0 的）：

```ts
/**
 * pipeline：无 barrier 流水线。每个 item 独立穿过 stages（item 间并发，受调度池限流）；
 * 某 stage 失败/抛错 → 该 item 落 null 并跳过其余 stage（per-item 隔离）。
 * stage.prompt 的 ${prev}/${item}/${index} 由宿主声明式插值（path-get，无 guest 再入，符合 §2.1）。
 */
export function makePipeline(scheduler: Scheduler, runSubagent: RunSubagent) {
  return async function pipeline(
    items: unknown[],
    ...stages: StageSpec[]
  ): Promise<(SpecResult | null)[]> {
    if (!Array.isArray(items)) {
      throw new WorkflowApiError("pipeline(items, ...stages): items must be an array");
    }
    if (stages.length === 0) {
      throw new WorkflowApiError("pipeline requires at least one stage");
    }
    const validated = stages.map((st, i) => validateStageSpec(st, `pipeline.stage[${i}]`));
    return Promise.all(
      items.map((item, index) =>
        runItemThroughStages(scheduler, runSubagent, validated, item, index),
      ),
    );
  };
}

async function runItemThroughStages(
  scheduler: Scheduler,
  runSubagent: RunSubagent,
  stages: StageSpec[],
  item: unknown,
  index: number,
): Promise<SpecResult | null> {
  let prev: SpecResult | null = null;
  for (const stage of stages) {
    const prompt = interpolate(stage.prompt, { item, index, prev });
    const spec: AgentSpec = {
      prompt,
      ...(stage.schema !== undefined ? { schema: stage.schema } : {}),
      ...(stage.tools !== undefined ? { tools: stage.tools } : {}),
      ...(stage.model !== undefined ? { model: stage.model } : {}),
    };
    try {
      const r = await scheduler.submit((signal) => runSubagent(spec, signal));
      if (!r.ok) return null; // stage 失败 → item 落 null，跳过其余 stage（不读 status）
      prev = r.value;
    } catch (e) {
      if (isFatal(e)) throw e; // 中断 / budget / backstop 冒泡
      return null; // stage 意外抛 → item 落 null
    }
  }
  return prev;
}

// ── 声明式插值：仅 ${prev|item|index} 的点路径取值，不支持任意表达式（spec §15）──
const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function interpolate(
  template: string,
  scope: { item: unknown; index: number; prev: SpecResult | null },
): string {
  return template.replace(/\$\{([^}]*)\}/g, (_match, raw: string) => {
    const path = raw.trim();
    if (path.length === 0) {
      throw new WorkflowApiError("pipeline interpolation: empty ${} placeholder");
    }
    const value = resolvePath(path, scope as unknown as Record<string, unknown>);
    if (value === undefined) {
      throw new WorkflowApiError(`pipeline interpolation: "${path}" resolved to undefined`);
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function resolvePath(path: string, root: Record<string, unknown>): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (!SEGMENT.test(seg)) {
      throw new WorkflowApiError(
        `pipeline interpolation: invalid segment "${seg}" — only \${prev|item|index} dotted paths allowed (no expressions, spec §15)`,
      );
    }
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
```

> `validateStageSpec`（M0）内部即调用 `validateAgentSpec`（prompt 必填 + §2.1 闭包守卫），故闭包 stage / 空 prompt 在 `Promise.all` 之前同步 throw。`StageSpec ⊂ AgentSpec`，本 Task 据 stage 字段以条件展开（`exactOptionalPropertyTypes` 下不可写 `key: undefined`）构造 `AgentSpec` 交 `runSubagent`。

### VERIFY + COMMIT

```bash
bun test packages/core/src/workflow/__tests__/pipeline.test.ts   # interpolate + pipeline 全绿
bun run test:core                                                # M2 全量回归（含 Task 1-6）
tsc --noEmit
biome check .
git add packages/core/src/workflow/primitives.ts \
        packages/core/src/workflow/__tests__/pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(core/workflow): pipeline() 无 barrier 流水线 + 声明式插值 (M2-7)

item 间并发、per-item 失败隔离;${prev/item/index} 宿主 path-get 插值,
拒绝任意表达式(spec §15);StageSpec/validateStageSpec 复用 M0;run-fatal 冒泡。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## M2 收口检查（spec §6 / §14 覆盖核对）

| spec 要求 | 落地 Task | 测试 |
|---|---|---|
| 并发池信号量，默认 min(16, cores-2) | T1 Semaphore + T3 Scheduler/defaultConcurrency | scheduler.test.ts 并发峰值 / defaultConcurrency 范围 |
| 单 run 累计 agent backstop | T3 maxAgentsPerRun | scheduler.test.ts SchedulerExhaustedError |
| provider 共享限流（RPM + 并发） | T4 SharedRateLimiter + T5 接线 | rate-limiter.test.ts / provider-manager-ratelimit.test.ts |
| token budget 硬上限（implements M0 Budget） | T2 TokenBudget + T3 准入预检 | scheduler.test.ts BudgetExceededError / Budget 结构 |
| `parallel` 真并发 + 失败项 null + 计时验证 | T6 | parallel.test.ts 峰值并发 / null / 物化 |
| `pipeline` 无 barrier + 单 item 失败隔离 | T7 | pipeline.test.ts 无 barrier / per-item null |
| §2.1 单挂起：收规格非闭包、挂起期不回调 guest | T6/T7（守卫复用 M0 `validateAgentSpec`/`validateStageSpec`）+ 宿主插值 | parallel/pipeline.test.ts 闭包拒绝 / 表达式拒绝 / 物化数组 |
| 中断扇出（run-fatal 冒泡） | T3/T6/T7 isFatal + AbortSignal | abort 冒泡用例 |

> **M0 契约对齐自检**：M2 全程 **不改 `workflow/types.ts`**；`AgentSpec`/`StageSpec`/`SpecResult`/`SubagentResult`/`RunSubagent`/`JsonSchema`/`Budget` 及守卫 `WorkflowApiError`/`validateAgentSpec`/`validateStageSpec` 均 `import` 自 `./types`，无任何本地重复声明；`SubagentResult` 用 M0 统一三态形态（成功 `value` / 失败 `{status,error?}`），消费方 `r.ok ? r.value : null`；`primitives.ts` 内对 `./types` 仅一处 import（M1 建、T6/T7 并入），且复用 M1 的 `export { WorkflowApiError } from "./types"`（不重复导出），满足"测试从 `../primitives` 取 `WorkflowApiError`"。
>
> M2 完成判据：`bun run test:core`（= `bun test packages/core tests`）全绿 + `tsc --noEmit` 无错 + `biome check .` 干净。`scheduler` / `parallel` / `pipeline` 的 guest 绑定（`newAsyncifiedFunction` + handle 编组 + `budget`/`phase`/`log` 注入）在 M4「事件 + 审批路由」随 runtime 集成测试一并验证（M1 runtime 接缝 + 本里程碑宿主工厂已就绪）。

---

## 里程碑 M3：journal + resume（契约对齐修正版）

> 依赖：**M0（`workflow/types.ts` 共享类型契约）** + M1（runtime + `agent()`）已落地；与 M2（`parallel`/`pipeline`）共用同一执行接缝 `makeJournaledRun`。
> 模块归属：`packages/core/src/workflow/`（agent core 拥有，spec §3）。
> 隔离引擎仍是 **QuickJS-ng(wasm, asyncify)**（spec §2/§13）；**M3 不触碰 QuickJS 实例**——journal/resume 是纯宿主侧持久化层，M1/M2 的宿主代码在那一次 async 挂起窗口内调用本接缝。
> 新增依赖：**无**（`node:crypto` + `drizzle-orm` + `bun:sqlite` 均已在仓内；`quickjs-emscripten` 属 M1）。
>
> **共享类型纪律（冻结契约，M0）**：跨里程碑共享类型——`RunStatus`/`PersistedRunStatus`/`AgentStatus`/`CallKind`/`JournalRow`/`WorkflowJournalPort`——**一律 import 自 `packages/core/src/workflow/types.ts`**（兄弟模块写 `from "./types"`，`__tests__` 写 `from "../types"`），M3 **不再本地声明**任何上述符号。M3 私有类型（`StartRunInput`/`RecordAgentStartInput`/`ConsultResult`/`RunOneSpec`/`RunCtx`/`JournaledRunDeps`）非契约符号，留在各自模块。
> **状态词统一**：终态词表 `completed | failed | interrupted`（**禁用 `cancelled`**）；持久层多一个中间态 `running`（= `PersistedRunStatus`）。M3 任何处不得出现 `cancelled`。
> **确定性桩边界**：guest 内 `Date.now`/`Math.random`/`new Date` 的确定性桩（spec §7 前提）**不在 M3，移至 M6** `createWorkflowRuntime` 的 PRELUDE。M3 e2e 用确定性 `runLive` 直接模拟“已桩死后”的世界；`WorkflowJournalService` 的 `now: () => number` 仅是宿主侧时钟 DI（与既有 `ApprovalService` 同构，落 `started_at`/`finished_at`），与 guest 确定性桩无关，**不要**在 M3 引入任何 guest 时钟桩 Task。
>
> **开工前**（当前在默认分支 `master`，先切工作分支）：
> ```bash
> git switch -c feat/workflow-m3-journal-resume
> ```
> 测试运行器：`packages/core` 用 `bun:test`（`bun:sqlite` 依赖；`vitest.config.ts` 显式排除 core）。测试置于 `packages/core/src/workflow/__tests__/`。

### 设计要点（对抗式修正后的不变量）

1. **resume 主键 = `(scriptHash, argsHash)`**：`workflow_runs` 按脚本源指纹 + 入参指纹唯一确定一个可续跑逻辑 run。spec §7 的列是最小集，补 `argsHash`（把 `args` JSON 转成可索引等值键）、`tenantId`（多租约定）、`error`、`subTurnId`（§8 下钻）。
2. **prefix-cache 键 = `(seq, specHash)`**：`workflow_agents` 每行记一次原语调用；`seq` 在 run 内单调唯一（`parallel`/`pipeline` 单项按规格数组序取连续 `seq`——规格在挂起前同步构造完毕，asyncify 安全）。
3. **确定性指纹**：`specHash`/`scriptHash`/`argsHash` 先 `canonicalJson`（递归按 key 排序）再 sha256；裸 `JSON.stringify` 受键序影响会静默丢失缓存命中。与 spec §7『禁 `Date.now`/`Math.random`』的确定性前提闭环（该前提的 **guest 桩在 M6 落地**，M3 只依赖其结果）。
4. **尾部失效**：首个不命中（specHash 变更 / 新增调用 / prior 非 `completed`）起，整条尾部一律未命中——下游规格经宿主 `${prev}` 插值依赖上游结果，越过缺口复用不健全（spec §2.1/§7）。
5. **崩溃续跑**：进程崩在半路时 run 卡 `running`，`findResumableRun` **不按 status 过滤**，只取最近匹配 run；planner 只重放 `status='completed'` 的 agent 行，天然实现部分续跑。
6. **可再 resume**：命中时也补写一条 `completed` 的 `workflow_agents` 行（复制 `specHash`+result），保证全命中的重放 run 本身仍可被二次 resume。
7. **失败语义分层**：journal 记真相（`runLive` throw → `failAgent` 落 `failed` → resume 重跑）；spec §10『失败→`null`』的归一在 M1 `agent()`/M2 `parallel` 包装层（接缝之上）完成。M3 接缝层不做 `SubagentResult`→`null` 归一。
8. **asyncify 安全**：命中判定 + 结果回灌全在宿主同步完成，`await` 的 live 子跑在 guest 恢复前 resolve，**绝不在挂起期再入 guest**；`parallel`/`pipeline` 单项按各自可序列化规格（`specHash`）逐项 journal，贴合『收规格非闭包』。
9. **端口实现契约**：`WorkflowJournalService` **`implements WorkflowJournalPort`**（M0 types.ts 定义的结构化端口），保证 M2/M6 注入面零漂移。

---

### Task 1 — 确定性指纹工具 `hash.ts`

**目标**：`scriptHash`/`argsHash`/`specHash`，key 序无关、可被 `JSON.parse` 还原。这是 resume 缓存命中的地基。无共享类型依赖（纯字符串/哈希工具）。

**RED**：新建 `packages/core/src/workflow/__tests__/hash.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { argsHash, canonicalJson, scriptHash, specHash } from "../hash";

describe("workflow 指纹：确定性 + 键序无关", () => {
  test("specHash 与顶层键序无关", () => {
    expect(specHash({ a: 1, b: 2 })).toBe(specHash({ b: 2, a: 1 }));
  });
  test("specHash 对嵌套对象/数组内对象键序也稳定", () => {
    expect(specHash({ x: { p: 1, q: 2 }, y: [{ m: 1, n: 2 }] })).toBe(
      specHash({ y: [{ n: 2, m: 1 }], x: { q: 2, p: 1 } }),
    );
  });
  test("数组元素顺序仍敏感（语义有序）", () => {
    expect(specHash([1, 2, 3])).not.toBe(specHash([3, 2, 1]));
  });
  test("不同规格 → 不同哈希", () => {
    expect(specHash({ prompt: "a" })).not.toBe(specHash({ prompt: "b" }));
  });
  test("scriptHash/argsHash 同源稳定、异源不同", () => {
    expect(scriptHash("agent('x')")).toBe(scriptHash("agent('x')"));
    expect(scriptHash("agent('x')")).not.toBe(scriptHash("agent('y')"));
    expect(argsHash({ seed: 1 })).toBe(argsHash({ seed: 1 }));
    expect(argsHash({ seed: 1 })).not.toBe(argsHash({ seed: 2 }));
  });
  test("canonicalJson 输出可被 JSON.parse 还原", () => {
    expect(JSON.parse(canonicalJson({ b: [3, 2], a: "x" }))).toEqual({ a: "x", b: [3, 2] });
  });
});
```

跑测（预期红：`Cannot find module '../hash'`）：

```bash
bun test packages/core/src/workflow/__tests__/hash.test.ts
```

**GREEN**：新建 `packages/core/src/workflow/hash.ts`

```ts
import { createHash } from "node:crypto";

/** 规范化 JSON：递归按 key 排序（数组顺序保留），消除键序差异。
 *  resume 缓存命中依赖此稳定性——裸 JSON.stringify 受键序影响会静默丢失前缀命中。*/
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortDeep(src[key]);
    return out;
  }
  return value;
}

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 脚本源指纹：run 级 resume 主键之一（配 argsHash）。 */
export function scriptHash(source: string): string {
  return sha256Hex(source);
}

/** 启动入参指纹：配 scriptHash 唯一确定一次可 resume 的逻辑 run。 */
export function argsHash(args: unknown): string {
  return sha256Hex(canonicalJson(args));
}

/** 单次原语调用的规格指纹：workflow_agents.specHash，逐调用缓存命中键。 */
export function specHash(spec: unknown): string {
  return sha256Hex(canonicalJson(spec));
}
```

跑测（预期绿：6 pass / 0 fail）→ 静态检查：

```bash
bun test packages/core/src/workflow/__tests__/hash.test.ts
bun run typecheck
bun run check
```

**commit**：

```bash
git add packages/core/src/workflow/hash.ts packages/core/src/workflow/__tests__/hash.test.ts
git commit -m "feat(workflow): 确定性指纹工具 scriptHash/argsHash/specHash（canonical JSON）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2 — journal 两表 + 迁移（`schema.ts`）

**目标**：落 `workflow_runs` / `workflow_agents`，列结构满足 spec §7 resume（`scriptHash`/`argsHash`/`seq`/`callKind`/`specHash`/`resultJson`）。状态列的字面量集合**镜像 M0 的 `PersistedRunStatus` / `AgentStatus`**（drizzle `text({enum})` 要求字面量数组，无法直接 import 联合类型，故就地写字面量并以注释钉死契约来源；统一用 `interrupted`，绝不用 `cancelled`）。

**RED**：新建 `packages/core/src/workflow/__tests__/migrations.test.ts`

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../db/migrate";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function columns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  db.close();
  return rows.map((r) => r.name);
}

describe("workflow journal 迁移", () => {
  test("workflow_runs / workflow_agents 建表且含 resume 关键列", () => {
    dir = mkdtempSync(join(tmpdir(), "arclight-wf-mig-"));
    const { dbPath } = runMigrations(join(dir, ".arclight"));

    const runCols = columns(dbPath, "workflow_runs");
    for (const c of ["id", "session_id", "script_hash", "args_hash", "args", "status", "started_at", "finished_at"]) {
      expect(runCols).toContain(c);
    }
    const agentCols = columns(dbPath, "workflow_agents");
    for (const c of ["id", "run_id", "seq", "call_kind", "spec_hash", "status", "result_json"]) {
      expect(agentCols).toContain(c);
    }
  });
});
```

跑测（预期红：两表不存在，`PRAGMA table_info` 返回空 → `toContain` 失败）：

```bash
bun test packages/core/src/workflow/__tests__/migrations.test.ts
```

**GREEN**：在 `packages/core/src/db/schema.ts` **末尾追加**两表（`sessions`/`turns`/`nowMs`/`index`/`uniqueIndex`/`sqliteTable`/`text`/`integer` 均已在文件上方定义/导入）

```ts
// ── workflow_runs ────────────────────────────────────────────────────────────
// 一次 workflow 脚本执行；(scriptHash, argsHash) 唯一确定一个可 resume 的逻辑 run。
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(), // runId = randomUUID()
    tenantId: text("tenant_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    scriptHash: text("script_hash").notNull(), // resume 主键之一（脚本源指纹）
    argsHash: text("args_hash").notNull(), // resume 主键之二（入参指纹）
    args: text("args", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    // 镜像 M0 PersistedRunStatus = RunStatus("completed"|"failed"|"interrupted") + "running"。禁用 "cancelled"。
    status: text("status", {
      enum: ["running", "completed", "failed", "interrupted"],
    })
      .notNull()
      .default("running"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    index("workflow_runs_session_idx").on(t.sessionId),
    index("workflow_runs_resume_idx").on(t.scriptHash, t.argsHash),
  ],
);

// ── workflow_agents ──────────────────────────────────────────────────────────
// run 内每次原语调用（agent / parallel 单项 / pipeline 单项）的 journal 行。
// (seq, specHash) 是 spec §7 的 prefix-cache 键；seq 在 run 内单调唯一。
export const workflowAgents = sqliteTable(
  "workflow_agents",
  {
    id: text("id").primaryKey(), // randomUUID()
    tenantId: text("tenant_id").notNull().default("local"),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(), // run 内单调调用序（并行项按规格数组序取连续 seq）
    callKind: text("call_kind", {
      enum: ["agent", "parallel-item", "pipeline-item"], // 镜像 M0 CallKind
    }).notNull(),
    specHash: text("spec_hash").notNull(), // 该调用规格指纹（逐调用缓存命中键）
    // 镜像 M0 AgentStatus = "running"|"completed"|"failed"。
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    resultJson: text("result_json", { mode: "json" }).$type<unknown>(), // 结构化/文本结果，resume 重放载荷
    subTurnId: text("sub_turn_id").references(() => turns.id, { onDelete: "set null" }), // 子 agent turn（审计下钻 §8）
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("workflow_agents_run_seq_uq").on(t.runId, t.seq),
    index("workflow_agents_run_status_idx").on(t.runId, t.status),
  ],
);
```

生成并应用迁移（从仓库根），再跑测（预期绿：1 pass / 0 fail）：

```bash
bun run db:generate          # 产出 packages/core/src/db/migrations/<ts>_*.sql（必须随提交）
bun run db:migrate           # 应用到 .arclight/arclight.sqlite
bun test packages/core/src/workflow/__tests__/migrations.test.ts
bun run typecheck
```

**commit**：

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/migrations packages/core/src/workflow/__tests__/migrations.test.ts
git commit -m "feat(workflow,db): workflow_runs/workflow_agents 表（resume 主键 scriptHash+argsHash，prefix 键 seq+specHash）

状态字面量镜像 M0 PersistedRunStatus/AgentStatus（interrupted，无 cancelled）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3 — `WorkflowJournalService`（resume-capable，`implements WorkflowJournalPort`）

**目标**：实现 M0 `WorkflowJournalPort` 端口——`startRun`/`finishRun`/`recordAgentStart`/`completeAgent`/`failAgent`/`findResumableRun`/`loadJournal`。与 `ApprovalService` 同构：构造接 `Db`，同步 `.run()/.get()/.all()`，时钟可注入。**`RunStatus`/`CallKind`/`JournalRow` import 自 `./types`，不再本地声明**；`finishRun` 直接收 `RunStatus`（M0 词表已不含 `running`，无需 `Exclude`）。

**RED**：新建 `packages/core/src/workflow/__tests__/journal-service.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, workspaces } from "../../db/schema";
import { WorkflowJournalService } from "../journal-service";

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), "arclight-wf-journal-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces).values({ id: "w1", name: "t", repoPath: "/r", arclightDir: "/r/.arclight" }).run();
  db.insert(sessions).values({ id: "s1", workspaceId: "w1" }).run();
});
afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("WorkflowJournalService", () => {
  test("startRun → record/complete agent → loadJournal 按 seq 升序回放，result 往返", () => {
    const j = new WorkflowJournalService(db, now);
    const runId = j.startRun({ sessionId: "s1", scriptHash: "sh1", argsHash: "ah1", args: { seed: 1 } });
    const a0 = j.recordAgentStart({ runId, seq: 0, callKind: "agent", specHash: "spec-0" });
    j.completeAgent(a0, { ok: true });
    const a1 = j.recordAgentStart({ runId, seq: 1, callKind: "parallel-item", specHash: "spec-1" });
    j.completeAgent(a1, "text-result");

    const journal = j.loadJournal(runId);
    expect(journal).toHaveLength(2);
    expect(journal[0]).toMatchObject({ seq: 0, specHash: "spec-0", status: "completed", resultJson: { ok: true } });
    expect(journal[1]).toMatchObject({ seq: 1, specHash: "spec-1", status: "completed", resultJson: "text-result" });
  });

  test("failAgent 记 failed", () => {
    const j = new WorkflowJournalService(db, now);
    const runId = j.startRun({ sessionId: "s1", scriptHash: "sh1", argsHash: "ah1", args: {} });
    const a = j.recordAgentStart({ runId, seq: 0, callKind: "agent", specHash: "x" });
    j.failAgent(a, "boom");
    expect(j.loadJournal(runId)[0]).toMatchObject({ status: "failed", resultJson: null });
  });

  test("findResumableRun 按 (scriptHash, argsHash) 取最近，不按 status 过滤（崩溃 run 仍可续）", () => {
    const j = new WorkflowJournalService(db, now);
    const r1 = j.startRun({ sessionId: "s1", scriptHash: "sh1", argsHash: "ah1", args: {} });
    j.finishRun(r1, "failed", "crash");
    clock += 1000;
    const r2 = j.startRun({ sessionId: "s1", scriptHash: "sh1", argsHash: "ah1", args: {} }); // 留 running（模拟崩溃）
    expect(j.findResumableRun("sh1", "ah1")?.runId).toBe(r2);
    expect(j.findResumableRun("sh1", "ah-other")).toBeNull();
    expect(j.findResumableRun("sh-other", "ah1")).toBeNull();
  });
});
```

跑测（预期红：`Cannot find module '../journal-service'`）：

```bash
bun test packages/core/src/workflow/__tests__/journal-service.test.ts
```

**GREEN**：新建 `packages/core/src/workflow/journal-service.ts`

```ts
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
```

> 注：`loadJournal` 的 select 投影列类型逐字段对齐 M0 `JournalRow`——`status` 列枚举 `"running"|"completed"|"failed"` 即 `AgentStatus`，`resultJson` 列 `$type<unknown>()` 即 `unknown`；`: JournalRow[]` 返回注解 + `implements WorkflowJournalPort` 双重把关，编译期即锁死端口形状。

跑测（预期绿：3 pass / 0 fail）→ 静态检查：

```bash
bun test packages/core/src/workflow/__tests__/journal-service.test.ts
bun run typecheck
bun run check
```

**commit**：

```bash
git add packages/core/src/workflow/journal-service.ts packages/core/src/workflow/__tests__/journal-service.test.ts
git commit -m "feat(workflow): WorkflowJournalService implements WorkflowJournalPort（record/complete/fail + findResumableRun/loadJournal）

共享状态/CallKind/JournalRow import 自 M0 types.ts，不再本地声明。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4 — `ResumePlanner` 前缀重放规划器

**目标**：对 prior journal，按 `(seq, specHash)` 逐调用判定命中；首个不命中（变更/新增/非 completed）起尾部失效。纯内存、无 IO，可独立单测。`JournalRow` **import 自 `./types`**（M0），不再从 `./journal-service` 取。`ConsultResult` 是 M3 私有类型，留在本模块。

**RED**：新建 `packages/core/src/workflow/__tests__/resume.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import type { JournalRow } from "../types";
import { ResumePlanner } from "../resume";

const row = (seq: number, specHash: string, status: JournalRow["status"], result: unknown): JournalRow => ({
  seq,
  specHash,
  status,
  resultJson: result,
});

describe("ResumePlanner 前缀重放", () => {
  test("全部规格未变 → 逐调用命中，回灌 prior 结果", () => {
    const p = new ResumePlanner([row(0, "h0", "completed", "r0"), row(1, "h1", "completed", "r1")]);
    expect(p.consult(0, "h0")).toEqual({ hit: true, result: "r0" });
    expect(p.consult(1, "h1")).toEqual({ hit: true, result: "r1" });
    expect(p.cacheHits).toBe(2);
  });

  test("中段 specHash 变更 → 该调用起整条尾部失效（即便其后规格未变）", () => {
    const p = new ResumePlanner([
      row(0, "h0", "completed", "r0"),
      row(1, "h1", "completed", "r1"),
      row(2, "h2", "completed", "r2"),
    ]);
    expect(p.consult(0, "h0").hit).toBe(true);
    expect(p.consult(1, "CHANGED").hit).toBe(false); // 变更点
    expect(p.consult(2, "h2").hit).toBe(false); // 尾部失效
    expect(p.cacheHits).toBe(1);
  });

  test("prior 该 seq 非 completed（failed/缺失） → 未命中且尾部失效", () => {
    const p = new ResumePlanner([row(0, "h0", "failed", null)]);
    expect(p.consult(0, "h0").hit).toBe(false);
    expect(p.consult(1, "h1").hit).toBe(false);
    expect(p.cacheHits).toBe(0);
  });

  test("空 journal（全新 run） → 一律未命中", () => {
    const p = new ResumePlanner([]);
    expect(p.consult(0, "h0").hit).toBe(false);
    expect(p.cacheHits).toBe(0);
  });
});
```

跑测（预期红：`Cannot find module '../resume'`）：

```bash
bun test packages/core/src/workflow/__tests__/resume.test.ts
```

**GREEN**：新建 `packages/core/src/workflow/resume.ts`

```ts
import type { JournalRow } from "./types";

export type ConsultResult = { hit: true; result: unknown } | { hit: false };

/** 前缀重放规划器：对相同 (scriptHash, argsHash) 的 prior journal，
 *  按 (seq, specHash) 逐调用判定命中；首个不命中（规格变更 / 新增调用 / prior 非 completed）
 *  起整条尾部失效——下游规格可能经宿主 ${prev} 插值依赖上游结果，越过缺口复用不安全（spec §2.1/§7）。*/
export class ResumePlanner {
  private readonly bySeq = new Map<number, JournalRow>();
  private broken = false;
  private hits = 0;

  constructor(prior: readonly JournalRow[]) {
    for (const r of prior) this.bySeq.set(r.seq, r);
  }

  consult(seq: number, specHash: string): ConsultResult {
    if (this.broken) return { hit: false };
    const prior = this.bySeq.get(seq);
    if (!prior || prior.specHash !== specHash || prior.status !== "completed") {
      this.broken = true;
      return { hit: false };
    }
    this.hits += 1;
    return { hit: true, result: prior.resultJson };
  }

  get cacheHits(): number {
    return this.hits;
  }
}
```

跑测（预期绿：4 pass / 0 fail）→ 静态检查：

```bash
bun test packages/core/src/workflow/__tests__/resume.test.ts
bun run typecheck
bun run check
```

**commit**：

```bash
git add packages/core/src/workflow/resume.ts packages/core/src/workflow/__tests__/resume.test.ts
git commit -m "feat(workflow): ResumePlanner 前缀重放（逐调用 specHash 命中 + 首个不命中尾部失效；JournalRow import 自 M0）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 — 执行接缝 `makeJournaledRun`（M1/M2 调用点）

**目标**：每次原语调用走此封套：命中 → 秒回 prior 结果（不起 live）且补写一条 completed 行（保证本 run 可再 resume）；未命中 → 起 live 并 journal 落 `(seq, specHash, result)`；`runLive` throw → `failAgent` 后继续抛（spec §10 的 null 归一在上层 `agent()`/`parallel` 包装，不在此层）。命中判定与回灌全宿主同步，不在挂起期再入 guest（asyncify 安全）。`CallKind` **import 自 `./types`**（M0）。

> **与 M0 `RunSubagent` 端口的关系**：`makeJournaledRun` 的 `runLive: RunOneSpec` 是 journaling 接缝的私有内层回调（承载 `seq`/`callKind`、失败以 throw 表达），**不是** M0 `RunSubagent`（`(spec, signal)=>Promise<SubagentResult>`）本身。M6 装配时由 `RunSubagent` 适配而来——`seq`/`callKind` 由编排循环按 run 内单调序分配并经 `ctx` 注入，`signal` 由闭包捕获（M4 `deriveChildSignal`）：
> ```ts
> const runLive: RunOneSpec = async (spec) => {
>   const r = await runSubagent(spec as AgentSpec, signal); // signal 来自 M6 闭包捕获的 run 级信号
>   if (r.ok) return r.value;                               // 成功 → completeAgent
>   throw new WorkflowApiError(r.error ?? r.status);        // 失败 → failAgent → resume 重跑；agent() 层归一 null（spec §10）
> };
> ```

**RED**：新建 `packages/core/src/workflow/__tests__/journaled-run.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, workspaces } from "../../db/schema";
import { specHash } from "../hash";
import { makeJournaledRun, type RunOneSpec } from "../journaled-run";
import { WorkflowJournalService } from "../journal-service";
import { ResumePlanner } from "../resume";

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arclight-wf-run-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces).values({ id: "w1", name: "t", repoPath: "/r", arclightDir: "/r/.arclight" }).run();
  db.insert(sessions).values({ id: "s1", workspaceId: "w1" }).run();
});
afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const mkRun = (j: WorkflowJournalService) =>
  j.startRun({ sessionId: "s1", scriptHash: "sh", argsHash: "ah", args: {} });

describe("makeJournaledRun", () => {
  test("空 planner → 起 live 并 journal 落 (seq, specHash, result)", async () => {
    const j = new WorkflowJournalService(db);
    const runId = mkRun(j);
    let live = 0;
    const runLive: RunOneSpec = async (spec) => {
      live++;
      return { echo: spec };
    };
    const run = makeJournaledRun({ journal: j, runId, planner: new ResumePlanner([]), runLive });

    const out = await run({ prompt: "a" }, { seq: 0, callKind: "agent" });
    expect(out).toEqual({ echo: { prompt: "a" } });
    expect(live).toBe(1);
    const journal = j.loadJournal(runId);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ seq: 0, specHash: specHash({ prompt: "a" }), status: "completed" });
  });

  test("planner 命中 → 不起 live，秒回 prior 结果，并补写一条 completed 行（可再 resume）", async () => {
    const j = new WorkflowJournalService(db);
    const runId = mkRun(j);
    let live = 0;
    const runLive: RunOneSpec = async () => {
      live++;
      return "LIVE";
    };
    const planner = new ResumePlanner([
      { seq: 0, specHash: specHash({ prompt: "a" }), status: "completed", resultJson: "CACHED" },
    ]);
    const run = makeJournaledRun({ journal: j, runId, planner, runLive });

    const out = await run({ prompt: "a" }, { seq: 0, callKind: "agent" });
    expect(out).toBe("CACHED");
    expect(live).toBe(0);
    const journal = j.loadJournal(runId);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ seq: 0, status: "completed", resultJson: "CACHED" });
  });

  test("runLive throw → failAgent 记 failed 并继续向上抛", async () => {
    const j = new WorkflowJournalService(db);
    const runId = mkRun(j);
    const runLive: RunOneSpec = async () => {
      throw new Error("boom");
    };
    const run = makeJournaledRun({ journal: j, runId, planner: new ResumePlanner([]), runLive });

    await expect(run({ prompt: "x" }, { seq: 0, callKind: "agent" })).rejects.toThrow("boom");
    expect(j.loadJournal(runId)[0]).toMatchObject({ status: "failed" });
  });
});
```

跑测（预期红：`Cannot find module '../journaled-run'`）：

```bash
bun test packages/core/src/workflow/__tests__/journaled-run.test.ts
```

**GREEN**：新建 `packages/core/src/workflow/journaled-run.ts`

```ts
import { specHash as computeSpecHash } from "./hash";
import type { WorkflowJournalService } from "./journal-service";
import type { ResumePlanner } from "./resume";
import type { CallKind } from "./types";

export type RunCtx = { seq: number; callKind: CallKind };

/** 实跑一个可序列化规格的子 agent；返回结构化结果或文本。真实实现是 M1 的嵌套 queryLoop。
 *  失败语义：此处 throw=真失败（供 journal 记 failed）；spec §10 的『失败→null』在 agent()/parallel 包装层归一。
 *  这是 journaling 接缝的私有抽象（承载 seq/callKind），不是 M0 RunSubagent 端口本身——
 *  M6 由 RunSubagent(spec, signal)=>Promise<SubagentResult> 适配为此回调（详见上文文档注）。*/
export type RunOneSpec = (spec: unknown, ctx: RunCtx) => Promise<unknown>;

export type JournaledRunDeps = {
  journal: WorkflowJournalService;
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
```

跑测（预期绿：3 pass / 0 fail）→ 静态检查：

```bash
bun test packages/core/src/workflow/__tests__/journaled-run.test.ts
bun run typecheck
bun run check
```

**commit**：

```bash
git add packages/core/src/workflow/journaled-run.ts packages/core/src/workflow/__tests__/journaled-run.test.ts
git commit -m "feat(workflow): makeJournaledRun 执行接缝（命中秒回+补写，未命中 live+journal，throw 记 failed）

CallKind import 自 M0 types.ts；文档钉死与 RunSubagent 端口的 M6 适配关系。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6 — journal + resume 端到端回归（spec §14）

**目标**：覆盖 spec §14『相同 scriptHash+args 全缓存命中；改中段后前缀命中、其后 live；确定性约束回归』。用确定性 `runLive`（结果只由 spec 决定，**模拟 guest 内 Date/random 已被 M6 runtime 桩死**——M3 不实现该桩，只消费其确定性结果）跨多次 run 驱动真实 journal。

**RED**：新建 `packages/core/src/workflow/__tests__/resume-e2e.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, workspaces } from "../../db/schema";
import { argsHash, scriptHash } from "../hash";
import { makeJournaledRun, type RunOneSpec } from "../journaled-run";
import { WorkflowJournalService } from "../journal-service";
import { ResumePlanner } from "../resume";

// 确定性 runLive：结果只由 spec 决定（模拟 guest 内 Date/random 已被 M6 runtime 桩死，spec §7 前提）。
const deterministicRun = (counter: { n: number }): RunOneSpec => async (spec) => {
  counter.n++;
  return { for: (spec as { prompt: string }).prompt };
};

const SCRIPT = "agent('a'); agent('b'); agent('c');";
const ARGS = { seed: 7 };

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arclight-wf-e2e-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces).values({ id: "w1", name: "t", repoPath: "/r", arclightDir: "/r/.arclight" }).run();
  db.insert(sessions).values({ id: "s1", workspaceId: "w1" }).run();
});
afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

// 跑一遍脚本的三次 agent 调用，返回结果数组 + live 次数 + 命中数。
async function driveRun(
  j: WorkflowJournalService,
  prompts: string[],
  planner: ResumePlanner,
): Promise<{ runId: string; results: unknown[]; live: number; hits: number }> {
  const runId = j.startRun({
    sessionId: "s1",
    scriptHash: scriptHash(SCRIPT),
    argsHash: argsHash(ARGS),
    args: ARGS,
  });
  const counter = { n: 0 };
  const run = makeJournaledRun({ journal: j, runId, planner, runLive: deterministicRun(counter) });
  const results: unknown[] = [];
  for (let seq = 0; seq < prompts.length; seq++) {
    results.push(await run({ prompt: prompts[seq] }, { seq, callKind: "agent" }));
  }
  j.finishRun(runId, "completed");
  return { runId, results, live: counter.n, hits: planner.cacheHits };
}

describe("journal + resume 端到端 (spec §14)", () => {
  test("相同 scriptHash+args 重跑 → 全缓存命中，零 live 调用，结果一致", async () => {
    const j = new WorkflowJournalService(db);
    const first = await driveRun(j, ["a", "b", "c"], new ResumePlanner([]));
    expect(first.live).toBe(3);

    const prior = j.findResumableRun(scriptHash(SCRIPT), argsHash(ARGS));
    expect(prior).not.toBeNull();
    const replay = await driveRun(j, ["a", "b", "c"], new ResumePlanner(j.loadJournal(prior!.runId)));
    expect(replay.hits).toBe(3);
    expect(replay.live).toBe(0);
    expect(replay.results).toEqual(first.results); // 确定性：重放结果逐位等于首跑
  });

  test("改中段调用 → 前缀命中、变更点及其后 live", async () => {
    const j = new WorkflowJournalService(db);
    await driveRun(j, ["a", "b", "c"], new ResumePlanner([]));
    const prior = j.findResumableRun(scriptHash(SCRIPT), argsHash(ARGS))!;

    const changed = await driveRun(j, ["a", "B-CHANGED", "c"], new ResumePlanner(j.loadJournal(prior.runId)));
    expect(changed.hits).toBe(1); // seq0 命中
    expect(changed.live).toBe(2); // seq1（变更）+ seq2（尾部失效）live
    expect(changed.results[0]).toEqual({ for: "a" });
    expect(changed.results[1]).toEqual({ for: "B-CHANGED" });
  });

  test("确定性回归：无 Date/random，两次独立全新跑结果逐位相等", async () => {
    const j = new WorkflowJournalService(db);
    const a = await driveRun(j, ["a", "b", "c"], new ResumePlanner([]));
    const b = await driveRun(j, ["a", "b", "c"], new ResumePlanner([]));
    expect(b.results).toEqual(a.results);
  });
});
```

跑测（预期红：断言不成立 / 行为未联通）：

```bash
bun test packages/core/src/workflow/__tests__/resume-e2e.test.ts
```

**GREEN**：本任务不引入新实现文件——Task 1–5 的件已满足（**不在 M3 增加任何 guest 时钟桩；guest 确定性桩属 M6**）。若红，按 systematic-debugging 定位（常见点：`canonicalJson` 漏排序导致 specHash 漂移；尾部失效未生效；`findResumableRun` 排序方向错）。修至全绿：

```bash
bun test packages/core/src/workflow/__tests__/resume-e2e.test.ts   # 预期 3 pass / 0 fail
bun run test:core                                                  # 全 core 套件回归（含 migrate.test 等）
bun run typecheck
bun run check
```

**commit**：

```bash
git add packages/core/src/workflow/__tests__/resume-e2e.test.ts
git commit -m "test(workflow): journal+resume 端到端（全命中/中段改动前缀命中/确定性回归 — spec §14）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### M3 验收清单（对照 spec §7 / §14 + M0 契约）

- [x] 共享类型纪律：`RunStatus`/`CallKind`/`JournalRow`（及其依赖 `AgentStatus`/`WorkflowJournalPort`）一律 import 自 `./types`（M0），M3 零本地重声明（Task 3/4/5）。
- [x] 状态词统一 `completed|failed|interrupted` + 持久态 `running`，**无 `cancelled`**；schema 字面量镜像 M0 `PersistedRunStatus`/`AgentStatus`（Task 2）。
- [x] `WorkflowJournalService implements WorkflowJournalPort`，端口形状编译期锁死（Task 3）。
- [x] 两表 `workflow_runs(scriptHash,argsHash,args,status)` / `workflow_agents(seq,callKind,specHash,resultJson,status)` 落库 + 迁移（Task 2）。
- [x] journal：每次调用按 `(seq, specHash)` 落 `workflow_agents`（Task 3/5）。
- [x] resume：相同 `scriptHash + args` → 未变前缀按 `specHash` 秒回，首个变更/新增起 live（Task 4/5/6）。
- [x] 确定性前提回归：`canonicalJson` 稳定指纹 + （M6 桩死的）Date/random 下两次跑逐位一致；**guest 确定性桩不在 M3，移至 M6**（Task 1/6）。
- [x] 崩溃续跑：run 卡 `running` 仍可 resume，只重放 completed 行（Task 3）。
- [x] asyncify 单挂起：journal 纯宿主侧、`parallel`/`pipeline` 按可序列化规格逐项 journal，不在挂起期再入 guest（前言 + Task 5）。
- [x] `makeJournaledRun` 与 M0 `RunSubagent` 端口的 M6 适配关系文档钉死（Task 5）。
- [x] 测试运行器贴合：全用 `bun:test`（`bun:sqlite` 依赖）、`__tests__/` 同目录、`bun test <file>` / `bun run test:core`（非 vitest）；迁移走 `bun run db:generate`+`bun run db:migrate`，生成 SQL 随提交。

---

## 里程碑 M4：事件 + 审批路由 + 中断

> 依赖：**M0**（`workflow/types.ts` 共享契约——本里程碑 import `WORKFLOW_EVENTS` / `RunStatus`，禁止本地重声明）、M1（runtime + `agent()` 嵌套 queryLoop）、M2（scheduler 并发池/限流）、M3（journal）已落地。本里程碑只新增并独立验证三块 **可单测的接缝**：protocol 的 `workflow.*` 事件、宿主侧旁路发射器、跨 subagent 审批冒泡、与中断扇出。每个单元用最小夹具（fake emit / fake ApprovalSeam / AbortController）自测，不依赖 M1–M3 模块跑通——与现有 `query-loop.test.ts` 同款 test-first 风格。
>
> 模块落点（spec §3）：`packages/core/src/workflow/{events,bubbling-approval,interrupt}.ts` + 同目录 `__tests__/`；protocol schema 落 `packages/protocol/src/events.ts`。
>
> **本里程碑钉死的两处契约 bug（M0 §11/下游表）**
> 1. `RichApprovalDecision` **不存在** → bubbling-approval 及其测试改用 `loop/types.ts:59-65` 既有 `ApprovalDecision`（无 `Rich` 前缀；deny 变体自带可选 `errorClass`）。
> 2. `workflow.agent.started` 的序号字段名 = **`agentSeq`**（非 `seq`）：信封 `seq` 由 `appendEvent` 单点分配，`DraftEvent = DistributiveOmit<ArcEvent,"seq"|"ts"|"epoch">`（appendEvent.ts:32），事件 payload **不得再声明 `seq`**，否则与信封字段冲突。
> 3. 六个 `workflow.*` 事件名在 **core 侧** 单点引用 M0 常量 `WORKFLOW_EVENTS`（events.ts）。**protocol 侧**保留权威 wire 字面量——因依赖方向是 `core → @arclight/protocol`（protocol 零 @arclight 依赖，index.ts:2），protocol 不能反向 import core 的 `types.ts`；两侧字面量同源于 spec §8，由 §8 schema 端到端测试（Task 1）+ core 发射器经真实 `ArcEventSchema` 复核（Task 2）双向钉死，杜绝漂移。
>
> **§2.1 asyncify 硬约束遵从**：以下所有发射/中断逻辑全部发生在 **宿主侧**（appendEvent + EventBus + AbortSignal）。QuickJS guest 实例挂起期间，绝不被同步回灌（不调用 guest 函数）；guest 仅通过单个挂起 Promise 的 resolve 恢复。三个单元均不触达 guest。
>
> 测试运行器纪律：`packages/core` 用 **bun:test**（`import { describe, expect, test } from "bun:test"`）；`packages/protocol` 用 **vitest**（`import { describe, expect, it } from "vitest"`）。

---

### Task 1 — protocol：`workflow.*` 六事件 schema（spec §8）

按 spec §8 落 6 个事件（`workflow.started / workflow.phase / workflow.agent.started / workflow.agent.completed / workflow.completed / workflow.failed`），append 进 `ArcEventSchema` discriminated union（append-only，前端未知 `t` 静默忽略契约见 events.ts:8）。中断不另设事件——用 `workflow.failed{reason:"interrupted"}` 表达，与顶层 throw 的 `reason:"error"` 区分。`workflow.agent.started` 的序号字段名为 **`agentSeq`**（非 `seq`，见上 §钉死 bug 2）。

**1a. 先写失败测试** — 新建 `packages/protocol/src/__tests__/workflow-events.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { ArcEventSchema, WireEventEnvelopeSchema } from "../index";

const base = { v: 1, sessionId: "s1", seq: 1, epoch: 0, ts: 1_700_000_000_000 } as const;

describe("workflow.* 事件 schema（spec §8）", () => {
  it("接受 workflow.started", () => {
    const r = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.started",
      turnId: "t1",
      workflowId: "run-1",
      name: "gate-circuit",
    });
    expect(r.success).toBe(true);
  });

  it("接受 workflow.phase", () => {
    const r = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.phase",
      workflowId: "run-1",
      title: "校验",
    });
    expect(r.success).toBe(true);
  });

  it("接受 workflow.agent.started（payload 序号字段 = agentSeq，与信封 seq 并存）", () => {
    const r = ArcEventSchema.safeParse({
      ...base, // base 已含信封 seq:1（appendEvent 分配）
      t: "workflow.agent.started",
      workflowId: "run-1",
      agentId: "a1",
      role: "executor",
      agentSeq: 0, // ← payload 序号，不是信封 seq
    });
    expect(r.success).toBe(true);
    // 缺 agentSeq 必败（字段必填，钉死 seq→agentSeq 改名不被静默放过）
    const missing = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.agent.started",
      workflowId: "run-1",
      agentId: "a1",
      role: "executor",
    });
    expect(missing.success).toBe(false);
  });

  it("接受 workflow.agent.completed（status 限 ok|failed）", () => {
    const ok = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.agent.completed",
      workflowId: "run-1",
      agentId: "a1",
      status: "failed",
    });
    expect(ok.success).toBe(true);
    const bad = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.agent.completed",
      workflowId: "run-1",
      agentId: "a1",
      status: "cancelled",
    });
    expect(bad.success).toBe(false);
  });

  it("接受 workflow.completed", () => {
    const r = ArcEventSchema.safeParse({ ...base, t: "workflow.completed", workflowId: "run-1" });
    expect(r.success).toBe(true);
  });

  it("接受 workflow.failed，reason 区分 error|interrupted", () => {
    for (const reason of ["error", "interrupted"] as const) {
      const r = ArcEventSchema.safeParse({
        ...base,
        t: "workflow.failed",
        workflowId: "run-1",
        reason,
        message: "x",
      });
      expect(r.success).toBe(true);
    }
    const bad = ArcEventSchema.safeParse({
      ...base,
      t: "workflow.failed",
      workflowId: "run-1",
      reason: "boom",
      message: "x",
    });
    expect(bad.success).toBe(false);
  });

  it("前向兼容：Wire 信封接受未来未知 t", () => {
    // 服务端先于客户端升级时，旧客户端必须仍接受信封并推进 maxSeq（events.ts:119-125）
    const r = WireEventEnvelopeSchema.safeParse({ ...base, t: "workflow.future_kind", any: 1 });
    expect(r.success).toBe(true);
  });
});
```

**1b. 跑测试，确认红**：

```bash
bunx vitest run packages/protocol/src/__tests__/workflow-events.test.ts
```

预期红：discriminatedUnion 尚无 `workflow.*` 成员，`safeParse` 对所有 `workflow.*` 输入返回 `success:false`，6 个 `expect(...).toBe(true)` 断言失败（`6 failed`）。`workflow.future_kind` 的 Wire 信封用例已通过（schema 已存在）。

**1c. 实现** — 编辑 `packages/protocol/src/events.ts`，在 `InterruptedSchema`（112 行）之后、`WireEventEnvelopeSchema`（122 行）之前插入：

```ts
// ── workflow.*（spec §8）：编排生命周期事件。走 appendEvent+bus 旁路（不混入主 turn 叙事流），
// 与 tool.progress 同一持久化+扇出路径。workflowId = workflow_runs.id（runId）。append-only。
//
// 字面量同源于 spec §8；core 侧（workflow/events.ts）经 M0 常量 WORKFLOW_EVENTS 单点引用。
// 本包不能反向 import core 的 types.ts（依赖方向 core→@arclight/protocol，本包零 @arclight 依赖，
// index.ts:2），故此处保留权威 wire 字面量，由 §8 schema 测试 + core 发射器 ArcEventSchema 复核双向钉死。
export const WorkflowStartedSchema = z.object({
  ...base,
  t: z.literal("workflow.started"),
  workflowId: z.string().min(1),
  name: z.string().min(1),
});

export const WorkflowPhaseSchema = z.object({
  ...base,
  t: z.literal("workflow.phase"),
  workflowId: z.string().min(1),
  title: z.string().min(1),
});

export const WorkflowAgentStartedSchema = z.object({
  ...base,
  t: z.literal("workflow.agent.started"),
  workflowId: z.string().min(1),
  agentId: z.string().min(1), // = workflow_agents.id
  role: z.string().min(1), // AgentSpec.label/role
  // 序号字段名 = agentSeq（非 seq）：信封 seq 由 appendEvent 单点分配
  // （DraftEvent = Omit<ArcEvent,"seq"|"ts"|"epoch">），payload 不得再声明 seq（契约 M0 §11）。
  agentSeq: z.number().int().nonnegative(),
});

export const WorkflowAgentCompletedSchema = z.object({
  ...base,
  t: z.literal("workflow.agent.completed"),
  workflowId: z.string().min(1),
  agentId: z.string().min(1),
  status: z.enum(["ok", "failed"]),
});

export const WorkflowCompletedSchema = z.object({
  ...base,
  t: z.literal("workflow.completed"),
  workflowId: z.string().min(1),
});

// 中断与顶层 throw 共用本事件，reason 区分（spec §10）：run 置 interrupted / failed
export const WorkflowFailedSchema = z.object({
  ...base,
  t: z.literal("workflow.failed"),
  workflowId: z.string().min(1),
  reason: z.enum(["error", "interrupted"]),
  message: z.string(),
});
```

再把这 6 个 schema **append** 到 `ArcEventSchema` 数组末尾（`InterruptedSchema` 之后）：

```ts
export const ArcEventSchema = z.discriminatedUnion("t", [
  SessionStartedSchema,
  TurnStartedSchema,
  MessageDeltaSchema,
  UserMessageSchema,
  ThinkingDeltaSchema,
  ToolRequestedSchema,
  ToolProgressSchema,
  ToolOutputSchema,
  PermissionAskSchema,
  ContextCompactedSchema,
  TurnCompletedSchema,
  SessionErrorSchema,
  InterruptedSchema,
  WorkflowStartedSchema, // append only（spec §8）
  WorkflowPhaseSchema,
  WorkflowAgentStartedSchema,
  WorkflowAgentCompletedSchema,
  WorkflowCompletedSchema,
  WorkflowFailedSchema,
]);
```

`packages/protocol/src/index.ts` 已 `export * from "./events"`，无需改导出。

**1d. 跑测试，确认绿 + 全量回归**：

```bash
bunx vitest run packages/protocol/src/__tests__/workflow-events.test.ts
bun run test          # = vitest run：protocol/client-core/web 全量，确认未破坏既有 schema 测试
bun run typecheck     # = tsc --noEmit（用包脚本，确保 node_modules/.bin 在 PATH 上）
bun run check         # = biome check .
```

预期：新文件全绿，`bun run test` 全绿（已有 `schema.test.ts` 不受影响——只 append union 成员）。

**1e. 提交**：

```bash
git add packages/protocol/src/events.ts packages/protocol/src/__tests__/workflow-events.test.ts
git commit -m "feat(protocol): workflow.* 六事件 schema（spec §8 编排生命周期；payload 序号 agentSeq）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2 — `core/workflow/events.ts`：宿主侧旁路发射器（spec §8）

`workflow.*` 必须走 **appendEvent + bus 扇出旁路**（spec §8：「持久化 + bus 扇出，不混入主 turn 叙事流」），与 `tool.progress`（query-loop.ts:257-267）同款——即调用 runner 注入的 `emit` 闭包（= `WorkflowContext.emit` = `appendEvent({db,bus}, draft)`，M0 §9），**绝不 `yield` 进 queryLoop 主叙事生成器**。事件绑 **父会话** sessionId，才能落主会话 SSE 流（web 进度树消费）。事件名一律经 M0 常量 `WORKFLOW_EVENTS`（`./types`）单点引用——杜绝字面量在 core 侧漂移。

**2a. 先写失败测试** — 新建 `packages/core/src/workflow/__tests__/events.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { type ArcEvent, ArcEventSchema } from "@arclight/protocol";
import type { DraftEvent } from "../../db/appendEvent";
import { WorkflowEvents } from "../events";

// runner 注入的 emit 同型夹具（seq/epoch/ts 由 appendEvent 事务内分配，此处用 fake 计数）
function makeEmit() {
  const events: ArcEvent[] = [];
  let seq = 0;
  const emit = (draft: DraftEvent): ArcEvent => {
    const e = { ...draft, seq: ++seq, epoch: 0, ts: 1_700_000_000_000 + seq } as ArcEvent;
    events.push(e);
    return e;
  };
  return { events, emit };
}

describe("WorkflowEvents：旁路发射 workflow.*（spec §8）", () => {
  test("六类事件按调用顺序经 emit 落库，绑父会话 + workflowId", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, {
      sessionId: "s-parent",
      turnId: "t-parent",
      workflowId: "run-1",
    });

    w.started("gate-circuit");
    w.phase("校验");
    w.agentStarted({ agentId: "a1", role: "executor", agentSeq: 0 });
    w.agentCompleted({ agentId: "a1", status: "ok" });
    w.completed();

    expect(events.map((e) => e.t)).toEqual([
      "workflow.started",
      "workflow.phase",
      "workflow.agent.started",
      "workflow.agent.completed",
      "workflow.completed",
    ]);
    // 全部绑父会话（落主流 SSE），且 seq 单调
    for (const e of events) {
      expect(e.sessionId).toBe("s-parent");
      expect(e.turnId).toBe("t-parent");
    }
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("started/agentStarted 负载字段与 §8 schema 端到端自洽（agentSeq 非 seq）", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    w.started("demo");
    w.agentStarted({ agentId: "a9", role: "reviewer", agentSeq: 2 });
    // 用真实 protocol schema 复核，钉死字段名（防 workflowId/role/agentSeq 漂移）
    for (const e of events) {
      expect(ArcEventSchema.safeParse(e).success).toBe(true);
    }
    expect(events[0]).toMatchObject({ t: "workflow.started", workflowId: "run-1", name: "demo" });
    expect(events[1]).toMatchObject({
      t: "workflow.agent.started",
      agentId: "a9",
      role: "reviewer",
      agentSeq: 2,
    });
  });

  test("failed 区分 error/interrupted（spec §10 两条终态）", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    w.failed("interrupted", "user aborted");
    w.failed("error", "top-level throw");
    expect(events[0]).toMatchObject({ t: "workflow.failed", reason: "interrupted" });
    expect(events[1]).toMatchObject({ t: "workflow.failed", reason: "error" });
    expect(ArcEventSchema.safeParse(events[0]).success).toBe(true);
    expect(ArcEventSchema.safeParse(events[1]).success).toBe(true);
  });
});
```

**2b. 跑测试，确认红**：

```bash
bun test packages/core/src/workflow/__tests__/events.test.ts
```

预期红：`../events` 模块不存在 → 模块解析失败，测试文件无法加载（`error: Cannot find module '../events'`）。

**2c. 实现** — 新建 `packages/core/src/workflow/events.ts`：

```ts
import type { ArcEvent } from "@arclight/protocol";
import type { DraftEvent } from "../db/appendEvent";
import { WORKFLOW_EVENTS } from "./types";

/** 发射上下文：绑父会话（落主流 SSE）+ 本次 workflow run。turnId = 发起 workflow 的父 turn。 */
export type WorkflowEventsCtx = {
  sessionId: string; // 父会话 id（workflow.* 落主流靠它）
  turnId?: string; // 发起 workflow 的父 turn（可选）
  workflowId: string; // workflow_runs.id（runId）
};

/**
 * workflow.* 宿主侧发射器（spec §8）。所有事件经注入的 emit（= WorkflowContext.emit = appendEvent 包装，
 * M0 §9）持久化 + bus 扇出，即「进度帧旁路」——绝不经 queryLoop 主叙事 yield。emit 与 query-loop.ts
 * 的闭包同型（seq/epoch/ts 由 appendEvent 事务内分配，调用方不得自带：DraftEvent 已 Omit 三者）。
 *
 * 事件名经 M0 常量 WORKFLOW_EVENTS 引用（单一真相源），protocol schema 字面量同源于 spec §8。
 *
 * §2.1 asyncify：发射在宿主侧完成，不回灌挂起中的 QuickJS guest。
 */
export class WorkflowEvents {
  constructor(
    private readonly emit: (draft: DraftEvent) => ArcEvent,
    private readonly ctx: WorkflowEventsCtx,
  ) {}

  private base() {
    return {
      v: 1 as const,
      sessionId: this.ctx.sessionId,
      turnId: this.ctx.turnId,
      workflowId: this.ctx.workflowId,
    };
  }

  started(name: string): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.started, name });
  }

  phase(title: string): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.phase, title });
  }

  agentStarted(a: { agentId: string; role: string; agentSeq: number }): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.agentStarted, ...a });
  }

  agentCompleted(a: { agentId: string; status: "ok" | "failed" }): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.agentCompleted, ...a });
  }

  completed(): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.completed });
  }

  failed(reason: "error" | "interrupted", message: string): ArcEvent {
    return this.emit({ ...this.base(), t: WORKFLOW_EVENTS.failed, reason, message });
  }
}
```

接线说明（无需在本 Task 编码，留给 M6 装配 `createWorkflowRuntime`）：runner 侧用 `WorkflowContext.emit`（= `appendEvent({ db, bus }, d)` 绑父会话），构造 `new WorkflowEvents(ctx.emit, { sessionId: ctx.parentSessionId, turnId: ctx.parentTurnId, workflowId: runId })`。

**2d. 跑测试，确认绿 + 类型/lint**：

```bash
bun test packages/core/src/workflow/__tests__/events.test.ts
bun run typecheck     # = tsc --noEmit
bun run check         # = biome check .
```

预期：3 个 describe 全绿，`tsc`/`biome` 通过。`WORKFLOW_EVENTS` 经 `as const` 收窄为字面量类型（如 `WORKFLOW_EVENTS.started: "workflow.started"`），`emit({ ...base(), t: WORKFLOW_EVENTS.started })` 据 discriminated union 收窄到对应 draft 成员，与 query-loop.ts 同款类型流转。

**2e. 提交**：

```bash
git add packages/core/src/workflow/events.ts packages/core/src/workflow/__tests__/events.test.ts
git commit -m "feat(core/workflow): workflow.* 旁路发射器（appendEvent+bus，绑父会话，WORKFLOW_EVENTS 单点引用）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3 — `core/workflow/bubbling-approval.ts`：跨 subagent 审批冒泡（spec §9）

`ApprovalSeam`（loop/types.ts:66-72）是 queryLoop 消费审批的 **唯一注入点**。给 subagent 的 `LoopDeps.approvals` 注入 `BubblingApprovalSeam`：它把 `ctx.sessionId` **重绑到父会话**后转发给父 `ApprovalPolicy.check`——于是 `permission.ask` 落 **主会话事件流**（被现有 web SSE 渲染）、`sessionAllow` 白名单归父会话；而 `turns.status → awaiting_approval` 仍作用于 subagent 的 turn（policy.ts:134-138 用 `ctx.turnId`），`callId`/`signal` 原样保留。决议由父层 C1 经同一 `askId` 调 `policy.decide(askId,...)`（policy.ts:216）回写——askId 是跨层唯一键，父层无需感知 subagent 内部 turnId/callId（spec §9）。决议形态用 `loop/types.ts:59-65` 既有 `ApprovalDecision`（不存在 `RichApprovalDecision`；deny 变体自带可选 `errorClass`）。

**3a. 先写失败测试** — 新建 `packages/core/src/workflow/__tests__/bubbling-approval.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import type { Tool } from "@arclight/protocol";
import type { ApprovalDecision, ApprovalSeam, LoopToolContext } from "../../loop/types";
import { BubblingApprovalSeam } from "../bubbling-approval";

const fakeTool = { meta: { name: "bash" } } as unknown as Tool<unknown, unknown>;

function childCtx(): LoopToolContext {
  return {
    sessionId: "s-child",
    turnId: "t-child",
    callId: "call-1",
    cwd: "/repo",
    signal: new AbortController().signal,
    emitProgress: () => {},
  };
}

describe("BubblingApprovalSeam：subagent 审批冒泡到父会话（spec §9）", () => {
  test("ctx.sessionId 重绑父会话；turnId/callId/signal 保留；allow 透传", async () => {
    let received: LoopToolContext | undefined;
    const parent: ApprovalSeam = {
      check: async (_t, _a, ctx) => {
        received = ctx;
        return { decision: "allow" };
      },
    };
    const ctx = childCtx();
    const seam = new BubblingApprovalSeam(parent, "s-parent");

    const d = await seam.check(fakeTool, { command: "ls" }, ctx);

    expect(d).toEqual({ decision: "allow" });
    expect(received?.sessionId).toBe("s-parent"); // 落主流靠它
    expect(received?.turnId).toBe("t-child"); // subagent turn 仍转 awaiting_approval
    expect(received?.callId).toBe("call-1"); // 决议回灌按 callId/askId 关联
    expect(received?.signal).toBe(ctx.signal); // 中断信号透传
  });

  test("deny（含 errorClass）原样透传——loop 据此封 envelope 回灌子 LLM", async () => {
    const denial: ApprovalDecision = {
      decision: "deny",
      reason: "user denied",
      errorClass: "APPROVAL_DENIED",
    };
    const parent: ApprovalSeam = { check: async () => denial };
    const seam = new BubblingApprovalSeam(parent, "s-parent");
    const d = await seam.check(fakeTool, { command: "rm -rf /" }, childCtx());
    expect(d).toEqual(denial);
  });

  test("不改写原 ctx 对象（重绑产生新对象，子 ctx 不被污染）", async () => {
    const parent: ApprovalSeam = { check: async () => ({ decision: "allow" }) };
    const ctx = childCtx();
    const seam = new BubblingApprovalSeam(parent, "s-parent");
    await seam.check(fakeTool, {}, ctx);
    expect(ctx.sessionId).toBe("s-child"); // 原 ctx 未被 mutate
  });
});
```

**3b. 跑测试，确认红**：

```bash
bun test packages/core/src/workflow/__tests__/bubbling-approval.test.ts
```

预期红：`../bubbling-approval` 不存在 → `error: Cannot find module '../bubbling-approval'`。

**3c. 实现** — 新建 `packages/core/src/workflow/bubbling-approval.ts`：

```ts
import type { Tool } from "@arclight/protocol";
import type { ApprovalDecision, ApprovalSeam, LoopToolContext } from "../loop/types";

/**
 * 跨 subagent 审批冒泡（spec §9）。注入子 agent 的 LoopDeps.approvals。
 *
 * 把 ctx.sessionId 重绑到父会话后转发给父 ApprovalPolicy：
 *  - permission.ask 落「父会话」事件流 → 现有 web SSE 直接呈现给用户（无需新前端）；
 *  - sessionAllow 本会话白名单归父会话（整个 workflow 即一个用户会话，符合预期）；
 *  - turns.status → awaiting_approval 仍作用于 subagent 的 turn（policy 用 ctx.turnId）；
 *  - callId/turnId/signal 原样保留：决议由父层 C1 经同一 askId 回写（askId 跨层唯一键），
 *    中断信号经 ctx.signal 透传到挂起的 waitForDecision。
 *
 * 并发下多个 subagent 各自的 permission.ask 并存于主流，靠 askId 区分回灌（spec §9）。
 * 返回 loop/types.ts 既有 ApprovalDecision（allow | deny{reason,errorClass?}）——不存在 RichApprovalDecision。
 * §2.1 asyncify：本接缝纯宿主侧 Promise 转发，不回灌挂起中的 guest。
 */
export class BubblingApprovalSeam implements ApprovalSeam {
  constructor(
    private readonly parent: ApprovalSeam,
    private readonly parentSessionId: string,
  ) {}

  check(
    tool: Tool<unknown, unknown>,
    args: unknown,
    ctx: LoopToolContext,
  ): Promise<ApprovalDecision> {
    // 重绑 sessionId（产生新 ctx，不 mutate 子 ctx）；其余字段透传
    return this.parent.check(tool, args, { ...ctx, sessionId: this.parentSessionId });
  }
}
```

**3d. 跑测试，确认绿 + 类型/lint**：

```bash
bun test packages/core/src/workflow/__tests__/bubbling-approval.test.ts
bun run typecheck     # = tsc --noEmit
bun run check         # = biome check .
```

预期：3 个用例全绿（`ApprovalDecision` 的 deny 变体含可选 `errorClass`，deny 透传类型自洽；不再引用不存在的 `RichApprovalDecision`）。

**3e. 提交**：

```bash
git add packages/core/src/workflow/bubbling-approval.ts packages/core/src/workflow/__tests__/bubbling-approval.test.ts
git commit -m "feat(core/workflow): 跨 subagent 审批冒泡（重绑父会话，ApprovalDecision，askId 回灌，spec §9）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4 — `core/workflow/interrupt.ts`：中断扇出 + 终态事件（spec §10）

中断（spec §10）：父 `AbortController.abort()`（runner.ts:501）须级联到所有在飞 subagent。每个 subagent 拿一个 **派生信号** `AbortSignal.any([parentSignal, localAc.signal])`——父 interrupt 或 scheduler 单独取消该 agent 任一触发即中断该 subagent 的 queryLoop（query-loop.ts:43/96 见 `signal.aborted` → 返回 `interrupted`）。run 终态由 `terminalEvent` 映射：`completed → workflow.completed`；`interrupted → workflow.failed{reason:"interrupted"}`；`failed → workflow.failed{reason:"error"}`（顶层 throw）。终态词表复用 M0 `RunStatus`（`completed|failed|interrupted`，无 `cancelled`）——不本地重声明 `RunOutcome`（M0 下游表：`M4 RunOutcome = RunStatus`）。run 物理状态（journal）写入交 M3 的 setter——M4 只负责事件语义，不引用未建表的状态列。

**4a. 先写失败测试** — 新建 `packages/core/src/workflow/__tests__/interrupt.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { type ArcEvent } from "@arclight/protocol";
import type { DraftEvent } from "../../db/appendEvent";
import { WorkflowEvents } from "../events";
import { deriveChildSignal, terminalEvent } from "../interrupt";

function makeEmit() {
  const events: ArcEvent[] = [];
  let seq = 0;
  const emit = (draft: DraftEvent): ArcEvent => {
    const e = { ...draft, seq: ++seq, epoch: 0, ts: 1_700_000_000_000 + seq } as ArcEvent;
    events.push(e);
    return e;
  };
  return { events, emit };
}

describe("deriveChildSignal：父 interrupt 级联扇出（spec §10）", () => {
  test("父 abort → 派生信号 aborted", () => {
    const parent = new AbortController();
    const { signal } = deriveChildSignal(parent.signal);
    expect(signal.aborted).toBe(false);
    parent.abort();
    expect(signal.aborted).toBe(true);
  });

  test("scheduler 单独取消该 agent → 派生 aborted，父不受影响", () => {
    const parent = new AbortController();
    const { signal, abort } = deriveChildSignal(parent.signal);
    abort();
    expect(signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  test("父已 abort 时派生信号即刻为 aborted", () => {
    const parent = new AbortController();
    parent.abort();
    const { signal } = deriveChildSignal(parent.signal);
    expect(signal.aborted).toBe(true);
  });
});

describe("terminalEvent：run 终态映射（spec §10，词表 = M0 RunStatus）", () => {
  test("completed → workflow.completed", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    terminalEvent(w, "completed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: "workflow.completed", workflowId: "run-1" });
  });

  test("interrupted → workflow.failed{reason:interrupted}", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    terminalEvent(w, "interrupted");
    expect(events[0]).toMatchObject({ t: "workflow.failed", reason: "interrupted" });
  });

  test("failed → workflow.failed{reason:error}，带 message", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    terminalEvent(w, "failed", "boom");
    expect(events[0]).toMatchObject({ t: "workflow.failed", reason: "error", message: "boom" });
  });
});
```

**4b. 跑测试，确认红**：

```bash
bun test packages/core/src/workflow/__tests__/interrupt.test.ts
```

预期红：`../interrupt` 不存在 → `error: Cannot find module '../interrupt'`。

**4c. 实现** — 新建 `packages/core/src/workflow/interrupt.ts`：

```ts
import type { RunStatus } from "./types";
import type { WorkflowEvents } from "./events";

/**
 * 为单个在飞 subagent 派生信号（spec §10 中断扇出）。
 * signal = AbortSignal.any([parentSignal, local.signal])：
 *  - 父 AgentRunner interrupt（runner.ts:501 ac.abort）→ parentSignal 触发 → 级联中断本 subagent；
 *  - scheduler 单独取消本 agent（限流/budget/失败收敛）→ 调返回的 abort()。
 * 任一触发即中断 subagent 的 queryLoop（query-loop.ts:43/96 见 signal.aborted → 返回 interrupted）。
 *
 * Bun 原生支持 AbortSignal.any（已验证）。
 */
export function deriveChildSignal(parentSignal: AbortSignal): {
  signal: AbortSignal;
  abort: () => void;
} {
  const local = new AbortController();
  const signal = AbortSignal.any([parentSignal, local.signal]);
  return { signal, abort: () => local.abort() };
}

/**
 * run 收口：把终态映射为 §8 终态事件（spec §10）。终态词表 = M0 RunStatus（completed|failed|interrupted）。
 *  completed   → workflow.completed
 *  interrupted → workflow.failed{reason:"interrupted"}（AbortSignal 扇出后 run 置 interrupted）
 *  failed      → workflow.failed{reason:"error"}（脚本顶层 throw）
 * journal 物理状态写入由 M3 的 journal setter 负责，本函数只发事件（不引用未建表的状态列）。
 */
export function terminalEvent(events: WorkflowEvents, outcome: RunStatus, message = ""): void {
  if (outcome === "completed") {
    events.completed();
  } else if (outcome === "interrupted") {
    events.failed("interrupted", message || "workflow interrupted");
  } else {
    events.failed("error", message || "workflow failed");
  }
}
```

**4d. 跑测试，确认绿 + 全量 core 回归 + 类型/lint**：

```bash
bun test packages/core/src/workflow/__tests__/interrupt.test.ts
bun run test:core     # = bun test packages/core tests：core 全量回归，确认未破坏既有 loop/approval 测试
bun run typecheck     # = tsc --noEmit
bun run check         # = biome check .
```

预期：interrupt 用例全绿；`bun run test:core` 全绿（M4 只新增 `workflow/` 模块，不改 loop/approval/db 既有路径）。

**4e. 提交**：

```bash
git add packages/core/src/workflow/interrupt.ts packages/core/src/workflow/__tests__/interrupt.test.ts
git commit -m "feat(core/workflow): 中断信号扇出 + run 终态事件映射（spec §10，终态词表复用 M0 RunStatus）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### M4 验收清单（spec §14「事件/审批」+ §8/§9/§10）

- [ ] §8：`workflow.started/phase/agent.started/agent.completed/completed/failed` 六事件入 protocol union（append-only），`bunx vitest run packages/protocol/...` 全绿；`workflow.agent.started` payload 序号字段 = **`agentSeq`**（非 `seq`），缺失即被 schema 拒。
- [ ] §8：`WorkflowEvents` 经注入 emit 走 appendEvent+bus 旁路（不 yield 进主叙事），绑父会话落主流；事件名经 M0 `WORKFLOW_EVENTS` 单点引用；产出经真实 `ArcEventSchema` 复核自洽。
- [ ] §9：`BubblingApprovalSeam` 重绑父会话使 permission.ask 冒泡到主流，subagent turn 转 awaiting_approval，决议按 askId 经 `policy.decide` 回灌；返回类型为既有 `ApprovalDecision`（**不引用 `RichApprovalDecision`**）。
- [ ] §10：`deriveChildSignal` 父 interrupt 级联中断所有在飞 subagent；`terminalEvent` 据 M0 `RunStatus` 区分 completed/interrupted/error 终态（不本地重声明 `RunOutcome`）。
- [ ] §2.1：三单元全在宿主侧，挂起期不回灌 guest。
- [ ] `bun run typecheck`（tsc --noEmit）+ `bun run check`（biome check .）通过；`bun run test:core` 与 `bun run test` 全量回归绿。

---

## 里程碑 M5：store + 动态合成入口

> 依赖：**M0（`workflow/types.ts` 共享类型契约）**、M1（`runtime.ts` + `agent()`）、M2（`scheduler`/`parallel`/`pipeline`）、M3（journal/resume）、M4（事件 + 审批路由）均已落地（spec §12 依赖链 `M0→M1→M2→M3/M4→M5→M6`）。
> M5 在已组好的基建之上补两件事：**命名 workflow 加载/保存 + 命名/临场合成解析（`store.ts`）** 与 **主 agent 临场生成脚本入口（`run_workflow` 工具 + `makeExecuteTool` 注入接缝）**（spec §3、§12.5、§14）。
>
> **里程碑边界（对抗式评审收口）：**
> - **共享类型一律 import 自 `./types`（M0 唯一权威），M5 绝不重复定义/本地重声明。** 本里程碑用到的 `WorkflowResult` / `WorkflowRuntime` / `WorkflowContext` / `LoadedWorkflow` / `WorkflowStorePort` / `RunStatus` 全部来自 `packages/core/src/workflow/types.ts`。
> - **`createWorkflowRuntime(ctx)`、公开入口 `runWorkflow(scriptOrName, args, ctx: WorkflowContext)`、`workflow()` 原语均由 M6 提供**（依赖链 M5→M6）。M5 **只引用契约签名、不实现其函数体**——理由：`runWorkflow` 与 `createWorkflowRuntime` 二者按契约组合（`createWorkflowRuntime(ctx).execute(resolveWorkflowSource(...), args)`），而 `createWorkflowRuntime` 是 M6 deliverable，M5 早于 M6 落地，不能前向 import 尚不存在的 `./runtime`（否则 `bun run typecheck` 红）。故 M5 交付公开入口要消费的两块拼图：**命名/合成解析 `resolveWorkflowSource`** 与 **临场合成工具 `run_workflow`**（工具消费一个**已构造好的注入式 `WorkflowRuntime` 实例**，因此在 M5 即可用假 runtime 端到端单测）。
> - `WorkflowRuntime.execute` 是**两参** `execute(source, args)`（M0 契约；M5 草稿的三参 `execute(source,args,ctx)` 已删除——ctx 在 `createWorkflowRuntime(ctx)` 时捕获）。
> - 终态词表统一 `completed | failed | interrupted`（M5 草稿的 `'cancelled'` → **`'interrupted'`**）。
> - `index.ts` **append-only**：仅追加 M5 的导出，不 clobber M1–M4 既有导出；公开入口的最终汇总在 M6。
> - **范围纪律**：M5 全部代码在**宿主侧**（store 文件 IO + 命名/合成判定 + 委托注入式 runtime）。不进 QuickJS guest、无 guest 回调/再入，天然满足 asyncify 单挂起约束（spec §2.1）——该约束只约束 M1/M2 的原语形态。
> - **无新增依赖**：仅用 `node:fs` / `node:crypto` / `zod`（均已在 `@arclight/core`）。QuickJS(wasm) 引擎是 M1 的依赖，M5 不碰。
> - **import 顺序纪律（biome `assist/source/organizeImports`，本仓 `bun run check` 强制、违则 exit 1）**：① 同一模块若同时有 `import type` 与值 `import`，**`import type` 行必须排在值 `import` 行之前**（或合并为单条 inline `type` 形，如 `import { type Foo, bar } from "x"`）；② 模块按路径字符串排序、更深的相对路径（`../../*`）排在更浅的（`../*`）之前、同深按字母序（故 `../builtin/runWorkflow` 排在 `../registry` 之前）。下文给出的 import 块均已按此规整——实现时**照抄顺序，勿凭习惯重排**。
> - 测试运行器：`packages/core` 用 **`bun test`**（`vitest.config.ts` 只 include protocol/client-core/web，不含 core）。测试置于对应 `__tests__/`。

**本里程碑文件清单：**

| 文件 | 动作 | 任务 |
|---|---|---|
| `packages/core/src/workflow/store.ts` | 新建 | T1 |
| `packages/core/src/workflow/__tests__/store.test.ts` | 新建 | T1 |
| `packages/core/src/workflow/index.ts` | 改（**追加** M5 导出，不 clobber） | T2 |
| `packages/core/src/workflow/__tests__/index.test.ts` | 新建 | T2 |
| `packages/core/src/tools/registry.ts` | 改（3 处最小 diff：注入接缝） | T3 |
| `packages/core/src/tools/builtin/runWorkflow.ts` | 新建 | T3 |
| `packages/core/src/tools/__tests__/runWorkflow.test.ts` | 新建 | T3 |
| `packages/core/src/serve.ts` | **不在 M5 改**（生产接线依赖 M6 `createWorkflowRuntime`，移交 M6） | T3.4 说明 |

---

### Task 1 — `WorkflowStore` + `resolveWorkflowSource`：命名 workflow 持久层 + 命名/合成解析

覆盖 spec §3（`store.ts`：`.arclight/workflows/*.workflow.js` 加载/保存/命名解析）、§7（`scriptHash` 供 resume）、§10（name 是唯一进文件系统路径的外部输入，须收口）、§11（量子消费者 `gate-circuit.workflow.js`）。

> **契约对齐**：`WorkflowStore implements WorkflowStorePort`（M0 端口）；`LoadedWorkflow` import 自 `./types`，**M5 不再本地声明**。`resolveWorkflowSource` 是「命名 vs 临场合成」判定的唯一收口点，M6 的公开 `runWorkflow` 复用之。

#### 1.1 失败测试在先

新建 `packages/core/src/workflow/__tests__/store.test.ts`：

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_NAME_RE, WorkflowStore } from "../store";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wf-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("WorkflowStore：命名 workflow 加载/保存（spec §3 store.ts, §14）", () => {
  test("save 后 load 拿回同一源码 + 稳定 scriptHash", () => {
    const store = new WorkflowStore(freshDir());
    const src = "phase('plan'); const r = await agent('hi'); return r;";
    const saved = store.save("my-flow", src);
    const loaded = store.load("my-flow");
    expect(loaded.name).toBe("my-flow");
    expect(loaded.source).toBe(src);
    expect(loaded.scriptHash).toBe(saved.scriptHash);
    expect(loaded.scriptHash).toBe(WorkflowStore.hashScript(src));
    expect(loaded.scriptHash).toHaveLength(64); // sha256 hex 全长，防 resume 碰撞误命中
  });

  test("list 去 .workflow.js 后缀并排序；目录不存在返回 []", () => {
    const store = new WorkflowStore(freshDir());
    expect(store.list()).toEqual([]); // workflows/ 子目录尚未创建
    store.save("zeta", "return 1;");
    store.save("alpha", "return 2;");
    expect(store.list()).toEqual(["alpha", "zeta"]);
  });

  test("§11 量子消费者：gate-circuit.workflow.js 落盘即可被 list/load", () => {
    const dir = freshDir();
    const wfDir = join(dir, "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "gate-circuit.workflow.js"), "await agent('build circuit');", "utf8");
    const store = new WorkflowStore(dir);
    expect(store.list()).toContain("gate-circuit");
    expect(store.load("gate-circuit").source).toContain("build circuit");
  });

  test("has：存在性探测，非法名直接 false 不抛", () => {
    const store = new WorkflowStore(freshDir());
    expect(store.has("missing")).toBe(false);
    expect(store.has("../etc/passwd")).toBe(false);
    store.save("present", "return 0;");
    expect(store.has("present")).toBe(true);
  });

  test("安全：路径穿越/非法名一律拒绝（spec §10）", () => {
    const store = new WorkflowStore(freshDir());
    for (const bad of ["../x", "a/b", ".", "..", "Foo", "with space", "", "x".repeat(65)]) {
      expect(() => store.save(bad, "x")).toThrow(/invalid workflow name/);
      expect(() => store.load(bad)).toThrow(/invalid workflow name/);
    }
    expect(WORKFLOW_NAME_RE.test("gate-circuit")).toBe(true);
    expect(WORKFLOW_NAME_RE.test("v2")).toBe(true);
  });

  test("load 合法但不存在的名 → 抛 no such workflow", () => {
    const store = new WorkflowStore(freshDir());
    expect(() => store.load("nope")).toThrow(/no such workflow/);
  });

  test("save 空源码被拒", () => {
    const store = new WorkflowStore(freshDir());
    expect(() => store.save("ok", "")).toThrow(/non-empty/);
  });
});
```

跑测（应红）：

```bash
bun test packages/core/src/workflow/__tests__/store.test.ts
```

预期红态：`error: Cannot find module '../store'`，套件加载失败（`0 pass`）——`store.ts` 尚不存在。

#### 1.2 实现

新建 `packages/core/src/workflow/store.ts`：

```ts
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
// 共享类型一律 import 自 M0 唯一权威 ./types（不本地重声明）。
import type { LoadedWorkflow, WorkflowStorePort } from "./types";

// 命名 workflow 持久层（spec §3 store.ts）。
// 安全要点（spec §10）：name 是唯一进入文件系统路径的外部输入，用严格 slug 正则收口——
// 正则禁掉 `/`、`.`、`..`、大写、空格，故天然无路径穿越（无需再 resolve + startsWith 比对）。
export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUFFIX = ".workflow.js";

// implements WorkflowStorePort（M0 端口）——结构化满足，供 M6 createWorkflowRuntime 注入。
export class WorkflowStore implements WorkflowStorePort {
  private readonly dir: string;

  constructor(arclightDir: string) {
    this.dir = join(arclightDir, "workflows");
  }

  /** scriptHash：M3 resume 缓存键的一半（另一半是 args，spec §7）。取全 64 位 hex 防碰撞误命中。 */
  static hashScript(source: string): string {
    return createHash("sha256").update(source, "utf8").digest("hex");
  }

  private assertName(name: string): void {
    if (!WORKFLOW_NAME_RE.test(name)) {
      throw new Error(`invalid workflow name: ${JSON.stringify(name)}`);
    }
  }

  private pathFor(name: string): string {
    this.assertName(name);
    return join(this.dir, `${name}${SUFFIX}`);
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(SUFFIX))
      .map((f) => f.slice(0, -SUFFIX.length))
      .filter((n) => WORKFLOW_NAME_RE.test(n))
      .sort();
  }

  has(name: string): boolean {
    if (!WORKFLOW_NAME_RE.test(name)) return false;
    return existsSync(join(this.dir, `${name}${SUFFIX}`));
  }

  load(name: string): LoadedWorkflow {
    const path = this.pathFor(name);
    if (!existsSync(path)) throw new Error(`no such workflow: ${name}`);
    const source = readFileSync(path, "utf8");
    return { name, source, scriptHash: WorkflowStore.hashScript(source) };
  }

  /** 原子保存：写临时文件后 rename，避免并发/崩溃留半截文件。 */
  save(name: string, source: string): { name: string; scriptHash: string } {
    const path = this.pathFor(name);
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("workflow source must be a non-empty string");
    }
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${name}.${randomUUID()}.tmp`);
    writeFileSync(tmp, source, "utf8");
    renameSync(tmp, path);
    return { name, scriptHash: WorkflowStore.hashScript(source) };
  }
}

/**
 * 命名 vs 临场合成判定（spec §1/§3）——M5 的解析唯一收口点；M6 公开 runWorkflow 复用之。
 * - slug 形（单 token，匹配 WORKFLOW_NAME_RE）→ 视为命名 workflow，从 store 载入；
 *   不存在则抛错（不把裸标识符当脚本跑，安全优先）。
 * - 其余（含 `(`/`;`/换行的合成脚本）→ 视为临场生成的内联源码，原样返回。
 */
export function resolveWorkflowSource(scriptOrName: string, store: WorkflowStore): string {
  const candidate = scriptOrName.trim();
  if (WORKFLOW_NAME_RE.test(candidate)) {
    if (!store.has(candidate)) throw new Error(`no such named workflow: ${candidate}`);
    return store.load(candidate).source;
  }
  return scriptOrName;
}
```

跑测（应绿）+ 质量门：

```bash
bun test packages/core/src/workflow/__tests__/store.test.ts   # 预期: 7 pass, 0 fail
bun run typecheck                                              # tsc --noEmit，0 error（含 implements WorkflowStorePort 校验）
bun run check                                                  # biome check .，0 error
```

#### 1.3 提交

```bash
git add packages/core/src/workflow/store.ts packages/core/src/workflow/__tests__/store.test.ts
git commit -m "feat(core/workflow): WorkflowStore + resolveWorkflowSource — 命名持久层 + 命名/合成解析

里程碑 M5 Task 1。WorkflowStore implements M0 WorkflowStorePort（LoadedWorkflow import 自 ./types，
不本地重声明）。slug 正则收口 name(spec §10)，原子 rename 保存，sha256 全 64 位 scriptHash 供
M3 resume 缓存键(spec §7)，覆盖量子 gate-circuit.workflow.js(spec §11)。resolveWorkflowSource：
slug 形载命名脚本、其余作内联合成源码、slug 未命中即抛(安全默认)——M6 公开 runWorkflow 复用此解析。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2 — `index.ts` 追加导出：M5 公开面 + 命名/合成解析单测

覆盖 spec §3（`index.ts` 暴露 store + 解析；公开 `runWorkflow(scriptOrName, args, ctx: WorkflowContext)` 入口在 M6 由 `resolveWorkflowSource` + `createWorkflowRuntime` 组合）、§1/§12.5（临场生成 + 命名复用）。

> **index.ts 纪律（M0）**：append-only。M5 只**追加**自己的导出，**不删除/不覆盖** M1–M4 已有导出；若上游里程碑已 re-export 下列某类型，**去重保留单一导出**即可。公开入口的最终汇总（`runWorkflow` / `createWorkflowRuntime`）在 M6。

#### 2.1 失败测试在先

新建 `packages/core/src/workflow/__tests__/index.test.ts`（验证 M5 公开面与解析行为；通过 `../index` 公开面 import，顺带校验 append-only 再导出可达）：

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkflowSource, WorkflowStore } from "../index";

const dirs: string[] = [];
function freshStore(): WorkflowStore {
  const d = mkdtempSync(join(tmpdir(), "wf-idx-"));
  dirs.push(d);
  return new WorkflowStore(d);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveWorkflowSource：命名 vs 临场合成判定（spec §1, §3）", () => {
  test("slug 形且已存 → 载入命名源码", () => {
    const store = freshStore();
    store.save("gate-circuit", "await agent('q');");
    expect(resolveWorkflowSource("gate-circuit", store)).toBe("await agent('q');");
  });

  test("含语法符号的内联脚本 → 原样作临场合成源码", () => {
    const store = freshStore();
    const inline = "phase('x');\nconst r = await agent('hi');\nreturn r;";
    expect(resolveWorkflowSource(inline, store)).toBe(inline);
  });

  test("slug 形但未存 → 抛错（不把裸标识符当脚本跑，安全优先）", () => {
    const store = freshStore();
    expect(() => resolveWorkflowSource("missing-flow", store)).toThrow(/no such named workflow/);
  });
});
```

跑测（应红）：

```bash
bun test packages/core/src/workflow/__tests__/index.test.ts
```

预期红态：`index.ts` 已由 M1–M4 创建/追加，但尚无 M5 导出 → `resolveWorkflowSource` 解析为 `undefined`，调用即 `TypeError: resolveWorkflowSource is not a function`（`0 pass`）。（若上游里程碑尚未创建 `index.ts`，则红态为 `Cannot find module '../index'`——两者皆为有效 RED，实现后转绿。）

#### 2.2 实现

编辑 `packages/core/src/workflow/index.ts`，在**文件末尾追加** M5 导出块（**保留 M1–M4 既有行不动**；如与上游 re-export 重复则去重）：

```ts
// ── M5：命名 workflow 持久层 + 命名/临场合成解析（spec §3） ──
export { resolveWorkflowSource, WORKFLOW_NAME_RE, WorkflowStore } from "./store";

// M5 公开面消费的共享类型（M0 唯一权威）。若上游里程碑已 re-export，去重保留单一导出。
// 注：公开入口 runWorkflow(scriptOrName, args, ctx: WorkflowContext) 与 createWorkflowRuntime
//     由 M6 追加导出——M6 实现体为 createWorkflowRuntime(ctx).execute(resolveWorkflowSource(...), args)。
export type {
  LoadedWorkflow,
  WorkflowContext,
  WorkflowResult,
  WorkflowRuntime,
  WorkflowStorePort,
} from "./types";
```

> 若当前仓库尚无 `index.ts`（早期里程碑未建），按 append-only 语义新建此文件并仅含上述 M5 块；M6 汇总时再补 `runtime`/公开入口导出。**M5 不创建 `WorkflowResult`/`WorkflowRuntime`/`WorkflowContext` 的本地定义**——它们已在 `./types`（M0）。

跑测（应绿）+ 质量门：

```bash
bun test packages/core/src/workflow/__tests__/index.test.ts   # 预期: 3 pass, 0 fail
bun run typecheck
bun run check
```

#### 2.3 提交

```bash
git add packages/core/src/workflow/index.ts packages/core/src/workflow/__tests__/index.test.ts
git commit -m "feat(core/workflow): index 追加 M5 公开面（store + 命名/合成解析）

里程碑 M5 Task 2。append-only 追加 WorkflowStore/WORKFLOW_NAME_RE/resolveWorkflowSource 与
共享类型再导出(LoadedWorkflow/WorkflowResult/WorkflowRuntime/WorkflowContext/WorkflowStorePort，
均自 M0 ./types)。公开入口 runWorkflow 与 createWorkflowRuntime 由 M6 汇总，不在 M5 重复定义。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3 — `run_workflow` 工具：主 agent 临场生成入口 + 注入接缝

覆盖 spec §1/§12.5（主 agent 临场生成脚本入口、命名复用）、§14（动态合成脚本执行）、§10/§1（防 >1 层嵌套：本工具非 auto-allow、须排除于子 agent 受限集）。

工具靠 `makeExecuteTool` 注入 `workflows:{store,runtime}`（仿 `sandbox`/`artifacts` 既有注入式，registry 仅 3 处最小 diff，loop 零改动）。注入的 `runtime` 是**已构造好的 `WorkflowRuntime` 实例**（M0 契约的两参 `execute(source, args)`），由 M6 `createWorkflowRuntime(ctx)` 产出并在生产接线处注入；M5 单测以**假 runtime** 端到端验证。

> **契约对齐**：`WorkflowRuntime.execute` 两参（无 ctx）；终态 `interrupted`（非 `cancelled`）；解析/保存失败归一 `VALIDATION`，runtime 抛出的 run-fatal（abort/budget/backstop）**不被吞成 VALIDATION**——交由 registry 壳归类（abort→`CANCELLED`、其余→`EXEC_FAILED`）。

#### 3.1 失败测试在先

新建 `packages/core/src/tools/__tests__/runWorkflow.test.ts`（import 顺序已按 biome `organizeImports` 规整：`import type` 行先于同模块值 import；`../builtin/runWorkflow` 先于 `../registry`）：

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@arclight/protocol";
import type { LoopToolContext } from "../../loop/types";
import type { WorkflowResult, WorkflowRuntime } from "../../workflow";
import { WorkflowStore } from "../../workflow";
import { RUN_WORKFLOW_TOOL_NAME, runWorkflowTool } from "../builtin/runWorkflow";
import { makeExecuteTool } from "../registry";

const tool = runWorkflowTool as unknown as Tool<unknown, unknown>;

const dirs: string[] = [];
function freshStore(): WorkflowStore {
  const d = mkdtempSync(join(tmpdir(), "wf-tool-"));
  dirs.push(d);
  return new WorkflowStore(d);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 假 runtime：M0 契约的两参 execute(source, args)。
function spyRuntime() {
  const calls: { source: string; args: unknown }[] = [];
  const runtime: WorkflowRuntime = {
    execute(source, args): Promise<WorkflowResult> {
      calls.push({ source, args });
      return Promise.resolve({ status: "completed", output: { ran: source } });
    },
  };
  return { runtime, calls };
}

function ctx(signal: AbortSignal): LoopToolContext {
  return { sessionId: "s", turnId: "t", callId: "c", cwd: "/tmp", signal, emitProgress: () => {} };
}

describe("run_workflow 工具：临场合成入口（spec §1/§12.5/§14）", () => {
  test("meta 非 safe/read → classify 永不 auto-allow（防子 agent 静默自起 workflow，§10/§1）", () => {
    expect(runWorkflowTool.meta.name).toBe(RUN_WORKFLOW_TOOL_NAME);
    expect(runWorkflowTool.meta.isReadOnly).toBe(false);
    expect(runWorkflowTool.meta.riskTier).not.toBe("safe");
    expect(runWorkflowTool.meta.executesShellCommands).toBe(false);
  });

  test("inline script → 经 makeExecuteTool 注入 workflows，runtime 收到内联源码", async () => {
    const { runtime, calls } = spyRuntime();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, runtime } });
    const out = await execute(
      tool,
      { script: "await agent('synth'); return 1;", args: { seed: 1 } },
      ctx(new AbortController().signal),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.preview).toContain("completed");
    expect(calls[0]?.source).toBe("await agent('synth'); return 1;");
    expect(calls[0]?.args).toEqual({ seed: 1 });
  });

  test("script + saveAs → 先持久化再运行（命名复用）", async () => {
    const { runtime } = spyRuntime();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, runtime } });
    await execute(tool, { script: "return 42;", saveAs: "kept-flow" }, ctx(new AbortController().signal));
    expect(store.has("kept-flow")).toBe(true);
    expect(store.load("kept-flow").source).toBe("return 42;");
  });

  test("name 指定已存 workflow → runtime 收到存储源码", async () => {
    const { runtime, calls } = spyRuntime();
    const store = freshStore();
    store.save("gate-circuit", "STORED_SRC");
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, runtime } });
    await execute(tool, { name: "gate-circuit" }, ctx(new AbortController().signal));
    expect(calls[0]?.source).toBe("STORED_SRC");
  });

  test("name 不存在 → VALIDATION envelope（可重试，LLM 改入参）", async () => {
    const { runtime } = spyRuntime();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, runtime } });
    const out = await execute(tool, { name: "ghost" }, ctx(new AbortController().signal));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.envelope.error_class).toBe("VALIDATION");
      expect(out.envelope.retry_allowed).toBe(true);
    }
  });

  test("同时给 name 和 script → schema refine 拒绝（VALIDATION）", async () => {
    const { runtime } = spyRuntime();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, runtime } });
    const out = await execute(
      tool,
      { name: "a", script: "return 1;" },
      ctx(new AbortController().signal),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.envelope.error_class).toBe("VALIDATION");
  });

  test("未注入 workflows → INTERNAL envelope", async () => {
    const execute = makeExecuteTool({ sandbox: {} as never }); // 无 workflows
    const out = await execute(tool, { script: "return 1;" }, ctx(new AbortController().signal));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.envelope.error_class).toBe("INTERNAL");
  });
});
```

跑测（应红）：

```bash
bun test packages/core/src/tools/__tests__/runWorkflow.test.ts
```

预期红态：`error: Cannot find module '../builtin/runWorkflow'`（`0 pass`）——工具与注入接缝均未落地。

#### 3.2 实现

**(a) `packages/core/src/tools/registry.ts` 三处最小 diff：**

新增 type-only 导入。**置于现有 import 块末尾**——`../workflow` 按路径字母序排在 `../sandbox/service` 之后（biome `organizeImports` 要求；已实测此位置 0 error）。注意是 type 导入：`WorkflowStore` 为类但仅作类型位、`WorkflowRuntime` 来自 M0 `./types`——运行时无耦合、无循环、被 erase：

```ts
import type { WorkflowRuntime, WorkflowStore } from "../workflow";
```

扩展 `CoreToolContext`：

```ts
// 改前
export type CoreToolContext = LoopToolContext & { sandbox: SandboxService };

// 改后
export type CoreToolContext = LoopToolContext & {
  sandbox: SandboxService;
  // 注入式 workflow 运行器（M5）：仅主 agent 的 run_workflow 工具消费；子 agent 受限集不含本工具。
  // runtime 为 M0 契约的 WorkflowRuntime 实例（两参 execute），由 M6 createWorkflowRuntime 产出。
  workflows?: { store: WorkflowStore; runtime: WorkflowRuntime };
};
```

扩展 `makeExecuteTool` deps + `coreCtx` 透传：

```ts
// 改前
export function makeExecuteTool(deps: {
  sandbox: SandboxService;
  artifacts?: ArtifactStore;
}): LoopDeps["executeTool"] {

// 改后
export function makeExecuteTool(deps: {
  sandbox: SandboxService;
  artifacts?: ArtifactStore;
  workflows?: { store: WorkflowStore; runtime: WorkflowRuntime };
}): LoopDeps["executeTool"] {
```

```ts
// 改前
    const coreCtx: CoreToolContext = { ...ctx, sandbox: deps.sandbox };

// 改后
    const coreCtx: CoreToolContext = { ...ctx, sandbox: deps.sandbox, workflows: deps.workflows };
```

**(b) 新建 `packages/core/src/tools/builtin/runWorkflow.ts`（import 顺序：同模块 `import type` 先于值 import）：**

```ts
import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import type { WorkflowResult } from "../../workflow";
import { resolveWorkflowSource } from "../../workflow";
import { type CoreToolContext, ToolExecError } from "../registry";

export const RUN_WORKFLOW_TOOL_NAME = "run_workflow";

// 恰好二选一：name(跑已存 workflow) | script(临场合成内联源码)；saveAs 仅在 script 下命名复用。
const Input = z
  .object({
    name: z.string().min(1).optional(),
    script: z.string().min(1).optional(),
    saveAs: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => (v.name === undefined) !== (v.script === undefined), {
    message: "provide exactly one of `name` or `script`",
  })
  .refine((v) => v.saveAs === undefined || v.script !== undefined, {
    message: "`saveAs` requires `script`",
  });

// 终态词表对齐 M0：completed | failed | interrupted（无 cancelled）。
const Output = z.object({
  status: z.enum(["completed", "failed", "interrupted"]),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export const runWorkflowTool: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  meta: {
    name: RUN_WORKFLOW_TOOL_NAME,
    description:
      "Run a multi-agent workflow. Provide `script` with inline workflow source to synthesize one on the fly (optionally `saveAs` to persist it for reuse), or `name` to run a saved workflow. Put any timestamps/seeds in `args` — Date.now/Math.random are stubbed inside workflows. Sub-agents run in isolated contexts; their risky tool calls surface their own approval prompts.",
    isReadOnly: false,
    isConcurrencySafe: false,
    executesShellCommands: false, // 自身不执行 shell；子 agent 的 shell 调用各自走黑名单+审批
    mutatesWorkspace: true, // 子 agent 可写工作区 → query-loop 据此打影子 git 检查点
    riskTier: "confirm", // 非 safe → classify 永不 auto-allow（防子 agent 静默自起 workflow，spec §10/§1）
    riskClass: "write",
    timeoutMs: 30 * 60_000, // 编排可长跑；内部各 subagent 另有自身超时
    maxResultSizeBytes: 512 * 1024,
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx): Promise<WorkflowResult> {
    const c = ctx as unknown as CoreToolContext;
    if (!c.workflows) {
      throw new ToolExecError("workflow runner not configured", "INTERNAL", false);
    }
    const { store, runtime } = c.workflows;

    // 解析阶段：命名不存在 / 非法名 / 保存失败 → 归一为 VALIDATION（可重试：LLM 改入参后再试）。
    let source: string;
    try {
      if (input.script !== undefined) {
        if (input.saveAs !== undefined) store.save(input.saveAs, input.script);
        source = input.script;
      } else {
        // refine 保证 name/script 恰一个存在；name 必为 slug 且须已存（resolveWorkflowSource 收口）。
        source = resolveWorkflowSource(input.name as string, store);
      }
    } catch (e) {
      throw new ToolExecError(
        e instanceof Error ? e.message : "invalid workflow request",
        "VALIDATION",
        true,
      );
    }

    // 执行阶段：runtime 抛出的 run-fatal（abort/budget/backstop）不被吞成 VALIDATION——
    // 交由 registry 壳归类（signal.aborted→CANCELLED、其余→EXEC_FAILED）。
    return runtime.execute(source, input.args ?? {});
  },
  toModelOutput: (out) =>
    out.status === "completed"
      ? `workflow completed: ${JSON.stringify(out.output ?? null)}`
      : `workflow ${out.status}${out.error ? `: ${out.error}` : ""}`,
};
```

> **类型自洽说明**：`execute` 声明返回 `Promise<WorkflowResult>`，而工具泛型 `Out = z.infer<typeof Output>` = `{ status: "completed"|"failed"|"interrupted"; output?: unknown; error?: string }`，与 `WorkflowResult`（`{ status: RunStatus; output?: unknown; error?: string }`，`RunStatus` 同此并集）结构等价——故 `Promise<WorkflowResult>` 可赋值给 `Tool<In, Out>` 要求的 `Promise<Out>`，`tsc --noEmit` 0 error。

跑测（应绿）+ 质量门：

```bash
bun test packages/core/src/tools/__tests__/runWorkflow.test.ts   # 预期: 7 pass, 0 fail
bun run typecheck                                                # 验证 registry 注入接缝类型自洽
bun run check                                                    # biome check .，0 error（import 顺序已规整）
```

#### 3.3 提交

```bash
git add packages/core/src/tools/registry.ts \
        packages/core/src/tools/builtin/runWorkflow.ts \
        packages/core/src/tools/__tests__/runWorkflow.test.ts
git commit -m "feat(core/tools): run_workflow 工具 — 主 agent 临场生成/命名复用入口

里程碑 M5 Task 3。makeExecuteTool 注入 workflows:{store,runtime}(仿 sandbox/artifacts)，
loop 零改动；runtime 为 M0 契约 WorkflowRuntime 实例(两参 execute(source,args))，M6 createWorkflowRuntime 产出。
confirm 风险位 → 永不 auto-allow，防子 agent 静默自起 workflow(spec §10/§1)。script|name 二选一，
saveAs 命名复用。解析/保存失败归一 VALIDATION；runtime 抛出的 run-fatal 不被吞，交 registry 壳分类。
终态对齐 M0：completed|failed|interrupted(无 cancelled)。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

#### 3.4 生产接线（移交 M6，**不在 M5 改 `serve.ts`**）

> **为何移交 M6**：生产环境注入的 `runtime` 须由 `createWorkflowRuntime(ctx: WorkflowContext)` 产出，而 `createWorkflowRuntime` 是 **M6 deliverable**（依赖链 M5→M6）。M5 早于 M6，**不能前向 import 尚不存在的 `./runtime`**——否则 `serve.ts` 的 `bun run typecheck` 直接红，破坏 M5 出口门。故 M5 只交付**可独立单测**的三块（store / resolveWorkflowSource / `run_workflow` 工具 + 注入接缝），生产接线留给 M6 一并完成。
>
> M6 在 `serve.ts` 落地时的接线形态（**此处仅为 M6 参考，不在 M5 执行**；import 顺序亦已按 biome `organizeImports` 合并/规整）：

```ts
// —— 以下为 M6 接线参考 ——
import { runWorkflowTool } from "./tools/builtin/runWorkflow";
import { createWorkflowRuntime, WorkflowStore } from "./workflow"; // createWorkflowRuntime 为 M6 追加导出（runtime.ts）

// registry：追加注册（保持既有 `as never` 风格）
const registry = new ToolRegistry()
  .register(readFileTool as never)
  .register(writeFileTool as never)
  .register(applyPatchTool as never)
  .register(bashTool as never)
  .register(runWorkflowTool as never); // M5 工具，M6 接线

const workflowStore = new WorkflowStore(arclightDir);
// createWorkflowRuntime 捕获 WorkflowContext（callProvider/registry/approvals/executeTool/emit/
// store/journal/signal 等）——其按 run 绑定 signal 的形态由 M6 runtime.ts 落地为准。
const workflowRuntime = createWorkflowRuntime({
  /* WorkflowContext：M1/M2/M3/M4 已就绪依赖，由 M6 装配 */
});

const runner = new AgentRunner({
  // ...既有字段不变...
  executeTool: makeExecuteTool({
    sandbox,
    artifacts: new ArtifactStore(db, arclightDir),
    workflows: { store: workflowStore, runtime: workflowRuntime }, // 注入接缝（M5 提供，M6 填值）
  }),
});
```

> **嵌套防护提醒（spec §1/§10）**：子 agent 的受限工具集（M1 `subagent.ts` 经 `RestrictedToolRegistry` 裁剪）**不得包含 `run_workflow`**——`workflow()` 一层嵌套由 M6 的 in-guest 原语提供，工具层不再开第二条入口。即便误纳入，本工具 `confirm` 风险位也会触发 `permission.ask` 冒泡给用户（spec §9），构成纵深防护。

---

### 里程碑出口校验

```bash
bun test packages/core/src/workflow/__tests__/store.test.ts   # 7 pass
bun test packages/core/src/workflow/__tests__/index.test.ts   # 3 pass
bun test packages/core/src/tools/__tests__/runWorkflow.test.ts # 7 pass
bun test packages/core tests   # 全量 core 套件：M5 三组测试 + 既有套件全绿（含 registry 注入接缝回归）
bun run typecheck              # tsc --noEmit，0 error（注：M5 不前向 import M6 ./runtime，typecheck 自洽）
bun run check                  # biome check .，0 error（含 organizeImports：同模块 import type 先于值 import、模块按路径序）
```

### spec 覆盖对照

| spec 条款 | 要求 | M5 落点 |
|---|---|---|
| §3 `store.ts` | 命名 workflow 加载/保存/解析 | T1 `WorkflowStore`(implements M0 `WorkflowStorePort`) + `resolveWorkflowSource` |
| §3 `index.ts` | 暴露 store + 解析（公开 `runWorkflow` 入口在 M6 汇总） | T2 append-only 导出；`runWorkflow(scriptOrName,args,ctx:WorkflowContext)`=M6 组合 `resolveWorkflowSource`+`createWorkflowRuntime` |
| §1/§12.5 | 临场生成 + 命名复用入口 | T1 `resolveWorkflowSource` + T3 `run_workflow`(script/name/saveAs) |
| §14 store 测试 | 命名加载/保存 + 动态合成脚本执行 | T1/T2/T3 全套（假 runtime 端到端） |
| §11 量子 | `gate-circuit.workflow.js` 命名加载 | T1 §11 测试 |
| §4 `workflow()` 原语 | 内联子 workflow 读 store（一层） | store 供 **M6** `primitives.ts` 的 `workflow()` 绑定消费（接线提醒已注明排除工具层二级入口） |
| §7 resume | scriptHash 缓存键 | T1 `WorkflowStore.hashScript`（全 64 位 sha256） |
| §10 安全 | name 收口、工具非 auto-allow | T1 slug 正则 + T3 `confirm` 风险位 |
| §2.1 asyncify | 不违反单挂起 | M5 全程宿主侧、无 guest 再入（范围纪律已声明） |
| M0 契约 | 共享类型 import 自 `./types`；`WorkflowRuntime` 两参；状态 `interrupted` | T1/T2/T3 全程：`LoadedWorkflow`/`WorkflowResult`/`WorkflowRuntime`/`WorkflowContext`/`WorkflowStorePort` 均 import；`execute(source,args)` 两参；Output 枚举 `interrupted` |
</content>
</invoke>

---

## 里程碑 M6：运行时集成

> 关联 spec：`docs/superpowers/specs/2026-06-16-workflow-infrastructure-design.md` §3（模块布局 / 公开入口 `runWorkflow(scriptOrName,args,ctx)`）/ §4（原语全集，注入 guest）/ §6（调度 + provider 限流 + token budget + sandbox 隔离）/ §7（journal/resume 确定性前提：`Date.now`/`Math.random`/无参 `new Date()` 桩、时间/种子经 args 注入）/ §10（失败/中断/安全）/ §11（量子消费者）/ §12（依赖链 `M0→M1→M2→M3/M4→M5→M6`，M6 收口）。
>
> **里程碑定位（缝合所有孤岛，闭合两处致命缺口）**：M0–M5 各自交付了**就绪但未接线**的孤岛——M1 的 `runWorkflowScript`/`runSubagent` + parallel/pipeline/workflow **抛错桩** + budget **no-op**；M2 的 `Scheduler`/`TokenBudget`/`makeParallel`/`makePipeline`/`SharedRateLimiter`；M3 的 `WorkflowJournalService`/`makeJournaledRun`/`ResumePlanner`；M4 的 `WorkflowEvents`/`BubblingApprovalSeam`/`deriveChildSignal`/`terminalEvent`；M5 的 `WorkflowStore`/`resolveWorkflowSource`/`run_workflow` 工具。本里程碑把它们**装配成一个真实可跑的运行时**，并闭合两处致命缺口：
> - **F1 — guest 原语注入未接线**：M1 `primitives.ts` 里 `parallel`/`pipeline`/`workflow` 是 `notUntilM6` 抛错桩、`budget` 是 no-op；M1 `runtime.ts` 的 PRELUDE 只绑 `agent`/`log`/`phase`/`args` 四个 guest 全局。**结果：guest 脚本里 `await parallel([...])` 根本无法跑——原语装配与 guest 注入两层都缺**。
> - **F2 — 集成运行时不存在**：无 `createWorkflowRuntime(ctx)` 把 M1 runtime/runSubagent + M2 scheduler/budget + M3 journal/resume + M4 events/审批/中断**组合成一次 run**；M0 的 `WorkflowRuntime`/公开 `runWorkflow` 仅是契约签名，**实现体一直空缺**（M5 显式移交 M6）。
>
> **共享类型纪律（M0 唯一权威）**：`WorkflowContext` / `WorkflowRuntime` / `WorkflowResult` / `RunStatus` / `AgentSpec` / `StageSpec` / `SpecResult` / `SubagentResult` / `RunSubagent` / `Budget` / `CallKind` / `WorkflowApiError` / `JsonSchema` 等**一律 `import` 自 `./types`**（兄弟模块 `from "./types"`，`__tests__` `from "../types"`）。M6 对 `types.ts` 的**唯一改动**是**追加一个可选字段** `WorkflowContext.onUsage?`（见 Task 3，additive、向后兼容、用既有已 import 的 `LoopDeps["onUsage"]` 投影类型）——不重声明、不改既有字段。
>
> **§2.1 asyncify 单挂起铁律（贯穿 F1）**：`parallel`/`pipeline`/`workflow` 在 guest 侧各是**一次** async 调用 → wasm 挂起一次 → 宿主侧 `Promise.all`/scheduler 并发跑完 → **一次性** JSON 回灌 → guest 恢复。宿主收**可序列化规格**（非 guest 闭包，M0 `validateAgentSpec` 守卫），挂起期**绝不回调 guest**。所有跨界仍只走「字符串」（guest 内 `JSON` 编解码，宿主 `newString/getString`），与 M1 `__agent` 同款。
>
> **里程碑边界**：M6 改 `runtime.ts`（PRELUDE/installPrimitives 扩展 + `createWorkflowRuntime`/`runWorkflow`）、`primitives.ts`（`makeWorkflowPrimitives` 接 wiring）、`subagent.ts`（`onUsage` 穿透）、`types.ts`（追加 `onUsage?`）、`index.ts`（汇总全部导出，**唯一权威**）、`tools/registry.ts` + `tools/builtin/runWorkflow.ts`（生产注入接缝 reconcile）、`serve.ts`（生产接线，承接 M5 §3.4）。**不改** M2 `scheduler.ts` / M3 `journal-service.ts`/`resume.ts`/`journaled-run.ts` / M4 `events.ts`/`bubbling-approval.ts`/`interrupt.ts` 的实现体（只消费其导出）。
>
> **开工前**（当前在默认分支 `master`，先切工作分支）：
> ```bash
> git switch -c feat/workflow-m6-runtime-integration
> ```
> 测试运行器：`packages/core` 用 `bun:test`（`vitest.config.ts` 排除 core）；`packages/protocol` 用 vitest（M6 不碰）。测试置于 `packages/core/src/workflow/__tests__/` 与 `packages/core/src/tools/__tests__/`。

---

## Task 1：F1-a — 扩展 runtime.ts PRELUDE + installPrimitives（guest 绑定 parallel/pipeline/workflow/budget + 无参 `new Date()` 桩）

**交付**：在 M1 `runtime.ts` 基础上，把 PRELUDE 从「只绑 4 个 guest 全局」扩展到「绑 M0 `WorkflowPrimitives` 全集 8 项」——新增 `__parallel`/`__pipeline`/`__workflow` 的 `newAsyncifiedFunction` 绑定（各一次挂起、JSON 进/出）+ `budget` 同步全局（`{ total, spent(), remaining() }`，由 `__budgetTotal`/`__budgetSpent`/`__budgetRemaining` 宿主桥接）；并把 spec §7 的确定性桩补全：**无参 `new Date()`** 桩为抛错（`new Date(ms)` 仍可用，时间经 `args` 注入）。本 Task 只接线 PRELUDE 与 `installPrimitives`——原语真实实现（`makeParallel` 装配）在 Task 2，故此处用 M1 风格 `stubPrimitives` 注入即可验证绑定通路。

### 1.1 RED — 先写失败测试

新建 `packages/core/src/workflow/__tests__/runtime-primitives.test.ts`：
```ts
import { describe, expect, test } from "bun:test";
import { runWorkflowScript } from "../runtime";
import type { WorkflowPrimitives } from "../types";

function stubPrimitives(over: Partial<WorkflowPrimitives> = {}): WorkflowPrimitives {
  return {
    args: over.args ?? {},
    agent: over.agent ?? (async () => "stub"),
    log: over.log ?? (() => {}),
    phase: over.phase ?? (() => {}),
    parallel: over.parallel ?? (async () => []),
    pipeline: over.pipeline ?? (async () => []),
    workflow: over.workflow ?? (async () => null),
    budget: over.budget ?? { total: 0, spent: () => 0, remaining: () => 0 },
  };
}

describe("M6 F1-a：guest 全集绑定（parallel/pipeline/workflow/budget）", () => {
  test("四个新原语 + budget 全局在 guest 内可见且类型正确", async () => {
    const res = await runWorkflowScript(
      `JSON.stringify({
         parallel: typeof parallel,
         pipeline: typeof pipeline,
         workflow: typeof workflow,
         budget: typeof budget,
         total: budget.total,
         remaining: budget.remaining(),
       })`,
      stubPrimitives({ budget: { total: 42, spent: () => 35, remaining: () => 7 } }),
    );
    expect(res.status).toBe("completed");
    expect(JSON.parse((res as { output: string }).output)).toEqual({
      parallel: "function",
      pipeline: "function",
      workflow: "function",
      budget: "object",
      total: 42,
      remaining: 7,
    });
  });

  test("await parallel([...]) 经 __parallel 一次挂起，规格 JSON 进、结果 JSON 出", async () => {
    const seen: unknown[] = [];
    const res = await runWorkflowScript(
      `const rs = await parallel([{ prompt: "a" }, { prompt: "b" }]); rs.join(",")`,
      stubPrimitives({
        parallel: async (specs) => {
          seen.push(specs);
          return specs.map((s) => s.prompt.toUpperCase());
        },
      }),
    );
    expect(res).toEqual({ status: "completed", output: "A,B" });
    expect(seen).toEqual([[{ prompt: "a" }, { prompt: "b" }]]); // 宿主收到的是可序列化规格
  });

  test("await pipeline(items, ...stages) 经 __pipeline 一次挂起（items+stages 同帧 marshal）", async () => {
    const res = await runWorkflowScript(
      `const rs = await pipeline(["x", "y"], { prompt: "s1-\${item}" }, { prompt: "s2" }); rs.length`,
      stubPrimitives({
        pipeline: async (items, ...stages) => items.map((_, i) => `${(items as string[])[i]}#${stages.length}`),
      }),
    );
    expect(res).toEqual({ status: "completed", output: 2 });
  });

  test("await workflow(name, args) 经 __workflow 一次挂起（name + args JSON）", async () => {
    const res = await runWorkflowScript(
      `const r = await workflow("child", { n: 1 }); JSON.stringify(r)`,
      stubPrimitives({ workflow: async (name, a) => ({ name, a }) }),
    );
    expect(res.status).toBe("completed");
    expect(JSON.parse((res as { output: string }).output)).toEqual({ name: "child", a: { n: 1 } });
  });

  test("无参 new Date() 抛错；new Date(args.now) 可用（spec §7 确定性源经 args 注入）", async () => {
    const guarded = await runWorkflowScript(
      `(() => { try { new Date(); return "no-throw"; } catch (e) { return String(e.message); } })()`,
      stubPrimitives(),
    );
    expect(guarded.status).toBe("completed");
    expect((guarded as { output: string }).output).toContain("new Date()");

    const fromArgs = await runWorkflowScript(
      `new Date(args.now).getTime()`,
      stubPrimitives({ args: { now: 1_700_000_000_000 } }),
    );
    expect(fromArgs).toEqual({ status: "completed", output: 1_700_000_000_000 });
  });

  test("回归：Date.now / Math.random 仍被桩抛错（M1 不破）", async () => {
    const d = await runWorkflowScript(`Date.now()`, stubPrimitives());
    expect(d.status).toBe("failed");
    expect((d as { error: string }).error).toContain("Date.now");
    const r = await runWorkflowScript(`Math.random()`, stubPrimitives());
    expect(r.status).toBe("failed");
    expect((r as { error: string }).error).toContain("Math.random");
  });
});
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/runtime-primitives.test.ts
```
预期失败：`parallel`/`pipeline`/`workflow`/`budget` 在 guest 内为 `undefined`（PRELUDE 未绑），相关断言红；`new Date()` 不抛（M1 只桩 `Date.now`）。

### 1.2 GREEN — 扩展 `runtime.ts`

对 `packages/core/src/workflow/runtime.ts` 两处改动。

**(a) PRELUDE**：在 M1 PRELUDE 基础上追加 `parallel`/`pipeline`/`workflow`/`budget` 的 guest 包装 + 无参 `Date()` 守卫（Proxy 保留静态方法与 `new Date(ms)`）。改后 `PRELUDE` 常量为：
```ts
const PRELUDE = `
globalThis.args = JSON.parse(__argsJson);
globalThis.log = (m) => { __log(String(m)); };
globalThis.phase = (t) => { __phase(String(t)); };
globalThis.agent = async (prompt, opts) =>
  JSON.parse(await __agent(String(prompt), JSON.stringify(opts === undefined ? null : opts)));
globalThis.parallel = async (specs) =>
  JSON.parse(await __parallel(JSON.stringify(specs === undefined ? [] : specs)));
globalThis.pipeline = async (items, ...stages) =>
  JSON.parse(await __pipeline(JSON.stringify({ items: items === undefined ? [] : items, stages })));
globalThis.workflow = async (name, wfArgs) =>
  JSON.parse(await __workflow(String(name), JSON.stringify(wfArgs === undefined ? null : wfArgs)));
globalThis.budget = Object.freeze({
  total: __budgetTotal,
  spent: () => __budgetSpent(),
  remaining: () => __budgetRemaining(),
});
const __NativeDate = Date;
globalThis.Date = new Proxy(__NativeDate, {
  apply() { throw new Error("Date() as a function is forbidden in workflow scripts; pass time via args"); },
  construct(target, a) {
    if (a.length === 0) {
      throw new Error("new Date() with no args is forbidden in workflow scripts; pass time via args");
    }
    return Reflect.construct(target, a);
  },
});
globalThis.Date.now = () => { throw new Error("Date.now() is forbidden in workflow scripts; pass time via args"); };
Math.random = () => { throw new Error("Math.random() is forbidden in workflow scripts; pass a seed via args"); };
`;
```
> 注：`globalThis.Date.now = ...` 经 Proxy 默认 `set` 落到 target，覆盖原生 `Date.now`，与 M1 行为一致；`Date.UTC`/`Date.parse` 经 `get` 透传仍可用；`new Date(ms)` 经 `construct`（`a.length>0`）正常构造。QuickJS-ng(ES2023) 支持 `Proxy`/`Reflect`。

**(b) installPrimitives**：在 M1 绑定 `__log`/`__phase`/`__agent` 之后，追加 `__parallel`/`__pipeline`/`__workflow`（`newAsyncifiedFunction`，与 `__agent` 同款单挂起）与 `__budgetTotal`（数值）+ `__budgetSpent`/`__budgetRemaining`（同步函数返回数值）。把这段插入 `agentFn.dispose();` 之后、函数结尾之前。需要在 import 行追加 `StageSpec`：
```ts
// runtime.ts 顶部对 ./types 的 import 追加 AgentSpec/StageSpec（值无关，纯类型）：
import type { AgentSpec, RunScriptResult, StageSpec, WorkflowPrimitives } from "./types";
```
```ts
  // ── M6 F1-a：parallel/pipeline/workflow（各一次 asyncify 挂起，宿主侧 Promise.all 真并发）──
  const parallelFn = context.newAsyncifiedFunction("__parallel", async (specsH) => {
    const specs = JSON.parse(context.getString(specsH)) as AgentSpec[];
    const results = await p.parallel(specs); // 挂起期宿主跑完，绝不回调 guest
    return context.newString(JSON.stringify(results));
  });
  context.setProp(context.global, "__parallel", parallelFn);
  parallelFn.dispose();

  const pipelineFn = context.newAsyncifiedFunction("__pipeline", async (argH) => {
    const { items, stages } = JSON.parse(context.getString(argH)) as {
      items: unknown[];
      stages: StageSpec[];
    };
    const results = await p.pipeline(items, ...stages);
    return context.newString(JSON.stringify(results));
  });
  context.setProp(context.global, "__pipeline", pipelineFn);
  pipelineFn.dispose();

  const workflowFn = context.newAsyncifiedFunction("__workflow", async (nameH, argsH) => {
    const name = context.getString(nameH);
    const argsJson = context.getString(argsH);
    const wfArgs = argsJson === "null" ? undefined : (JSON.parse(argsJson) as unknown);
    const result = await p.workflow(name, wfArgs);
    return context.newString(JSON.stringify(result ?? null));
  });
  context.setProp(context.global, "__workflow", workflowFn);
  workflowFn.dispose();

  // ── M6 F1-a：budget 同步桥接（total 快照 + spent/remaining 实时）──
  const totalH = context.newNumber(p.budget.total);
  context.setProp(context.global, "__budgetTotal", totalH);
  totalH.dispose();
  const spentFn = context.newFunction("__budgetSpent", () => context.newNumber(p.budget.spent()));
  context.setProp(context.global, "__budgetSpent", spentFn);
  spentFn.dispose();
  const remainingFn = context.newFunction("__budgetRemaining", () =>
    context.newNumber(p.budget.remaining()),
  );
  context.setProp(context.global, "__budgetRemaining", remainingFn);
  remainingFn.dispose();
```

### 1.3 VERIFY
```bash
bun test packages/core/src/workflow/__tests__/runtime-primitives.test.ts
bun test packages/core/src/workflow/__tests__/runtime.test.ts   # M1 回归：7 test 仍绿
bun run typecheck
bun run check
```
预期：本套 6 test 全绿；M1 `runtime.test.ts` 不破（仅探测 `agent`/4 宿主全局，新增全局不影响）；类型/lint 干净。

### 1.4 COMMIT
```bash
git add packages/core/src/workflow/runtime.ts \
        packages/core/src/workflow/__tests__/runtime-primitives.test.ts
git commit -m "feat(workflow): M6 F1-a runtime PRELUDE 绑定 parallel/pipeline/workflow/budget + 无参 Date() 桩

guest 全集注入：__parallel/__pipeline/__workflow 各一次 asyncify 挂起（JSON 进出）+
budget 同步桥接；无参 new Date() 桩抛错、时间经 args 注入（spec §7）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2：F1-b — `makeWorkflowPrimitives` 接 wiring，把抛错桩/ no-op 换成真实 makeParallel/makePipeline/workflow/budget（闭合 F1）

**交付**：把 M1 `primitives.ts` 的 `makeWorkflowPrimitives(ctx, args)` 扩展为 `makeWorkflowPrimitives(ctx, args, wiring?)`。`wiring` 缺省（M1 顺序脚本路径）→ `parallel`/`pipeline`/`workflow` 仍是 `notUntilM6` 抛错桩、`budget` 仍 no-op（**M1 既有测试不破**）；`wiring` 提供（M6/生产）→ `parallel` = `makeParallel(scheduler, run)`、`pipeline` = `makePipeline(scheduler, run)`、`workflow` = `wiring.workflow`、`budget` = `wiring.budget`，`agent` 改走 `scheduler.submit` 入池（budget 准入 + journal + 事件由 `wiring.run` 承载）。导出 `PrimitiveWiring` 供 Task 4 装配。**resume 确定性**：`parallel` 在调度前**同步**经 `wiring.bindSeqs` 按规格数组序预分配连续 `seq`（asyncify 安全：规格挂起前已 marshal）。本 Task 用一段真实 guest 脚本 + 真实 `Scheduler` + fake `RunSubagent` 证明 **`await parallel([...specs])` 真能经宿主 `Promise.all` + scheduler 跑通**——F1 闭合。

### 2.1 RED — 先写失败测试

新建 `packages/core/src/workflow/__tests__/primitives-wiring.test.ts`：
```ts
import { describe, expect, test } from "bun:test";
import { makeWorkflowPrimitives, type PrimitiveWiring } from "../primitives";
import { runWorkflowScript } from "../runtime";
import { Scheduler, TokenBudget } from "../scheduler";
import type { AgentSpec, CallKind, RunSubagent } from "../types";
import { makeCtx, scriptedProvider } from "./fixtures";

const liveSignal = () => new AbortController().signal;

// 测试用最小 wiring：run 直接回显 prompt（无 journal/事件，那些在 Task 4 端到端验证）。
function testWiring(run: RunSubagent, total = 1000): PrimitiveWiring {
  return {
    scheduler: new Scheduler({ signal: liveSignal(), maxConcurrent: 4 }),
    run,
    workflow: async (name) => `wf:${name}`,
    budget: new TokenBudget(total),
    bindSeqs: () => {}, // 本 Task 不验 seq 落库（Task 7 e2e 验）
  };
}

describe("M6 F1-b：makeWorkflowPrimitives 接 wiring（闭合 F1）", () => {
  test("guest `await parallel([...specs])` 经真实 Scheduler + 宿主 Promise.all 跑通（保序）", async () => {
    const { provider } = scriptedProvider([]);
    const run: RunSubagent = async (spec) => ({ ok: true, value: spec.prompt.toUpperCase() });
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), { seed: 1 }, testWiring(run));
    const res = await runWorkflowScript(
      `const rs = await parallel([{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }]); rs.join("-")`,
      prims,
    );
    expect(res).toEqual({ status: "completed", output: "A-B-C" });
  });

  test("失败项 → null（subagent 普通失败不拖垮整体，spec §10）", async () => {
    const { provider } = scriptedProvider([]);
    const run: RunSubagent = async (spec) =>
      spec.prompt === "bad"
        ? { ok: false, status: "failed", error: "x" }
        : { ok: true, value: spec.prompt };
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}, testWiring(run));
    const res = await runWorkflowScript(
      `const rs = await parallel([{ prompt: "ok" }, { prompt: "bad" }]); JSON.stringify(rs)`,
      prims,
    );
    expect(res.status).toBe("completed");
    expect(JSON.parse((res as { output: string }).output)).toEqual(["ok", null]);
  });

  test("budget 全局在 guest 内可读（total/remaining）", async () => {
    const { provider } = scriptedProvider([]);
    const run: RunSubagent = async (s) => ({ ok: true, value: s.prompt });
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}, testWiring(run, 500));
    const res = await runWorkflowScript(`budget.total + ":" + budget.remaining()`, prims);
    expect(res).toEqual({ status: "completed", output: "500:500" });
  });

  test("agent() 经 wiring 入池（scheduler.submit）跑通", async () => {
    const { provider } = scriptedProvider([]);
    const run: RunSubagent = async (s) => ({ ok: true, value: `R:${s.prompt}` });
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}, testWiring(run));
    const res = await runWorkflowScript(`await agent("hi")`, prims);
    expect(res).toEqual({ status: "completed", output: "R:hi" });
  });

  test("无 wiring（M1 顺序路径）→ parallel 仍抛错桩 → 归一为 failed", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "t", toolCalls: [], finishReason: "stop" } },
    ]);
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}); // 2 参，无 wiring
    const res = await runWorkflowScript(`await parallel([{ prompt: "a" }])`, prims);
    expect(res.status).toBe("failed");
    expect((res as { error: string }).error).toContain("not wired");
  });

  test("bindSeqs 在 parallel 调度前同步按数组序预分配连续 seq（resume 确定性）", async () => {
    const { provider } = scriptedProvider([]);
    const order: { spec: AgentSpec; kind: CallKind }[] = [];
    const wiring = testWiring(async (s) => ({ ok: true, value: s.prompt }));
    wiring.bindSeqs = (specs, kind) => {
      for (const s of specs) order.push({ spec: s, kind });
    };
    const prims = makeWorkflowPrimitives(makeCtx({ provider }), {}, wiring);
    await runWorkflowScript(`await parallel([{ prompt: "a" }, { prompt: "b" }])`, prims);
    // bindSeqs 收到的是数组序的两个 parallel-item 规格（同步、挂起前）
    expect(order.map((o) => o.spec.prompt)).toEqual(["a", "b"]);
    expect(order.every((o) => o.kind === "parallel-item")).toBe(true);
  });
});
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/primitives-wiring.test.ts
```
预期失败：`makeWorkflowPrimitives` 现为 2 参，第三参 `wiring` 不被消费 → `parallel` 仍是抛错桩 → 全部 wiring 用例红；`PrimitiveWiring` 未导出（`error: Export named 'PrimitiveWiring' not found`）。

### 2.2 GREEN — 扩展 `primitives.ts`

`makeParallel`/`makePipeline`（M2 已建于本文件）、`runSubagent`（M1）、守卫 `validateAgentSpec`/`WorkflowApiError`、类型 `Scheduler`/`Budget`/`RunSubagent`（M2 已 import）均在本文件可用。追加 `CallKind` 到 `./types` 的 import 行（并入既有那一行），并替换 `makeWorkflowPrimitives`：
```ts
// primitives.ts 顶部对 ./types 的具名 import 最终形态（并入 CallKind）：
import {
  type AgentSpec,
  type Budget,
  type CallKind,
  type RunSubagent,
  type SpecResult,
  type StageSpec,
  validateAgentSpec,
  validateStageSpec,
  WorkflowApiError,
  type WorkflowContext,
  type WorkflowPrimitives,
} from "./types";

/**
 * M6 装配接缝：createWorkflowRuntime 注入真实调度/记账/journaling/事件。
 *  - scheduler：M2 并发池（budget 准入 + backstop + abort）。
 *  - run：journaling + workflow.* 事件 + budget 计费 + cwd 隔离的 RunSubagent（Task 4 装配）。
 *  - workflow：一层内联子 workflow（Task 4）。
 *  - budget：guest 可见的只读视图（M2 TokenBudget）。
 *  - bindSeqs：parallel 调度前同步按数组序预分配连续 seq（resume 确定性，asyncify 安全）。
 */
export type PrimitiveWiring = {
  scheduler: Scheduler;
  run: RunSubagent;
  workflow: WorkflowPrimitives["workflow"];
  budget: Budget;
  bindSeqs: (specs: AgentSpec[], callKind: CallKind) => void;
};

export function makeWorkflowPrimitives(
  ctx: WorkflowContext,
  args: unknown,
  wiring?: PrimitiveWiring,
): WorkflowPrimitives {
  return {
    args,
    log: (msg) => ctx.onLog?.(msg),
    phase: (title) => ctx.onPhase?.(title),
    agent: async (prompt, opts) => {
      const spec: AgentSpec = { prompt, ...(opts ?? {}) };
      if (!wiring) {
        // M1 顺序路径：直接嵌套 queryLoop（无池/无 journal），成功→value，失败→null（spec §10）。
        const res = await runSubagent(spec, ctx);
        return res.ok ? res.value : null;
      }
      validateAgentSpec(spec, "agent");
      wiring.bindSeqs([spec], "agent"); // 单调 seq（agent 调用序）
      const r = await wiring.scheduler.submit((signal) => wiring.run(spec, signal));
      return r.ok ? r.value : null;
    },
    parallel: wiring
      ? async (specs) => {
          if (!Array.isArray(specs)) {
            throw new WorkflowApiError("parallel(specs): specs must be an array of AgentSpec");
          }
          // 同步校验 + seq 预分配（数组序），再交 makeParallel（其内再校验幂等、回灌同引用规格）。
          const validated = specs.map((s, i) => validateAgentSpec(s, `parallel[${i}]`));
          wiring.bindSeqs(validated, "parallel-item");
          return makeParallel(wiring.scheduler, wiring.run)(validated);
        }
      : notUntilM6("parallel"),
    pipeline: wiring
      ? async (items, ...stages) => makePipeline(wiring.scheduler, wiring.run)(items, ...stages)
      : notUntilM6("pipeline"),
    workflow: wiring?.workflow ?? notUntilM6("workflow"),
    budget: wiring?.budget ?? noopBudget,
  };
}
```
> 关键：`makeParallel`（M2）内部 `validated.map((s,i)=>validateAgentSpec(s,...))` 对已校验规格再校验时**返回同一对象引用**（`validateAgentSpec` 返回入参本身），故传给 `wiring.run(spec, …)` 的 `spec` 与 `bindSeqs` 预分配时的 `spec` 是**同一引用**——Task 4 据对象 identity 取回该项 `seq`，实现数组序确定 seq（resume 命中）。`pipeline` 的 per-stage 规格在 `makePipeline` 内部构造（非同一引用），其 `seq` 由 Task 4 的 `run` 按到达序分配（resume 确定性对 pipeline 推后，与 spec §15 一致）；`notUntilM6`/`noopBudget` 为 M1 既有桩，wiring 缺省时复用。

### 2.3 VERIFY
```bash
bun test packages/core/src/workflow/__tests__/primitives-wiring.test.ts
bun test packages/core/src/workflow/__tests__/run-workflow.test.ts   # M1 顺序脚本回归（无 wiring 路径）
bun test packages/core/src/workflow/__tests__/parallel.test.ts \
         packages/core/src/workflow/__tests__/pipeline.test.ts        # M2 makeParallel/makePipeline 回归
bun run typecheck
bun run check
```
预期：本套 6 test 全绿（F1 已闭合——guest `await parallel([...])` 真跑通）；M1 `run-workflow.test.ts`（2 参，无 wiring）+ M2 parallel/pipeline 套件不破；类型/lint 干净。

### 2.4 COMMIT
```bash
git add packages/core/src/workflow/primitives.ts \
        packages/core/src/workflow/__tests__/primitives-wiring.test.ts
git commit -m "feat(workflow): M6 F1-b makeWorkflowPrimitives 接 wiring，闭合 guest 原语注入（F1）

parallel/pipeline/workflow 抛错桩 + budget no-op → 真实 makeParallel/makePipeline/workflow/
budget（wiring 缺省仍回退 M1 桩，顺序路径不破）；parallel 调度前同步按数组序预分配 seq。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3：onUsage→budget.charge 接线（`types.ts` 追加 `onUsage?` + `subagent.ts` 穿透）

**交付**：闭合「token budget 记账」缺口（spec §6）。subagent 的 `queryLoop` 每轮经 `LoopDeps.onUsage?.(res.usage)` 回传 usage（`query-loop.ts`：`if (res.usage) deps.onUsage?.(res.usage)`，real；`onUsage: (u:{inputTokens,outputTokens,cacheReadTokens?,cacheWriteTokens?})=>void`，`loop/types.ts`）。M1 `runSubagent` 构造 `LoopDeps` 时**未设 `onUsage`**——M6 在 M0 `WorkflowContext` **追加可选字段** `onUsage?`（additive，用既有已 import 的 `LoopDeps["onUsage"]` 投影），并让 `runSubagent` 把 `ctx.onUsage` 穿透进 `LoopDeps.onUsage`。Task 4 的 `createWorkflowRuntime` 据此注入 `onUsage: (u)=>budget.charge(u.inputTokens+u.outputTokens)`，与 M2 `TokenBudget.charge` 闭环。

### 3.1 RED — 先写失败测试

新建 `packages/core/src/workflow/__tests__/subagent-usage.test.ts`：
```ts
import { describe, expect, test } from "bun:test";
import { runSubagent } from "../subagent";
import { makeCtx, scriptedProvider } from "./fixtures";

describe("M6：runSubagent 把 ctx.onUsage 穿透进 LoopDeps（budget 记账地基）", () => {
  test("provider 每轮 usage 经 ctx.onUsage 回传（input+output 可被宿主累加）", async () => {
    const charged: number[] = [];
    const { provider } = scriptedProvider([
      {
        result: {
          text: "done",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 40 },
        },
      },
    ]);
    const ctx = makeCtx({ provider });
    ctx.onUsage = (u) => charged.push(u.inputTokens + u.outputTokens);
    const res = await runSubagent({ prompt: "x" }, ctx);
    expect(res).toEqual({ ok: true, value: "done" });
    expect(charged).toEqual([140]);
  });

  test("ctx.onUsage 未设时 runSubagent 正常（向后兼容，no-op）", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "ok", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "y" }, makeCtx({ provider }));
    expect(res).toEqual({ ok: true, value: "ok" });
  });
});
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/subagent-usage.test.ts
```
预期失败：第 1 用例——`ctx.onUsage` 不是 `WorkflowContext` 字段（`tsc`/`bun` 报属性不存在 / 赋值后未被 `runSubagent` 接入 → `charged` 为空）。

### 3.2 GREEN — `types.ts` 追加字段 + `subagent.ts` 穿透

**(a)** `packages/core/src/workflow/types.ts`：`WorkflowContext` 内 `onLog?` 之后追加（`LoopDeps` 已在文件顶部 import，零新增 import）：
```ts
  onPhase?: (title: string) => void;
  onLog?: (msg: string) => void;
  /** usage 回传钩子（M6 接线）：subagent queryLoop 每轮 provider usage 经此回传；
   *  createWorkflowRuntime 接 budget.charge(input+output)（spec §6 token budget 记账）。 */
  onUsage?: LoopDeps["onUsage"];
```

**(b)** `packages/core/src/workflow/subagent.ts`：`runSubagent` 内构造 `deps: LoopDeps` 时，在 `maxReflections` 之后条件展开 `onUsage`（`exactOptionalPropertyTypes` 下不可写 `onUsage: undefined`，故用条件展开）：
```ts
  const deps: LoopDeps = {
    emit: ctx.emit,
    callProvider: ctx.callProvider,
    registry,
    approvals: ctx.approvals,
    executeTool: ctx.executeTool,
    signal,
    maxRetries: ctx.maxRetries ?? 3,
    maxReflections: ctx.maxReflections ?? 3,
    ...(ctx.onUsage ? { onUsage: ctx.onUsage } : {}),
  };
```

### 3.3 VERIFY
```bash
bun test packages/core/src/workflow/__tests__/subagent-usage.test.ts
bun test packages/core/src/workflow/__tests__/subagent.test.ts \
         packages/core/src/workflow/__tests__/schema.test.ts   # M1 subagent 回归
bun run typecheck
bun run check
```
预期：本套 2 test 全绿；M1 subagent/schema 套件不破（`onUsage` 缺省 → 条件展开为空 → 行为不变）；类型/lint 干净。

### 3.4 COMMIT
```bash
git add packages/core/src/workflow/types.ts packages/core/src/workflow/subagent.ts \
        packages/core/src/workflow/__tests__/subagent-usage.test.ts
git commit -m "feat(workflow): M6 onUsage 穿透——WorkflowContext.onUsage? + runSubagent 接 LoopDeps.onUsage

为 token budget 记账接地基：subagent queryLoop 每轮 usage 经 ctx.onUsage 回传；
additive 可选字段（LoopDeps['onUsage'] 投影），缺省 no-op 向后兼容。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4：F2 — `createWorkflowRuntime(ctx)` 集成运行时（闭合 F2）

**交付**：在 `runtime.ts` 落地 `createWorkflowRuntime(ctx: WorkflowContext): WorkflowRuntime`——把孤岛装配成一次真实 run：
- **M2** `new TokenBudget(ctx.budgetTotal ?? DEFAULT)` + `new Scheduler({ signal: ctx.signal, maxConcurrent, maxAgentsPerRun, budget })`；
- **M3** 若 `ctx.journal` 存在：`findResumableRun(scriptHash, argsHash)` → `ResumePlanner(loadJournal(prior))`，`startRun(...)` 得 `runId`；`makeJournaledRun({journal, runId, planner, runLive})` 包 live 子跑；
- **M4** `new WorkflowEvents(ctx.emit, { sessionId: ctx.parentSessionId, turnId, workflowId: runId })`；`BubblingApprovalSeam(ctx.approvals, ctx.parentSessionId)`；终态经 `terminalEvent`；
- **F2 适配**：把 M1 `runSubagent(spec, ctx)` 适配成 M0 `RunSubagent` 端口（`(spec, signal)=>SubagentResult`，`ctx` 经闭包捕获，per-call 派生 `cwd`/`approvals=bubbling`/`onUsage=budget.charge`）；分配**单调 `agentSeq`**（= journal `seq` = 事件 `agentSeq`，数组序确定）；发 `workflow.*` 事件序列；
- **per-subagent sandbox 隔离接缝**：`deriveChildCwd`——默认继承 `ctx.cwd`，`isolation:"worktree"` 派生独立子工作区 cwd（物理置备按 spec §15 推后）；
- **workflow() 一层内联**：经 `ctx.store.load(name)` 载脚本、`depth` 守卫（`>1` 抛错）、单层递归 `createWorkflowRuntime(childCtx).execute`；
- `execute(source, args)`：`runWorkflowScript` 跑脚本；终态归一（`signal.aborted`→interrupted 优先；completed/failed），发终态事件 + `finishRun`。

### 4.1 RED — 先写失败测试

新建 `packages/core/src/workflow/__tests__/create-runtime.test.ts`：
```ts
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
  const rows: { runId: string; seq: number; callKind: CallKind; specHash: string; status: AgentStatus; result: unknown }[] = [];
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
      if (r) { r.status = status; if (error) r.error = error; }
    },
    recordAgentStart: (i) => {
      const id = `a-${rows.length}`;
      rows.push({ runId: i.runId, seq: i.seq, callKind: i.callKind, specHash: i.specHash, status: "running", result: null });
      return id;
    },
    completeAgent: (id, result) => {
      const r = rows[Number(id.slice(2))];
      if (r) { r.status = "completed"; r.result = result; }
    },
    failAgent: (id, error) => {
      const r = rows[Number(id.slice(2))];
      if (r) { r.status = "failed"; r.result = error; }
    },
    findResumableRun: () => null,
    loadJournal: () => [],
  };
  return { j, rows, runs };
}

// 把 emit spy 收集的事件类型序列拿出来
function ctxWithEvents(over: Partial<WorkflowContext> = {}): { ctx: WorkflowContext; ts: () => string[] } {
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
    const res = await rt.execute(`await agent("hello")`, { seed: 1 });
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
      `const rs = await parallel([{ prompt: "a" }, { prompt: "b" }]); rs.join(",")`,
      {},
    );
    expect(res).toMatchObject({ status: "completed", output: "R-a,R-b" });
    const parallelRows = rows.filter((r) => r.callKind === "parallel-item").sort((x, y) => x.seq - y.seq);
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
        if (n === "child") return { name: n, source: `await agent("inner")`, scriptHash: "h" };
        throw new Error(`no such workflow: ${n}`);
      },
    };
    const { ctx } = ctxWithEvents({
      store,
      callProvider: (async function* () {
        return { text: "INNER", toolCalls: [], finishReason: "stop" } as never;
      }) as never,
    });
    const rt = createWorkflowRuntime(ctx);
    const ok = await rt.execute(`await workflow("child")`, {});
    expect(ok.status).toBe("completed");
    expect(ok.output).toBe("INNER");

    // depth 守卫：在 depth=1 的 ctx 上再调 workflow() → 抛错 → 脚本 failed
    const deep = createWorkflowRuntime({ ...ctx, depth: 1 });
    const bad = await deep.execute(`await workflow("child")`, {});
    expect(bad.status).toBe("failed");
    expect(bad.error).toMatch(/one level|nesting/);
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
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/create-runtime.test.ts
```
预期失败：`createWorkflowRuntime`/`deriveChildCwd` 未从 `../runtime` 导出（`Export named 'createWorkflowRuntime' not found`）。

### 4.2 GREEN — 在 `runtime.ts` 追加集成层

在 `runtime.ts` 文件末尾（`runWorkflowScript` 之后）追加。先补 import（按 biome 路径序并入既有块；`runtime.ts` 此前已 import quickjs 变体与 `./types`）：
```ts
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isAbortError } from "../loop/concurrency";
import { BubblingApprovalSeam } from "./bubbling-approval";
import { WorkflowEvents } from "./events";
import { argsHash, scriptHash } from "./hash";
import { terminalEvent } from "./interrupt";
import type { WorkflowJournalService } from "./journal-service";
import { makeJournaledRun, type RunOneSpec } from "./journaled-run";
import { makeWorkflowPrimitives, type PrimitiveWiring } from "./primitives";
import { ResumePlanner } from "./resume";
import { BudgetExceededError, Scheduler, SchedulerExhaustedError, TokenBudget } from "./scheduler";
import { runSubagent } from "./subagent";
// 既有 ./types import 行并入：AgentSpec/CallKind/RunStatus/RunSubagent/SpecResult/
//   WorkflowApiError/WorkflowContext/WorkflowResult/WorkflowRuntime
```
追加实现：
```ts
// 缺省 token budget 上限（ctx.budgetTotal 未给时）：足够大、避免误触硬上限，又非 Infinity（TokenBudget 要求有限正数）。
const DEFAULT_TOKEN_BUDGET = 100_000_000;

/** 子 agent 失败的内层载体：journaled 接缝据此 failAgent；run 包装据 status 归一 SubagentResult。 */
class SubagentFailure extends Error {
  constructor(
    readonly status: "failed" | "interrupted",
    readonly detail?: string,
  ) {
    super(detail ?? status);
    this.name = "SubagentFailure";
  }
}

/** run-fatal：必须冒泡到脚本顶层（中断 / budget 硬上限 / backstop），不可被吞成 null（spec §10）。 */
function isFatalError(e: unknown): boolean {
  return e instanceof BudgetExceededError || e instanceof SchedulerExhaustedError || isAbortError(e);
}

/**
 * per-subagent sandbox 隔离接缝（spec §6）。默认继承父 cwd；isolation:"worktree" 派生独立子工作区 cwd
 * （并发写同一工作区时按需）。物理置备（git worktree / tmp clone）的触发判定按 spec §15 推后——
 * 此处只产出隔离 cwd 接缝；cwd 不入 specHash（不破 resume 命中）。
 */
export function deriveChildCwd(ctx: WorkflowContext, spec: AgentSpec): string {
  if (spec.isolation === "worktree") {
    return join(ctx.cwd, ".arclight", "wf-worktrees", ctx.newId?.() ?? randomUUID());
  }
  return ctx.cwd;
}

/**
 * F2 集成运行时：把 M1 runtime/runSubagent + M2 scheduler/budget + M3 journal/resume +
 * M4 events/审批/中断 装配成一次 run。ctx 在此捕获（M0：execute(source,args) 两参）。
 */
export function createWorkflowRuntime(ctx: WorkflowContext): WorkflowRuntime {
  return {
    async execute(source: string, args: unknown): Promise<WorkflowResult> {
      const sh = scriptHash(source);
      const ah = argsHash(args);
      const budget = new TokenBudget(
        ctx.budgetTotal && ctx.budgetTotal > 0 ? ctx.budgetTotal : DEFAULT_TOKEN_BUDGET,
      );
      const scheduler = new Scheduler({
        signal: ctx.signal,
        ...(ctx.maxConcurrent !== undefined ? { maxConcurrent: ctx.maxConcurrent } : {}),
        ...(ctx.maxAgentsPerRun !== undefined ? { maxAgentsPerRun: ctx.maxAgentsPerRun } : {}),
        budget,
      });

      // ── M3 journal + resume（journal 可选：单测可不接）──
      let runId: string;
      let planner: ResumePlanner;
      if (ctx.journal) {
        const prior = ctx.journal.findResumableRun(sh, ah);
        planner = new ResumePlanner(prior ? ctx.journal.loadJournal(prior.runId) : []);
        runId = ctx.journal.startRun({
          sessionId: ctx.parentSessionId,
          scriptHash: sh,
          argsHash: ah,
          args: (args ?? {}) as Record<string, unknown>,
        });
      } else {
        runId = ctx.newId?.() ?? randomUUID();
        planner = new ResumePlanner([]);
      }

      // ── M4 事件（绑父会话，落主流 SSE）──
      const events = new WorkflowEvents(ctx.emit, {
        sessionId: ctx.parentSessionId,
        ...(ctx.parentTurnId ? { turnId: ctx.parentTurnId } : {}),
        workflowId: runId,
      });
      events.started(`workflow:${sh.slice(0, 8)}`);

      // ── 单调 agentSeq + callKind 预绑（parallel 数组序确定，resume 命中）──
      const seqMap = new Map<AgentSpec, { seq: number; callKind: CallKind }>();
      let seqCounter = 0;
      const bindSeqs: PrimitiveWiring["bindSeqs"] = (specs, callKind) => {
        for (const s of specs) seqMap.set(s, { seq: seqCounter++, callKind });
      };

      const bubbling = new BubblingApprovalSeam(ctx.approvals, ctx.parentSessionId);
      const chargeUsage: WorkflowContext["onUsage"] = (u) =>
        budget.charge((u.inputTokens ?? 0) + (u.outputTokens ?? 0));

      // ── F2 适配：M1 runSubagent(spec, ctx) → journaling 内层 RunOneSpec（失败以 throw 表达）──
      const runLive: RunOneSpec = async (spec) => {
        const s = spec as AgentSpec;
        const childCtx: WorkflowContext = {
          ...ctx,
          signal: ctx.signal, // run 级信号；runSubagent 内部再 AbortSignal.any 派生子信号（M1）
          cwd: deriveChildCwd(ctx, s),
          approvals: bubbling,
          onUsage: chargeUsage,
        };
        const r = await runSubagent(s, childCtx);
        if (r.ok) return r.value;
        throw new SubagentFailure(r.status, r.error);
      };
      const journaled: RunOneSpec = ctx.journal
        ? makeJournaledRun({
            journal: ctx.journal as unknown as WorkflowJournalService, // 端口形状一致（recordAgentStart/completeAgent/failAgent）
            runId,
            planner,
            runLive,
          })
        : runLive;

      // ── F2 适配：journaled + 事件 → M0 RunSubagent 端口（makeParallel/makePipeline/agent 共用）──
      const run: RunSubagent = async (spec, signal) => {
        const bound = seqMap.get(spec) ?? { seq: seqCounter++, callKind: "pipeline-item" as CallKind };
        const agentId = ctx.newId?.() ?? randomUUID();
        events.agentStarted({ agentId, role: spec.label ?? bound.callKind, agentSeq: bound.seq });
        try {
          const value = await journaled(spec, { seq: bound.seq, callKind: bound.callKind });
          events.agentCompleted({ agentId, status: "ok" });
          return { ok: true, value: value as SpecResult };
        } catch (e) {
          if (isFatalError(e)) {
            events.agentCompleted({ agentId, status: "failed" });
            throw e; // 中断 / budget / backstop 冒泡（spec §10）
          }
          events.agentCompleted({ agentId, status: "failed" });
          if (e instanceof SubagentFailure) {
            return e.detail !== undefined
              ? { ok: false, status: e.status, error: e.detail }
              : { ok: false, status: e.status };
          }
          return {
            ok: false,
            status: signal.aborted ? "interrupted" : "failed",
            error: e instanceof Error ? e.message : String(e),
          };
        }
      };

      // ── workflow() 一层内联（depth 守卫 + 单层递归）──
      const workflowRunner: WorkflowPrimitives["workflow"] = async (name, wfArgs) => {
        if ((ctx.depth ?? 0) >= 1) {
          throw new WorkflowApiError("workflow() nesting exceeds one level (spec §1/§4)");
        }
        const loaded = ctx.store.load(name); // 不存在则抛（store 收口）
        const child = createWorkflowRuntime({ ...ctx, depth: (ctx.depth ?? 0) + 1 });
        const res = await child.execute(loaded.source, wfArgs ?? {});
        if (res.status === "completed") return res.output ?? null;
        throw new WorkflowApiError(res.error ?? `sub-workflow "${name}" ${res.status}`);
      };

      // ── 装配 guest 原语全集（F1 wiring）+ 跑脚本 ──
      // phase() 经派生 ctx 接 events.phase（spec §8 workflow.phase）——createWorkflowRuntime 是
      // 唯一接线点：makeWorkflowPrimitives 的 phase 读 ctx.onPhase，而 createWorkflowRuntime/serve.ts
      // 均不设 onPhase，若不在此接线则 guest phase() 静默无事件（缺 §8 六事件之一）。log() 仍走
      // ctx.onLog（spec §8 无 workflow.log 事件）。注：仅 phase/log 读此 ctx 参；run/agent 经 wiring
      // 闭包捕获的原始 ctx（见上 runLive/run），故派生 ctx 不影响 subagent 路径。
      const primitivesCtx: WorkflowContext = {
        ...ctx,
        onPhase: (title: string) => {
          events.phase(title);
          ctx.onPhase?.(title);
        },
      };
      const wiring: PrimitiveWiring = { scheduler, run, workflow: workflowRunner, budget, bindSeqs };
      const primitives = makeWorkflowPrimitives(primitivesCtx, args, wiring);
      const scriptResult = await runWorkflowScript(source, primitives);

      // ── 终态归一（signal.aborted 优先 → interrupted；否则脚本结果）+ 终态事件 + finishRun ──
      let status: RunStatus;
      let error: string | undefined;
      let output: unknown;
      if (ctx.signal.aborted) {
        status = "interrupted";
      } else if (scriptResult.status === "completed") {
        status = "completed";
        output = scriptResult.output;
      } else {
        status = "failed";
        error = scriptResult.error;
      }
      terminalEvent(events, status, error ?? "");
      ctx.journal?.finishRun(runId, status, error);
      return {
        status,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    },
  };
}
```
> 设计要点：① **agentSeq = journal seq = 事件 agentSeq**——单一单调计数器，`parallel` 经 `bindSeqs` 同步按数组序预分配（regsume 命中），`agent` 取下一序，`pipeline` per-stage 到达序分配。② **run-fatal 冒泡**：scheduler 准入失败（abort/budget/backstop）在 task 运行前抛出，经 `Promise.all` 冒泡（不进 `run` 的 try/catch）；`run` 内 `isFatalError` 二次防线。③ **失败→null**：subagent 普通失败经 `SubagentFailure`→`{ok:false}`→`makeParallel` 映 `null`（spec §10）。④ **中断扇出**：`ctx.signal` 传入 scheduler + 每个 `runSubagent`（其内 `AbortSignal.any([ctx.signal, childAc])` 再派生，M1），父 abort 级联所有在飞子 agent；run 终态 `signal.aborted`→interrupted。⑤ **journal 端口**：`makeJournaledRun` 形参标注 `WorkflowJournalService`，M0 `WorkflowJournalPort` 结构一致（`recordAgentStart`/`completeAgent`/`failAgent` 同签名），生产传真 service、单测传 port fake，`as unknown as` 收敛。⑥ **phase 接线**：guest `phase(title)` 经派生 `primitivesCtx.onPhase` 触发 `events.phase(title)` 发 `workflow.phase`（§8 六事件之一）；`log()` 无对应事件（§8 未定义 workflow.log），仍走 `ctx.onLog`。

### 4.3 VERIFY
```bash
bun test packages/core/src/workflow/__tests__/create-runtime.test.ts
bun test packages/core/src/workflow/__tests__/   # workflow 目录全量回归（M1–M4 + M6 Task1-4）
bun run typecheck
bun run check
```
预期：本套 7 test 全绿（F2 闭合；含 phase()→workflow.phase 接线）；workflow 目录既有套件不破；类型/lint 干净。

### 4.4 COMMIT
```bash
git add packages/core/src/workflow/runtime.ts \
        packages/core/src/workflow/__tests__/create-runtime.test.ts
git commit -m "feat(workflow): M6 F2 createWorkflowRuntime —— 集成运行时（闭合 F2）

装配 M1 runtime/runSubagent + M2 scheduler/budget + M3 journal/resume + M4 events/审批/中断；
单调 agentSeq=journal seq=事件 agentSeq；runSubagent→RunSubagent 端口适配（cwd/bubbling/onUsage 闭包注入）；
workflow() 一层内联 + depth 守卫；per-subagent cwd 隔离接缝 deriveChildCwd；终态归一 + 事件。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5：公开 `runWorkflow(scriptOrName, args, ctx)` 入口 + `index.ts` 汇总全部导出（唯一权威）

**交付**：① 在 `runtime.ts` 落地 M0 契约的公开入口 `runWorkflow(scriptOrName: string, args: unknown, ctx: WorkflowContext): Promise<WorkflowResult>`——经 M5 `resolveWorkflowSource`（命名 vs 临场合成判定，复用 `ctx.store`）解析后 `createWorkflowRuntime(ctx).execute(source, args)`。② 把 `index.ts` 收为**唯一权威**对外面：汇总 M1–M6 全部公开符号（含 `createWorkflowRuntime`/`runWorkflow`/`deriveChildCwd` + M2/M3/M4 已建但此前未在 index 汇总的导出）+ 共享类型再导出（权威仍 `./types`）。

### 5.1 RED — 先写失败测试

新建 `packages/core/src/workflow/__tests__/run-workflow-entry.test.ts`：
```ts
import { describe, expect, test } from "bun:test";
import { createWorkflowRuntime, runWorkflow, WorkflowStore } from "../index";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowContext } from "../types";
import { dummyStore, makeCtx, scriptedProvider } from "./fixtures";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctxFor(store: WorkflowContext["store"], provider: WorkflowContext["callProvider"]): WorkflowContext {
  const base = makeCtx({ provider });
  return { ...base, parentSessionId: "s", parentTurnId: "t", store, emit: () => ({}) as never };
}

describe("M6：公开 runWorkflow(scriptOrName, args, ctx)", () => {
  test("入口经 index 可达，且与 createWorkflowRuntime 同为公开面", () => {
    expect(typeof runWorkflow).toBe("function");
    expect(typeof createWorkflowRuntime).toBe("function");
  });

  test("内联脚本（含语法符号）→ 原样作临场合成源码执行", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "OUT", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runWorkflow(`await agent("synth")`, {}, ctxFor(dummyStore, provider));
    expect(res).toMatchObject({ status: "completed", output: "OUT" });
  });

  test("slug 命名 → 从 store 载入命名脚本执行", async () => {
    const d = mkdtempSync(join(tmpdir(), "wf-entry-"));
    dirs.push(d);
    const store = new WorkflowStore(d);
    store.save("gate-circuit", `await agent("build")`);
    const { provider } = scriptedProvider([
      { result: { text: "BUILT", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runWorkflow("gate-circuit", {}, ctxFor(store, provider));
    expect(res).toMatchObject({ status: "completed", output: "BUILT" });
  });

  test("slug 命名但未存 → 抛错（不把裸标识符当脚本跑，安全默认）", async () => {
    const d = mkdtempSync(join(tmpdir(), "wf-entry-"));
    dirs.push(d);
    const store = new WorkflowStore(d);
    const { provider } = scriptedProvider([]);
    await expect(runWorkflow("missing-flow", {}, ctxFor(store, provider))).rejects.toThrow(
      /no such named workflow/,
    );
  });
});
```

跑测（预期 RED）：
```bash
bun test packages/core/src/workflow/__tests__/run-workflow-entry.test.ts
```
预期失败：`runWorkflow`/`createWorkflowRuntime` 未从 `../index` 导出（`Export named 'runWorkflow' not found`）。

### 5.2 GREEN — `runtime.ts` 追加 `runWorkflow` + `index.ts` 汇总

**(a)** `runtime.ts`：在 `createWorkflowRuntime` 之后追加公开入口（`resolveWorkflowSource` 自 M5 `./store`；其形参为 `WorkflowStore`，`ctx.store` 是结构子集 `WorkflowStorePort`，仅用 `has`/`load`，`as unknown as` 收敛）。import 行并入 `./store`：
```ts
import { resolveWorkflowSource, type WorkflowStore } from "./store";
```
```ts
/**
 * 公开入口（spec §3 / M0 契约）。scriptOrName：slug → 命名 workflow（从 ctx.store 载入，未存抛错）；
 * 其余 → 临场合成内联源码（原样）。解析后委托 createWorkflowRuntime(ctx).execute。
 */
export async function runWorkflow(
  scriptOrName: string,
  args: unknown,
  ctx: WorkflowContext,
): Promise<WorkflowResult> {
  const source = resolveWorkflowSource(scriptOrName, ctx.store as unknown as WorkflowStore);
  return createWorkflowRuntime(ctx).execute(source, args);
}
```

**(b)** `packages/core/src/workflow/index.ts` 收为**唯一权威**对外面（覆盖 M1/M5 既有内容，汇总 M1–M6 全部公开符号；`export ... from` 按 biome `organizeImports` 路径序排列）：
```ts
// workflow 子系统对外索引——M6 收口为唯一权威对外面（汇总 M1–M6 全部公开符号）。
// 共享类型的唯一权威定义在 ./types（M0）；消费方应从 ./types import，index 仅再导出便捷别名。

// ── 值导出（按来源路径 biome 排序）──
export { BubblingApprovalSeam } from "./bubbling-approval"; // M4
export { WorkflowEvents } from "./events"; // M4
export { argsHash, canonicalJson, scriptHash, specHash } from "./hash"; // M3
export { deriveChildSignal, terminalEvent } from "./interrupt"; // M4
export { WorkflowJournalService } from "./journal-service"; // M3
export { makeJournaledRun } from "./journaled-run"; // M3
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
export { jsonSchemaToZod, makeStructuredOutputTool } from "./schema"; // M1
export {
  BudgetExceededError, // M2
  defaultConcurrency, // M2
  Scheduler, // M2
  SchedulerExhaustedError, // M2
  TokenBudget, // M2
} from "./scheduler";
export { resolveWorkflowSource, WORKFLOW_NAME_RE, WorkflowStore } from "./store"; // M5
export { defaultSafeToolNames, RestrictedToolRegistry, runSubagent } from "./subagent"; // M1
// WorkflowApiError + 守卫（权威 ./types；primitives 亦 re-export，此处单点取 ./types 避免 TS2308）
export {
  assertSerializableSpec,
  validateAgentSpec,
  validateStageSpec,
  WORKFLOW_EVENTS,
  WorkflowApiError,
} from "./types";

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
export type { PrimitiveWiring } from "./primitives";
```
> 注：`WorkflowApiError` 在 `primitives.ts` 经 `export { WorkflowApiError } from "./types"` re-export（M1/M2），此处 index 从 `./types` 单点导出即可，**不**从 `./primitives` 再导一次（否则 TS2308 重复导出冲突）。`./primitives` 的值导出仅列 `interpolate`/`makeParallel`/`makePipeline`/`makeWorkflowPrimitives`。

### 5.3 VERIFY
```bash
bun test packages/core/src/workflow/__tests__/run-workflow-entry.test.ts
bun test packages/core/src/workflow/__tests__/   # workflow 全量回归（含 M5 index.test.ts、store.test.ts）
bun run typecheck
bun run check
```
预期：本套 4 test 全绿；M5 `index.test.ts`（`resolveWorkflowSource`/`WorkflowStore` 经 `../index` 可达）仍绿；类型/lint 干净（含 `organizeImports` 导出排序）。

### 5.4 COMMIT
```bash
git add packages/core/src/workflow/runtime.ts packages/core/src/workflow/index.ts \
        packages/core/src/workflow/__tests__/run-workflow-entry.test.ts
git commit -m "feat(workflow): M6 公开 runWorkflow 入口 + index.ts 汇总全部导出（唯一权威）

runWorkflow(scriptOrName,args,ctx)=resolveWorkflowSource+createWorkflowRuntime.execute；
index 收口 M1–M6 全部公开符号 + 共享类型再导出（权威 ./types）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6：生产接线 reconcile —— `run_workflow` 注入接缝改 per-call launch + `serve.ts` 接线（承接 M5 §3.4）

**交付**：闭合「生产接线」缺口。**契约 reconcile 的根因**：M0 `WorkflowRuntime.execute(source, args)` 是**两参**、ctx 在 `createWorkflowRuntime(ctx)` 捕获，而 `ctx` 含**每次 run 才知**的 `parentSessionId`/`parentTurnId`/`cwd`/`signal`——进程单例 runtime **无法**预先捕获这些。但 `run_workflow` 工具的 `execute(input, ctx: LoopToolContext)` 恰好**握有**该次工具调用的 `sessionId`/`turnId`/`cwd`/`signal`（spec §8 事件须绑父会话、§10 中断须绑父 turn 信号）。故 M6 把 M5 占位的 `workflows.runtime: WorkflowRuntime` **reconcile 为 per-call 启动接缝** `workflows.launch(source, args, toolCtx)`：工具保留 M5 的解析/保存/`VALIDATION`/`INTERNAL` 逻辑不变，仅把末步 `runtime.execute(source, args)` 改为 `launch(source, args, ctx)`；`launch` 闭包（serve.ts 构造）据 `toolCtx` + 进程级依赖装 `WorkflowContext` 调 `runWorkflow`。子 agent 的受限集经 `defaultSafeToolNames`（仅 `isReadOnly && riskTier==="safe"`）天然排除 `confirm` 风险位的 `run_workflow`，杜绝 >1 层嵌套（spec §1/§10）。

### 6.1 RED — 改 M5 的 `runWorkflow.test.ts`（launch spy 取代 runtime spy）

M5 `packages/core/src/tools/__tests__/runWorkflow.test.ts` 的假 runtime 改为假 launch（验证工具把已解析 source + args + **toolCtx** 透传）。替换其 `spyRuntime` 与注入处：
```ts
// import 段：用 WorkflowResult（仍自 ../../workflow）；不再需要 WorkflowRuntime 类型
import type { WorkflowResult } from "../../workflow";

// 假 launch：M6 per-call 接缝 (source, args, toolCtx) => Promise<WorkflowResult>。
function spyLaunch() {
  const calls: { source: string; args: unknown; sessionId: string; signalAborted: boolean }[] = [];
  const launch = (source: string, args: Record<string, unknown>, toolCtx: LoopToolContext) => {
    calls.push({ source, args, sessionId: toolCtx.sessionId, signalAborted: toolCtx.signal.aborted });
    return Promise.resolve<WorkflowResult>({ status: "completed", output: { ran: source } });
  };
  return { launch, calls };
}
```
各用例把 `makeExecuteTool({ sandbox: {} as never, workflows: { store, runtime } })` 改为 `workflows: { store, launch }`，并把断言 `calls[0]?.source` 等改为读 launch 的 calls；新增一条断言透传 toolCtx：
```ts
  test("inline script → 经 makeExecuteTool 注入 workflows，launch 收到内联源码 + 父会话 ctx", async () => {
    const { launch, calls } = spyLaunch();
    const store = freshStore();
    const execute = makeExecuteTool({ sandbox: {} as never, workflows: { store, launch } });
    const out = await execute(
      tool,
      { script: "await agent('synth'); return 1;", args: { seed: 1 } },
      ctx(new AbortController().signal),
    );
    expect(out.ok).toBe(true);
    expect(calls[0]?.source).toBe("await agent('synth'); return 1;");
    expect(calls[0]?.args).toEqual({ seed: 1 });
    expect(calls[0]?.sessionId).toBe("s"); // 父会话 ctx 透传（事件绑父会话靠它）
  });
```
（其余用例：`saveAs` 持久化、`name` 载存储源码、`name` 不存在→`VALIDATION`、`name`+`script` 同给→`VALIDATION`、未注入 workflows→`INTERNAL`、meta 非 safe/read 永不 auto-allow——逻辑不变，仅注入键 `runtime`→`launch`、spy 读法相应调整。）

跑测（预期 RED）：
```bash
bun test packages/core/src/tools/__tests__/runWorkflow.test.ts
```
预期失败：注入键 `launch` 不被 registry/工具消费（仍找 `runtime`）→ `INTERNAL` 或调用形态不符，断言红。

### 6.2 GREEN — 改 `registry.ts` 注入类型 + `runWorkflow.ts` 工具末步

**(a)** `packages/core/src/tools/registry.ts`：把 M5 注入的 `workflows` 从 `{ store, runtime }` 改为 `{ store, launch }`。import 改为（`WorkflowRuntime` 不再需要、改 `WorkflowResult`；`LoopToolContext` 已在本文件 import）：
```ts
import type { WorkflowResult, WorkflowStore } from "../workflow";
```
`CoreToolContext` 与 `makeExecuteTool` deps 内的 `workflows` 字段统一为：
```ts
  // 注入式 workflow 启动接缝（M6）：仅主 agent 的 run_workflow 工具消费；子 agent 受限集不含本工具。
  // launch 据本次工具调用的 LoopToolContext（父会话/turn/cwd/signal）装 WorkflowContext 并 runWorkflow——
  // 进程单例 runtime 无法预捕获 per-run 的会话/信号，故用 per-call 接缝（spec §8 事件绑父会话 / §10 中断绑父信号）。
  workflows?: {
    store: WorkflowStore;
    launch: (
      source: string,
      args: Record<string, unknown>,
      toolCtx: LoopToolContext,
    ) => Promise<WorkflowResult>;
  };
```
（`CoreToolContext` 与 `makeExecuteTool` 的 deps 两处 `workflows?: { store; runtime }` 同步替换；`coreCtx` 透传 `workflows: deps.workflows` 不变。）

**(b)** `packages/core/src/tools/builtin/runWorkflow.ts`：解析/保存/`VALIDATION`/`INTERNAL` 全不变，仅改解构与末步执行：
```ts
    const { store, launch } = c.workflows;
```
```ts
    // 执行阶段：launch 据父会话 ctx 装 WorkflowContext 并 runWorkflow（run-fatal 不被吞，交 registry 壳分类）。
    return launch(source, input.args ?? {}, ctx as unknown as LoopToolContext);
```
（`ctx` 即工具 `execute(input, ctx)` 的第二参；`runWorkflow.ts` 顶部 import 追加 `import type { LoopToolContext } from "../../loop/types";`，按 biome 路径序置于 `@arclight/protocol` 之后、`zod` 之前的相对路径区。`WorkflowResult` 仍自 `../../workflow`；`resolveWorkflowSource` 不变。）

### 6.3 GREEN — `serve.ts` 生产接线

> 背景：M2 Task 5 已在 `serve.ts` 新建 `const sharedRateLimiter = new SharedRateLimiter({ maxConcurrent: 8 })` 并把它作为 `ProviderManager` 第三参（`serve.ts` 当前 `new SandboxRouter()` 在 47、`new ToolRegistry().register(...)×4` 在 50–54、`ProviderManager` 在 62–71、`makeExecuteTool`/`AgentRunner` 在 72–86）。M5 未改 serve.ts（移交 M6）。本步在既有变量（`db`/`bus`/`arclightDir`/`registry`/`approvals`/`providerManager`/`sandbox`）之上接线，**不动** M2 的限流接线。

import 段追加（biome 路径序）：
```ts
import { appendEvent } from "./db/appendEvent";
import { runWorkflowTool } from "./tools/builtin/runWorkflow";
import { runWorkflow, WorkflowJournalService, WorkflowStore } from "./workflow";
```

`const registry = new ToolRegistry().register(...)`（50–54）末尾追加 `run_workflow` 注册（主 agent 可见；子 agent 经 `defaultSafeToolNames` 排除）：
```ts
  const registry = new ToolRegistry()
    .register(readFileTool as never)
    .register(writeFileTool as never)
    .register(applyPatchTool as never)
    .register(bashTool as never)
    .register(runWorkflowTool as never); // M6：主 agent 临场合成入口
```

`ProviderManager` 构造（62–71）之后、`AgentRunner` 构造之前，新建 store/journal + 子 agent executeTool（**不含** workflows，防二级入口）+ launch 闭包：
```ts
  // ── M6 workflow 生产接线 ──
  const workflowStore = new WorkflowStore(arclightDir);
  const workflowJournal = new WorkflowJournalService(db);
  // 子 agent 的工具执行壳：不注入 workflows（杜绝子 agent 经工具层自起 workflow，spec §1/§10）。
  const subagentExecuteTool = makeExecuteTool({
    sandbox,
    artifacts: new ArtifactStore(db, arclightDir),
  });
  // per-call 启动接缝：据本次 run_workflow 调用的 LoopToolContext 装 WorkflowContext 并 runWorkflow。
  const launchWorkflow = (
    source: string,
    args: Record<string, unknown>,
    toolCtx: import("./loop/types").LoopToolContext,
  ) =>
    runWorkflow(source, args, {
      parentSessionId: toolCtx.sessionId,
      parentTurnId: toolCtx.turnId,
      cwd: toolCtx.cwd,
      signal: toolCtx.signal,
      callProvider: providerManager.callProvider, // 已经 SharedRateLimiter wrap（M2）
      registry, // 子 agent 经 RestrictedToolRegistry+defaultSafeToolNames 进一步裁剪（run_workflow 非 safe 被排除）
      approvals,
      executeTool: subagentExecuteTool,
      emit: (draft) => appendEvent({ db, bus }, draft), // 绑父会话落主流 SSE（spec §8）
      store: workflowStore,
      journal: workflowJournal,
    });
```

`AgentRunner` 构造（72–86）的 `executeTool` 字段改为注入 workflows：
```ts
    executeTool: makeExecuteTool({
      sandbox,
      artifacts: new ArtifactStore(db, arclightDir),
      workflows: { store: workflowStore, launch: launchWorkflow }, // M6 注入接缝
    }),
```

> 接线不变量：① 主 agent registry 含 `run_workflow`；子 agent ctx 用同一 `registry` 但经 `runSubagent` 的 `RestrictedToolRegistry` + `defaultSafeToolNames`（仅 `isReadOnly && riskTier==="safe"`）裁剪——`run_workflow` 是 `riskTier:"confirm"`、`isReadOnly:false`，故被天然排除（spec §10 纵深防护）。② `emit` 用 `appendEvent({db,bus}, draft)`，`workflow.*` 落父会话主流 SSE（spec §8）。③ `callProvider` 已被 M2 `SharedRateLimiter` wrap，并发子 agent 共享限流（spec §6）。④ `signal = toolCtx.signal` = 父 turn 的 `AbortController.signal`（runner.ts:336/501），父 interrupt 经它级联中断在飞子 agent（spec §10）。

### 6.4 VERIFY
```bash
bun test packages/core/src/tools/__tests__/runWorkflow.test.ts
bun run test:core   # 全量 core 回归（serve/runner 接线、registry 注入接缝、M1–M6 workflow 套件）
bun run typecheck
bun run check
```
预期：`runWorkflow.test.ts`（launch 接缝）全绿；`bun run test:core` 全绿（serve 接线不破既有路径）；类型/lint 干净。

### 6.5 COMMIT
```bash
git add packages/core/src/tools/registry.ts \
        packages/core/src/tools/builtin/runWorkflow.ts \
        packages/core/src/tools/__tests__/runWorkflow.test.ts \
        packages/core/src/serve.ts
git commit -m "feat(core): M6 生产接线——run_workflow per-call launch 接缝 + serve.ts 装配 workflow 运行时

reconcile M5 占位 runtime→launch(source,args,toolCtx)：进程单例无法预捕获 per-run 会话/信号，
据工具 LoopToolContext 装 WorkflowContext 调 runWorkflow（事件绑父会话/中断绑父信号）；
serve.ts 注册 run_workflow（主 agent）+ 子 agent executeTool 不含 workflows（防二级嵌套）+
emit 绑父会话主流 + callProvider 经 M2 共享限流。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7：端到端集成测试（真 Scheduler + 真 sqlite journal + 事件序列 + resume 重放命中）

**交付**：spec §14 综合回归——一段 guest 脚本 `const rs = await parallel([{prompt:'a'},{prompt:'b'}]); rs.length` 经**真实** `createWorkflowRuntime`（真 `Scheduler` + 真 `WorkflowJournalService`/sqlite + 真 `WorkflowEvents`）跑通：①结果正确；②journal 落 `workflow_runs`（1 行）+ `workflow_agents`（2 行 parallel-item，seq 0/1 数组序，completed）；③`workflow.*` 事件序列正确（started→agent.started×2→agent.completed×2→completed）；④**resume 重放命中**——相同 scriptHash+args 二次跑，`findResumableRun` 命中、`ResumePlanner` 全命中、零 live provider 调用、结果一致。本 Task **不新增实现**（Task 1–6 已就绪）；红则按 systematic-debugging 定位（常见点：seq 非数组序导致 resume miss；`canonicalJson` 指纹漂移；事件序列错）。

### 7.1 RED — 端到端测试

新建 `packages/core/src/workflow/__tests__/integration-e2e.test.ts`：
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ArcEvent } from "@arclight/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, workflowAgents, workflowRuns, workspaces } from "../../db/schema";
import type { DraftEvent } from "../../db/appendEvent";
import type { CallProvider, LlmMessage } from "../../loop/types";
import { createWorkflowRuntime } from "../runtime";
import { WorkflowJournalService } from "../journal-service";
import type { WorkflowContext } from "../types";
import { allowAllApprovals, dummySandbox, dummyStore } from "./fixtures";
import { makeExecuteTool, ToolRegistry } from "../../tools/registry";
import { eq } from "drizzle-orm";

// prompt-keyed provider（避免脚本化 provider 在并发下的轮次竞争）；记录 provider 调用次数（验 resume 零 live）。
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
  db.insert(workspaces).values({ id: "w1", name: "t", repoPath: "/r", arclightDir: "/r/.arclight" }).run();
  db.insert(sessions).values({ id: "s-parent", workspaceId: "w1" }).run();
});
afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeWfCtx(provider: CallProvider, events: ArcEvent[], journal: WorkflowJournalService): WorkflowContext {
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

const SCRIPT = `const rs = await parallel([{ prompt: "a" }, { prompt: "b" }]); rs.length`;

describe("M6 e2e：parallel + 真 Scheduler + 真 journal + 事件序列 + resume", () => {
  test("首跑：结果=2，journal 落 1 run + 2 parallel-item 行（seq 0/1），事件序列正确", async () => {
    const counter = { calls: 0 };
    const events: ArcEvent[] = [];
    const journal = new WorkflowJournalService(db);
    const ctx = makeWfCtx(promptProvider(counter), events, journal);

    const res = await createWorkflowRuntime(ctx).execute(SCRIPT, { seed: 1 });
    expect(res).toMatchObject({ status: "completed", output: 2 });
    expect(counter.calls).toBe(2); // 两个子 agent 各一次 provider 调用

    // journal：1 个 run（completed）
    const runs = db.select().from(workflowRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    // 2 个 parallel-item agent 行，seq 0/1（数组序），completed
    const agents = db.select().from(workflowAgents).where(eq(workflowAgents.runId, runs[0]!.id)).all();
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.seq).sort()).toEqual([0, 1]);
    expect(agents.every((a) => a.callKind === "parallel-item" && a.status === "completed")).toBe(true);

    // 事件序列：started → agent.started×2 → agent.completed×2 → completed
    const types = events.map((e) => e.t);
    expect(types[0]).toBe("workflow.started");
    expect(types[types.length - 1]).toBe("workflow.completed");
    expect(types.filter((t) => t === "workflow.agent.started")).toHaveLength(2);
    expect(types.filter((t) => t === "workflow.agent.completed")).toHaveLength(2);
    // agent.started 的 agentSeq 覆盖 {0,1}
    const seqs = events
      .filter((e) => e.t === "workflow.agent.started")
      .map((e) => (e as { agentSeq: number }).agentSeq)
      .sort();
    expect(seqs).toEqual([0, 1]);
  });

  test("resume：相同 scriptHash+args 重跑 → 全命中、零 live provider 调用、结果一致", async () => {
    const first = { calls: 0 };
    const journal = new WorkflowJournalService(db);
    const ctx1 = makeWfCtx(promptProvider(first), [], journal);
    const r1 = await createWorkflowRuntime(ctx1).execute(SCRIPT, { seed: 1 });
    expect(r1).toMatchObject({ status: "completed", output: 2 });
    expect(first.calls).toBe(2);

    // 二次跑：同 script + 同 args → ResumePlanner 全命中前缀 → 零 live
    const second = { calls: 0 };
    const ctx2 = makeWfCtx(promptProvider(second), [], journal);
    const r2 = await createWorkflowRuntime(ctx2).execute(SCRIPT, { seed: 1 });
    expect(r2).toMatchObject({ status: "completed", output: 2 });
    expect(second.calls).toBe(0); // resume 命中：不起 live 子跑
    // 两次跑各落一个 run（含可再 resume 的补写 completed 行）
    expect(db.select().from(workflowRuns).all()).toHaveLength(2);
  });

  test("args 变化 → 不命中，重新 live（确定性键 = scriptHash + argsHash）", async () => {
    const c1 = { calls: 0 };
    const journal = new WorkflowJournalService(db);
    await createWorkflowRuntime(makeWfCtx(promptProvider(c1), [], journal)).execute(SCRIPT, { seed: 1 });
    const c2 = { calls: 0 };
    await createWorkflowRuntime(makeWfCtx(promptProvider(c2), [], journal)).execute(SCRIPT, { seed: 2 });
    expect(c2.calls).toBe(2); // argsHash 变 → findResumableRun 不命中 → 全 live
  });
});
```

跑测（预期初 RED，后随实现转绿）：
```bash
bun test packages/core/src/workflow/__tests__/integration-e2e.test.ts
```
> 若红，按 systematic-debugging 定位（不改测试契约）：①seq 非数组序 → resume miss：核对 Task 2 `bindSeqs` 在 `makeParallel` 前同步预分配、Task 4 `run` 据 identity Map 取 seq；②`canonicalJson` 指纹漂移 → 核对 M3 `hash.ts`；③事件序列错 → 核对 Task 4 `events.agentStarted/agentCompleted` 包裹位置；④resume 仍 live → 核对 `findResumableRun(scriptHash, argsHash)` 与 `loadJournal` 命中（M3 Task 3/6 已绿，e2e 经真 runtime 复核）。

### 7.2 VERIFY（里程碑出口全量门）
```bash
bun test packages/core/src/workflow/__tests__/integration-e2e.test.ts
bun run test:core   # = bun test packages/core tests：M0–M6 全量 core 套件 + 顶层集成测全绿
bun run test        # = vitest run：protocol/client-core/web 全量（M4 protocol workflow-events 等）
bun run typecheck   # tsc --noEmit，0 error
bun run check       # biome check .，0 error（含 organizeImports）
```
预期：e2e 3 test 全绿；`bun run test:core` 全绿（serve/runner 接线不破）；`bun run test`（vitest）全绿；类型/lint 干净。

### 7.3 COMMIT
```bash
git add packages/core/src/workflow/__tests__/integration-e2e.test.ts
git commit -m "test(workflow): M6 端到端集成（parallel 经真 Scheduler+真 journal 跑通、事件序列、resume 全命中 — spec §14）

guest await parallel([...]) → 宿主 Promise.all + Scheduler；workflow_runs/workflow_agents 落库
(seq 数组序)；workflow.* 事件序列；相同 scriptHash+args 重跑零 live、结果一致；args 变则重 live。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## M6 验收清单（对照 spec §3/§4/§6/§7/§10/§11/§12 + 两处致命闭合）

- [ ] **F1 闭合（guest 原语注入）**：`runtime.ts` PRELUDE 绑 `parallel`/`pipeline`/`workflow`（各一次 `newAsyncifiedFunction` 挂起，JSON 进出）+ `budget` 同步全局（`{total,spent(),remaining()}`）；`primitives.ts` `makeWorkflowPrimitives(ctx,args,wiring)` 把抛错桩/no-op 换成真实 `makeParallel(scheduler,run)`/`makePipeline`/`workflow()`/`budget`——**guest `await parallel([...specs])` 真经宿主 `Promise.all`+Scheduler 跑通**（Task 1/2/7）；严守 §2.1 单挂起（收可序列化规格、挂起期不回调 guest）。
- [ ] **F2 闭合（集成运行时）**：`createWorkflowRuntime(ctx)` 组合 M1 runtime/runSubagent + M2 Scheduler/TokenBudget/makeParallel/makePipeline + M3 makeJournaledRun/resume + M4 events/bubblingApproval/interrupt；分配单调 `agentSeq`（=journal seq=事件 agentSeq）；发 `workflow.*`（含 guest `phase()`→`workflow.phase`，经派生 ctx 接 `events.phase`——createWorkflowRuntime 唯一接线点）；M1 `runSubagent(spec,ctx)` 适配为 M0 `RunSubagent` 端口（cwd/bubbling/onUsage 经闭包注入，signal 捕获）（Task 4）。
- [ ] **onUsage→budget.charge**：`WorkflowContext.onUsage?` 追加（additive）；`runSubagent` 穿透 `ctx.onUsage`→`LoopDeps.onUsage`；`createWorkflowRuntime` 注入 `(u)=>budget.charge(u.inputTokens+u.outputTokens)`（query-loop.ts onUsage 真实存在）（Task 3/4）。
- [ ] **per-subagent sandbox 隔离接缝**：`deriveChildCwd` 默认继承父 cwd、`isolation:"worktree"` 派生独立子工作区 cwd（并发子互异；物理置备按 §15 推后）（Task 4）。
- [ ] **workflow() 一层内联**：经 `ctx.store.load` 载命名脚本、单层递归 `createWorkflowRuntime(childCtx).execute`、`depth` 守卫（`>1` 抛错）（Task 4）。
- [ ] **确定性桩**：无参 `new Date()` PRELUDE 桩抛错；`Date.now`/`Math.random` 仍桩；时间/种子经 `args` 注入（spec §7）（Task 1）。
- [ ] **公开入口 + index 权威**：`runWorkflow(scriptOrName,args,ctx:WorkflowContext)`=`resolveWorkflowSource`+`createWorkflowRuntime.execute`；`index.ts` 汇总 M1–M6 全部导出（唯一权威）（Task 5）。
- [ ] **生产接线**：`run_workflow` 注入接缝 reconcile 为 per-call `launch(source,args,toolCtx)`（进程单例无法预捕获 per-run 会话/信号）；`serve.ts` 注册主 agent `run_workflow` + 子 agent executeTool 不含 workflows（防二级嵌套，§1/§10）+ `emit` 绑父会话主流（§8）+ `callProvider` 经 M2 共享限流（§6）+ `signal`=父 turn 信号（§10）（Task 6）。
- [ ] **端到端**：guest `parallel([{prompt:'a'},{prompt:'b'}]); rs.length` 经真 Scheduler 跑通、journal 落 `workflow_runs`/`workflow_agents`（seq 数组序）、`workflow.*` 序列正确、resume 重放命中（零 live）（Task 7）。
- [ ] **共享类型纪律**：除 `WorkflowContext.onUsage?` additive 追加外，M6 全程 import 自 `./types`，无重声明；状态词 `completed|failed|interrupted`（无 `cancelled`）。
- [ ] **工具链卫生**：逐 Task `bun test`→`bun run typecheck`→`bun run check`；里程碑出口 `bun run test:core` + `bun run test`（vitest）全量回归绿。

### spec 覆盖对照

| spec 条款 | 要求 | M6 落点 |
|---|---|---|
| §3 公开入口 | `runWorkflow(scriptOrName,args,ctx)` + index 暴露 | Task 5 |
| §4 原语全集注入 guest | parallel/pipeline/workflow/budget 真实注入 | Task 1（PRELUDE/install）+ Task 2（装配）|
| §6 调度/限流/budget/sandbox | Scheduler + onUsage→budget.charge + 共享限流 + per-subagent cwd | Task 3/4/6（限流复用 M2 wrap）|
| §7 journal/resume/确定性 | journal 落库 + resume 命中 + 无参 Date 桩 | Task 1/4/7 |
| §10 失败/中断/安全 | 失败→null、run-fatal 冒泡、中断扇出、子 agent 不见 run_workflow | Task 4/6 |
| §11 量子消费者 | gate-circuit.workflow.js 经 runWorkflow/store 跑 | Task 5/6（store+launch 接线）|
| §12 收口 | M6 装配全链路 | Task 1–7 |
| §2.1 asyncify 单挂起 | 收规格非闭包、挂起期不回调 guest、一次性回灌 | Task 1/2（贯穿）|

---

## 已知收尾项与风险（执行前必读）

本计划经独立对抗式校验判定 ship-ready；以下 3 项为校验暴露的跨里程碑收尾点，**不静默省略**，执行到对应里程碑时处理：

1. **[风险·M6 Task1/Task4 须 RED 优先验证] 宿主 async 原语 reject 是否在 guest 内呈现为可捕获异常。** M6 的 run-fatal 冒泡（abort/budget/backstop）、`workflow()` depth>1 守卫、子 workflow 失败抛错，均依赖 `newAsyncifiedFunction` 回调 reject → guest 内 `try/catch` 可捕获。但 M1 runtime 从未测过此语义（M1 的 `agent` 失败归一为 `null` 而非 reject）。**实现 M6 时先写一个 RED 用例验证「宿主拒绝 → guest 抛异常」**；若不成立，在 M1 `installPrimitives` 的 asyncified 包装内 `catch` 并以哨兵 `{ __wfFatal: msg }` JSON 回灌，PRELUDE 包装层据此 `throw`。这是 M6 错误路径正确性的前提。

2. **[完整性·spec §8 下钻链路] `workflow_agents.subTurnId` 当前恒为 null。** M0 `recordAgentStart` 有可选 `subTurnId`、M3 schema 有该列，但 M1 `runSubagent` 内部生成的子 turnId（`wf-${newId()}`）未对外暴露，M6 journaled-run 调用未传 → 进度树「下钻单 agent 子 turn」未建立。修：M1 `runSubagent` 返回/回调子 turnId → M6 run 适配经 RunCtx 透传给 `makeJournaledRun`→`recordAgentStart.subTurnId`（跨 M1/M3/M6 小改）。

3. **[增强·非阻塞] per-agent 级取消未接线。** M4 `deriveChildSignal` 在 M6 未用于单 agent 取消（当前 run 级 `ctx.signal` 直传，**run 级中断扇出已满足 spec §10**）。如需取消单个在飞 agent：在 M2 `Scheduler.submit` 内 `deriveChildSignal(opts.signal)` 并把派生 signal 传给 task，backstop/限流收敛时 `abort()`；否则 `deriveChildSignal` 作为预留接缝可接受。
