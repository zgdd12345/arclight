import { isAbortError } from "../loop/concurrency";
import { BudgetExceededError, type Scheduler, SchedulerExhaustedError } from "./scheduler";
import { runSubagent } from "./subagent";
// 共享契约类型自 M0；WorkflowApiError 亦自 M0。命名导入按 biome 排序（WorkflowApiError 在 WorkflowContext 之前）。
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

// M0 契约：primitives.ts 须 re-export WorkflowApiError 使 guest 侧 import { WorkflowApiError } from "../primitives" 可解析。
export { WorkflowApiError } from "./types";

// ── run-fatal 判断（scheduler 抛出的三类致命错，必须冒泡到脚本顶层）──────────────
/** run-fatal：中断 / budget 硬上限 / backstop，不可被吞成 null（spec §10）。 */
function isFatal(e: unknown): boolean {
  return (
    e instanceof BudgetExceededError || e instanceof SchedulerExhaustedError || isAbortError(e)
  );
}

/**
 * parallel：barrier，宿主侧 Promise.all 真并发（spec §4/§10）。
 * §2.1 单挂起：specs 是已 marshal 的纯数据（无 guest 闭包），全部并发跑完后一次性回灌，
 * 期间绝不再入 guest。单项 subagent 失败 → null（不拖垮整体）；run-fatal → 抛出。
 *
 * guest 绑定（M1 runtime.ts）：ctx.newAsyncifiedFunction("parallel", marshal(makeParallel(...)))
 *   —— 整个 Promise.all 在一次 asyncify 挂起内完成，resolve 后一次性把纯数组回灌 guest。
 */
export function makeParallel(scheduler: Scheduler, runSubagentFn: RunSubagent) {
  return async function parallel(specs: AgentSpec[]): Promise<(SpecResult | null)[]> {
    if (!Array.isArray(specs)) {
      throw new WorkflowApiError("parallel(specs): specs must be an array of AgentSpec");
    }
    // validateAgentSpec 同步校验（闭包守卫 + 空 prompt）——异常在 Promise.all 前同步抛出，
    // async 函数将其包为 rejected promise，调用方 await 时获得 WorkflowApiError。
    const validated = specs.map((s, i) => validateAgentSpec(s, `parallel[${i}]`));
    return Promise.all(
      validated.map((spec) =>
        scheduler.submit(async (signal): Promise<SpecResult | null> => {
          try {
            const r = await runSubagentFn(spec, signal);
            return r.ok ? r.value : null; // 统一 SubagentResult：失败分支不读 status（spec §10）
          } catch (e) {
            if (isFatal(e)) throw e; // 中断 / budget / backstop 冒泡，不被吞
            return null; // 其余 subagent 内部错 → null（spec §10）
          }
        }),
      ),
    );
  };
}

/**
 * pipeline：无 barrier 流水线。每个 item 独立穿过 stages（item 间并发，受调度池限流）；
 * 某 stage 失败/抛错 → 该 item 落 null 并跳过其余 stage（per-item 隔离）。
 * stage.prompt 的 ${prev}/${item}/${index} 由宿主声明式插值（path-get，无 guest 再入，符合 §2.1）。
 */
export function makePipeline(scheduler: Scheduler, runSubagentFn: RunSubagent) {
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
    // validateStageSpec 同步校验（闭包守卫 + 空 prompt）——异常在 Promise.all 前同步抛出
    const validated = stages.map((st, i) => validateStageSpec(st, `pipeline.stage[${i}]`));
    return Promise.all(
      items.map((item, index) =>
        runItemThroughStages(scheduler, runSubagentFn, validated, item, index),
      ),
    );
  };
}

async function runItemThroughStages(
  scheduler: Scheduler,
  runSubagentFn: RunSubagent,
  stages: StageSpec[],
  item: unknown,
  index: number,
  preAllocatedSpecs?: AgentSpec[],
): Promise<SpecResult | null> {
  let prev: SpecResult | null = null;
  for (let si = 0; si < stages.length; si++) {
    // si is within bounds by loop condition; noUncheckedIndexedAccess requires explicit assertions.
    // biome-ignore lint/style/noNonNullAssertion: si < stages.length guarantees defined
    const stage = stages[si]!;
    const prompt = interpolate(stage.prompt, { item, index, prev });
    let spec: AgentSpec;
    if (preAllocatedSpecs) {
      // Mutate the pre-bound sentinel so the seqMap lookup (keyed by object identity) resolves
      // to the correct pre-allocated seq.  Fields absent from this stage are left unset;
      // each sentinel starts as { prompt } only, so there is no cross-stage contamination.
      // biome-ignore lint/style/noNonNullAssertion: sentinels.length === stages.length by construction
      const sentinel = preAllocatedSpecs[si]!;
      sentinel.prompt = prompt;
      if (stage.schema !== undefined) sentinel.schema = stage.schema;
      if (stage.tools !== undefined) sentinel.tools = stage.tools;
      if (stage.model !== undefined) sentinel.model = stage.model;
      spec = sentinel;
    } else {
      // exactOptionalPropertyTypes: only spread keys that are defined
      spec = {
        prompt,
        ...(stage.schema !== undefined ? { schema: stage.schema } : {}),
        ...(stage.tools !== undefined ? { tools: stage.tools } : {}),
        ...(stage.model !== undefined ? { model: stage.model } : {}),
      };
    }
    try {
      const r = await scheduler.submit((signal) => runSubagentFn(spec, signal));
      if (!r.ok) return null; // stage 失败 → item 落 null，跳过其余 stage（不读 status）
      prev = r.value;
    } catch (e) {
      if (isFatal(e)) throw e; // 中断 / budget / backstop 冒泡，不被吞
      return null; // stage 意外抛 → item 落 null
    }
  }
  return prev;
}

// ── 声明式插值：仅 ${prev|item|index} 的点路径取值，不支持任意表达式（spec §15）──
const SEGMENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * 将 template 中的 `${...}` 占位符替换为 scope 中对应的值。
 * 仅支持点路径取值（`${item}`、`${index}`、`${prev.field}`）；
 * 拒绝任意表达式，undefined 取值抛 WorkflowApiError。
 */
export function interpolate(
  template: string,
  scope: { item: unknown; index: number; prev: SpecResult | null },
): string {
  return template.replace(/\$\{([^}]*)\}/g, (_match, raw: string) => {
    const path = raw.trim();
    if (path.length === 0) {
      throw new WorkflowApiError(`pipeline interpolation: empty placeholder (\${...})`);
    }
    const value = resolvePath(path, scope as unknown as Record<string, unknown>);
    if (value === undefined) {
      throw new WorkflowApiError(`pipeline interpolation: "\${${path}}" resolved to undefined`);
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function resolvePath(path: string, root: Record<string, unknown>): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (!SEGMENT_RE.test(seg)) {
      throw new WorkflowApiError(
        `pipeline interpolation: invalid segment "${seg}" — only \${prev|item|index} dotted paths allowed (no expressions, spec §15)`,
      );
    }
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur as object, seg))
      return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

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
      ? async (items, ...stages) => {
          if (!Array.isArray(items)) {
            throw new WorkflowApiError("pipeline(items, ...stages): items must be an array");
          }
          if (stages.length === 0) {
            throw new WorkflowApiError("pipeline requires at least one stage");
          }
          const validated = stages.map((st, i) => validateStageSpec(st, `pipeline.stage[${i}]`));
          // Pre-allocate one sentinel AgentSpec per (item × stage) slot in item-major order
          // and synchronously bind them all BEFORE any scheduler.submit.  seqMap in runtime.ts
          // is keyed by object identity; we mutate each sentinel's prompt (and optional fields)
          // just before handing it to `run`, so the pre-bound seq travels intact to journaling.
          const sentinels: AgentSpec[][] = items.map((_, ii) =>
            validated.map((_, si) => ({ prompt: `__pipeline_sentinel_${ii}_${si}` }) as AgentSpec),
          );
          wiring.bindSeqs(sentinels.flat(), "pipeline-item");
          return Promise.all(
            items.map((item, index) =>
              runItemThroughStages(
                wiring.scheduler,
                wiring.run,
                validated,
                item,
                index,
                sentinels[index],
              ),
            ),
          );
        }
      : notUntilM6("pipeline"),
    workflow: wiring?.workflow ?? notUntilM6("workflow"),
    budget: wiring?.budget ?? noopBudget,
  };
}
