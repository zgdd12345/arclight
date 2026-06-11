import { z } from "zod";
import type { CapabilityProfile } from "./capability";
import type { ArcEvent } from "./events";

// ── 风险分级（P0 工具契约 §C）──
export const RiskClassSchema = z.enum(["read", "write", "irreversible", "funds"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const RiskTierSchema = z.enum(["safe", "confirm", "admin_only"]);
export type RiskTier = z.infer<typeof RiskTierSchema>;

// ── 工具元数据 ──
export const ToolMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  isReadOnly: z.boolean(),
  isConcurrencySafe: z.boolean(),
  riskTier: RiskTierSchema,
  riskClass: RiskClassSchema,
  timeoutMs: z.number().int().positive(),
  maxResultSizeBytes: z.number().int().positive(),
});
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
