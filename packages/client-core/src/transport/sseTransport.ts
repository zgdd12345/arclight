import { type ArcEvent, parseWireEvent } from "@arclight/protocol";
import { EpochTracker } from "../epoch";
import type { HttpClient } from "./httpClient";
import { parseSseStream } from "./stream";

// EventStreamManager（DEV_PLAN §2.2，自研续接，废 useChat resume）。三纪律：
// ① coalesce 合批（默认 16ms）喂 reducer，避免每 token 一次渲染
// ② 250ms 指数退避 ×2 封顶 8s + jitter（base*(0.5+random*0.5)），成功复位
// ③ seq 单调去重：dispatch 入口 seq <= maxSeq 直接丢弃（重连 replay 幻影重复）
// 409 续接：{reason, snapshotUrl} → 拉 snapshot 全量重建 → setBookmark 后再 connect。

export type Snapshot = { sessionId: string; epoch: number; lastSeq: number; events: ArcEvent[] };
export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export type EventStreamOptions = {
  http: HttpClient;
  sessionId: string;
  onEvents: (batch: ArcEvent[]) => void; // 合批后回调（含 snapshot 重建的事件）
  onResync?: (snapshot: Snapshot, reason: string) => void;
  onStatus?: (status: ConnectionStatus) => void;
  onFrameError?: (raw: string, issues: string[]) => void; // 单帧解析/校验失败（不断连）
  onAuthError?: (httpStatus: number) => void; // 401/403：token 失效/无权，已终止重连
  coalesceMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  random?: () => number; // jitter 注入（测试可定值）
  sleep?: (ms: number) => Promise<void>;
};

export class EventStreamManager {
  readonly epochTracker = new EpochTracker();
  private maxSeq = 0;
  private stopped = true;
  private abort: AbortController | null = null;
  private pending: ArcEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  constructor(private readonly opts: EventStreamOptions) {}

  setBookmark(lastSeq: number, epoch: number): void {
    this.maxSeq = lastSeq;
    this.epochTracker.setBookmark(lastSeq, epoch);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.runLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.flushNow();
    this.status("closed");
  }

  // ── 内部 ──

  private status(s: ConnectionStatus): void {
    this.opts.onStatus?.(s);
  }

  private dispatch(e: ArcEvent): void {
    if (e.seq <= this.maxSeq) return; // 纪律③ 去重
    this.maxSeq = e.seq;
    this.epochTracker.advance(e.seq, e.epoch);
    this.pending.push(e);
    const coalesceMs = this.opts.coalesceMs ?? 16;
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushNow(), coalesceMs); // 纪律① 合批
    }
  }

  private flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.opts.onEvents(batch);
  }

  private backoffDelay(): number {
    const base = this.opts.backoffBaseMs ?? 250;
    const cap = this.opts.backoffCapMs ?? 8000;
    const raw = Math.min(base * 2 ** this.attempt, cap);
    const random = this.opts.random ?? Math.random;
    return raw * (0.5 + random() * 0.5); // 纪律② jitter 防多标签页齐冲
  }

  private async runLoop(): Promise<void> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    while (!this.stopped) {
      this.status(this.attempt === 0 ? "connecting" : "reconnecting");
      try {
        const path =
          `/api/sessions/${this.opts.sessionId}/events` +
          `?afterSeq=${this.maxSeq}&epoch=${this.epochTracker.epoch}`;
        this.abort = new AbortController();
        // HttpClient.getRaw 不带 signal；这里用其 url/headers 组可中断 fetch
        const { http } = this.opts;
        const res = await fetch(http.url(path), {
          headers: http.headers(),
          signal: this.abort.signal,
        });

        if (res.status === 409) {
          const body = (await res.json()) as { reason: string; snapshotUrl: string };
          await this.resync(body.reason, body.snapshotUrl);
          this.attempt = 0;
          continue; // 重建书签后立刻重连
        }
        // 鉴权失败是终态：token 失效/轮换后重试永远 401，退避重连只会无限刷错
        //（核心重启换 token 的旧标签页曾以此打出上百条 401）。停止循环并上报。
        if (res.status === 401 || res.status === 403) {
          this.stopped = true;
          this.status("closed");
          this.opts.onAuthError?.(res.status);
          return;
        }
        if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);

        this.status("open");
        this.attempt = 0; // 纪律② 成功复位
        for await (const frame of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
          if (this.stopped) break;
          // 纪律④ 单帧容错：JSON 解析或信封校验失败只跳过该帧，
          // 不推进 maxSeq，不断连——一条坏帧不应代价整条流的重连。
          // 用 parseWireEvent（宽容版）：未知 `t` 是 forward-compat 一等公民，
          // 照常 dispatch 推进 maxSeq/epoch，由 reducer 静默忽略；
          // 若在此丢弃，重连 afterSeq 会卡在未知事件之前无限重放。
          let raw: unknown;
          try {
            raw = JSON.parse(frame.data);
          } catch {
            this.opts.onFrameError?.(frame.data, ["invalid JSON"]);
            continue;
          }
          const result = parseWireEvent(raw);
          if (!result.ok) {
            this.opts.onFrameError?.(frame.data, result.issues);
            continue;
          }
          this.dispatch(result.value);
        }
        // 服务器正常断流 → 走重连
      } catch {
        if (this.stopped) break;
      } finally {
        this.flushNow();
      }
      if (this.stopped) break;
      await sleep(this.backoffDelay());
      this.attempt = Math.min(this.attempt + 1, 10);
    }
  }

  private async resync(reason: string, snapshotUrl: string): Promise<void> {
    const snap = await this.opts.http.getJson<Snapshot & { ok: boolean }>(snapshotUrl);
    // 关键坑④：先 setBookmark 再继续 connect
    this.maxSeq = 0; // 全量重建：snapshot 事件流重新过 dispatch（去重基线归零）
    this.pending = [];
    this.opts.onResync?.(snap, reason);
    for (const e of snap.events) this.dispatch(e);
    this.flushNow();
    this.setBookmark(snap.lastSeq, snap.epoch);
  }
}
