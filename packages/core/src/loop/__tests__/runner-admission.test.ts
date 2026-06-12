// 准入收口回归（FINDING 1/8）：startTurn 系 fire-and-forget（commands.ts `void`），
// 其准入段（置 running + 发 turn.started）在外层 try/catch 之前。若该处抛出非 StaleEpochError
// 的异常（appendEvent SQLITE_BUSY / SessionNotFound / 抛错的 bus 订阅者）逃出 startTurn，
// turns 行永卡 running、ac 不 abort、active 不清 → isActive() 恒真 → 该 session 后续 submit
// 永久 TURN_ACTIVE 409 楔死。修复：admitTurn 就地把 turn 干净置 failed 并清理，绝不向 void 重抛。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, turns, workspaces } from "../../db/schema";
import { EventBus } from "../../events/bus";
import type { ToolRegistry } from "../../tools/registry";
import { AgentRunner, type RunnerDeps } from "../runner";
import type { ApprovalSeam, CallProvider, ProviderResult } from "../types";

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];

const SESSION = "s1";

// provider 不应在准入失败时被触达；给个永不产出工具调用的收尾 provider 兜底。
// biome-ignore lint/correctness/useYield: 纯 return generator
const noopProvider: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
  return { text: "", toolCalls: [], finishReason: "stop" };
};

const approvals: ApprovalSeam = { check: async () => ({ decision: "allow" }) };

function makeRunner(bus: EventBus): AgentRunner {
  const deps: RunnerDeps = {
    db,
    bus,
    registry: { schemas: () => [], get: () => undefined } as unknown as ToolRegistry,
    callProvider: noopProvider,
    executeTool: async () => ({ ok: true, preview: "ok" }),
    approvals,
  };
  return new AgentRunner(deps);
}

/** 调用方（C1 handler）契约：先落 queued turn 行，再 fire-and-forget startTurn。 */
function seedTurn(turnId: string): void {
  db.insert(turns)
    .values({
      id: turnId,
      sessionId: SESSION,
      commandId: `cmd-${turnId}`,
      status: "queued",
      input: {},
    })
    .run();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arclight-runner-admit-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces)
    .values({ id: "w1", name: "t", repoPath: dir, arclightDir: join(dir, ".arclight") })
    .run();
  db.insert(sessions).values({ id: SESSION, workspaceId: "w1" }).run();
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("startTurn 准入收口", () => {
  test("FINDING 1：准入首个 emit 抛非 Stale 异常 → turn 干净置 failed，active 清空（session 不被楔死）", async () => {
    // 抛错的 bus 订阅者：appendEvent 落库后 bus.publish 抛出，异常经 emit 上抛到准入段。
    const throwingBus = {
      subscribe: () => () => {},
      publish: () => {
        throw new Error("subscriber boom");
      },
    } as unknown as EventBus;
    const runner = makeRunner(throwingBus);
    seedTurn("t1");

    // 不得让异常逃出 startTurn（否则 commands.ts 的 void 会静默吞掉，turn 永卡 running）
    await runner.startTurn({ sessionId: SESSION, turnId: "t1", userText: "hello", baseEpoch: 0 });

    const row = db.select().from(turns).where(eq(turns.id, "t1")).get();
    expect(row?.status).toBe("failed"); // 关键：非 'running' 孤儿
    expect(row?.status).not.toBe("running");
    expect(row?.error?.error_class).toBe("INTERNAL");
    expect(row?.completedAt).toBeTruthy();
    // session 未被楔死：active 已清，isActive 复位 → 后续 submit 可被受理
    expect(runner.isActive(SESSION)).toBe(false);
  });

  test("FINDING 1（/undo 分支）：undo 准入同样收口，非 Stale 异常不楔死 session", async () => {
    const throwingBus = {
      subscribe: () => () => {},
      publish: () => {
        throw new Error("subscriber boom");
      },
    } as unknown as EventBus;
    const runner = makeRunner(throwingBus);
    seedTurn("tu");

    await runner.startTurn({ sessionId: SESSION, turnId: "tu", userText: "/undo", baseEpoch: 0 });

    const row = db.select().from(turns).where(eq(turns.id, "tu")).get();
    expect(row?.status).toBe("failed");
    expect(runner.isActive(SESSION)).toBe(false);
  });

  test("既有行为不回退：准入 StaleEpochError → failed(retry_allowed) 且 active 清空", async () => {
    // session.epoch 已推进到 2，client 仍以陈旧 baseEpoch=0 提交 → 首个 append 在事务内被拦下。
    db.update(sessions).set({ epoch: 2 }).where(eq(sessions.id, SESSION)).run();
    const runner = makeRunner(new EventBus());
    seedTurn("ts");

    await runner.startTurn({ sessionId: SESSION, turnId: "ts", userText: "hi", baseEpoch: 0 });

    const row = db.select().from(turns).where(eq(turns.id, "ts")).get();
    expect(row?.status).toBe("failed");
    expect(row?.error?.error_class).toBe("VALIDATION");
    expect(row?.error?.retry_allowed).toBe(true); // resync 后可重提交
    expect(runner.isActive(SESSION)).toBe(false);
  });

  test("准入成功路径：epoch 匹配 → turn.started 落库，turn 走完置 completed，active 清空", async () => {
    const runner = makeRunner(new EventBus());
    seedTurn("tok");

    await runner.startTurn({ sessionId: SESSION, turnId: "tok", userText: "hi", baseEpoch: 0 });

    const row = db.select().from(turns).where(eq(turns.id, "tok")).get();
    expect(row?.status).toBe("completed");
    expect(row?.startedAt).toBeTruthy();
    expect(runner.isActive(SESSION)).toBe(false);
  });
});
