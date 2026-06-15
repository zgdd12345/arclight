import { randomUUID } from "node:crypto";
import { type ArcAck, parseArcCommand } from "@arclight/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { ApprovalPolicy } from "../../approval/policy";
import { ApprovalNotFoundError } from "../../approval/service";
import type { Db } from "../../db/client";
import { sessions, turns } from "../../db/schema";
import type { EventBus } from "../../events/bus";
import { runMockTurn } from "../../loop/mock-loop";
import type { AgentRunner } from "../../loop/runner";

// C1: POST /api/commands。生命周期（P0 §C）：auth → 幂等检查(session+commandId)
// → epoch 检查(StaleEpochError) → 创建 turn → 流水线异步执行。
// 流水线选择：注入 runner = 真实 queryLoop；未注入（测试）= mock loop。

export function createCommandsRoute(deps: {
  db: Db;
  bus: EventBus;
  runner?: AgentRunner;
  approvals?: ApprovalPolicy;
  mockDeltaMs?: number;
}) {
  const { db, bus, runner, approvals } = deps;

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
        // 同 session 单 active turn（runner 登记为权威，DB 行为兜底）
        // DB 兜底覆盖全部"活跃"终态：queued/running/awaiting_approval，
        // 防止 runner 未注册（mock 模式）或崩溃孤儿行时两次并发提交均通过。
        if (runner?.isActive(cmd.sessionId)) {
          return c.json(ackErr(cmd.commandId, "TURN_ACTIVE", "session has an active turn"), 409);
        }
        const active = db
          .select({ id: turns.id })
          .from(turns)
          .where(
            and(
              eq(turns.sessionId, cmd.sessionId),
              inArray(turns.status, ["queued", "running", "awaiting_approval"]),
            ),
          )
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
        // 会话自动标题（仿 ChatGPT）：title 为空时取首条提问前 40 字；/undo 等斜杠命令不作标题。
        if (!session.title) {
          const autoTitle = cmd.input.text.trim().replace(/\s+/g, " ").slice(0, 40);
          if (autoTitle && !autoTitle.startsWith("/")) {
            db.update(sessions)
              .set({ title: autoTitle })
              .where(eq(sessions.id, cmd.sessionId))
              .run();
          }
        }
        // fire-and-forget：事件经 appendEvent 落库后由 bus 推给 SSE
        // baseEpoch 透传至准入 append 作 expectedEpoch：上面的 epoch 预检是事务外 TOCTOU 读，
        // 真正的 seq/epoch 不变式守护在首个 append 的事务内复核（appendEvent expectedEpoch）。
        if (runner) {
          void runner.startTurn({
            sessionId: cmd.sessionId,
            turnId,
            userText: cmd.input.text,
            baseEpoch: cmd.input.baseEpoch,
          });
        } else {
          void runMockTurn(
            { db, bus },
            {
              sessionId: cmd.sessionId,
              turnId,
              baseEpoch: cmd.input.baseEpoch,
              ...(deps.mockDeltaMs ? { deltaMs: deps.mockDeltaMs } : {}),
            },
          );
        }
        return c.json({ ok: true, commandId: cmd.commandId, turnId } satisfies ArcAck, 202);
      }
      case "interrupt": {
        const t = db.select({ id: turns.id }).from(turns).where(eq(turns.id, cmd.turnId)).get();
        if (!t) return c.json(ackErr(cmd.commandId, "TURN_NOT_FOUND", cmd.turnId), 404);
        runner?.interrupt(cmd.turnId); // abort 透传：callProvider 流 / 工具 signal / 沙箱 kill
        return c.json({ ok: true, commandId: cmd.commandId, turnId: cmd.turnId } satisfies ArcAck);
      }
      case "approve": {
        if (!approvals)
          return c.json(ackErr(cmd.commandId, "ASK_NOT_FOUND", "approvals unavailable"), 404);
        try {
          const status = approvals.decide(cmd.askId, cmd.decision, cmd.scope ?? "once");
          // 决议落地（allowed/denied）或已终态（expired/cancelled）均回 ok；挂起的 loop 轮询感知
          return c.json({ ok: true, commandId: cmd.commandId, status } satisfies ArcAck);
        } catch (err) {
          // 未知 askId（已清理/伪造）→ 契约 ASK_NOT_FOUND ack，而非未处理 500
          if (err instanceof ApprovalNotFoundError) {
            return c.json(ackErr(cmd.commandId, "ASK_NOT_FOUND", cmd.askId), 404);
          }
          throw err;
        }
      }
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
