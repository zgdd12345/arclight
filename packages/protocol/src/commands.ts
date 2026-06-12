import { z } from "zod";
import { CapabilityProfileSchema } from "./capability";

// ArcCommand 五类（P0 工具契约 §C）。C1: POST /api/commands

export const SubmitInputSchema = z.object({
  text: z.string().min(1),
  agent: z.literal("code"), // 阶段一仅 code agent
  mode: z.enum(["chat", "edit", "test"]).optional(),
  baseEpoch: z.number().int().nonnegative(), // 乐观锁：≠ sessions.epoch → StaleEpochError
});
export type SubmitInput = z.infer<typeof SubmitInputSchema>;

const cmdBase = { v: z.literal(1), commandId: z.string().min(1) };

export const SubmitCommandSchema = z.object({
  ...cmdBase,
  k: z.literal("submit"),
  sessionId: z.string().min(1),
  input: SubmitInputSchema,
});

export const InterruptCommandSchema = z.object({
  ...cmdBase,
  k: z.literal("interrupt"),
  turnId: z.string().min(1),
  reason: z.enum(["user", "abort"]),
});

export const ApproveCommandSchema = z.object({
  ...cmdBase,
  k: z.literal("approve"),
  askId: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
  // once = 仅本次；session = 本会话内记住该工具，后续同工具的 confirm 档自动放行
  // （黑名单仍永远先拦）。缺省 once，向后兼容旧客户端。
  scope: z.enum(["once", "session"]).optional(),
});

export const DeclareCapCommandSchema = z.object({
  ...cmdBase,
  k: z.literal("declareCap"),
  profile: CapabilityProfileSchema,
});

export const ResumeCommandSchema = z.object({
  ...cmdBase,
  k: z.literal("resume"),
  sessionId: z.string().min(1),
  afterSeq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
});

export const ArcCommandSchema = z.discriminatedUnion("k", [
  SubmitCommandSchema,
  InterruptCommandSchema,
  ApproveCommandSchema,
  DeclareCapCommandSchema,
  ResumeCommandSchema,
]);
export type ArcCommand = z.infer<typeof ArcCommandSchema>;
export type ArcCommandKind = ArcCommand["k"];
