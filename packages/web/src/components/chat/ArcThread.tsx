"use client";

// ArcThread —— 工程日志流（DESIGN.md「核心模式·无聊天气泡」）。
// 借 ChatGPT 的页面骨架：居中对话列 + 底部居中输入框 + 流式过程全程可见
// （思考披露区 / 工具仪器卡 / 运行指示行 / 停止按钮）；
// 视觉守 CARBON ARC 修订版（DESIGN.md 2026-06-12）：留白分隔的 transcript、
// 左 gutter mono 角色标识（USER 黄铜 / AGENT 琥珀）、柔和圆角、零气泡零阴影。

import {
  ComposerPrimitive,
  MessagePrimitive,
  type TextMessagePartProps,
  ThreadPrimitive,
  useComposerRuntime,
} from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getProviderConfig,
  type ProviderConfig,
  patchProviderConfig,
  uploadSessionFile,
} from "../../lib/arcClient";
import { useArcCommand, useArcSession, useFollowUpQueue } from "../../lib/assistantRuntime";
import { ToolCallCard } from "../tools/ToolCallCard";
import { ThinkingDisclosure } from "./ThinkingDisclosure";

// USER 文本 = 原文回显（保留换行，不解析 markdown）。
function PlainTextPart({ text }: TextMessagePartProps) {
  return (
    <p className="max-w-[680px] whitespace-pre-wrap break-words leading-relaxed text-text">
      {text}
    </p>
  );
}

// AGENT 文本 = markdown 散文（标题/列表/表格/代码块按 .prose-arc 排版纪律渲染）。
function MarkdownTextPart({ text }: TextMessagePartProps) {
  return (
    <div className="prose-arc max-w-[680px] break-words text-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

const userPartComponents = {
  Text: PlainTextPart,
} as const;

const assistantPartComponents = {
  Text: MarkdownTextPart,
  Reasoning: ThinkingDisclosure,
  tools: { Fallback: ToolCallCard },
} as const;

// gutter 角色标识（actor）：USER 黄铜 / AGENT 琥珀。prop 名避用 `role`（防与 ARIA role 混淆）。
function LogEntry({ actor }: { actor: "USER" | "AGENT" }) {
  const actorColor = actor === "USER" ? "var(--brass)" : "var(--accent)";
  return (
    <MessagePrimitive.Root className="grid grid-cols-[64px_1fr] gap-4 py-5 md:grid-cols-[88px_1fr]">
      <div
        className="select-none pt-0.5 font-mono text-[11px] uppercase tracking-wider"
        style={{ color: actorColor }}
      >
        {actor}
      </div>
      <div className="min-w-0 space-y-2">
        <MessagePrimitive.Parts
          components={actor === "USER" ? userPartComponents : assistantPartComponents}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

const UserMessage = () => <LogEntry actor="USER" />;
const AssistantMessage = () => <LogEntry actor="AGENT" />;

// 运行指示行：turn 进行中且画面上没有正在流式吐字的内容（等首 token / 工具结果
// 回灌后的下一轮 provider 调用）时，在日志流末尾点亮灯丝——过程永不静默。
function RunningIndicator() {
  const state = useArcSession();
  if (state.turn.status !== "running") return null;
  const last = state.messages.at(-1);
  const lastPart = last?.parts.at(-1);
  const streaming =
    last?.role === "assistant" &&
    lastPart !== undefined &&
    (lastPart.type !== "tool" || lastPart.status === "requested" || lastPart.status === "running");
  if (streaming) return null;
  return (
    <div className="grid grid-cols-[64px_1fr] gap-4 py-4 md:grid-cols-[88px_1fr]">
      <div className="select-none pt-0.5 font-mono text-[11px] uppercase tracking-wider text-accent">
        AGENT
      </div>
      <div className="flex items-center gap-2 font-mono text-[12px] text-muted">
        <span className="filament inline-block h-2 w-2 rounded-full bg-accent" aria-hidden />
        处理中…
      </div>
    </div>
  );
}

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
              思考与处理过程会全程展示在这里。
            </p>
          </div>
        </ThreadPrimitive.Empty>

        <div className="mx-auto w-full max-w-[840px] px-5">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <RunningIndicator />
        </div>

        <ThreadPrimitive.ScrollToBottom className="sticky bottom-3 mx-auto block rounded-full border border-hairline bg-surface px-3 py-1 font-mono text-[11px] text-muted disabled:hidden">
          ↓ 最新
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>

      <Composer />
    </ThreadPrimitive.Root>
  );
}

// 📎 附件上传（仿 ChatGPT）：上传到会话 workspace 的 .arclight/uploads/，
// 把相对路径插入输入框——Agent 经 read_file 读取，submit 协议保持 text-only。
function AttachButton() {
  const state = useArcSession();
  const composer = useComposerRuntime();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const onPick = async (file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(true);
    const r = await uploadSessionFile(state.sessionId, file).finally(() => setUploading(false));
    if (fileRef.current) fileRef.current.value = "";
    if (!r) return;
    const prev = composer.getState().text;
    composer.setText(`${prev ? `${prev}\n` : ""}[附件 ${r.name}] ./${r.path}\n`);
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => void onPick(e.target.files?.[0])}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
        className="rounded-lg p-1.5 font-mono text-[15px] leading-none text-muted hover:bg-panel hover:text-text disabled:opacity-40"
        title="上传附件（存入 .arclight/uploads，Agent 可读取）"
      >
        {uploading ? "…" : "📎"}
      </button>
    </>
  );
}

// 模型切换（仿 ChatGPT）：全局热切换，下一次提问起生效。
function ModelSwitcher() {
  const [cfg, setCfg] = useState<ProviderConfig | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getProviderConfig().then(setCfg);
  }, []);

  if (!cfg) return null;
  return (
    <select
      value={cfg.model}
      disabled={busy}
      onChange={(e) => {
        setBusy(true);
        void patchProviderConfig({ model: e.target.value })
          .then((next) => next && setCfg(next))
          .finally(() => setBusy(false));
      }}
      className="max-w-[160px] cursor-pointer rounded-lg border-none bg-transparent py-1 font-mono text-[11px] text-muted outline-none hover:text-text"
      title="切换模型（全局，下一次提问生效）"
    >
      {cfg.availableModels.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

// Composer 内层（在 ComposerPrimitive.Root 内，可用 useComposerRuntime）。
// 运行中：Enter 与"↪ 排队"按钮均入队（turn 完成后自动逐条发出）；空闲：正常发送。
function ComposerBody() {
  const state = useArcSession();
  const command = useArcCommand();
  const { enqueue } = useFollowUpQueue();
  const composer = useComposerRuntime();
  const running = state.turn.status === "running";

  const queueCurrent = () => {
    const text = composer.getState().text;
    if (text.trim()) {
      enqueue(text);
      composer.setText("");
    }
  };

  return (
    <>
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        placeholder={running ? "继续输入，turn 完成后自动发送…" : "给 Agent 一条指令…"}
        // 运行中拦截 Enter（无 Shift）→ 入队而非提交（提交在 running 时本就被 assistant-ui 拦下）。
        onKeyDownCapture={(e) => {
          if (running && e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            queueCurrent();
          }
        }}
        className="max-h-40 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14px] text-text outline-none placeholder:text-muted"
      />
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
        <AttachButton />
        <span className="select-none font-mono text-[11px] text-muted">
          {running ? "Enter 排队 · Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行"}
        </span>
        <span className="flex-1" />
        <ModelSwitcher />
        {running ? (
          <>
            <button
              type="button"
              onClick={queueCurrent}
              className="rounded-lg border border-hairline px-3 py-1.5 font-mono text-[12px] text-muted hover:bg-panel hover:text-text"
              title="排队：turn 完成后自动发送"
            >
              ↪ 排队
            </button>
            <button
              type="button"
              onClick={() => {
                // 停止 = 中断当前 turn（非危险操作，琥珀而非 hazard 红——红只属于审批面）
                if (state.turn.id) void command.interrupt(state.turn.id, "user");
              }}
              className="rounded-lg border border-accent px-3 py-1.5 font-mono text-[12px] text-accent"
            >
              ■ 停止
            </button>
          </>
        ) : (
          <ComposerPrimitive.Send className="rounded-lg border border-accent bg-accent px-4 py-1.5 text-[13px] font-[700] text-base">
            发送
          </ComposerPrimitive.Send>
        )}
      </div>
    </>
  );
}

function Composer() {
  const { queue, clear, error, retry } = useFollowUpQueue();

  return (
    <div className="bg-base px-5 py-4">
      <div className="mx-auto w-full max-w-[840px]">
        {/* 排队提示条：有排队消息时常驻，turn 完成后自动逐条发出；发送失败显示错误 + 重试 */}
        {queue.length > 0 ? (
          <div
            className="mb-2 flex items-center gap-2 rounded-lg border bg-surface px-3 py-1.5 font-mono text-[11px]"
            style={{ borderColor: error ? "var(--accent-hot)" : "var(--hairline)" }}
          >
            <span style={{ color: error ? "var(--accent-hot)" : "var(--accent)" }}>↪</span>
            {error ? (
              <span className="flex-1 truncate text-accent-hot">{error}</span>
            ) : (
              <span className="flex-1 truncate text-muted">
                已排队 {queue.length} 条 · turn 完成后自动发送：{queue[0]}
                {queue.length > 1 ? " …" : ""}
              </span>
            )}
            {error ? (
              <button
                type="button"
                onClick={retry}
                className="shrink-0 rounded px-1.5 py-0.5 text-accent hover:bg-panel"
              >
                重试
              </button>
            ) : null}
            <button
              type="button"
              onClick={clear}
              className="shrink-0 rounded px-1.5 py-0.5 text-muted hover:bg-panel hover:text-text"
            >
              清空
            </button>
          </div>
        ) : null}

        <ComposerPrimitive.Root className="flex flex-col rounded-2xl border border-hairline bg-surface transition-colors duration-150 focus-within:border-muted">
          <ComposerBody />
        </ComposerPrimitive.Root>
      </div>
    </div>
  );
}
