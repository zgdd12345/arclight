import { z } from "zod";
import type { CapabilityProfile } from "./capability";
import type { ArcEvent } from "./events";

// ── 风险分级（P0 工具契约 §C）──
export const RiskClassSchema = z.enum(["read", "write", "irreversible", "funds"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const RiskTierSchema = z.enum(["safe", "confirm", "admin_only"]);
export type RiskTier = z.infer<typeof RiskTierSchema>;

// ── 工具元数据 ──
// 能力位（capability）原则：审批/检查点等横切策略据「能力」判定，绝不按 name 特判，
// 否则新工具（如未来的命令执行器）会静默绕过黑名单/检查点。下面两位是 P0 §C 的安全开关：
//   executesShellCommands —— 该工具会执行任意 shell 命令 → 审批 preset 套用 shell 黑名单+风险升级。
//   mutatesWorkspace      —— 该工具可能改写工作区文件 → query-loop 据此打影子 git 检查点（供 /undo /redo）。
// 两位均为可选输入，parse 时回填缺省（executesShellCommands→false 走 fail-safe；
// mutatesWorkspace→!isReadOnly 保持向后兼容）。
export const ToolMetaSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    isReadOnly: z.boolean(),
    isConcurrencySafe: z.boolean(),
    executesShellCommands: z.boolean().optional(),
    mutatesWorkspace: z.boolean().optional(),
    riskTier: RiskTierSchema,
    riskClass: RiskClassSchema,
    timeoutMs: z.number().int().positive(),
    maxResultSizeBytes: z.number().int().positive(),
  })
  .transform((m) => ({
    ...m,
    executesShellCommands: m.executesShellCommands ?? false,
    mutatesWorkspace: m.mutatesWorkspace ?? !m.isReadOnly,
  }));
export type ToolMeta = z.infer<typeof ToolMetaSchema>;

// ── 5 键错误信封：绝不泄 traceback ──
export const ToolErrorClassSchema = z.enum([
  "VALIDATION",
  "PERMISSION_DENIED",
  "APPROVAL_DENIED",
  "APPROVAL_EXPIRED",
  "SANDBOX_UNAVAILABLE",
  "SANDBOX_DENIED",
  "TIMEOUT",
  "CANCELLED",
  "EXEC_FAILED",
  "INTERNAL",
]);
export type ToolErrorClass = z.infer<typeof ToolErrorClassSchema>;

export const ToolErrorEnvelopeSchema = z
  .object({
    status: z.literal("error"),
    tool: z.string(),
    error_class: ToolErrorClassSchema,
    user_message: z.string(),
    retry_allowed: z.boolean(),
  })
  .strict(); // 5 键收口：多余键（如 stack/traceback）一律拒绝
export type ToolErrorEnvelope = z.infer<typeof ToolErrorEnvelopeSchema>;

/** 5 键错误信封工厂——唯一构造点，避免各处手写对象字面量（loop / registry / policy 共用） */
export function makeToolError(
  tool: string,
  error_class: ToolErrorClass,
  user_message: string,
  retry_allowed: boolean,
): ToolErrorEnvelope {
  return { status: "error", tool, error_class, user_message, retry_allowed };
}

// ── 工具执行上下文与接口（运行时类型，不进 zod）──
export type ToolContext = {
  tenantId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  cwd: string;
  capability: CapabilityProfile;
  signal: AbortSignal;
  emit: (e: ArcEvent) => Promise<void>;
};

export type Tool<In, Out> = {
  meta: ToolMeta;
  inputSchema: z.ZodType<In>;
  outputSchema: z.ZodType<Out>;
  execute(input: In, ctx: ToolContext): Promise<Out>;
  toModelOutput?(out: Out): string;
};
