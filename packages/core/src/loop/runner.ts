import { randomUUID } from "node:crypto";
import type { ArcEvent } from "@arclight/protocol";
import { eq } from "drizzle-orm";
import { CheckpointTracker } from "../coding/checkpoint/tracker";
import { UndoRedoController } from "../coding/checkpoint/undo-redo";
import { RepoMap } from "../coding/repomap/index";
import { appendEvent, StaleEpochError } from "../db/appendEvent";
import type { Db } from "../db/client";
import { events, memories, sessions, turns, workspaces } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { ToolRegistry } from "../tools/registry";
import { type CompactResult, compact, estimateTokens, shouldCompact } from "./compaction";
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
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
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
  // 按 cwd 复用 RepoMap 实例：每 turn 重建会反复开 SQLite + PRAGMA + DDL（TagCache）。
  // 缓存按 mtime 失效，跨 turn 复用安全。dispose 时统一关闭。
  private readonly repoMaps = new Map<string, RepoMap>();

  constructor(private readonly deps: RunnerDeps) {}

  /** 释放跨 turn 持有的资源（RepoMap 的 SQLite 句柄等）。serve 收尾时调用。 */
  dispose(): void {
    for (const rm of this.repoMaps.values()) rm.close();
    this.repoMaps.clear();
  }

  /** 惰性构造并按 cwd 复用 RepoMap（TagCache 句柄复用，避免每 turn 重开库） */
  private getRepoMap(cwd: string): RepoMap {
    const cached = this.repoMaps.get(cwd);
    if (cached) return cached;
    const rm = new RepoMap(cwd, this.deps.arclightDir);
    this.repoMaps.set(cwd, rm);
    return rm;
  }

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

  /** 准入乐观锁失败收口：陈旧 baseEpoch 在首个 append 被事务内拦下后，turn 干净置 failed。
   *  retry_allowed=true——client resync 到新 epoch 后可重提交。 */
  private failStaleTurn(turnId: string, e: StaleEpochError): void {
    this.deps.db
      .update(turns)
      .set({
        status: "failed",
        error: {
          status: "error",
          tool: "runner",
          error_class: "VALIDATION",
          user_message: e.message.slice(0, 200),
          retry_allowed: true,
        },
        completedAt: new Date(),
      })
      .where(eq(turns.id, turnId))
      .run();
  }

  /** 非 Stale 的内部故障收口：turn 干净置 failed（retry_allowed=false）。准入处与 startTurn
   *  catch 共用——绝不向 fire-and-forget 的 void 重抛，避免楔死 session（isActive 恒真）。 */
  private failInternalTurn(turnId: string, e: unknown): void {
    this.deps.db
      .update(turns)
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
  }

  /** turn 准入（/undo/redo 与正常分支共用，消除重复）：置 running + 发 turn.started
   *  （首个 append 带 expectedEpoch 乐观锁）。返回 false 表示准入失败——已干净置 failed
   *  并 abort+清 active，调用方须立即 return。
   *
   *  关键：startTurn 系 fire-and-forget（commands.ts `void runner.startTurn(...)`），且本段在
   *  外层 try/catch（其 finally 才 ac.abort()+active.delete）之前。若准入处的非 Stale 异常
   *  （appendEvent SQLITE_BUSY / SessionNotFoundError / 抛错的 bus 订阅者）上抛逃出 startTurn，
   *  则已 commit 的 turns 行永卡 running、ac 不 abort、active 不清 → isActive() 恒真 →
   *  该 session 后续每次 submit 都被 TURN_ACTIVE 409 楔死至进程重启。故此处一律就地置 failed，
   *  绝不向 void 重抛。 */
  private admitTurn(
    turnId: string,
    sessionId: string,
    ac: AbortController,
    emit: (draft: Parameters<typeof appendEvent>[1]) => ArcEvent,
    userText?: string,
  ): boolean {
    this.deps.db
      .update(turns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(turns.id, turnId))
      .run();
    try {
      emit({ v: 1, t: "turn.started", sessionId, turnId });
      // 问答回显：用户输入紧随 turn.started 落事件流（持久化 + replay），
      // transcript 的"问"不再依赖客户端乐观消息（刷新即丢）。
      if (userText !== undefined) {
        emit({
          v: 1,
          t: "user.message",
          sessionId,
          turnId,
          messageId: `u-${turnId}`,
          text: userText,
        });
      }
      return true;
    } catch (e) {
      if (e instanceof StaleEpochError) {
        // 准入处陈旧 epoch：turn 干净置 failed（retry_allowed），不留 running 孤儿
        this.failStaleTurn(turnId, e);
      } else {
        // 非 Stale 准入故障：干净置 failed（避免楔死 session）
        this.failInternalTurn(turnId, e);
      }
      ac.abort();
      this.active.delete(sessionId);
      return false;
    }
  }

  /** fire-and-forget：调用方（C1 handler）先落 turn 行再调本方法 */
  async startTurn(args: {
    sessionId: string;
    turnId: string;
    userText: string;
    baseEpoch: number;
  }): Promise<void> {
    const { db, bus } = this.deps;
    const { sessionId, turnId, baseEpoch } = args;
    const ac = new AbortController();
    this.active.set(sessionId, { turnId, ac });

    const cwd = this.resolveWorkspace(sessionId)?.repoPath ?? process.cwd();
    // 准入乐观锁（P0 §C）：本 turn 首个 append（turn.started）以 client 声明的 baseEpoch
    // 作 expectedEpoch，在 appendEvent 事务内复核 session.epoch。绕过路由 TOCTOU 预检
    // （baseEpoch!==epoch 在事务外读）的陈旧提交在此以 StaleEpochError 终止，绝不在错误 epoch 下落库。
    // 注：仅首个 append 设防——turn 内后续 append 不带 expectedEpoch，因 mid-turn 压缩会合法推进 epoch。
    let admitted = false;
    const emit = (draft: Parameters<typeof appendEvent>[1]) => {
      if (admitted) return appendEvent({ db, bus }, draft);
      admitted = true;
      return appendEvent({ db, bus }, draft, { expectedEpoch: baseEpoch });
    };

    // /undo /redo：拦截特殊指令，不进 provider 循环（DEV_PLAN §2.3 ③）
    const slash = args.userText.trim();
    if (slash === "/undo" || slash === "/redo") {
      if (!this.admitTurn(turnId, sessionId, ac, emit, args.userText)) return;
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

    // 受理即反馈：turn.started 在慢准备（checkpoint/RepoMap 冷加载首 turn 可达数十秒）
    // 之前立即发出，客户端立刻看到 running；准入乐观锁（expectedEpoch）也在此生效。
    if (!this.admitTurn(turnId, sessionId, ac, emit, args.userText)) return;

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
    // 用户记忆注入（仿 ChatGPT Memory）：启用项作为上下文前缀，跨会话长期生效。
    // 弹性：查询失败静默跳过（记忆是增强不是依赖，旧库未迁移时不阻断 turn）。
    try {
      const mems = db
        .select({ content: memories.content })
        .from(memories)
        .where(eq(memories.enabled, true))
        .all();
      if (mems.length > 0) {
        messages.push({
          role: "user",
          content: `[用户记忆 — 长期偏好与事实，回答与做事时遵循]\n${mems.map((m) => `- ${m.content}`).join("\n")}`,
        });
      }
    } catch {
      // memories 表不可用：跳过注入
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
                // BUG5：透传 prompt cache 读/写量，填充 usage 表既有 cache 列
                cacheReadTokens: u.cacheReadTokens ?? 0,
                cacheWriteTokens: u.cacheWriteTokens ?? 0,
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
          if (!shouldCompact(messages, this.deps.effectiveWindow)) return false;
          const provider = this.deps.compactProvider ?? this.deps.callProvider;
          let result: CompactResult | null;
          try {
            result = await compact(messages, provider, ac.signal);
          } catch {
            return false; // 压缩失败不阻断 turn
          }
          if (!result) return false;
          // 原地替换消息（loop 持同一数组引用）
          messages.splice(0, messages.length, ...result.messages);
          // BUG4：epoch++ 与 context.compacted 事件【同一事务】原子落库。
          // 旧实现先 epoch++（自动提交）再由 loop 另起事务 appendEvent——两段之间崩溃
          // 留下「epoch 已进、compacted 行缺失」的半完成态，events 路由的 epoch-jump 重同步
          // 因 lastCompactedSeq==null 永不触发，前端永久卡 STALE_EPOCH。此处合一根治。
          const event = db.transaction((tx) => {
            const row = tx
              .select({ nextSeq: sessions.nextSeq, epoch: sessions.epoch })
              .from(sessions)
              .where(eq(sessions.id, sessionId))
              .get();
            if (!row) return null;
            const newEpoch = row.epoch + 1;
            const seq = row.nextSeq;
            // context.compacted 的 summarySeq = 其自身 seq（与旧 appendEvent 行为一致）
            const full = {
              v: 1,
              t: "context.compacted",
              sessionId,
              turnId,
              summarySeq: seq,
              seq,
              epoch: newEpoch,
              ts: Date.now(),
            } as ArcEvent;
            tx.update(sessions)
              .set({
                epoch: newEpoch,
                summary: result.summaryText.slice(0, 4000),
                nextSeq: seq + 1,
                lastEventSeq: seq,
              })
              .where(eq(sessions.id, sessionId))
              .run();
            tx.insert(events)
              .values({
                id: randomUUID(),
                sessionId,
                turnId,
                seq,
                epoch: newEpoch,
                type: "context.compacted",
                event: full,
              })
              .run();
            return full;
          });
          if (event) bus.publish(event); // 先持久化提交，后扇出 bus
          return event !== null;
        },
      },
    };

    try {
      const gen = queryLoop(state, loopDeps);
      let r = await gen.next();
      while (!r.done) r = await gen.next(); // 事件已在 emit 内落库+扇出
      db.update(turns)
        .set({ status: r.value.status, completedAt: new Date() })
        .where(eq(turns.id, turnId))
        .run();
    } catch (e) {
      // 准入乐观锁：陈旧 baseEpoch 绕过路由预检后在首个 append 处被事务内拦下（无事件落库）
      if (e instanceof StaleEpochError) {
        this.failStaleTurn(turnId, e);
      } else {
        // loop 契约上不 throw；此处为最后防线（如 appendEvent DB 故障）
        this.failInternalTurn(turnId, e);
      }
    } finally {
      // 上下文余量仪表：无论成功/失败/中断都记一次最终上下文 token（state.messages 即最终上下文，
      // 含 RepoMap/记忆/摘要/工具回灌；压缩 splice 后也正确）。放 finally 保证压缩后 DB 异常也不留陈旧值。
      // 与 shouldCompact 同口径（@anthropic-ai/tokenizer 估计）。session 行不存在时 update 为 no-op。
      try {
        db.update(sessions)
          .set({ contextTokens: estimateTokens(state.messages) })
          .where(eq(sessions.id, sessionId))
          .run();
      } catch {
        // 估算/写库失败不影响 turn 收尾
      }
      ac.abort(); // 清理在途（沙箱 run / provider 流）
      this.active.delete(sessionId);
    }
  }

  /** 枚举工作区源文件（有界）→ RepoMap 文本。tree-sitter 不可用自动正则降级（R2）。
   *  mentioned 标识符从用户输入粗提；chatFiles 暂空（U7 接 active turn 涉及文件）。 */
  /** 冷路径预热（tokenizer/tree-sitter 加载 + tag 缓存填充）：serve 启动后后台调用，
   *  消掉首 turn 的数十秒准备空窗。失败静默（预热不挡服务）。 */
  async warmup(cwd: string): Promise<void> {
    if (!this.deps.repoMap) return;
    await this.buildRepoMap(cwd, "").catch(() => {});
  }

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
    // 复用按 cwd 缓存的 RepoMap 实例（dispose 时统一关闭，不再每 turn 开/关库）
    const rm = this.getRepoMap(cwd);
    return await rm.generate(files, this.deps.repoMapTokens ?? 1024, {
      mentionedIdents: mentioned,
    });
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
