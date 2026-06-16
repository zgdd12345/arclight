import variant from "@jitl/quickjs-ng-wasmfile-release-asyncify";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSAsyncWASMModule,
  type QuickJSHandle,
} from "quickjs-emscripten";
// 共享契约类型自 M0 单一权威来源；runtime.ts 绝不本地重声明。
import type { AgentSpec, RunScriptResult, StageSpec, WorkflowPrimitives } from "./types";

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
): Promise<RunScriptResult> {
  const mod = await getAsyncModule();
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
