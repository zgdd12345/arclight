"use client";

// PermissionModal —— 「断电闸刀」（DESIGN.md 信任面纪律②，本系统的灵魂）。
// 消费 store 的 pendingApprovals[0]（一次一个）。视觉与常规暖光 UI 反转：
//   · 弹出时整个工作区压暗降饱和（遮罩 rgba(5,4,3,.78) + saturate(.4)），暖光退场
//   · 命令全文 mono 展示；RiskBadge 显示四级风险
//   · 默认焦点 + Enter/Escape 一律落在「拒绝」——误回车 = 拒绝（fail-closed）
//   · 高危（irreversible/funds 或 risk=high）批准用 hold-to-confirm（按住 ~800ms）
//   · 底部常驻 "fail-closed · 回车=拒绝 · {N}s 自动过期"
//   · 前端倒计时仅 UX 提示；归零后禁用按钮，真相以内核事件清掉这条 pendingApproval 为准
//   · decision 不前端乐观删除：approve(askId,...) 后等内核 envelope 驱动移除，避免与内核打架

import type { CommandClient } from "@arclight/client-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useArcSession } from "../../lib/assistantRuntime";
import { isDangerousRisk, RiskBadge, riskLevelColor } from "./RiskBadge";

const HOLD_MS = 800;

// 审批桌面通知：审批 60s 自动过期，用户切走标签页极易错过。permission.ask 到达且
// 页面不可见时弹 Web Notification（仅在已授权时）；点击聚焦窗口。授权请求由设置页的
// "开启审批通知"按钮发起（需用户手势）；此处只读 Notification.permission，不主动弹窗请求。
function useApprovalNotification(
  askId: string | null,
  commandText: string,
  riskLabel: string,
): void {
  useEffect(() => {
    if (!askId) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (typeof document !== "undefined" && document.visibilityState === "visible") return;

    const n = new Notification("arclight · 需要授权", {
      body: `${riskLabel}\n${commandText.slice(0, 120)}`,
      tag: `arclight-approval-${askId}`,
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    // ask 解决/切换 → 关掉这条通知（避免堆积陈旧提醒）
    return () => n.close();
  }, [askId, commandText, riskLabel]);
}

// 前端倒计时（仅 UX 提示）：从 expiresAt 算剩余秒，250ms 刷新一次。
function useCountdown(expiresAt: number): number {
  const [secs, setSecs] = useState(() => Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
  useEffect(() => {
    const tick = () => setSecs(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  return secs;
}

// hold-to-confirm 批准按钮：pointerdown 起算，按满 HOLD_MS 才触发；松开/移出取消。
// 进度条用当前风险档色（琥珀/紫/红）从左充满，提供「正在合闸」的庄重视觉反馈。
function HoldToConfirm({
  color,
  label,
  disabled,
  onConfirm,
}: {
  color: string;
  label: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [progress, setProgress] = useState(0); // 0..1
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(0);

  const cancel = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setProgress(0);
  }, []);

  const begin = useCallback(() => {
    if (disabled || rafRef.current !== null) return;
    startRef.current = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - startRef.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        rafRef.current = null;
        setProgress(0);
        onConfirm();
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [disabled, onConfirm]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={begin}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      className="relative overflow-hidden border px-4 py-2 text-[13px] font-[700] uppercase tracking-wide disabled:opacity-40"
      style={{ borderColor: color, color, fontFamily: "var(--font-mono)" }}
    >
      <span
        className="pointer-events-none absolute inset-y-0 left-0"
        style={{ width: `${progress * 100}%`, backgroundColor: color, opacity: 0.3 }}
        aria-hidden
      />
      <span className="relative">{progress > 0 ? "按住合闸…" : label}</span>
    </button>
  );
}

export function PermissionModal({ command }: { command: CommandClient }) {
  const { pendingApprovals } = useArcSession();
  const ask = pendingApprovals[0] ?? null;
  const askId = ask?.askId ?? null;

  // 已对该 askId 作出决定 → 禁用按钮、等内核事件清除（不前端乐观删除）。
  const [respondedAskId, setRespondedAskId] = useState<string | null>(null);
  const denyRef = useRef<HTMLButtonElement | null>(null);

  // askId 变化时：复位「已决定」标记（避免上一条审批的 respondedAskId 卡住下一条队列里的
  // 审批），并把焦点强制落在「拒绝」（fail-closed）。当前 ask 从 pendingApprovals 消失时
  // （内核 envelope 已清除），ask 变 null → 组件返回 null 卸载，模态真正关闭。
  useEffect(() => {
    setRespondedAskId(null);
    if (askId) denyRef.current?.focus();
  }, [askId]);

  const decide = useCallback(
    (decision: "allow" | "deny", scope: "once" | "session" = "once") => {
      if (!ask || respondedAskId === ask.askId) return;
      setRespondedAskId(ask.askId);
      void command.approve(ask.askId, decision, scope);
    },
    [ask, respondedAskId, command],
  );

  const expiresAt = ask?.expiresAt ?? 0;
  const secs = useCountdown(expiresAt);

  // 桌面通知（hook 须在早返回前调用；ask 为 null 时传空值，hook 内部短路不弹）
  const notifyText =
    ask && typeof ask.detail.command === "string" && ask.detail.command.trim()
      ? ask.detail.command
      : (ask?.action ?? "");
  useApprovalNotification(askId, notifyText, ask ? `风险 ${ask.risk} · ${ask.cls}` : "");

  if (!ask) return null;

  const expired = secs <= 0;
  const responded = respondedAskId === ask.askId;
  const locked = expired || responded;

  const command_text =
    typeof ask.detail.command === "string" && ask.detail.command.trim()
      ? ask.detail.command
      : ask.action;
  const dangerous = isDangerousRisk(ask.risk, ask.cls);
  const levelColor = riskLevelColor(ask.risk, ask.cls);

  // Enter/Escape 一律 = 拒绝。capture 阶段拦截，覆盖「焦点在批准按钮时回车=批准」的默认行为。
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      decide("deny");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="权限审批"
      onKeyDownCapture={onKeyDownCapture}
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      // 断电闸刀：整屏压暗降饱和，暖光退场——与常规 UI 视觉反转的关键。
      style={{ backgroundColor: "rgba(5,4,3,.78)", backdropFilter: "saturate(.4)" }}
    >
      <div
        className="w-full max-w-[560px] border bg-surface"
        style={{ borderColor: "var(--hairline)" }}
      >
        {/* 头部：风险徽章 + 标题 + 倒计时读数 */}
        <div
          className="flex items-center gap-3 border-b px-5 py-3"
          style={{ borderColor: "var(--hairline)" }}
        >
          <RiskBadge risk={ask.risk} cls={ask.cls} />
          <span className="text-[13px] font-[700] text-text">需要授权</span>
          <div className="flex-1" />
          <span
            className="text-[12px] tabular-nums"
            style={{
              fontFamily: "var(--font-mono)",
              color: expired ? "var(--hazard)" : "var(--muted)",
            }}
          >
            {expired ? "已过期" : `${secs}s`}
          </span>
        </div>

        {/* 命令全文（mono） */}
        <div className="px-5 py-4">
          <div
            className="mb-2 text-[11px] uppercase tracking-wider text-muted"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {ask.action}
          </div>
          <pre
            className="max-h-60 overflow-auto whitespace-pre-wrap break-words border bg-base px-3 py-2 text-[12px] text-text"
            style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
          >
            {command_text}
          </pre>
          {expired ? (
            <p
              className="mt-3 text-[12px]"
              style={{ color: "var(--hazard)", fontFamily: "var(--font-mono)" }}
            >
              此请求已过期，等待内核回收……
            </p>
          ) : null}
        </div>

        {/* 操作区：拒绝默认焦点；批准按高危走 hold-to-confirm */}
        <div
          className="flex items-center justify-end gap-3 border-t px-5 py-3"
          style={{ borderColor: "var(--hairline)" }}
        >
          <button
            type="button"
            ref={denyRef}
            disabled={responded}
            onClick={() => decide("deny")}
            className="border px-4 py-2 text-[13px] font-[700] uppercase tracking-wide text-text disabled:opacity-40"
            style={{ borderColor: "var(--text)", fontFamily: "var(--font-mono)" }}
          >
            拒绝
          </button>

          {dangerous ? (
            // 高危（不可逆/资金/risk=high）：只许逐次按住批准，不提供「本会话允许」
            <HoldToConfirm
              color={levelColor}
              label="按住批准"
              disabled={locked}
              onConfirm={() => decide("allow")}
            />
          ) : (
            <>
              {/* 本会话内允许此工具：批准本次 + 记住，后续同工具不再弹（黑名单仍永远先拦） */}
              <button
                type="button"
                disabled={locked}
                onClick={() => decide("allow", "session")}
                className="border px-4 py-2 text-[13px] font-[700] text-muted disabled:opacity-40"
                style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
                title="本会话内此工具的后续操作自动放行；黑名单命令仍会被拒"
              >
                本会话允许
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => decide("allow")}
                className="border px-4 py-2 text-[13px] font-[700] uppercase tracking-wide disabled:opacity-40"
                style={{
                  borderColor: levelColor,
                  color: levelColor,
                  fontFamily: "var(--font-mono)",
                }}
              >
                批准
              </button>
            </>
          )}
        </div>

        {/* 底部常驻说明（fail-closed 纪律） */}
        <div
          className="border-t px-5 py-2 text-[11px] text-muted"
          style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
        >
          fail-closed · 回车=拒绝 · {Math.max(0, secs)}s 自动过期
          {dangerous ? " · 高危需按住批准" : ""}
        </div>
      </div>
    </div>
  );
}
