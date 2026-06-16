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
