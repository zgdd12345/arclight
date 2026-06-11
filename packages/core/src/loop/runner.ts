import { eq } from "drizzle-orm";
import { appendEvent } from "../db/appendEvent";
import type { Db } from "../db/client";
import { sessions, turns, workspaces } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { ToolRegistry } from "../tools/registry";
import { queryLoop } from "./query-loop";
import type { ApprovalSeam, CallProvider, LoopDeps, LoopState } from "./types";

// AgentRunner：queryLoop 的有状态包装（DEV_PLAN §2.1）。
// 职责：单 session 单 active turn 登记、AbortController 双路径（interrupt 命令 / 进程收尾）、
// turn 状态机落库。事件持久化在 loop 的 emit（appendEvent）内完成，runner 只消费驱动。
// slice2 范围注：每 turn 以 [user text] 起新上下文；跨 turn 会话历史物化（messages 表回放）随 U5/U6。

// 注：system prompt 在 provider profile（makeCallProvider）单点注入，runner 不重复拼装。
export type RunnerDeps = {
  db: Db;
  bus: EventBus;
  registry: ToolRegistry;
  callProvider: CallProvider;
  executeTool: LoopDeps["executeTool"];
  approvals: ApprovalSeam;
  onInterrupt?: (turnId: string) => void; // 中断时收尾挂起审批等
  maxRetries?: number;
};

export class AgentRunner {
  private readonly active = new Map<string, { turnId: string; ac: AbortController }>();

  constructor(private readonly deps: RunnerDeps) {}

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** fire-and-forget：调用方（C1 handler）先落 turn 行再调本方法 */
  async startTurn(args: { sessionId: string; turnId: string; userText: string }): Promise<void> {
    const { db, bus } = this.deps;
    const { sessionId, turnId } = args;
    const ac = new AbortController();
    this.active.set(sessionId, { turnId, ac });

    const ws = db
      .select({ repoPath: workspaces.repoPath })
      .from(workspaces)
      .innerJoin(sessions, eq(sessions.workspaceId, workspaces.id))
      .where(eq(sessions.id, sessionId))
      .get();
    const cwd = ws?.repoPath ?? process.cwd();

    const state: LoopState = {
      sessionId,
      turnId,
      cwd,
      messages: [{ role: "user", content: args.userText }],
    };
    const loopDeps: LoopDeps = {
      emit: (draft) => appendEvent({ db, bus }, draft),
      callProvider: this.deps.callProvider,
      registry: this.deps.registry,
      approvals: this.deps.approvals,
      executeTool: this.deps.executeTool,
      signal: ac.signal,
      maxRetries: this.deps.maxRetries ?? 3,
    };

    db.update(turns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(turns.id, turnId))
      .run();
    try {
      const gen = queryLoop(state, loopDeps);
      let r = await gen.next();
      while (!r.done) r = await gen.next(); // 事件已在 emit 内落库+扇出
      db.update(turns)
        .set({ status: r.value.status, completedAt: new Date() })
        .where(eq(turns.id, turnId))
        .run();
    } catch (e) {
      // loop 契约上不 throw；此处为最后防线（如 appendEvent DB 故障）
      db.update(turns)
        .set({
          status: "failed",
          error: {
            status: "error",
            tool: "runner",
            error_class: "INTERNAL",
            user_message: e instanceof Error ? e.message.slice(0, 200) : "internal error",
            retry_allowed: false,
          },
          completedAt: new Date(),
        })
        .where(eq(turns.id, turnId))
        .run();
    } finally {
      ac.abort(); // 清理在途（沙箱 run / provider 流）
      this.active.delete(sessionId);
    }
  }

  /** interrupt 命令路径：abort 透传 callProvider / 工具 ctx.signal / 沙箱 kill；收尾挂起审批 */
  interrupt(turnId: string): boolean {
    this.deps.onInterrupt?.(turnId); // 先转 cancelled，再 abort 解阻挂起的轮询
    for (const [, entry] of this.active) {
      if (entry.turnId === turnId) {
        entry.ac.abort();
        return true;
      }
    }
    return false;
  }
}
