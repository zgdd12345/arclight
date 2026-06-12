import type { ArcEvent, Tool, ToolErrorEnvelope } from "@arclight/protocol";
import { and, eq } from "drizzle-orm";
import { appendEvent } from "../db/appendEvent";
import type { Db } from "../db/client";
import { approvals, toolCalls, turns } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { ApprovalDecision, ApprovalSeam, LoopToolContext } from "../loop/types";
import { previewJson } from "../util/text";
import { classify } from "./presets";
import { ApprovalService } from "./service";

export type AuditKind = "blacklist.hit" | "approval.asked" | "tool.denied";
export type AuditFn = (
  kind: AuditKind,
  detail: Record<string, unknown>,
  sessionId?: string,
) => void;

/** unknown → 安全的 Record（非对象回退空对象），detail/args 落库前统一过 */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

// ApprovalSeam 完整实现（替换 slice2 的 allow-all）。fail-closed：
// - 黑名单/admin_only → deny（不弹审批）
// - confirm → emit permission.ask + 挂起等决议；turn 转 awaiting_approval（不占 provider 调用）
// - 决议映射回 loop：allowed→allow；denied/expired/cancelled→deny（errorClass 细分）
// 挂起靠轮询 ApprovalService 终态（内核权威），由 C1 approve / interrupt / TTL 推进。

export type DenyClass = Extract<
  ToolErrorEnvelope["error_class"],
  "APPROVAL_DENIED" | "APPROVAL_EXPIRED" | "PERMISSION_DENIED"
>;

export type RichApprovalDecision = ApprovalDecision & { errorClass?: DenyClass };

export class ApprovalPolicy implements ApprovalSeam {
  private readonly service: ApprovalService;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    opts: {
      ttlMs?: number;
      now?: () => number;
      pollMs?: number;
      dangerFullAccess?: boolean;
      audit?: AuditFn;
    } = {},
  ) {
    this.service = new ApprovalService(db, opts.ttlMs, opts.now);
    this.pollMs = opts.pollMs ?? 200;
    this.dangerFullAccess = opts.dangerFullAccess ?? false;
    this.audit = opts.audit;
  }
  private readonly pollMs: number;
  private readonly dangerFullAccess: boolean;
  private readonly audit: AuditFn | undefined;
  // 本会话工具白名单（sessionId → 已"本会话允许"的工具名集合）。内存态，进程级；
  // 重启/新会话自然清空（session 语义）。仅短路本应弹审批的 confirm 档（risk=med）——
  // 黑名单/admin_only 在 classify 内先判，永不经此放行；且高危（risk=high）的批准
  // 绝不被记入本表（见 rememberToolForSession：纵深防御，挡住客户端伪造 scope 的提权）。
  private readonly sessionAllow = new Map<string, Set<string>>();

  /** interrupt 路径：把该 turn 下所有 pending 审批转 cancelled。
   *  注：waitForDecision 也会在 signal.aborted 时自行 cancel；此方法保证即便无活跃挂起者，
   *  DB 里的 pending 行也被收尾（中断后不变式：审批转终态）。 */
  cancelTurn(turnId: string): void {
    const pending = this.db
      .select({ askId: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.turnId, turnId), eq(approvals.status, "pending")))
      .all();
    for (const { askId } of pending) this.service.cancel(askId);
  }

  async check(
    tool: Tool<unknown, unknown>,
    args: unknown,
    ctx: LoopToolContext,
  ): Promise<RichApprovalDecision> {
    const decision = classify(tool, args, { dangerFullAccess: this.dangerFullAccess });

    if (decision.kind === "auto-allow") return { decision: "allow" };
    if (decision.kind === "deny") {
      // 黑名单/admin_only 拒绝 → 审计留痕（安全敏感）
      this.audit?.(
        "blacklist.hit",
        { tool: tool.meta.name, reason: decision.reason },
        ctx.sessionId,
      );
      return { decision: "deny", reason: decision.reason, errorClass: "PERMISSION_DENIED" };
    }
    // 本会话白名单短路：用户此前对该工具点过「本会话内允许」→ 直接放行，不再弹审批。
    // 位置在 classify 之后（L81）——黑名单/admin_only 已在 classify 内拒掉（返回 deny），
    // 绝不会走到这里；故此短路只可能命中 confirm 档（risk=med）。且白名单本身只收 med 档
    // （rememberToolForSession 拒收 high），双重保证高危工具不被本会话自动放行。
    // bash 属 confirm 档：一次「本会话允许」会自动放行后续非黑名单 shell——这是按设计接受的，
    // 因为 bash 受沙箱约束（docker --network none、仅项目目录 rw、shadow-git checkpoint 覆盖改动），
    // 爆炸半径有界。
    if (this.sessionAllow.get(ctx.sessionId)?.has(tool.meta.name)) {
      this.audit?.(
        "approval.asked",
        { tool: tool.meta.name, action: decision.action, autoAllow: "session" },
        ctx.sessionId,
      );
      return { decision: "allow" };
    }

    this.audit?.(
      "approval.asked",
      { tool: tool.meta.name, action: decision.action, risk: decision.risk },
      ctx.sessionId,
    );

    // ── ask：落库 + emit permission.ask + 挂起 ──
    // 确保 tool_calls 行存在（approvals.toolCallId FK；slice2 loop 尚未持久化 tool_calls，
    // 富 tool_calls 生命周期落库随 U5/U6——此处先 upsert 最小行以建立审批链接）
    this.ensureToolCallRow(tool.meta.name, args, ctx);
    const ask = this.service.create({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolCallId: ctx.callId,
      risk: decision.risk,
      cls: decision.cls,
      action: decision.action,
      detail: asRecord(args),
    });
    this.db
      .update(toolCalls)
      .set({ status: "awaiting_approval", approvalId: ask.askId })
      .where(eq(toolCalls.id, ctx.callId))
      .run();
    this.db
      .update(turns)
      .set({ status: "awaiting_approval" })
      .where(eq(turns.id, ctx.turnId))
      .run();

    this.emit({
      v: 1,
      t: "permission.ask",
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      askId: ask.askId,
      callId: ctx.callId,
      risk: decision.risk,
      cls: decision.cls,
      action: decision.action,
      detail: asRecord(args),
      expiresAt: ask.expiresAt,
    });

    const status = await this.waitForDecision(ask.askId, ctx.signal);
    // 恢复 turn 运行态（loop 仍在同一 provider 轮内，未额外调用 provider）
    this.db.update(turns).set({ status: "running" }).where(eq(turns.id, ctx.turnId)).run();

    if (status === "allowed") return { decision: "allow" };
    if (status === "expired") {
      return { decision: "deny", reason: "approval expired (60s)", errorClass: "APPROVAL_EXPIRED" };
    }
    if (status === "cancelled") {
      return { decision: "deny", reason: "turn interrupted", errorClass: "APPROVAL_DENIED" };
    }
    return { decision: "deny", reason: "user denied", errorClass: "APPROVAL_DENIED" };
  }

  /** 挂起：轮询终态。中断 → cancel；TTL 到 → expire。绝不在此调用 provider。 */
  private async waitForDecision(askId: string, signal: AbortSignal): Promise<string> {
    while (true) {
      if (signal.aborted) return this.service.cancel(askId);
      const s = this.service.expireIfDue(askId);
      if (s !== "pending") return s;
      await this.sleepOrAbort(this.pollMs, signal);
    }
  }

  private sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      // 定时器先到（正常轮询路径）也要摘掉监听器，否则每轮泄漏一个直到 signal abort
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private ensureToolCallRow(name: string, args: unknown, ctx: LoopToolContext): void {
    // 单语句 upsert（消除多余 SELECT round-trip）；行已存在则不动
    this.db
      .insert(toolCalls)
      .values({
        id: ctx.callId,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        name,
        status: "awaiting_approval",
        args: asRecord(args),
        argsPreview: previewJson(args),
      })
      .onConflictDoNothing()
      .run();
  }

  private emit(draft: Parameters<typeof appendEvent>[1]): ArcEvent {
    return appendEvent({ db: this.db, bus: this.bus }, draft);
  }

  /** C1 approve 命令入口。scope=session & allow → 把该 askId 对应的工具记入本会话白名单，
   *  后续同工具的 confirm 档自动放行（黑名单仍先拦）。 */
  decide(askId: string, decision: "allow" | "deny", scope: "once" | "session" = "once"): string {
    if (decision === "allow" && scope === "session") this.rememberToolForSession(askId);
    return this.service.decide(askId, decision);
  }

  /** 由 askId 反查 (sessionId, 工具名)，记入本会话白名单。行缺失则静默跳过（决议本身仍照常）。
   *  纵深防御（防客户端伪造 scope 提权）：仅 confirm 档（risk=med）可被本会话记住；
   *  高危（risk=high，即 admin_only，含 dangerFullAccess 放行的 admin_only）绝不记住——
   *  这类工具每次调用都必须重新弹审批。本次「允许这一发」仍由 service.decide 照常生效，
   *  此处只跳过「记住」。服务端以 approvals.risk 为准，不信任客户端传入的 scope。 */
  private rememberToolForSession(askId: string): void {
    const a = this.db
      .select({
        sessionId: approvals.sessionId,
        toolCallId: approvals.toolCallId,
        risk: approvals.risk,
      })
      .from(approvals)
      .where(eq(approvals.id, askId))
      .get();
    if (!a?.toolCallId) return;
    // 高危永不记住：挡住「客户端把 admin_only 工具伪造成 session-scope」的提权路径
    if (a.risk === "high") return;
    const tc = this.db
      .select({ name: toolCalls.name })
      .from(toolCalls)
      .where(eq(toolCalls.id, a.toolCallId))
      .get();
    if (!tc) return;
    let set = this.sessionAllow.get(a.sessionId);
    if (!set) {
      set = new Set();
      this.sessionAllow.set(a.sessionId, set);
    }
    set.add(tc.name);
  }
}
