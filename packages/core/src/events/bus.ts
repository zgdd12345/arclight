import type { ArcEvent } from "@arclight/protocol";

// 进程内事件总线：appendEvent 落库后发布，SSE 订阅者实时收流。
// 不变式由 appendEvent 守护（先持久化后发布），bus 只做扇出，不排序、不缓冲——
// 断线补帧一律走 SQLite replay（events 表即缓冲）。
export type EventListener = (e: ArcEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();

  subscribe(sessionId: string, fn: EventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  publish(e: ArcEvent): void {
    const set = this.listeners.get(e.sessionId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(e);
      } catch {
        // 单个订阅者出错不拖垮扇出；订阅者自己负责错误处理
      }
    }
  }
}
