import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, turns, workspaces } from "../../db/schema";
import { UsageTracker } from "../tracker";

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces)
    .values({ id: "w", name: "r", repoPath: "/r", arclightDir: "/r/.arclight" })
    .run();
  db.insert(sessions).values({ id: "s", workspaceId: "w" }).run();
  for (const id of ["t1", "t2"]) {
    db.insert(turns)
      .values({ id, sessionId: "s", commandId: `cmd-${id}`, status: "completed", input: {} })
      .run();
  }
});
afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("UsageTracker", () => {
  test("record 落库 + cost 估算（glm-4.6 价格）", () => {
    const t = new UsageTracker(db, "zhipu", "glm-4.6");
    t.record({ sessionId: "s", turnId: "t1", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const totals = t.sessionTotals("s");
    expect(totals.inputTokens).toBe(1_000_000);
    expect(totals.outputTokens).toBe(1_000_000);
    // glm-4.6: in 0.6 + out 2.2 = 2.8 USD per 1M each → 2.8 USD = 2_800_000 micros
    expect(totals.costUsdMicros).toBe(2_800_000);
  });

  test("多次 record 累加", () => {
    const t = new UsageTracker(db, "zhipu", "glm-4.6");
    t.record({ sessionId: "s", turnId: "t1", inputTokens: 100, outputTokens: 50 });
    t.record({ sessionId: "s", turnId: "t2", inputTokens: 200, outputTokens: 80 });
    const totals = t.sessionTotals("s");
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(130);
  });

  test("未知模型 cost=0（不崩）", () => {
    const t = new UsageTracker(db, "x", "unknown-model");
    t.record({ sessionId: "s", turnId: "t1", inputTokens: 1000, outputTokens: 1000 });
    expect(t.sessionTotals("s").costUsdMicros).toBe(0);
  });

  test("model 传 thunk：record 取当前值，热切换后模型名与定价随之更新", () => {
    let model = "glm-4.6";
    const t = new UsageTracker(db, "zhipu", () => model);
    t.record({ sessionId: "s", turnId: "t1", inputTokens: 1_000_000, outputTokens: 0 });
    model = "claude-sonnet-4-5"; // 模拟 PATCH /api/config 热切换
    t.record({ sessionId: "s", turnId: "t2", inputTokens: 1_000_000, outputTokens: 0 });
    const rows = sqlite
      .query<{ model: string; cost_usd_micros: number }, []>(
        "SELECT model, cost_usd_micros FROM usage WHERE session_id='s' ORDER BY turn_id",
      )
      .all();
    expect(rows.map((r) => r.model)).toEqual(["glm-4.6", "claude-sonnet-4-5"]);
    expect(rows[0]?.cost_usd_micros).toBe(600_000); // glm-4.6 输入 0.6/1M
    expect(rows[1]?.cost_usd_micros).toBe(3_000_000); // sonnet 输入 3.0/1M
  });

  test("BUG5：cacheReadTokens/cacheWriteTokens 落库到 cache 列", () => {
    const t = new UsageTracker(db, "zhipu", "glm-4.6");
    t.record({
      sessionId: "s",
      turnId: "t1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheWriteTokens: 70,
    });
    const row = sqlite
      .query<{ cache_read_tokens: number; cache_write_tokens: number }, []>(
        "SELECT cache_read_tokens, cache_write_tokens FROM usage WHERE session_id='s' LIMIT 1",
      )
      .get();
    expect(row?.cache_read_tokens).toBe(30);
    expect(row?.cache_write_tokens).toBe(70);
  });
});
