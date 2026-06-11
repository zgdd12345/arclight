"use client";

// ArcThread —— 工程日志流（DESIGN.md「核心模式·无聊天气泡」）。
// 每条消息是带 hairline 分隔的日志条目：左 gutter 放 mono 角色标识
// （USER 黄铜 / AGENT 琥珀），正文区上限 ~680px。零气泡、零阴影、radius 0。

import {
  ComposerPrimitive,
  MessagePrimitive,
  type TextMessagePartProps,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { ToolCallCard } from "../tools/ToolCallCard";

// 文本 part = 人声散文（Hanken / body），非 mono。
function TextPart({ text }: TextMessagePartProps) {
  return (
    <p className="max-w-[680px] whitespace-pre-wrap break-words leading-relaxed text-text">
      {text}
    </p>
  );
}

const partComponents = {
  Text: TextPart,
  tools: { Fallback: ToolCallCard },
} as const;

// gutter 角色标识（actor）：USER 黄铜 / AGENT 琥珀。prop 名避用 `role`（防与 ARIA role 混淆）。
function LogEntry({ actor }: { actor: "USER" | "AGENT" }) {
  const actorColor = actor === "USER" ? "var(--brass)" : "var(--accent)";
  return (
    <MessagePrimitive.Root
      className="grid grid-cols-[72px_1fr] gap-4 border-b px-5 py-4 md:grid-cols-[88px_1fr]"
      style={{ borderColor: "var(--hairline)" }}
    >
      <div
        className="select-none pt-0.5 text-[11px] uppercase tracking-wider"
        style={{ color: actorColor, fontFamily: "var(--font-mono)" }}
      >
        {actor}
      </div>
      <div className="min-w-0 space-y-2">
        <MessagePrimitive.Parts components={partComponents} />
      </div>
    </MessagePrimitive.Root>
  );
}

const UserMessage = () => <LogEntry actor="USER" />;
const AssistantMessage = () => <LogEntry actor="AGENT" />;

export function ArcThread() {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col bg-base">
      <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
        <ThreadPrimitive.Empty>
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-24 text-center">
            <p
              className="text-[28px] text-text"
              style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
            >
              工作台已就绪
            </p>
            <p className="max-w-[420px] text-[14px] text-muted">
              在自己的仓库上跑写代码 Agent。输入一条指令开始 —— 读改文件、沙箱跑命令、自校正。
            </p>
          </div>
        </ThreadPrimitive.Empty>

        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      </ThreadPrimitive.Viewport>

      <Composer />
    </ThreadPrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root
      className="flex items-end gap-3 border-t bg-surface px-5 py-3"
      style={{ borderColor: "var(--hairline)" }}
    >
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        placeholder="给 Agent 一条指令…"
        className="max-h-40 flex-1 resize-none bg-transparent py-2 text-[14px] text-text outline-none placeholder:text-muted"
      />
      <ComposerPrimitive.Send
        className="border px-4 py-2 text-[13px] font-[700] text-base"
        style={{ backgroundColor: "var(--accent)", borderColor: "var(--accent)" }}
      >
        发送
      </ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  );
}
