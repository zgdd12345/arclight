import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ArcEvent } from "@arclight/protocol";
import variant from "@jitl/quickjs-ng-wasmfile-release-asyncify";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSAsyncWASMModule,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { isAbortError } from "../loop/concurrency";
import { BubblingApprovalSeam } from "./bubbling-approval";
import { WorkflowEvents } from "./events";
import { argsHash, scriptHash } from "./hash";
import { terminalEvent } from "./interrupt";
import { makeJournaledRun, type RunOneSpec } from "./journaled-run";
import { makeWorkflowPrimitives, type PrimitiveWiring } from "./primitives";
import { ResumePlanner } from "./resume";
import { BudgetExceededError, Scheduler, SchedulerExhaustedError, TokenBudget } from "./scheduler";
import { resolveWorkflowSource, WORKFLOW_NAME_RE } from "./store";
import { runSubagent } from "./subagent";
// 共享契约类型自 M0 单一权威来源；runtime.ts 绝不本地重声明。
import {
  type AgentSpec,
  type CallKind,
  type RunScriptResult,
  type RunStatus,
  type RunSubagent,
  type SpecResult,
  type StageSpec,
  WorkflowApiError,
  type WorkflowContext,
  type WorkflowPrimitives,
  type WorkflowResult,
  type WorkflowRuntime,
  type WorkflowStorePort,
} from "./types";

// 异步 wasm 模块按进程缓存：asyncify 变体加载一次复用（与 provider-manager 单例同构）。
let modulePromise: Promise<QuickJSAsyncWASMModule> | undefined;
function getAsyncModule(): Promise<QuickJSAsyncWASMModule> {
  if (!modulePromise) {
    modulePromise = newQuickJSAsyncWASMModuleFromVariant(variant);
    modulePromise.catch(() => {
      modulePromise = undefined;
    });
  }
  return modulePromise;
}

// 宿主↔guest 跨界一律走「字符串」；对象在 guest 内 JSON 编解码，宿主侧零手工 handle 构造。
//
// asyncify 设计原则：newAsyncifiedFunction 将宿主 async 转为 guest 侧同步调用——
// WASM 在 asyncify 挂起期间宿主跑完 queryLoop，恢复后 __agent() 对 guest 同步返回字符串。
// 因此 agent 在 PRELUDE 中定义为普通同步函数（无 async/await）；
// guest 脚本直接调用 agent(...) 得到结果，不需要顶层 await。
// （QuickJS-ng global eval 模式不支持 top-level await，与上述设计完全一致。）
//
// M6 F1-a 扩展：绑全 M0 WorkflowPrimitives 8 项（agent/log/phase/args 保持 M1 不变）。
// NOTE: QuickJS global eval 模式（evalCodeAsync 默认）在解析层拒绝 top-level await（"expecting ';'"），
// 因此 parallel/pipeline/workflow 均为**同步**包装——asyncify 单挂起机制使 __parallel/__pipeline/__workflow
// 对 guest 透明同步，与 __agent 完全对称。guest 脚本无需也不可在顶层写 await。
const PRELUDE = `
globalThis.args = JSON.parse(__argsJson);
globalThis.log = (m) => { __log(String(m)); };
globalThis.phase = (t) => { __phase(String(t)); };
globalThis.agent = (prompt, opts) =>
  JSON.parse(__agent(String(prompt), JSON.stringify(opts === undefined ? null : opts)));
globalThis.parallel = (specs) =>
  JSON.parse(__parallel(JSON.stringify(specs === undefined ? [] : specs)));
globalThis.pipeline = (items, ...stages) =>
  JSON.parse(__pipeline(JSON.stringify({ items: items === undefined ? [] : items, stages })));
globalThis.workflow = (name, wfArgs) =>
  JSON.parse(__workflow(String(name), JSON.stringify(wfArgs === undefined ? null : wfArgs)));
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

// M1 bindingss: args/agent/log/phase; M6 F1-a 追加: __parallel/__pipeline/__workflow + budget 桥接。
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

  // newAsyncifiedFunction: 宿主 async → guest 同步（asyncify wasm 挂起机制）。
  // 宿主完整跑完 p.agent()（含嵌套 queryLoop），期间绝不回调 guest（§2.1 单挂起约束）。
  // 返回的 newString handle 由 QuickJS 接管所有权，宿主不 dispose。
  const agentFn = context.newAsyncifiedFunction("__agent", async (promptH, optsH) => {
    const prompt = context.getString(promptH);
    const optsJson = context.getString(optsH); // guest 始终传 JSON 字符串
    const opts =
      optsJson === "null" ? undefined : (JSON.parse(optsJson) as Omit<AgentSpec, "prompt">);
    const result = await p.agent(prompt, opts);
    return context.newString(JSON.stringify(result ?? null));
  });
  context.setProp(context.global, "__agent", agentFn);
  agentFn.dispose();

  // ── M6 F1-a：parallel/pipeline/workflow（各一次 asyncify 挂起，宿主侧并发跑完，绝不回调 guest）──
  const parallelFn = context.newAsyncifiedFunction("__parallel", async (specsH) => {
    const specs = JSON.parse(context.getString(specsH)) as AgentSpec[];
    const results = await p.parallel(specs);
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

  // ── M6 F1-a：budget 同步桥接（total 快照于 PRELUDE 求值时；spent/remaining 实时）──
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
}

export async function runWorkflowScript(
  script: string,
  primitives: WorkflowPrimitives,
  opts?: { freshModule?: boolean },
): Promise<RunScriptResult> {
  // 嵌套 workflow() 在父 guest asyncify 挂起期内运行；asyncify 的 suspend/resume 栈是 WASM 实例级
  // （ASYNCIFY_STACK_SIZE 为模块全局），共用进程缓存模块的嵌套 run 会破坏父挂起态。故嵌套 run 取
  // 独立 WASM 实例（各自 asyncify 栈，互不串扰）；顶层 run 仍复用进程缓存模块（asyncify 变体加载昂贵）。
  // 嵌套模块在 context.dispose() 后无引用，随 GC 回收（模块无显式 dispose API）。
  const mod = opts?.freshModule
    ? await newQuickJSAsyncWASMModuleFromVariant(variant)
    : await getAsyncModule();
  // mod.newContext() creates a context that owns its runtime; context.dispose() cleans up both
  // in the correct order. Bun 1.3.12 has a HostRef cleanup bug on the separate
  // mod.newRuntime() + runtime.newContext() path (async fn HostRef id = INT_MIN).
  const context = mod.newContext();
  try {
    installPrimitives(context, primitives);
    // PRELUDE failure is a programming error and intentionally propagates rather than normalizing to {status:"failed"}.
    // 注入序 + 确定性桩：同步 eval（无 await）。prelude 为可信代码。
    context.unwrapResult(context.evalCode(PRELUDE)).dispose();

    let valueHandle: QuickJSHandle;
    try {
      // global eval 模式：返回最后表达式完成值（completion value）。
      // asyncify 挂起使宿主 async 在 guest 侧透明同步；无 top-level await 需求。
      valueHandle = context.unwrapResult(await context.evalCodeAsync(script));
    } catch (e) {
      // 语法错误 / guest 顶层 throw 归一为结构化失败（unwrapResult 抛 QuickJSUnwrapError）
      return { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    const output = context.dump(valueHandle) as unknown;
    valueHandle.dispose();
    return { status: "completed", output };
  } finally {
    context.dispose(); // disposes context + its owned runtime
  }
}

// ── M6 F2：createWorkflowRuntime —— 集成运行时（闭合 F2）────────────────────────

// 缺省 token budget 上限（ctx.budgetTotal 未给时）：足够大、避免误触硬上限，又非 Infinity
// （TokenBudget 要求有限正数）。
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
  return (
    e instanceof BudgetExceededError || e instanceof SchedulerExhaustedError || isAbortError(e)
  );
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
      const budget =
        ctx.sharedBudget ??
        new TokenBudget(
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
        budget.charge(u.inputTokens + u.outputTokens);

      // 子 agent 叙事事件落各自子 turn（spec §8「可下钻单 agent 的子 turn」），不混入父会话进度总线
      // （workflow.* 经 ctx.emit 落父会话）。父 emit 经 appendEvent 按 draft.sessionId 落库，而子 agent
      // 用独立 wf-session——其会话行物理置备 + 子 turn 持久化属生产接线（serve.ts），此处先以静默 sink
      // 收口，保证父进度总线只含 §8 六类 workflow.* 事件（且避免子事件触发 SessionNotFoundError）。
      const childEmit: WorkflowContext["emit"] = (draft) =>
        ({ ...draft, seq: 0, ts: 0, epoch: 0 }) as ArcEvent;

      // ── F2 适配：M1 runSubagent(spec, ctx) → journaling 内层 RunOneSpec（失败以 throw 表达）──
      const runLive: RunOneSpec = async (spec) => {
        const s = spec as AgentSpec;
        const childCtx: WorkflowContext = {
          ...ctx,
          signal: ctx.signal, // run 级信号；runSubagent 内部再 AbortSignal.any 派生子信号（M1）
          cwd: deriveChildCwd(ctx, s),
          approvals: bubbling,
          emit: childEmit,
          onUsage: chargeUsage,
        };
        const r = await runSubagent(s, childCtx);
        if (r.ok) return r.value;
        throw new SubagentFailure(r.status, r.error);
      };
      const journaled: RunOneSpec = ctx.journal
        ? makeJournaledRun({ journal: ctx.journal, runId, planner, runLive })
        : runLive;

      // ── F2 适配：journaled + 事件 → M0 RunSubagent 端口（makeParallel/makePipeline/agent 共用）──
      const run: RunSubagent = async (spec, signal) => {
        const bound = seqMap.get(spec) ?? {
          seq: seqCounter++,
          callKind: "pipeline-item" as CallKind,
        };
        const agentId = ctx.newId?.() ?? randomUUID();
        events.agentStarted({ agentId, role: spec.label ?? bound.callKind, agentSeq: bound.seq });
        try {
          const value = await journaled(spec, { seq: bound.seq, callKind: bound.callKind });
          events.agentCompleted({ agentId, status: "ok" });
          return { ok: true, value: value as SpecResult };
        } catch (e) {
          events.agentCompleted({ agentId, status: "failed" });
          if (isFatalError(e)) throw e; // 中断 / budget / backstop 冒泡（spec §10）
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
        if (!ctx.store) {
          throw new WorkflowApiError("workflow() requires a store to load named workflows");
        }
        const loaded = ctx.store.load(name); // 不存在则抛（store 收口）
        const child = createWorkflowRuntime({
          ...ctx,
          depth: (ctx.depth ?? 0) + 1,
          sharedBudget: budget, // thread run-wide budget into nested run (no 2x overspend)
        });
        const res = await child.execute(loaded.source, wfArgs ?? {});
        if (res.status === "completed") return res.output ?? null;
        throw new WorkflowApiError(res.error ?? `sub-workflow "${name}" ${res.status}`);
      };

      // ── 装配 guest 原语全集（F1 wiring）+ 跑脚本 ──
      // phase() 经派生 ctx 接 events.phase（spec §8 workflow.phase）——createWorkflowRuntime 是唯一接线点：
      // makeWorkflowPrimitives 的 phase 读 ctx.onPhase，而 createWorkflowRuntime/serve.ts 均不设 onPhase，
      // 若不在此接线则 guest phase() 静默无事件（缺 §8 六事件之一）。log() 仍走 ctx.onLog（§8 无 workflow.log）。
      // 注：仅 phase/log 读此 ctx 参；run/agent 经 wiring 闭包捕获的原始 ctx（见上 runLive/run），
      // 故派生 ctx 不影响 subagent 路径。
      const primitivesCtx: WorkflowContext = {
        ...ctx,
        onPhase: (title: string) => {
          events.phase(title);
          ctx.onPhase?.(title);
        },
      };
      const wiring: PrimitiveWiring = {
        scheduler,
        run,
        workflow: workflowRunner,
        budget,
        bindSeqs,
      };
      const primitives = makeWorkflowPrimitives(primitivesCtx, args, wiring);
      // 嵌套 run（depth>0）取独立 WASM 实例：避免与父 asyncify 挂起态串栈（见 runWorkflowScript 注）。
      const scriptResult = await runWorkflowScript(source, primitives, {
        freshModule: (ctx.depth ?? 0) > 0,
      });

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

/**
 * 公开入口（spec §3 / M0 契约）。scriptOrName：slug → 命名 workflow（从 ctx.store 载入，未存抛错）；
 * 其余 → 临场合成内联源码（原样）。解析后委托 createWorkflowRuntime(ctx).execute。
 */
export async function runWorkflow(
  scriptOrName: string,
  args: unknown,
  ctx: WorkflowContext,
): Promise<WorkflowResult> {
  if (WORKFLOW_NAME_RE.test(scriptOrName.trim()) && !ctx.store) {
    throw new Error("runWorkflow: ctx.store is required to run a named workflow");
  }
  const source = resolveWorkflowSource(scriptOrName, ctx.store as WorkflowStorePort);
  return createWorkflowRuntime(ctx).execute(source, args);
}
