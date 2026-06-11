// Unit 2 端到端集成测：真实 HTTP/SSE 全链（core 服务端 ↔ client-core 传输层）。
// 续接三路径：①增量 replay（真实）②buffer-expired → snapshot（真实）③epoch-jump（mock epoch 触发，
// 真实端到端验收绑 Unit 6 压缩落地后回归——吸收 OD-3）。
// 位置说明：放仓库根 tests/ 而非任一包内，维持 "core 不 import 端包 / client-core 不 import core" 纪律。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArcEvent } from "@arclight/protocol";
import { CommandClient } from "../packages/client-core/src/command";
import { SessionStore } from "../packages/client-core/src/store/sessionStore";
import { HttpClient } from "../packages/client-core/src/transport/httpClient";
import {
  EventStreamManager,
  type Snapshot,
} from "../packages/client-core/src/transport/sseTransport";
import { parseSseStream } from "../packages/client-core/src/transport/stream";
import { appendEvent } from "../packages/core/src/db/appendEvent";
import { createDb } from "../packages/core/src/db/client";
import { runMigrations } from "../packages/core/src/db/migrate";
import { EventBus } from "../packages/core/src/events/bus";
import { createApp } from "../packages/core/src/server/app";

const TOKEN = "integration-test-token-0123456789abcdef0123456789abcdef";
let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let server: ReturnType<typeof Bun.serve>;
let http: HttpClient;
let commands: CommandClient;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "arclight-it-"));
  const arclightDir = join(dir, ".arclight");
  const { dbPath } = runMigrations(arclightDir);
  ({ db, sqlite } = createDb(dbPath));
  const bus = new EventBus();
  const app = createApp({
    repoPath: dir,
    arclightDir,
    db,
    bus,
    token: TOKEN,
    heartbeatMs: 150,
    mockDeltaMs: 5,
  });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: app.fetch });
  http = new HttpClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: TOKEN });
  commands = new CommandClient(http);
});

afterAll(() => {
  server.stop(true);
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createSession(id: string): Promise<void> {
  const r = await http.postJson<{ ok: boolean }>("/api/sessions", { id });
  expect(r.status).toBe(201);
}

async function submitAndWait(sessionId: string, baseEpoch = 0): Promise<void> {
  const ack = await commands.submit(sessionId, { text: "hi", agent: "code", baseEpoch });
  expect(ack.ok).toBe(true);
  // mock loop：8 事件 × 5ms，留余量
  await Bun.sleep(300);
}

function collectStream(sessionId: string, afterSeq: number, epoch = 0) {
  const store = new SessionStore(sessionId);
  const got: ArcEvent[] = [];
  const resyncs: string[] = [];
  const esm = new EventStreamManager({
    http,
    sessionId,
    onEvents: (batch) => {
      got.push(...batch);
      store.applyBatch(batch);
    },
    onResync: (_s: Snapshot, reason) => {
      store.reset();
      resyncs.push(reason);
    },
    coalesceMs: 4,
  });
  esm.setBookmark(afterSeq, epoch);
  esm.start();
  return { esm, store, got, resyncs };
}

describe("路径① 增量 replay + 实时", () => {
  test("submit → 全事件有序到达，seq 连续无缺口，store 状态完整", async () => {
    await createSession("it1");
    const { esm, store, got } = collectStream("it1", 0);
    await submitAndWait("it1");
    await Bun.sleep(100);
    esm.stop();

    const seqs = got.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1)); // 1..N 连续
    expect(got[0]?.t).toBe("turn.started");
    expect(got.at(-1)?.t).toBe("turn.completed");
    const st = store.getSnapshot();
    expect(st.turn.status).toBe("completed");
    expect((st.messages[0]?.parts[0] as { text: string }).text).toContain("slice1");
  });

  test("断线重连：afterSeq=N 续接无重复无缺口", async () => {
    await createSession("it2");
    await submitAndWait("it2");

    // 第一段：raw SSE 读前 3 帧后掐断
    const ac = new AbortController();
    const res = await fetch(http.url("/api/sessions/it2/events?afterSeq=0"), {
      headers: http.headers(),
      signal: ac.signal,
    });
    const first: ArcEvent[] = [];
    if (!res.body) throw new Error("no body");
    for await (const f of parseSseStream(res.body)) {
      first.push(JSON.parse(f.data) as ArcEvent);
      if (first.length === 3) break;
    }
    ac.abort();
    expect(first.map((e) => e.seq)).toEqual([1, 2, 3]);

    // 第二段：凭书签续接
    const { esm, got } = collectStream("it2", 3);
    await Bun.sleep(150);
    esm.stop();
    const all = [...first.map((e) => e.seq), ...got.map((e) => e.seq)];
    expect(new Set(all).size).toBe(all.length); // 无重复
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1)); // 无缺口
  });

  test("幻影重复防线：服务端 replay 重叠帧被 maxSeq 去重", async () => {
    await createSession("it3");
    await submitAndWait("it3");
    const { esm, got } = collectStream("it3", 0);
    await Bun.sleep(150);
    // 人为停启（书签保持）→ 服务端全量 replay → dispatch 去重
    esm.stop();
    const n = got.length;
    esm.start();
    await Bun.sleep(150);
    esm.stop();
    expect(got.length).toBe(n); // 重连未产生任何重复帧
  });
});

describe("路径② buffer-expired → snapshot 全量重建（真实触发）", () => {
  test("删除早期事件后 afterSeq 落缺口 → 409 → snapshot 续接一致", async () => {
    await createSession("it4");
    await submitAndWait("it4");
    // 修剪 seq<=4（模拟缓冲清理）——原生 SQL，避免根工作区引第二份 drizzle 实例
    sqlite.exec("DELETE FROM events WHERE session_id = 'it4' AND seq <= 4");

    const direct = await fetch(http.url("/api/sessions/it4/events?afterSeq=2"), {
      headers: http.headers(),
    });
    expect(direct.status).toBe(409);
    expect(((await direct.json()) as { reason: string }).reason).toBe("buffer-expired");

    const { esm, store, got, resyncs } = collectStream("it4", 2);
    await Bun.sleep(200);
    esm.stop();
    expect(resyncs).toEqual(["buffer-expired"]);
    const lastSeq = sqlite
      .query<{ last_event_seq: number }, []>("SELECT last_event_seq FROM sessions WHERE id = 'it4'")
      .get()?.last_event_seq;
    expect(got.at(-1)?.seq).toBe(lastSeq); // 重建后追平
    expect(store.getSnapshot().turn.status).toBe("completed");
  });
});

describe("路径③ epoch-jump（mock epoch 触发，端到端回归绑 Unit 6）", () => {
  test("旧 epoch + afterSeq 早于 compacted → 409 epoch-jump → snapshot 重建后 epoch 追平", async () => {
    await createSession("it5");
    await submitAndWait("it5");
    // mock 压缩边界：epoch 2 + context.compacted 事件（真实压缩在 Unit 6 落地）
    sqlite.exec("UPDATE sessions SET epoch = 2 WHERE id = 'it5'");
    const t = sqlite
      .query<{ id: string }, []>("SELECT id FROM turns WHERE session_id = 'it5'")
      .get();
    appendEvent(
      { db },
      { v: 1, t: "context.compacted", sessionId: "it5", turnId: t?.id ?? "", summarySeq: 1 },
    );

    const direct = await fetch(http.url("/api/sessions/it5/events?afterSeq=1&epoch=0"), {
      headers: http.headers(),
    });
    expect(direct.status).toBe(409);
    expect(((await direct.json()) as { reason: string }).reason).toBe("epoch-jump");

    const { esm, resyncs } = collectStream("it5", 1, 0);
    await Bun.sleep(200);
    expect(resyncs).toEqual(["epoch-jump"]);
    expect(esm.epochTracker.epoch).toBe(2); // 书签已跳到新 epoch
    esm.stop();
  });
});

describe("刷新不丢（snapshot bootstrap + 增量续接）", () => {
  test("snapshot 重建 → afterSeq=lastSeq 连接 → 第二个 turn 只收新事件", async () => {
    await createSession("it6");
    await submitAndWait("it6");
    const snap = await http.getJson<Snapshot>("/api/sessions/it6/snapshot");
    const store = new SessionStore("it6");
    store.applyBatch(snap.events); // bootstrap
    expect(store.getSnapshot().turn.status).toBe("completed");

    const { esm, got } = collectStream("it6", snap.lastSeq, snap.epoch);
    await submitAndWait("it6"); // 第二个 turn
    await Bun.sleep(100);
    esm.stop();
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((e) => e.seq > snap.lastSeq)).toBe(true); // 零旧事件重复
  });
});

describe("C2 输入校验（Codex 对抗式发现）", () => {
  test("epoch=NaN/非整数 → 400，绝不静默跳过 epoch-jump", async () => {
    await createSession("it9");
    for (const bad of ["notanumber", "1.5", "-1"]) {
      const res = await fetch(http.url(`/api/sessions/it9/events?afterSeq=0&epoch=${bad}`), {
        headers: http.headers(),
      });
      expect(res.status, `epoch=${bad}`).toBe(400);
      await res.body?.cancel();
    }
  });

  test("afterSeq=NaN/负 → 400", async () => {
    await createSession("it10");
    for (const bad of ["NaN", "-3", "1.2"]) {
      const res = await fetch(http.url(`/api/sessions/it10/events?afterSeq=${bad}`), {
        headers: http.headers(),
      });
      expect(res.status, `afterSeq=${bad}`).toBe(400);
      await res.body?.cancel();
    }
  });
});

describe("C1 防线", () => {
  test("STALE_EPOCH：baseEpoch 落后 → 409", async () => {
    await createSession("it7");
    sqlite.exec("UPDATE sessions SET epoch = 1 WHERE id = 'it7'");
    const ack = await commands.submit("it7", { text: "x", agent: "code", baseEpoch: 0 });
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.code).toBe("STALE_EPOCH");
  });

  test("幂等：同 commandId 重复 submit 返回首次 turnId", async () => {
    await createSession("it8");
    const a1 = await commands.submit(
      "it8",
      { text: "x", agent: "code", baseEpoch: 0 },
      "fixed-cmd",
    );
    await Bun.sleep(250);
    const a2 = await commands.submit(
      "it8",
      { text: "x", agent: "code", baseEpoch: 0 },
      "fixed-cmd",
    );
    expect(a1.ok && a2.ok).toBe(true);
    if (a1.ok && a2.ok) expect(a2.turnId).toBe(a1.turnId);
  });
});
