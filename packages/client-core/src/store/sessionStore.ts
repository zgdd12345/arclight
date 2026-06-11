import type { ArcEvent } from "@arclight/protocol";
import { initialState, reduceBatch, type SessionState } from "./reducer";

// 端无关 store：subscribe/getSnapshot 契约与 React useSyncExternalStore 对齐
// （useArcSession hook 在 web 包接线时落地——client-core 不引 react）。
export class SessionStore {
  private state: SessionState;
  private readonly listeners = new Set<() => void>();

  constructor(sessionId: string) {
    this.state = initialState(sessionId);
  }

  getSnapshot = (): SessionState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** EventStreamManager.onEvents 直接接这里 */
  applyBatch = (batch: ArcEvent[]): void => {
    const next = reduceBatch(this.state, batch);
    if (next === this.state) return;
    this.state = next;
    for (const fn of this.listeners) fn();
  };

  /** resync 全量重建：清空后由 snapshot 事件流重放 */
  reset = (): void => {
    this.state = initialState(this.state.sessionId);
    for (const fn of this.listeners) fn();
  };
}
