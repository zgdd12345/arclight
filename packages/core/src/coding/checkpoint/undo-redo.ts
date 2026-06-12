import type { CheckpointTracker } from "./tracker";

// undo/redo 控制器（DEV_PLAN §2.3 ③，吸收 MISSING-4）。
// 自持有序 ref 栈（不每次从 DB 重导，以正确建模 redo 栈截断）：
//   stack = [baseline, post-edit-1, post-edit-2, ...]，cursor 指当前工作区所在下标。
//   record(ref)：在 cursor 之后追加；若 cursor 不在栈尾（曾 undo），先截断前向历史（清空 redo）。
//   undo：cursor-- → restore；redo：cursor++ → restore。
//   reset --hard 由 tracker 执行，O(log n) 由 git 对象寻址保证。

export type UndoRedoResult =
  | { ok: true; action: "undo" | "redo"; ref: string }
  | { ok: false; reason: string };

export class UndoRedoController {
  private stack: string[] = [];
  private cursor = -1; // 指向 stack 中当前工作区对应的 ref；-1 = 空

  constructor(private readonly tracker: CheckpointTracker) {
    this.hydrate();
  }

  /** 从已持久化的 checkpoints 行重建可导航栈（服务重启后 /undo 不再误报"无检查点"）。
   *  运行时 record 语义为「首个 pre-edit 作基线 + 每个 post-edit 作可导航点」，
   *  故此处同样以首行为基线、其后仅取 post-edit 行；游标置于栈尾（最新态）。
   *  注：曾 undo 后未再写即结束的 session，其废弃 redo 行也会被纳入——这些都是真实
   *  落库的 commit 态，重建到栈尾可接受（与内存态的细微差异为固有限制）。 */
  private hydrate(): void {
    const rows = this.tracker.list();
    if (rows.length === 0) return;
    const first = rows[0];
    if (!first) return;
    this.stack = [first.ref];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row?.label?.startsWith("post-edit")) this.stack.push(row.ref);
    }
    this.cursor = this.stack.length - 1;
  }

  /** 记录一个可导航检查点（基线或 post-edit）。曾 undo 后的新写 → 截断 redo 历史。 */
  record(ref: string): void {
    if (this.cursor < this.stack.length - 1) {
      this.stack = this.stack.slice(0, this.cursor + 1); // 清空 redo 栈（前向历史作废）
    }
    this.stack.push(ref);
    this.cursor = this.stack.length - 1;
  }

  hasBaseline(): boolean {
    return this.stack.length > 0;
  }

  async undo(): Promise<UndoRedoResult> {
    if (this.stack.length === 0) return { ok: false, reason: "no checkpoints to undo" };
    if (this.cursor <= 0) return { ok: false, reason: "already at earliest checkpoint" };
    this.cursor -= 1;
    const ref = this.stack[this.cursor];
    if (!ref) return { ok: false, reason: "checkpoint missing" };
    await this.tracker.restore(ref);
    return { ok: true, action: "undo", ref };
  }

  async redo(): Promise<UndoRedoResult> {
    if (this.cursor >= this.stack.length - 1) {
      return { ok: false, reason: "nothing to redo (already at latest)" };
    }
    this.cursor += 1;
    const ref = this.stack[this.cursor];
    if (!ref) return { ok: false, reason: "checkpoint missing" };
    await this.tracker.restore(ref);
    return { ok: true, action: "redo", ref };
  }

  /** 当前游标位置（测试/可观测用） */
  get position(): number {
    return this.cursor;
  }
}
