import { z } from "zod";

// C1 命令应答。ok=受理（幂等：同 (sessionId, commandId) 重复提交返回首次结果）；
// error 用稳定 code，不泄内部细节。
export const ArcAckSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    commandId: z.string(),
    turnId: z.string().optional(),
    sessionId: z.string().optional(),
    status: z.string().optional(), // approve 应答带审批终态（allowed/denied/expired/cancelled）
  }),
  z.object({
    ok: z.literal(false),
    commandId: z.string(),
    code: z.enum([
      "STALE_EPOCH",
      "SESSION_NOT_FOUND",
      "TURN_NOT_FOUND",
      "ASK_NOT_FOUND",
      "TURN_ACTIVE", // 同 session 单 active turn
      "VALIDATION",
      "UNAUTHORIZED",
      "INTERNAL",
    ]),
    message: z.string(),
  }),
]);
export type ArcAck = z.infer<typeof ArcAckSchema>;
