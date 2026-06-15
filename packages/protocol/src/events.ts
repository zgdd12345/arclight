import { z } from "zod";
import { RiskClassSchema, RiskTierSchema, ToolErrorEnvelopeSchema } from "./tool";

// ArcEvent：内核唯一真相源。不变式（DEV_PLAN §2.1）：
// - loop 是唯一 seq 生产者；yield 顺序 = 持久顺序 = SSE replay 顺序（SSE id: = seq）
// - epoch 仅在压缩边界 +1
// - 持久化所有 UI 重建所需事件；纯心跳 `: heartbeat` 不持久化
// 前端纪律：未知 `t` 静默忽略（forward-compat），故新增事件只能 append。

const base = {
  v: z.literal(1),
  sessionId: z.string().min(1),
  seq: z.number().int().positive(),
  epoch: z.number().int().nonnegative(),
  ts: z.number().int().positive(), // Unix ms
  turnId: z.string().optional(),
};

export const SessionStartedSchema = z.object({ ...base, t: z.literal("session.started") });

export const TurnStartedSchema = z.object({
  ...base,
  t: z.literal("turn.started"),
  turnId: z.string().min(1),
});

export const MessageDeltaSchema = z.object({
  ...base,
  t: z.literal("message.delta"),
  messageId: z.string().min(1),
  role: z.enum(["assistant"]),
  delta: z.string(), // 内核侧 100-250ms 合批
});

// user.message：用户输入回显帧。问答 transcript 的"问"必须落事件流——
// 否则只存在于客户端乐观消息里，刷新/重连/历史回放即丢。turn 准入时单点发出。
export const UserMessageSchema = z.object({
  ...base,
  t: z.literal("user.message"),
  messageId: z.string().min(1),
  text: z.string(),
});

// thinking.delta：模型推理（reasoning/thinking）流。与 message.delta 同源同 messageId，
// 仅声道不同——前端渲染为可折叠"思考过程"披露区，不混入正文。
export const ThinkingDeltaSchema = z.object({
  ...base,
  t: z.literal("thinking.delta"),
  messageId: z.string().min(1),
  delta: z.string(),
});

export const ToolRequestedSchema = z.object({
  ...base,
  t: z.literal("tool.requested"),
  callId: z.string().min(1),
  name: z.string().min(1),
  argsPreview: z.string(),
  riskTier: RiskTierSchema,
  riskClass: RiskClassSchema,
});

export const ToolProgressSchema = z.object({
  ...base,
  t: z.literal("tool.progress"),
  callId: z.string().min(1),
  stream: z.enum(["stdout", "stderr"]),
  chunk: z.string(), // chunk 合批；超大只落 artifact
});

export const ToolOutputSchema = z.object({
  ...base,
  t: z.literal("tool.output"),
  callId: z.string().min(1),
  status: z.enum(["ok", "error"]),
  preview: z.string(), // 前 16KB；完整输出走 spillRef
  spillRef: z.string().optional(), // artifact://<id>
  error: ToolErrorEnvelopeSchema.optional(),
});

export const PermissionAskSchema = z.object({
  ...base,
  t: z.literal("permission.ask"),
  askId: z.string().min(1),
  callId: z.string().min(1),
  risk: z.enum(["low", "med", "high"]),
  cls: RiskClassSchema,
  action: z.string().min(1),
  detail: z.record(z.string(), z.unknown()),
  expiresAt: z.number().int().positive(),
});

export const ContextCompactedSchema = z.object({
  ...base,
  t: z.literal("context.compacted"),
  summarySeq: z.number().int().positive(),
});

export const TurnCompletedSchema = z.object({
  ...base,
  t: z.literal("turn.completed"),
  turnId: z.string().min(1),
  status: z.enum(["completed", "failed", "interrupted"]),
});

export const SessionErrorSchema = z.object({
  ...base,
  t: z.literal("session.error"),
  error: ToolErrorEnvelopeSchema,
});

export const InterruptedSchema = z.object({
  ...base,
  t: z.literal("interrupted"),
  turnId: z.string().min(1),
  reason: z.enum(["user", "abort"]),
});

// Wire 宽容信封（forward-compat 的另一半契约）：服务端先于客户端升级时会出现本版本
// 未知的 `t`——只要 base 信封合法就必须被接受并推进 maxSeq/epoch，由 reducer 静默忽略；
// 若消费端直接丢弃，重连 afterSeq 会停在未知事件之前，无限重放重丢。
export const WireEventEnvelopeSchema = z.looseObject({
  ...base,
  t: z.string().min(1),
});

export const ArcEventSchema = z.discriminatedUnion("t", [
  SessionStartedSchema,
  TurnStartedSchema,
  MessageDeltaSchema,
  UserMessageSchema,
  ThinkingDeltaSchema,
  ToolRequestedSchema,
  ToolProgressSchema,
  ToolOutputSchema,
  PermissionAskSchema,
  ContextCompactedSchema,
  TurnCompletedSchema,
  SessionErrorSchema,
  InterruptedSchema,
]);
export type ArcEvent = z.infer<typeof ArcEventSchema>;
export type ArcEventType = ArcEvent["t"];

// 注：落库前的"草稿事件"类型（seq/ts 由 appendEvent 在单事务内分配）随 appendEvent 在
// slice1（Unit 2）定义——对 discriminated union 做 Omit 需要分配式映射，届时与使用方一起落地。
