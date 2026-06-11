import { randomUUID } from "node:crypto";
import type { RiskClass } from "@arclight/protocol";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { approvals } from "../db/schema";

// ApprovalService 状态机（P0 §C / DEV_PLAN §2.3）：
//   pending →(approve allow, 未过期) allowed | →(deny) denied | →(60s 过期) expired | →(turn 中断) cancelled
// 后四态为终态，唯一不可逆。内核权威（前端倒计时仅 UX）。decide 幂等：重复决议返回首次终态。

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "cancelled";
export type Risk = "low" | "med" | "high";

export const DEFAULT_TTL_MS = 60_000;

export type CreateAskInput = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  risk: Risk;
  cls: RiskClass;
  action: string;
  detail: Record<string, unknown>;
};

export type Ask = { askId: string; expiresAt: number };

export class ApprovalService {
  constructor(
    private readonly db: Db,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: CreateAskInput): Ask {
    const askId = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.db
      .insert(approvals)
      .values({
        id: askId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        status: "pending",
        risk: input.risk,
        cls: input.cls,
        action: input.action,
        detail: input.detail,
        expiresAt: new Date(expiresAt),
      })
      .run();
    return { askId, expiresAt };
  }

  /** 终态转移（幂等）。允许目标态：allowed/denied/expired/cancelled。
   *  pending 已是终态则原样返回（先到先得，防 approve 与 expire 竞态双写）。 */
  private transition(
    askId: string,
    target: Exclude<ApprovalStatus, "pending">,
    reason: string,
  ): ApprovalStatus {
    return this.db.transaction((tx) => {
      const row = tx.select().from(approvals).where(eq(approvals.id, askId)).get();
      if (!row) throw new Error(`approval not found: ${askId}`);
      if (row.status !== "pending") return row.status; // 幂等：已终态
      // 过期优先级：到期后无论请求什么决议，结果都是 expired（内核权威）
      const effective: Exclude<ApprovalStatus, "pending"> =
        target !== "cancelled" && this.now() >= row.expiresAt.getTime() ? "expired" : target;
      tx.update(approvals)
        .set({ status: effective, decidedAt: new Date(this.now()), decisionReason: reason })
        .where(eq(approvals.id, askId))
        .run();
      return effective;
    });
  }

  decide(askId: string, decision: "allow" | "deny"): ApprovalStatus {
    return this.transition(
      askId,
      decision === "allow" ? "allowed" : "denied",
      decision === "allow" ? "user approved" : "user denied",
    );
  }

  /** 内核扫描：把已过 TTL 的 pending 转 expired（轮询或访问时调用） */
  expireIfDue(askId: string): ApprovalStatus {
    const row = this.db.select().from(approvals).where(eq(approvals.id, askId)).get();
    if (!row) throw new Error(`approval not found: ${askId}`);
    if (row.status !== "pending") return row.status;
    if (this.now() >= row.expiresAt.getTime())
      return this.transition(askId, "expired", "ttl expired");
    return "pending";
  }

  /** turn 中断：挂起审批转 cancelled 终态 */
  cancel(askId: string): ApprovalStatus {
    return this.transition(askId, "cancelled", "turn interrupted");
  }

  get(askId: string): ApprovalStatus | null {
    return (
      this.db.select({ s: approvals.status }).from(approvals).where(eq(approvals.id, askId)).get()
        ?.s ?? null
    );
  }
}
