// Unit 6：epoch-jump 真实端到端回归（补 Unit 2 悬空验收，吸收 OD-3）。
// 与 sse-resume 的 mock-epoch 不同——此处由【真实 compaction】驱动 epoch++，
// 验证：长会话触发压缩 → context.compacted（新 epoch）→ 前端 EventStreamManager
// 旧 epoch 连接 → 409 epoch-jump → snapshot 全量重建 → 书签追平新 epoch。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@arclight/protocol";
import { HttpClient } from "../packages/client-core/src/transport/httpClient";
import {
  EventStreamManager,
  type Snapshot,
} from "../packages/client-core/src/transport/sseTransport";
import { ArtifactStore } from "../packages/core/src/artifacts/store";
import { createDb } from "../packages/core/src/db/client";
import { runMigrations } from "../packages/core/src/db/migrate";
import { sessions, turns, workspaces } from "../packages/core/src/db/schema";
import { EventBus } from "../packages/core/src/events/bus";
import { AgentRunner } from "../packages/core/src/loop/runner";
import type { CallProvider, ProviderResult } from "../packages/core/src/loop/types";
import { SandboxRouter } from "../packages/core/src/sandbox/router";
import { createApp } from "../packages/core/src/server/app";
import { makeExecuteTool, ToolRegistry } from "../packages/core/src/tools/registry";

const TOKEN = "epoch-it-token-0123456789abcdef0123456789abcdef";

// 工具：往消息里塞大量内容，逼近压缩窗口
function bloatTool(): Tool<unknown, unknown> {
  return {
    meta: {
      name: "bloat",
      description: "returns a large blob",
      isReadOnly: true,
      isConcurrencySafe: true,
      riskTier: "safe",
      riskClass: "read",
      timeoutMs: 5000,
      maxResultSizeBytes: 1024 * 1024,
    },
    inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) } as never,
    outputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) } as never,
    execute: async () => ({ blob: "lorem ipsum dolor sit amet ".repeat(80) }),
  } as Tool<unknown, unknown>;
}

let root: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let server: ReturnType<typeof Bun.serve>;
let http: HttpClient;
let runner: AgentRunner;

function setup() {
  root = mkdtempSync(join(tmpdir(), "arclight-epoch-"));
  const workTree = join(root, "repo");
  mkdirSync(workTree, { recursive: true });
  const arclightDir = join(workTree, ".arclight");
  const { dbPath } = runMigrations(arclightDir);
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces).values({ id: "w1", name: "r", repoPath: workTree, arclightDir }).run();
  db.insert(sessions).values({ id: "s", workspaceId: "w1" }).run();
  const bus = new EventBus();

  // provider：每轮调一次 bloat 工具，多轮后消息膨胀触发压缩，最终收尾
  let calls = 0;
  // biome-ignore lint/correctness/useYield: 纯 return generator（契约要求 async generator）
  const provider: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
    calls++;
    if (calls <= 3) {
      return {
        text: "thinking ".repeat(20),
        toolCalls: [{ callId: `c${calls}`, name: "bloat", rawArgs: {} }],
        finishReason: "tool-calls",
      };
    }
    return { text: "done", toolCalls: [], finishReason: "stop" };
  };
  // biome-ignore lint/correctness/useYield: 纯 return generator（契约要求 async generator）
  const summarizer: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
    return { text: "SUMMARY of prior turns", toolCalls: [], finishReason: "stop" };
  };

  runner = new AgentRunner({
    db,
    bus,
    registry: new ToolRegistry().register(bloatTool()),
    callProvider: provider,
    compactProvider: summarizer,
    effectiveWindow: 300, // 压低窗口：几轮 bloat 即触发压缩
    executeTool: makeExecuteTool({
      sandbox: new SandboxRouter(),
      artifacts: new ArtifactStore(db, arclightDir),
    }),
    approvals: { check: async () => ({ decision: "allow" }) },
  });
  const app = createApp({ repoPath: workTree, arclightDir, db, bus, token: TOKEN, runner });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: app.fetch });
  http = new HttpClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: TOKEN });
}

afterEach(() => {
  server?.stop(true);
  sqlite?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

describe("epoch-jump 真实端到端（compaction 驱动）", () => {
  beforeEach(setup);

  test("长会话触发真实压缩 → epoch 递增 + context.compacted 落库", async () => {
    await fetch(http.url("/api/sessions"), {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "s" }),
    });
    await http.postJson("/api/commands", {
      k: "submit",
      v: 1,
      commandId: "c1",
      sessionId: "s",
      input: { text: "do a lot of work", agent: "code", baseEpoch: 0 },
    });
    // 等 turn 完成
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = sqlite
        .query<{ status: string }, []>("SELECT status FROM turns WHERE session_id='s' LIMIT 1")
        .get()?.status;
      if (s && ["completed", "failed", "interrupted"].includes(s)) break;
      await Bun.sleep(20);
    }
    const epoch =
      sqlite.query<{ epoch: number }, []>("SELECT epoch FROM sessions WHERE id='s'").get()?.epoch ??
      0;
    expect(epoch).toBeGreaterThanOrEqual(1); // 真实压缩推进了 epoch
    const compacted = sqlite
      .query("SELECT 1 FROM events WHERE type='context.compacted' LIMIT 1")
      .get();
    expect(compacted).not.toBeNull();
  }, 15000);

  test("旧 epoch 连接早于压缩点 → 409 epoch-jump → snapshot 重建追平", async () => {
    await fetch(http.url("/api/sessions"), {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "s" }),
    });
    await http.postJson("/api/commands", {
      k: "submit",
      v: 1,
      commandId: "c1",
      sessionId: "s",
      input: { text: "work", agent: "code", baseEpoch: 0 },
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = sqlite
        .query<{ status: string }, []>("SELECT status FROM turns WHERE session_id='s' LIMIT 1")
        .get()?.status;
      if (s && ["completed", "failed", "interrupted"].includes(s)) break;
      await Bun.sleep(20);
    }
    const finalEpoch =
      sqlite.query<{ epoch: number }, []>("SELECT epoch FROM sessions WHERE id='s'").get()?.epoch ??
      0;
    expect(finalEpoch).toBeGreaterThanOrEqual(1);

    // 直接打 C2：用旧 epoch=0 + afterSeq=1（早于压缩点）→ 必须 409 epoch-jump
    const direct = await fetch(http.url("/api/sessions/s/events?afterSeq=1&epoch=0"), {
      headers: H,
    });
    expect(direct.status).toBe(409);
    expect(((await direct.json()) as { reason: string }).reason).toBe("epoch-jump");

    // 前端 EventStreamManager：旧书签连接 → 自动 resync → 追平新 epoch
    const resyncs: string[] = [];
    const esm = new EventStreamManager({
      http,
      sessionId: "s",
      onEvents: () => {},
      onResync: (_s: Snapshot, reason) => resyncs.push(reason),
      coalesceMs: 4,
    });
    esm.setBookmark(1, 0); // 旧 epoch
    esm.start();
    await Bun.sleep(300);
    esm.stop();
    expect(resyncs).toContain("epoch-jump");
    expect(esm.epochTracker.epoch).toBe(finalEpoch); // 书签追平真实压缩后的 epoch
  }, 15000);

  test("BUG4 读侧兜底：epoch 已进但无 context.compacted 行 → 仍 409 epoch-jump", async () => {
    await fetch(http.url("/api/sessions"), {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "s" }),
    });
    // 模拟崩溃半完成态：epoch 推进但 context.compacted 事件缺失（旧非原子实现的遗留窗口）
    sqlite.query("UPDATE sessions SET epoch = 1 WHERE id = 's'").run();
    const noCompacted = sqlite
      .query("SELECT 1 FROM events WHERE type='context.compacted' AND session_id='s' LIMIT 1")
      .get();
    expect(noCompacted).toBeNull();
    // 旧 epoch=0 连接：旧实现因 lastCompactedSeq==null 漏判 → 客户端永卡 STALE_EPOCH；
    // 修复后降级用 minAvailableSeq 兜底 → 必须 409 epoch-jump
    const res = await fetch(http.url("/api/sessions/s/events?afterSeq=0&epoch=0"), { headers: H });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("epoch-jump");
  });

  test("准入乐观锁：epoch 在路由预检与准入 append 之间推进 → turn 干净 failed，旧 epoch 下无事件落库", async () => {
    // 模拟 TOCTOU 缝隙：提交在 epoch=0 通过路由预检（baseEpoch==epoch），随后压缩把 epoch 推到 1，
    // 准入 append 才执行。startTurn 携 baseEpoch=0 直驱准入路径，绕过路由预检（预检已在 epoch=0 放行）。
    sqlite.query("UPDATE sessions SET epoch = 1 WHERE id = 's'").run();
    const turnId = "stale-admit-turn";
    // route 正常会先落 turn 行（queued）；此处手动落，直驱准入 append
    db.insert(turns)
      .values({ id: turnId, sessionId: "s", commandId: "cmd-stale", status: "queued", input: {} })
      .run();

    await runner.startTurn({ sessionId: "s", turnId, userText: "do work", baseEpoch: 0 });

    // turn 干净置 failed（不崩 runner、不留 running 孤儿）
    const status = sqlite
      .query<{ status: string }, [string]>("SELECT status FROM turns WHERE id = ?")
      .get(turnId)?.status;
    expect(status).toBe("failed");
    // 关键不变式：陈旧 epoch 下绝无事件落库（准入事务整体回滚）
    const ev = sqlite
      .query<{ n: number }, [string]>("SELECT 1 AS n FROM events WHERE turn_id = ? LIMIT 1")
      .get(turnId);
    expect(ev).toBeNull();
    // seq 未被消耗，active 登记已清理
    const nextSeq = sqlite
      .query<{ nextSeq: number }, []>("SELECT next_seq AS nextSeq FROM sessions WHERE id = 's'")
      .get()?.nextSeq;
    expect(nextSeq).toBe(1);
    expect(runner.isActive("s")).toBe(false);
  });
});
