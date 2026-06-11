import { randomUUID } from "node:crypto";
import { type ArcAck, parseArcCommand } from "@arclight/protocol";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { sessions, turns } from "../../db/schema";
import type { EventBus } from "../../events/bus";
import { runMockTurn } from "../../loop/mock-loop";

// C1: POST /api/commands。生命周期（P0 §C）：auth → 幂等检查(session+commandId)
// → epoch 检查(StaleEpochError) → 创建 turn → 流水线异步执行（slice1 = mock loop）。

export function createCommandsRoute(deps: { db: Db; bus: EventBus; mockDeltaMs?: number }) {
  const { db, bus } = deps;

  return new Hono().post("/", async (c) => {
    const parsed = parseArcCommand(await c.req.json().catch(() => null));
    if (!parsed.ok) {
      const ack: ArcAck = {
        ok: false,
        commandId: "unknown",
        code: "VALIDATION",
        message: parsed.issues.join("; "),
      };
      return c.json(ack, 400);
    }
    const cmd = parsed.value;

    switch (cmd.k) {
      case "submit": {
        const session = db.select().from(sessions).where(eq(sessions.id, cmd.sessionId)).get();
        if (!session) {
          return c.json(ackErr(cmd.commandId, "SESSION_NOT_FOUND", cmd.sessionId), 404);
        }
        // 幂等：同 (sessionId, commandId) 重复提交返回首次 turn
        const dup = db
          .select({ id: turns.id })
          .from(turns)
          .where(and(eq(turns.sessionId, cmd.sessionId), eq(turns.commandId, cmd.commandId)))
          .get();
        if (dup) {
          return c.json({ ok: true, commandId: cmd.commandId, turnId: dup.id } satisfies ArcAck);
        }
        if (cmd.input.baseEpoch !== session.epoch) {
          return c.json(
            ackErr(
              cmd.commandId,
              "STALE_EPOCH",
              `baseEpoch=${cmd.input.baseEpoch}, current=${session.epoch}`,
            ),
            409,
          );
        }
        // 同 session 单 active turn
        const active = db
          .select({ id: turns.id })
          .from(turns)
          .where(and(eq(turns.sessionId, cmd.sessionId), eq(turns.status, "running")))
          .get();
        if (active) return c.json(ackErr(cmd.commandId, "TURN_ACTIVE", active.id), 409);

        const turnId = randomUUID();
        db.insert(turns)
          .values({
            id: turnId,
            sessionId: cmd.sessionId,
            commandId: cmd.commandId,
            status: "queued",
            input: cmd.input,
          })
          .run();
        // fire-and-forget：事件经 appendEvent 落库后由 bus 推给 SSE
        void runMockTurn(
          { db, bus },
          {
            sessionId: cmd.sessionId,
            turnId,
            ...(deps.mockDeltaMs ? { deltaMs: deps.mockDeltaMs } : {}),
          },
        );
        return c.json({ ok: true, commandId: cmd.commandId, turnId } satisfies ArcAck, 202);
      }
      case "interrupt": {
        // slice2 接 AbortController；当前仅校验存在性
        const t = db.select({ id: turns.id }).from(turns).where(eq(turns.id, cmd.turnId)).get();
        if (!t) return c.json(ackErr(cmd.commandId, "TURN_NOT_FOUND", cmd.turnId), 404);
        return c.json({ ok: true, commandId: cmd.commandId, turnId: cmd.turnId } satisfies ArcAck);
      }
      case "approve":
        // slice3 实装审批状态机
        return c.json(ackErr(cmd.commandId, "ASK_NOT_FOUND", "approvals land in slice3"), 404);
      case "declareCap":
      case "resume":
        return c.json({ ok: true, commandId: cmd.commandId } satisfies ArcAck);
    }
  });
}

function ackErr(
  commandId: string,
  code: Extract<ArcAck, { ok: false }>["code"],
  message: string,
): ArcAck {
  return { ok: false, commandId, code, message };
}
