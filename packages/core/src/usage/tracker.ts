import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { usage } from "../db/schema";

// usage 计量（DEV_PLAN §3.4）：每轮 provider usage 落 usage 表 + cost 估算。
// 成本仅展示，不做 quota 强制（§5.2 DoD #7）。GLM 价格按 per-1M-token 估（可配）。

export type ModelPricing = { inputPer1M: number; outputPer1M: number };

// 默认价格（USD per 1M tokens）。glm-4.6 公开价约 ¥… → 这里用占位估值，可经 config 覆盖。
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "glm-4.6": { inputPer1M: 0.6, outputPer1M: 2.2 },
  "claude-sonnet-4-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
};

export class UsageTracker {
  constructor(
    private readonly db: Db,
    private readonly provider: string,
    private readonly model: string,
  ) {}

  record(args: {
    sessionId: string;
    turnId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    const pricing = DEFAULT_PRICING[this.model] ?? { inputPer1M: 0, outputPer1M: 0 };
    const costUsd =
      (args.inputTokens / 1_000_000) * pricing.inputPer1M +
      (args.outputTokens / 1_000_000) * pricing.outputPer1M;
    this.db
      .insert(usage)
      .values({
        id: randomUUID(),
        sessionId: args.sessionId,
        turnId: args.turnId,
        provider: this.provider,
        model: this.model,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        cacheReadTokens: args.cacheReadTokens ?? 0,
        cacheWriteTokens: args.cacheWriteTokens ?? 0,
        costUsdMicros: Math.round(costUsd * 1_000_000),
      })
      .run();
  }

  /** session 累计（成本可观测展示用）。SQL 聚合，与 routes/sessions.ts 的 /usage 端点对称——
   *  不全表加载（usage 行随时间无限增长）。 */
  sessionTotals(sessionId: string): {
    inputTokens: number;
    outputTokens: number;
    costUsdMicros: number;
  } {
    const r = this.db
      .select({
        inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}), 0)`,
        costUsdMicros: sql<number>`coalesce(sum(${usage.costUsdMicros}), 0)`,
      })
      .from(usage)
      .where(eq(usage.sessionId, sessionId))
      .get();
    return {
      inputTokens: r?.inputTokens ?? 0,
      outputTokens: r?.outputTokens ?? 0,
      costUsdMicros: r?.costUsdMicros ?? 0,
    };
  }
}
