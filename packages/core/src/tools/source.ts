// source.ts — ToolSource 抽象层（spec §3）
// agent core 拥有；实现完成后冻结。
// MCP/skills 模块在真实实现落地前可依赖 FakeSource 作测试桩。

import type { Tool } from "@arclight/protocol";
import { ToolRegistry } from "./registry";

// ─── 基础类型 ────────────────────────────────────────────────────────────────

/** 每次 source.list() / contribute() 调用的最小会话上下文。
 *  字段对应 runner.ts startTurn 时已知的最小集合（sessionId / cwd / signal）。
 *  MCP source 可据 sessionId 建立 per-session 连接；skills source 可据 cwd 筛选可用清单。 */
export type SessionCtx = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
};

/** 提示词注入片段（contribute() 返回类型）。
 *  重要约束：系统提示词由 makeCallProvider 单点持有，runner.ts 注释 line 21 明确禁止
 *  runner 重组（"system prompt 在 provider profile 单点注入，runner 不重复拼装"）。
 *  因此 runner 将片段作 role:"user" 上下文消息注入 LoopState.messages
 *  （与 RepoMap / 记忆注入完全同口径）。 */
export type PromptFragment = {
  /** 注入内容（纯文本；Markdown 可用）。注入方式：role:"user" 上下文消息（非系统提示词——系统提示词由 ProviderManager 单点持有）。 */
  readonly content: string;
  /** 可选调试标签（"skills-list" 等）；runner 不作业务处理 */
  readonly tag?: string;
};

// ─── ToolSource 接口（spec §3 verbatim）────────────────────────────────────

/** 工具来源抽象（spec §3 verbatim interface）。
 *  已实现：BuiltinSource（本文件）/ FakeSource（测试桩）。
 *  待实现：McpSource（id="mcp:<server>"）/ SkillsSource（id="skills"）。 */
export interface ToolSource {
  /** 来源标识："builtin" | "mcp:<server>" | "skills" */
  readonly id: string;
  /** 异步枚举工具列表。MCP source 在此建立连接并拉取 server 工具定义。 */
  list(ctx: SessionCtx): Promise<Tool<unknown, unknown>[]>;
  /** 可选：向提示词注入片段（skills source 用于渐进披露可用 skill/workflow 清单）。
   *  调用顺序保证：contribute() 在同一 session/turn 内 list() 之后被调用。
   *  若实现需在 list() 中做文件系统扫描等探查（如 skills source），应将探查结果缓存至
   *  实例状态，contribute() 直接读缓存——禁止在 contribute() 内重复执行探查。 */
  contribute?(ctx: SessionCtx): PromptFragment | undefined;
  /** 可选：释放资源（MCP source 在此断连）。 */
  dispose?(): Promise<void>;
}

// ─── 内置工具来源 ────────────────────────────────────────────────────────────

/** BuiltinSource：包装一组已有工具的 id="builtin" 来源。
 *  serve.ts 传入全部 builtin tools；子 agent 可传入受限集（排除 run_workflow 等）。
 *  设计说明：不内部 import 各 builtin 常量——调用方（serve.ts / 测试）负责传入工具列表，
 *  使 source.ts 与具体 builtin 实现解耦（builtin/ 下可自由增删工具，无需改本文件）。 */
export class BuiltinSource implements ToolSource {
  readonly id = "builtin" as const;

  constructor(private readonly tools: readonly Tool<unknown, unknown>[]) {}

  list(_ctx: SessionCtx): Promise<Tool<unknown, unknown>[]> {
    // 返回浅拷贝：防止外部 mutation 影响内部状态
    return Promise.resolve(this.tools.slice());
  }

  // 无 contribute()：内置工具不向提示词注入额外片段
}

// ─── 测试桩 ──────────────────────────────────────────────────────────────────

/** FakeSource：满足 ToolSource 接口的最小测试桩（spec §3 step 4）。
 *  MCP/skills 模块在真实实现落地前可 import 本桩；disposeCount 供断言资源释放语义。 */
export class FakeSource implements ToolSource {
  readonly id: string;
  private readonly _tools: readonly Tool<unknown, unknown>[];
  private readonly _fragment: PromptFragment | undefined;
  /** dispose() 被调用次数；测试可断言 */
  public disposeCount = 0;

  constructor(
    opts: {
      id?: string;
      tools?: readonly Tool<unknown, unknown>[];
      fragment?: PromptFragment;
    } = {},
  ) {
    this.id = opts.id ?? "fake";
    this._tools = opts.tools ?? [];
    this._fragment = opts.fragment;
  }

  list(_ctx: SessionCtx): Promise<Tool<unknown, unknown>[]> {
    return Promise.resolve(this._tools.slice());
  }

  contribute(_ctx: SessionCtx): PromptFragment | undefined {
    return this._fragment;
  }

  async dispose(): Promise<void> {
    this.disposeCount++;
  }
}

// ─── 组合工具 ────────────────────────────────────────────────────────────────

/** N 个 ToolSource 合并进一个 ToolRegistry（spec §3 "loop 在会话开始时把 N 个 source 组合"）。
 *  同名工具：后来的 source 覆盖先来的（与 ToolRegistry.register 行为一致）。
 *  设计说明：本函数住在 source.ts（而非作为 ToolRegistry 的静态方法），
 *  以保持 source.ts → registry.ts 单向依赖，避免 registry.ts → source.ts 反向 import 形成环。
 *  runner.ts 在首个 queryLoop 轮次之前调用本函数。 */
export async function composeSources(
  sources: readonly ToolSource[],
  ctx: SessionCtx,
): Promise<ToolRegistry> {
  const reg = new ToolRegistry();
  // 并发拉取所有 source 的工具列表（消除 N 个 MCP source 串行建连延迟）。
  // 按 source 顺序注册结果以维持后来者覆盖（last-wins）语义。
  const results = await Promise.all(sources.map((s) => s.list(ctx)));
  for (const tools of results) {
    for (const tool of tools) {
      reg.register(tool);
    }
  }
  return reg;
}

/** 从 N 个 ToolSource 收集 contribute() 非 undefined 返回值（保序）。
 *  runner.ts 将结果逐条注入为 role:"user" 消息
 *  （在 RepoMap/记忆注入之后、用户消息之前）。 */
export function collectFragments(
  sources: readonly ToolSource[],
  ctx: SessionCtx,
): PromptFragment[] {
  const frags: PromptFragment[] = [];
  for (const source of sources) {
    const frag = source.contribute?.(ctx);
    if (frag !== undefined) frags.push(frag);
  }
  return frags;
}
