"use client";

// ThinkingDisclosure —— "思考过程"披露区（DESIGN.md：accent = Agent 思考灯丝）。
// 借 ChatGPT 的交互模式（流式展开 → 答案开始后自动折叠成一行，可点开重读），
// 视觉服从 CARBON ARC：灯丝呼吸圆点 + hairline 左标尺 + 方角 + muted 人声正文。
//
// 流式判定依赖 assistant-ui 的 part status：thinking part 是消息尾部且 turn 运行中
// 时为 running；text/tool part 接续后转 complete → 未经用户手动展开则自动折叠。

import type { ReasoningMessagePartProps } from "@assistant-ui/react";
import { useState } from "react";

export function ThinkingDisclosure({ text, status }: ReasoningMessagePartProps) {
  const live = status?.type === "running";
  // null = 用户未干预（跟随 live 自动展开/折叠）；true/false = 用户手动定格
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;

  if (!text && !live) return null;

  return (
    <div className="my-2 max-w-[680px]">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="flex cursor-pointer select-none items-center gap-2 py-1 font-mono text-[11px] uppercase tracking-wider text-muted"
        aria-expanded={open}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full${live ? " filament" : ""}`}
          style={{ backgroundColor: live ? "var(--accent)" : "var(--muted)" }}
          aria-hidden
        />
        <span style={{ color: live ? "var(--accent)" : undefined }}>
          {live ? "思考中" : "思考过程"}
        </span>
        {!live && text ? <span>· {text.length} 字</span> : null}
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div
          className={`ml-[3px] border-l border-hairline pl-3 ${
            live
              ? // 流式尾部跟随：column-reverse 让滚动锚定在底部，新思考行始终可见
                "flex max-h-44 flex-col-reverse overflow-y-auto"
              : "max-h-96 overflow-y-auto"
          }`}
        >
          <p className="whitespace-pre-wrap break-words py-1 text-[13px] leading-relaxed text-muted">
            {text}
          </p>
        </div>
      ) : null}
    </div>
  );
}
