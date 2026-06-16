import { isAbortError } from "../loop/concurrency";
import { BudgetExceededError, type Scheduler, SchedulerExhaustedError } from "./scheduler";
import { runSubagent } from "./subagent";
// 共享契约类型自 M0；WorkflowApiError 亦自 M0。命名导入按 biome 排序（WorkflowApiError 在 WorkflowContext 之前）。
import {
  type AgentSpec,
  type Budget,
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
): Promise<SpecResult | null> {
  let prev: SpecResult | null = null;
  for (const stage of stages) {
    const prompt = interpolate(stage.prompt, { item, index, prev });
    // exactOptionalPropertyTypes: only spread keys that are defined
    const spec: AgentSpec = {
      prompt,
      ...(stage.schema !== undefined ? { schema: stage.schema } : {}),
      ...(stage.tools !== undefined ? { tools: stage.tools } : {}),
      ...(stage.model !== undefined ? { model: stage.model } : {}),
    };
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
      throw new WorkflowApiError("pipeline interpolation: empty placeholder (${...})");
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
    if (cur === null || typeof cur !== "object") return undefined;
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
