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

// 宿主↔guest 跨界一律走「字符串」；对象在 guest 内 JSON 编解码，宿主侧零手工 handle 构造。
//
// asyncify 设计原则：newAsyncifiedFunction 将宿主 async 转为 guest 侧同步调用——
// WASM 在 asyncify 挂起期间宿主跑完 queryLoop，恢复后 __agent() 对 guest 同步返回字符串。
// 因此 agent 在 PRELUDE 中定义为普通同步函数（无 async/await）；
// guest 脚本直接调用 agent(...) 得到结果，不需要顶层 await。
// （QuickJS-ng global eval 模式不支持 top-level await，与上述设计完全一致。）
//
// M1 只绑 agent/log/phase/args；parallel/pipeline/workflow + budget 全局的 PRELUDE 绑定归 M6。
const PRELUDE = `
globalThis.args = JSON.parse(__argsJson);
globalThis.log = (m) => { __log(String(m)); };
globalThis.phase = (t) => { __phase(String(t)); };
globalThis.agent = (prompt, opts) =>
  JSON.parse(__agent(String(prompt), JSON.stringify(opts === undefined ? null : opts)));
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

  // newAsyncifiedFunction: 宿主 async → guest 同步（asyncify wasm 挂起机制）。
  // 宿主完整跑完 p.agent()（含嵌套 queryLoop），期间绝不回调 guest（§2.1 单挂起约束）。
  // 返回的 newString handle 由 QuickJS 接管所有权，宿主不 dispose。
  const agentFn = context.newAsyncifiedFunction("__agent", async (promptH, optsH) => {
    const prompt = context.getString(promptH);
    const optsJson = context.getString(optsH); // guest 始终传 JSON 字符串
    const opts =
      optsJson === "null" ? undefined : (JSON.parse(optsJson) as Record<string, unknown>);
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
  // mod.newContext() creates a context that owns its runtime; context.dispose() cleans up both
  // in the correct order. Bun 1.3.12 has a HostRef cleanup bug on the separate
  // mod.newRuntime() + runtime.newContext() path (async fn HostRef id = INT_MIN).
  const context = mod.newContext();
  try {
    installPrimitives(context, primitives);
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
