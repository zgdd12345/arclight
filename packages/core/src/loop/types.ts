import type { ArcEvent, Tool, ToolErrorEnvelope } from "@arclight/protocol";
import type { DraftEvent } from "../db/appendEvent";

// queryLoop 契约层（DEV_PLAN §2.1）。全部依赖注入：单元测全 mock，无需 HTTP server / 真实 API。

// ── LLM 消息（append-only，护 prompt cache）──
export type LlmTextMessage = { role: "system" | "user" | "assistant"; content: string };
export type LlmAssistantToolUse = {
  role: "assistant";
  content: string;
  toolCalls: { callId: string; name: string; args: unknown }[];
};
export type LlmToolResult = {
  role: "tool";
  callId: string;
  name: string;
  /** 工具输出 preview 或 5 键 envelope JSON（失败回灌喂反射） */
  content: string;
  isError: boolean;
};
export type LlmMessage = LlmTextMessage | LlmAssistantToolUse | LlmToolResult;

// ── provider 原语（callProvider 是唯一触达 "ai" 的边界）──
export type ProviderStreamPart =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callId: string; name: string; rawArgs: unknown };

export type ProviderToolCall = { callId: string; name: string; rawArgs: unknown };

export type ProviderResult = {
  text: string;
  toolCalls: ProviderToolCall[];
  /** "length"=被 maxOutputTokens 截断（部分答案仍交付，但必须可观测，不得静默） */
  finishReason: "stop" | "tool-calls" | "aborted" | "error" | "length";
  /** finishReason="error" 时有效 */
  retryable?: boolean;
  errorMessage?: string;
  /** cacheReadTokens/cacheWriteTokens：prompt cache 命中/写入（缺省 0） */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};

/** 给 provider 的工具形状：只有 schema，绝无 execute（不变式：工具执行 0% 交 AI SDK） */
export type ProviderToolSchema = { name: string; description: string; inputSchema: unknown };

export type CallProvider = (
  messages: readonly LlmMessage[],
  tools: readonly ProviderToolSchema[],
  signal: AbortSignal,
) => AsyncGenerator<ProviderStreamPart, ProviderResult>;

// ── 审批接缝（U4：完整状态机——pending/allowed/denied/expired/cancelled）──
// errorClass 让策略层细分 deny 原因（DENIED/EXPIRED/PERMISSION_DENIED）；缺省 APPROVAL_DENIED。
export type ApprovalDecision =
  | { decision: "allow" }
  | {
      decision: "deny";
      reason: string;
      errorClass?: "APPROVAL_DENIED" | "APPROVAL_EXPIRED" | "PERMISSION_DENIED";
    };
export type ApprovalSeam = {
  check(
    tool: Tool<unknown, unknown>,
    args: unknown,
    ctx: LoopToolContext,
  ): Promise<ApprovalDecision>;
};

export type LoopToolContext = {
  sessionId: string;
  turnId: string;
  callId: string;
  cwd: string;
  signal: AbortSignal;
  emitProgress: (chunk: string, stream: "stdout" | "stderr") => void;
};

// ── 工具注册表接口（实现见 tools/registry.ts）──
export type ExecutedToolResult = {
  callId: string;
  name: string;
  /** 成功：投影后 preview；失败：5 键 envelope */
  output:
    | { ok: true; preview: string; spillRef?: string }
    | { ok: false; envelope: ToolErrorEnvelope };
};

export interface ToolRegistryLike {
  schemas(): ProviderToolSchema[];
  get(name: string): Tool<unknown, unknown> | undefined;
}

// ── loop 状态与依赖 ──
export type LoopState = {
  sessionId: string;
  turnId: string;
  cwd: string;
  messages: LlmMessage[]; // append-only
};

export type LoopDeps = {
  /** appendEvent 包装：落库与 yield 同处（emit 返回已 stamped 事件，loop 原样 yield） */
  emit: (draft: DraftEvent) => ArcEvent;
  callProvider: CallProvider;
  registry: ToolRegistryLike;
  approvals: ApprovalSeam;
  /** 执行单个工具（含 zod 校验/沙箱/输出投影），永不 throw——失败编码进 envelope */
  executeTool: (
    tool: Tool<unknown, unknown>,
    rawArgs: unknown,
    ctx: LoopToolContext,
  ) => Promise<ExecutedToolResult["output"]>;
  signal: AbortSignal;
  maxRetries: number;
  retryDelayMs?: (attempt: number) => number; // 测试注入 0
  readConcurrency?: number; // 默认 8
  /** 反射闭环上限（DEV_PLAN §2.3 ④）：连续 N 轮工具全失败即如实上报停止，不无限自校正。默认 3。 */
  maxReflections?: number;
  /** usage 回传钩子（DEV_PLAN §3.4 可观测）：每轮 provider usage 落库（含 prompt cache 命中/写入） */
  onUsage?: (u: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }) => void;
  /** 写工具执行前后的检查点钩子（DEV_PLAN §2.3 ③）。写工具 = !isReadOnly。 */
  checkpoint?: {
    pre(toolName: string): Promise<void>;
    post(toolName: string): Promise<void>;
  };
  /** 压缩钩子（DEV_PLAN §2.1）。在两次 provider 调用之间检查并执行。绝不在 tool 配对未完成时调用。
   *  契约（BUG4 修复后）：epoch++ 与 context.compacted 事件由本钩子在【同一 SQLite 事务】内原子落库，
   *  并在提交后扇出 bus——loop 不再单独 emit context.compacted（杜绝崩溃半完成态卡死 STALE_EPOCH）。
   *  返回 true 表示本轮已压缩。 */
  compaction?: {
    maybeCompact(messages: LlmMessage[]): Promise<boolean>;
  };
};

export type TurnOutcome = { status: "completed" | "failed" | "interrupted" };
