// sseTransport 单帧容错测试（DEV_PLAN §2.2 纪律④）。
// 验证：JSON 解析失败或 schema 校验失败的帧被跳过；
// 合法帧正常交付；maxSeq 只含合法帧；连接不被断开。

import type { ArcEvent } from "@arclight/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../httpClient";
import { type ConnectionStatus, EventStreamManager } from "../sseTransport";

// ── 辅助 ──

/** 将 SSE 文本包装成 ReadableStream<Uint8Array>（一次性写入） */
function makeSseStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(text));
      ctrl.close();
    },
  });
}

function makeHttp(): HttpClient {
  return new HttpClient({ baseUrl: "http://test.local", token: "test-token" });
}

/** 构造合法 session.started 事件的 JSON 字符串（用于 data: 行） */
function sessionStartedJson(seq: number): string {
  return JSON.stringify({
    v: 1,
    t: "session.started",
    sessionId: "s1",
    seq,
    epoch: 0,
    ts: 1_700_000_000_000,
  });
}

// ── 测试 ──

describe("EventStreamManager 单帧容错（纪律④）", () => {
  // 跨 runner 兼容：vitest 有 vi.stubGlobal，但 `bun test` 的 vitest shim 无此 API。
  // 直接换 globalThis.fetch 并在 afterEach 复原——两个 runner 都能跑（DEV_PLAN §3.1）。
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("JSON 格式错误帧跳过：两侧合法帧正常交付，maxSeq 正确，不触发重连", async () => {
    // 流内容：合法帧 seq=1 → JSON 格式错误帧 → 合法帧 seq=2
    const sseText = [
      `data: ${sessionStartedJson(1)}\n\n`,
      `data: {broken json\n\n`,
      `data: ${sessionStartedJson(2)}\n\n`,
    ].join("");

    const received: ArcEvent[] = [];
    const frameErrors: Array<string[]> = [];
    const statusLog: ConnectionStatus[] = [];

    let resolveEvents!: () => void;
    const eventsReady = new Promise<void>((r) => {
      resolveEvents = r;
    });

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: makeSseStream(sseText),
        } as unknown as Response);
      }
      // 后续调用永不完成——stop() 已经阻止了重连，这里只是保险
      return new Promise<never>(() => {});
    }) as unknown as typeof fetch;

    const manager = new EventStreamManager({
      http: makeHttp(),
      sessionId: "s1",
      onEvents(batch) {
        received.push(...batch);
        manager.stop(); // 拿到事件后立即停，避免重连循环
        resolveEvents();
      },
      onFrameError(_raw, issues) {
        frameErrors.push(issues);
      },
      onStatus(s) {
        statusLog.push(s);
      },
      coalesceMs: 9999, // 合批窗口超长，依赖 finally 的 flushNow 触发交付
      sleep: () => new Promise<never>(() => {}), // 退避永不完成
    });

    manager.start();
    await eventsReady;

    // 两条合法事件全部到达，顺序正确
    expect(received).toHaveLength(2);
    expect(received[0]?.seq).toBe(1);
    expect(received[1]?.seq).toBe(2);

    // JSON 格式错误触发了 onFrameError，issues 含 "invalid JSON"
    expect(frameErrors).toHaveLength(1);
    expect(frameErrors[0]).toEqual(["invalid JSON"]);

    // maxSeq 仅由合法帧推进，等于 2
    expect((manager as unknown as { maxSeq: number }).maxSeq).toBe(2);

    // 状态序列：connecting → open（无 reconnecting）
    expect(statusLog).toContain("connecting");
    expect(statusLog).toContain("open");
    expect(statusLog).not.toContain("reconnecting");

    // fetch 只被调用一次（stop 后无重连）
    expect(fetchCallCount).toBe(1);
  });

  it("schema 校验失败帧跳过：合法 JSON 但不合 ArcEventSchema 的帧被过滤", async () => {
    // 合法 JSON 但缺少必需字段 seq / epoch / ts → ArcEventSchema 校验失败
    const badSchemaJson = JSON.stringify({ v: 1, t: "session.started", sessionId: "s1" });
    const sseText = [
      `data: ${sessionStartedJson(1)}\n\n`,
      `data: ${badSchemaJson}\n\n`,
      `data: ${sessionStartedJson(3)}\n\n`,
    ].join("");

    const received: ArcEvent[] = [];
    const frameErrors: Array<string[]> = [];

    let resolveEvents!: () => void;
    const eventsReady = new Promise<void>((r) => {
      resolveEvents = r;
    });

    globalThis.fetch = vi.fn().mockImplementation(
      (() => {
        let n = 0;
        return () => {
          n++;
          if (n === 1) {
            return Promise.resolve({
              ok: true,
              status: 200,
              body: makeSseStream(sseText),
            } as unknown as Response);
          }
          return new Promise<never>(() => {});
        };
      })(),
    ) as unknown as typeof fetch;

    const manager = new EventStreamManager({
      http: makeHttp(),
      sessionId: "s1",
      onEvents(batch) {
        received.push(...batch);
        manager.stop();
        resolveEvents();
      },
      onFrameError(_raw, issues) {
        frameErrors.push(issues);
      },
      coalesceMs: 9999,
      sleep: () => new Promise<never>(() => {}),
    });

    manager.start();
    await eventsReady;

    // 只有 seq=1 和 seq=3 的合法事件到达（schema 无效帧被跳过）
    expect(received).toHaveLength(2);
    expect(received.map((e) => e.seq)).toEqual([1, 3]);

    // schema 校验失败触发了 onFrameError（issues 包含字段路径提示）
    expect(frameErrors).toHaveLength(1);
    expect(frameErrors[0]?.length ?? 0).toBeGreaterThan(0);

    // maxSeq = 3（schema 无效帧不推进 maxSeq）
    expect((manager as unknown as { maxSeq: number }).maxSeq).toBe(3);
  });

  it("forward-compat：未知 t 但信封合法的事件照常交付并推进 maxSeq（不算坏帧）", async () => {
    // 服务端先升级的场景：本版本未知的事件类型。若被当坏帧丢弃，
    // 重连 afterSeq 会停在它之前 → 服务端无限重放、客户端无限重丢。
    const futureEventJson = JSON.stringify({
      v: 1,
      t: "future.event",
      sessionId: "s1",
      seq: 2,
      epoch: 0,
      ts: 1_700_000_000_000,
      somethingNew: "payload",
    });
    const sseText = [
      `data: ${sessionStartedJson(1)}\n\n`,
      `data: ${futureEventJson}\n\n`,
      `data: ${sessionStartedJson(3)}\n\n`,
    ].join("");

    const received: ArcEvent[] = [];
    const frameErrors: Array<string[]> = [];

    let resolveEvents!: () => void;
    const eventsReady = new Promise<void>((r) => {
      resolveEvents = r;
    });

    globalThis.fetch = vi.fn().mockImplementation(
      (() => {
        let n = 0;
        return () => {
          n++;
          if (n === 1) {
            return Promise.resolve({
              ok: true,
              status: 200,
              body: makeSseStream(sseText),
            } as unknown as Response);
          }
          return new Promise<never>(() => {});
        };
      })(),
    ) as unknown as typeof fetch;

    const manager = new EventStreamManager({
      http: makeHttp(),
      sessionId: "s1",
      onEvents(batch) {
        received.push(...batch);
        manager.stop();
        resolveEvents();
      },
      onFrameError(_raw, issues) {
        frameErrors.push(issues);
      },
      coalesceMs: 9999,
      sleep: () => new Promise<never>(() => {}),
    });

    manager.start();
    await eventsReady;

    // 三条事件全部交付（未知 t 由 reducer 静默忽略，传输层不丢）
    expect(received.map((e) => e.seq)).toEqual([1, 2, 3]);
    // 不触发 onFrameError——未知 t 不是坏帧
    expect(frameErrors).toHaveLength(0);
    // maxSeq 推进到 3：重连不会重放未知事件
    expect((manager as unknown as { maxSeq: number }).maxSeq).toBe(3);
  });
});
