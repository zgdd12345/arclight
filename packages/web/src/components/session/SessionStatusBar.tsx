"use client";

// SessionStatusBar —— 顶栏仪表条（DEV_PLAN §2.2 / DESIGN.md Layout）。
// 左：移动端汉堡 + wordmark「arc light」（Fraunces，灯丝琥珀）。
// 右：上下文余量仪表 + 黄铜成本仪表 + 改动历史(undo/redo) + 导出 + 连接状态点 + epoch/seq + theme。
// 只做"成本/上下文/状态可观测"展示，不做 quota 强制。

import type { ConnectionStatus } from "@arclight/client-core";
import { useEffect, useRef, useState } from "react";
import {
  type Checkpoint,
  getContextUsage,
  getSessionUsage,
  listCheckpoints,
} from "../../lib/arcClient";
import { useArcCommand, useArcSession } from "../../lib/assistantRuntime";
import { downloadMarkdown, exportMarkdown } from "../../lib/exportMarkdown";
import { applyTheme } from "../../lib/theme";

// 顶栏 mono 边框小按钮的统一样式（改动/导出/theme 共用，保 DESIGN.md 一致）。
const TOPBAR_BTN_CLASS =
  "rounded-md border px-2 py-1 text-[11px] uppercase tracking-wide text-muted hover:bg-panel";
const TOPBAR_BTN_STYLE = {
  borderColor: "var(--hairline)",
  fontFamily: "var(--font-mono)",
} as const;

// 仪表轮询：初次挂载 + 每次 turn 状态变化（turn 落终态后用量/上下文已更新）重拉。
// alive flag 防卸载后 setState；turnStatus 是有意的触发依赖（body 内不直接读取）。
function useSessionPoll<T>(
  fetcher: (id: string) => Promise<T | null>,
  sessionId: string,
  turnStatus: string,
): T | null {
  const [data, setData] = useState<T | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: turnStatus 为有意触发依赖；fetcher 调用方稳定
  useEffect(() => {
    let alive = true;
    void fetcher(sessionId).then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [sessionId, turnStatus]);
  return data;
}

function dotStyle(status: ConnectionStatus, running: boolean): { color: string; breathe: boolean } {
  if (running) return { color: "var(--accent)", breathe: true };
  switch (status) {
    case "open":
      return { color: "var(--positive)", breathe: false };
    case "connecting":
    case "reconnecting":
      return { color: "var(--accent)", breathe: true };
    default:
      return { color: "var(--muted)", breathe: false };
  }
}

function toggleTheme(): void {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "light" ? "dark" : "light");
}

// 数字千分位（token 数读起来更像仪表）。
function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

// token 紧凑式：90k / 1.2M（仪表用，省空间）。
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// 成本：micros(USD 百万分之一) → 人类可读。极小值给 4 位小数，否则 2 位。
function fmtCost(micros: number): string {
  const usd = micros / 1_000_000;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// 成本仪表（DESIGN.md：顶栏右侧黄铜成本读数，mono）。turn 落终态后刷新。
function CostMeter({ sessionId, turnStatus }: { sessionId: string; turnStatus: string }) {
  const usage = useSessionPoll(getSessionUsage, sessionId, turnStatus);

  if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0)) return null;
  const total = usage.inputTokens + usage.outputTokens;
  return (
    <span
      className="hidden items-center gap-2 text-[12px] sm:flex"
      style={{ fontFamily: "var(--font-mono)", color: "var(--brass)" }}
      title={`输入 ${fmtTokens(usage.inputTokens)} · 输出 ${fmtTokens(usage.outputTokens)} tokens`}
    >
      <span>{fmtTokens(total)} tok</span>
      <span style={{ opacity: 0.5 }}>·</span>
      <span>{fmtCost(usage.costUsdMicros)}</span>
    </span>
  );
}

// 上下文余量仪表：上次 turn 上下文 token vs 压缩窗口。色彩梯度（避 hazard 红——红仅审批面）：
// <70% 鼠尾草 / 70-90% 琥珀 / >90% 热琥珀（接近压缩）。
function ContextMeter({ sessionId, turnStatus }: { sessionId: string; turnStatus: string }) {
  const ctx = useSessionPoll(getContextUsage, sessionId, turnStatus);

  if (!ctx || ctx.currentTokens === 0) return null;
  const ratio = Math.min(1, ctx.currentTokens / ctx.effectiveWindow);
  const pct = Math.round(ratio * 100);
  const color =
    ratio >= 0.9 ? "var(--accent-hot)" : ratio >= 0.7 ? "var(--accent)" : "var(--positive)";
  return (
    <span
      className="hidden items-center gap-1.5 text-[12px] md:flex"
      style={{ fontFamily: "var(--font-mono)", color: "var(--muted)" }}
      title={`上下文 ${fmtTokens(ctx.currentTokens)} / ${fmtTokens(ctx.effectiveWindow)} tokens（${pct}%，接近时自动压缩）`}
    >
      {/* 细 bar + 游标（DESIGN.md 仪表语言） */}
      <span
        className="relative inline-block h-1.5 w-12 overflow-hidden rounded-full"
        style={{ backgroundColor: "var(--hairline)" }}
        aria-hidden
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </span>
      <span>{fmtCompact(ctx.currentTokens)}</span>
      <span style={{ opacity: 0.5 }}>/</span>
      <span>{fmtCompact(ctx.effectiveWindow)}</span>
    </span>
  );
}

// 友好检查点标签：post-edit:apply_patch → "apply_patch"，pre-edit:* → "（基线）"。
function friendlyLabel(label: string | null): string {
  if (!label) return "checkpoint";
  const m = label.match(/^(pre|post)-edit:(.+)$/);
  if (m) return m[1] === "pre" ? `${m[2]}（改前）` : m[2];
  return label;
}

// 改动历史 + undo/redo（/undo /redo 可视化）。按钮发 /undo /redo（复用已测内核路径）；
// 弹层列出本会话 shadow-git 检查点时间线（只读）。
function ChangesPopover({
  sessionId,
  turnStatus,
  baseEpoch,
  running,
}: {
  sessionId: string;
  turnStatus: string;
  baseEpoch: number;
  running: boolean;
}) {
  const command = useArcCommand();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Checkpoint[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // 打开时 + turn 落终态时刷新检查点列表
  // biome-ignore lint/correctness/useExhaustiveDependencies: turnStatus 有意触发刷新
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listCheckpoints(sessionId).then((cps) => {
      if (alive) setItems(cps);
    });
    return () => {
      alive = false;
    };
  }, [open, sessionId, turnStatus]);

  // 点外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const sendSlash = (cmd: "/undo" | "/redo") => {
    if (running) return;
    void command.submit(sessionId, { text: cmd, agent: "code", baseEpoch });
  };

  // 时间线展示 post-edit 点（"改完"的可导航态），新→旧
  const timeline = items.filter((c) => !c.label?.startsWith("pre-edit")).reverse();

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={TOPBAR_BTN_CLASS}
        style={TOPBAR_BTN_STYLE}
        title="改动历史与撤销/重做"
        aria-expanded={open}
      >
        改动
      </button>
      {open ? (
        <div
          className="absolute right-0 z-30 mt-2 w-[320px] rounded-xl border bg-base p-3 shadow-lg"
          style={{ borderColor: "var(--hairline)" }}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="flex-1 text-[12px] font-[600] text-text">改动历史</span>
            <button
              type="button"
              disabled={running}
              onClick={() => sendSlash("/undo")}
              className="rounded-md border px-2 py-1 font-mono text-[11px] text-text hover:bg-panel disabled:opacity-40"
              style={{ borderColor: "var(--hairline)" }}
              title="撤销上一次改动"
            >
              ↶ 撤销
            </button>
            <button
              type="button"
              disabled={running}
              onClick={() => sendSlash("/redo")}
              className="rounded-md border px-2 py-1 font-mono text-[11px] text-text hover:bg-panel disabled:opacity-40"
              style={{ borderColor: "var(--hairline)" }}
              title="重做"
            >
              ↷ 重做
            </button>
          </div>
          {running ? (
            <p className="mb-2 font-mono text-[10px] text-muted">turn 运行中，撤销/重做暂不可用</p>
          ) : null}
          {timeline.length === 0 ? (
            <p className="py-3 text-center text-[12px] text-muted">本会话暂无文件改动</p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {timeline.map((c) => (
                <li
                  key={c.id}
                  className="rounded-md border px-2 py-1.5"
                  style={{ borderColor: "var(--hairline)" }}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-accent">
                      {friendlyLabel(c.label)}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted">
                      {c.changedFiles.length} 文件
                    </span>
                  </div>
                  {c.changedFiles.length > 0 ? (
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted">
                      {c.changedFiles.slice(0, 3).join(", ")}
                      {c.changedFiles.length > 3 ? " …" : ""}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

// 导出当前会话为 markdown。标题取首条用户消息文本（截断），回退 sessionId。
function ExportButton() {
  const state = useArcSession();
  const onExport = () => {
    const firstUser = state.messages.find((m) => m.role === "user");
    const titlePart = firstUser?.parts.find((p) => p.type === "text");
    const title = titlePart && "text" in titlePart ? titlePart.text.slice(0, 40) : null;
    const md = exportMarkdown(state.messages, {
      title,
      sessionId: state.sessionId,
      exportedAt: Date.now(),
    });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadMarkdown(md, `arclight-${state.sessionId.slice(0, 8)}-${stamp}.md`);
  };
  return (
    <button
      type="button"
      onClick={onExport}
      disabled={state.messages.length === 0}
      className={`${TOPBAR_BTN_CLASS} disabled:opacity-40`}
      style={TOPBAR_BTN_STYLE}
      title="导出对话为 markdown"
    >
      导出
    </button>
  );
}

export function SessionStatusBar({
  status,
  onToggleNav,
}: {
  status: ConnectionStatus;
  onToggleNav?: () => void;
}) {
  const state = useArcSession();
  const running = state.turn.status === "running";
  const dot = dotStyle(status, running);

  return (
    <header
      className="flex items-center gap-3 border-b bg-base px-3 py-3 md:px-5"
      style={{ borderColor: "var(--hairline)" }}
    >
      {onToggleNav ? (
        <button
          type="button"
          onClick={onToggleNav}
          className="rounded-md p-1.5 text-muted hover:bg-panel hover:text-text md:hidden"
          title="菜单"
          aria-label="打开侧边栏"
        >
          <span className="font-mono text-[16px] leading-none">≡</span>
        </button>
      ) : null}

      <span
        className="text-[20px] leading-none text-accent"
        style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
      >
        arc light
      </span>

      <div className="flex-1" />

      <ContextMeter sessionId={state.sessionId} turnStatus={state.turn.status} />
      <CostMeter sessionId={state.sessionId} turnStatus={state.turn.status} />
      <ChangesPopover
        sessionId={state.sessionId}
        turnStatus={state.turn.status}
        baseEpoch={state.epoch}
        running={running}
      />
      <ExportButton />

      <span
        className="flex items-center gap-2 text-[12px] text-muted"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full${dot.breathe ? " filament" : ""}`}
          style={{ backgroundColor: dot.color }}
          aria-hidden
        />
        <span className="hidden sm:inline">{status}</span>
      </span>

      <span
        className="hidden text-[12px] text-muted lg:inline"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        epoch {state.epoch} · seq {state.maxSeq}
      </span>

      <button
        type="button"
        onClick={toggleTheme}
        className={TOPBAR_BTN_CLASS}
        style={TOPBAR_BTN_STYLE}
      >
        theme
      </button>
    </header>
  );
}
