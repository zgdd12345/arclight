import { eq, sql } from "drizzle-orm";
import { CheckpointTracker } from "../coding/checkpoint/tracker";
import { UndoRedoController } from "../coding/checkpoint/undo-redo";
import { RepoMap } from "../coding/repomap/index";
import { appendEvent } from "../db/appendEvent";
import type { Db } from "../db/client";
import { sessions, turns, workspaces } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { ToolRegistry } from "../tools/registry";
import { type CompactResult, compact, shouldCompact } from "./compaction";
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
  arclightDir?: string; // 启用 shadow-git 检查点（缺省禁用，便于测试）
  /** 压缩 provider（缺省 = callProvider；测试可注入轻量摘要器） */
  compactProvider?: CallProvider;
  effectiveWindow?: number; // 压缩触发窗口（测试压低）
  repoMap?: boolean; // 进 turn 前注入 RepoMap 上下文（弹性，缺省关）
  repoMapTokens?: number; // RepoMap token 预算（默认 1024）
  usage?: {
    record(a: {
      sessionId: string;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
    }): void;
  };
  maxReflections?: number;
  maxRetries?: number;
};

type SessionCheckpoint = {
  tracker: CheckpointTracker;
  undoRedo: UndoRedoController;
  workspaceId: string;
};

export class AgentRunner {
  private readonly active = new Map<string, { turnId: string; ac: AbortController }>();
  private readonly checkpoints = new Map<string, SessionCheckpoint>();

  constructor(private readonly deps: RunnerDeps) {}

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** session → 其 workspace 的 id + repoPath（单点维护 join，getCheckpoint/startTurn 共用） */
  private resolveWorkspace(sessionId: string): { id: string; repoPath: string } | undefined {
    return this.deps.db
      .select({ id: workspaces.id, repoPath: workspaces.repoPath })
      .from(workspaces)
      .innerJoin(sessions, eq(sessions.workspaceId, workspaces.id))
      .where(eq(sessions.id, sessionId))
      .get();
  }

  /** 惰性构造 session 的检查点追踪器（需 arclightDir 启用） */
  private getCheckpoint(sessionId: string, cwd: string): SessionCheckpoint | null {
    if (!this.deps.arclightDir) return null;
    const cached = this.checkpoints.get(sessionId);
    if (cached) return cached;
    const workspaceId = this.resolveWorkspace(sessionId)?.id ?? "local";
    const tracker = new CheckpointTracker(
      this.deps.db,
      this.deps.arclightDir,
      workspaceId,
      sessionId,
      cwd,
    );
    const sc: SessionCheckpoint = {
      tracker,
      undoRedo: new UndoRedoController(tracker),
      workspaceId,
    };
    this.checkpoints.set(sessionId, sc);
    return sc;
  }

  /** /undo /redo 命令：restore + 发事件。返回 false 表示无可操作。 */
  async undoRedo(
    sessionId: string,
    action: "undo" | "redo",
    cwd: string,
  ): Promise<{ ok: boolean; message: string }> {
    const sc = this.getCheckpoint(sessionId, cwd);
    if (!sc) return { ok: false, message: "checkpoints disabled" };
    const r = action === "undo" ? await sc.undoRedo.undo() : await sc.undoRedo.redo();
    return r.ok
      ? { ok: true, message: `${action} → ${r.ref.slice(0, 8)}` }
      : { ok: false, message: r.reason };
  }

  /** fire-and-forget：调用方（C1 handler）先落 turn 行再调本方法 */
  async startTurn(args: { sessionId: string; turnId: string; userText: string }): Promise<void> {
    const { db, bus } = this.deps;
    const { sessionId, turnId } = args;
    const ac = new AbortController();
    this.active.set(sessionId, { turnId, ac });

    const cwd = this.resolveWorkspace(sessionId)?.repoPath ?? process.cwd();
    const emit = (draft: Parameters<typeof appendEvent>[1]) => appendEvent({ db, bus }, draft);

    // /undo /redo：拦截特殊指令，不进 provider 循环（DEV_PLAN §2.3 ③）
    const slash = args.userText.trim();
    if (slash === "/undo" || slash === "/redo") {
      db.update(turns)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(turns.id, turnId))
        .run();
      emit({ v: 1, t: "turn.started", sessionId, turnId });
      const action = slash === "/undo" ? "undo" : "redo";
      let res: { ok: boolean; message: string };
      try {
        res = await this.undoRedo(sessionId, action, cwd);
      } catch (e) {
        res = { ok: false, message: e instanceof Error ? e.message : "undo/redo failed" };
      }
      emit({
        v: 1,
        t: "message.delta",
        sessionId,
        turnId,
        messageId: `m-${turnId}`,
        role: "assistant",
        delta: res.ok ? `✓ ${res.message}` : `✗ ${action} 失败：${res.message}`,
      });
      emit({ v: 1, t: "turn.completed", sessionId, turnId, status: "completed" });
      db.update(turns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(turns.id, turnId))
        .run();
      ac.abort();
      this.active.delete(sessionId);
      return;
    }

    const sc = this.getCheckpoint(sessionId, cwd);

    // RepoMap 注入（弹性）：进 turn 前生成仓库符号图，作上下文前缀。失败/不可用静默跳过。
    const messages: LoopState["messages"] = [];
    if (this.deps.repoMap) {
      const mapText = await this.buildRepoMap(cwd, args.userText).catch(() => "");
      if (mapText) {
        messages.push({
          role: "user",
          content: `[Repository context — most relevant symbols by reference graph]\n${mapText}`,
        });
      }
    }
    messages.push({ role: "user", content: args.userText });

    const state: LoopState = { sessionId, turnId, cwd, messages };
    const loopDeps: LoopDeps = {
      emit,
      callProvider: this.deps.callProvider,
      registry: this.deps.registry,
      approvals: this.deps.approvals,
      executeTool: this.deps.executeTool,
      signal: ac.signal,
      maxRetries: this.deps.maxRetries ?? 3,
      ...(this.deps.maxReflections !== undefined
        ? { maxReflections: this.deps.maxReflections }
        : {}),
      ...(this.deps.usage
        ? {
            onUsage: (u) =>
              this.deps.usage?.record({
                sessionId,
                turnId,
                inputTokens: u.inputTokens,
                outputTokens: u.outputTokens,
              }),
          }
        : {}),
      ...(sc
        ? {
            checkpoint: {
              pre: async (toolName: string) => {
                const pre = await sc.tracker.commit(`pre-edit:${toolName}`, turnId);
                // 首次写之前的态作基线（undo 可回到所有编辑之前）
                if (!sc.undoRedo.hasBaseline()) sc.undoRedo.record(pre.ref);
              },
              post: async (toolName: string) => {
                const post = await sc.tracker.commit(`post-edit:${toolName}`, turnId);
                sc.undoRedo.record(post.ref); // 追加可导航点；曾 undo 则截断 redo
              },
            },
          }
        : {}),
      compaction: {
        maybeCompact: async (messages) => {
          if (!shouldCompact(messages, this.deps.effectiveWindow)) return null;
          const provider = this.deps.compactProvider ?? this.deps.callProvider;
          let result: CompactResult | null;
          try {
            result = await compact(messages, provider, ac.signal);
          } catch {
            return null; // 压缩失败不阻断 turn
          }
          if (!result) return null;
          // 原地替换消息（loop 持同一数组引用）
          messages.splice(0, messages.length, ...result.messages);
          // 先 epoch++（DB 权威），后 yield context.compacted——appendEvent 将 stamp 新 epoch
          const row = db
            .update(sessions)
            .set({ epoch: sql`${sessions.epoch} + 1`, summary: result.summaryText.slice(0, 4000) })
            .where(eq(sessions.id, sessionId))
            .returning({ epoch: sessions.epoch, nextSeq: sessions.nextSeq })
            .get();
          return { epoch: row?.epoch ?? 0, summarySeq: row?.nextSeq ?? 1 };
        },
      },
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

  /** 枚举工作区源文件（有界）→ RepoMap 文本。tree-sitter 不可用自动正则降级（R2）。
   *  mentioned 标识符从用户输入粗提；chatFiles 暂空（U7 接 active turn 涉及文件）。 */
  private async buildRepoMap(cwd: string, userText: string): Promise<string> {
    const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx}");
    const files: string[] = [];
    for await (const f of glob.scan({ cwd, onlyFiles: true })) {
      if (/node_modules|\.arclight|dist|build|\.next|migrations/.test(f)) continue;
      files.push(f);
      if (files.length >= 200) break; // 有界，防超大仓拖慢
    }
    if (files.length === 0) return "";
    const mentioned = new Set(
      (userText.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g) ?? []).slice(0, 40),
    );
    const rm = new RepoMap(cwd, this.deps.arclightDir);
    try {
      return await rm.generate(files, this.deps.repoMapTokens ?? 1024, {
        mentionedIdents: mentioned,
      });
    } finally {
      rm.close();
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
