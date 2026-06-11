"use client";

// SessionStatusBar —— 顶栏仪表条（DEV_PLAN §2.2 / DESIGN.md Layout）。
// 左：wordmark「arc light」（Fraunces，灯丝琥珀）。
// 右：连接状态点（连接/运行中走灯丝呼吸）+ epoch/seq（mono 小字）。
// 只做"成本/状态可观测"展示，不做 quota 强制。

import type { ConnectionStatus } from "@arclight/client-core";
import { useArcSession } from "../../lib/assistantRuntime";

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
  const el = document.documentElement;
  const next = el.getAttribute("data-theme") === "light" ? "dark" : "light";
  el.setAttribute("data-theme", next);
}

export function SessionStatusBar({ status }: { status: ConnectionStatus }) {
  const state = useArcSession();
  const running = state.turn.status === "running";
  const dot = dotStyle(status, running);

  return (
    <header
      className="flex items-center gap-4 border-b bg-base px-5 py-3"
      style={{ borderColor: "var(--hairline)" }}
    >
      <span
        className="text-[20px] leading-none text-accent"
        style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
      >
        arc light
      </span>

      <div className="flex-1" />

      <span
        className="flex items-center gap-2 text-[12px] text-muted"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full${dot.breathe ? " filament" : ""}`}
          style={{ backgroundColor: dot.color }}
          aria-hidden
        />
        {status}
      </span>

      <span className="text-[12px] text-muted" style={{ fontFamily: "var(--font-mono)" }}>
        epoch {state.epoch} · seq {state.maxSeq}
      </span>

      <button
        type="button"
        onClick={toggleTheme}
        className="border px-2 py-1 text-[11px] uppercase tracking-wide text-muted"
        style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
      >
        theme
      </button>
    </header>
  );
}
