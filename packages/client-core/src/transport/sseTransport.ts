import type { ArcEvent } from "@arclight/protocol";
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
        if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);

        this.status("open");
        this.attempt = 0; // 纪律② 成功复位
        for await (const frame of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
          if (this.stopped) break;
          const e = JSON.parse(frame.data) as ArcEvent;
          this.dispatch(e);
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
