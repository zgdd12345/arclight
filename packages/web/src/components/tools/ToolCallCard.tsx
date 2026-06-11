"use client";

// ToolCallCard —— 台架仪器（DEV_PLAN 分期降级的朴素版）。
// 单线边框卡片：头部一行 = 工具名（琥珀 mono）+ argsPreview + 风险/状态读数；
// 输出区 <pre> mono（preview 文本）。
// 富信息（status/risk/preview/progress）经 callId 回查 client-core store，
// 而非塞进 assistant-ui tool-call 协议。
//
// 信任面纪律：hazard 红 `#FF4D2E` 全产品仅审批面可用——本卡片为台架仪器，
// irreversible/funds 用电弧紫（elevated）而非红，绝不稀释红色的危险条件反射。

import type { ToolPart } from "@arclight/client-core";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { useArcSession } from "../../lib/assistantRuntime";
import { DiffView } from "./DiffView";

// ToolRenderHint（DEV_PLAN §2.2 ③）：按工具名分发渲染主体。
//   apply_patch / write_file → diff（鼠尾草/灰烬，Monaco 懒加载）
//   bash                     → terminal（先 <pre> 流，xterm 后置）
//   read_file                → text（文件内容 mono）
//   未知                      → json 兜底
type RenderHint = "diff" | "terminal" | "text" | "json";

function renderHint(name: string): RenderHint {
  switch (name) {
    case "apply_patch":
    case "write_file":
      return "diff";
    case "bash":
      return "terminal";
    case "read_file":
      return "text";
    default:
      return "json";
  }
}

// JSON 兜底：能 parse 则美化缩进，否则原样。
function prettyJson(raw: string): string {
  if (!raw.trim()) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function findToolPart(
  messages: ReturnType<typeof useArcSession>["messages"],
  callId: string,
): ToolPart | null {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    if (!msg) continue;
    for (const part of msg.parts) {
      if (part.type === "tool" && part.callId === callId) return part;
    }
  }
  return null;
}

// riskClass → 非红色徽章色（read 鼠尾草 / write 琥珀 / irreversible·funds 电弧紫）
function riskColor(riskClass: string): string {
  switch (riskClass) {
    case "read":
      return "var(--positive)";
    case "write":
      return "var(--accent)";
    case "irreversible":
    case "funds":
      return "var(--violet)";
    default:
      return "var(--violet)"; // 未知按最高档（非红）显示
  }
}

function statusColor(status: ToolPart["status"]): string {
  switch (status) {
    case "ok":
      return "var(--positive)";
    case "error":
      return "var(--accent-hot)";
    case "running":
      return "var(--accent)";
    default:
      return "var(--muted)";
  }
}

export function ToolCallCard({ toolCallId, toolName, argsText }: ToolCallMessagePartProps) {
  const state = useArcSession();
  const part = findToolPart(state.messages, toolCallId);

  const name = part?.name ?? toolName;
  const args = part?.argsPreview ?? argsText ?? "";
  const status = part?.status ?? "requested";
  const riskClass = part?.riskClass ?? "";
  const riskTier = part?.riskTier ?? "";
  const output = part?.outputPreview || part?.progress || "";
  const hint = renderHint(name);

  return (
    <div
      className="my-3 border bg-surface font-mono text-[12px]"
      style={{ borderColor: "var(--hairline)" }}
    >
      {/* 头部读数行 */}
      <div
        className="flex items-center gap-3 border-b px-3 py-2"
        style={{ borderColor: "var(--hairline)" }}
      >
        <span className="font-[700] text-accent">{name}</span>
        {args ? (
          <span className="flex-1 truncate text-muted">{args}</span>
        ) : (
          <span className="flex-1" />
        )}
        {riskClass ? (
          <span
            className="border px-1.5 py-0.5 text-[11px] uppercase tracking-wide"
            style={{ color: riskColor(riskClass), borderColor: riskColor(riskClass) }}
          >
            {riskClass}
            {riskTier ? ` · ${riskTier}` : ""}
          </span>
        ) : null}
        <span
          className="text-[11px] uppercase tracking-wide"
          style={{ color: statusColor(status) }}
        >
          {status}
        </span>
      </div>

      {/* 主体：按 ToolRenderHint 分发（spillRef 完整输出懒拉后置 slice2+） */}
      <ToolBody hint={hint} name={name} args={args} output={output} />
    </div>
  );
}

// 渲染主体分发。diff 卡用 patch 文本（argsPreview 优先，回退 output）；
// 其余沿用 <pre> mono 流（终端/文本/JSON），保 CARBON ARC 台架仪器风格。
function ToolBody({
  hint,
  name,
  args,
  output,
}: {
  hint: RenderHint;
  name: string;
  args: string;
  output: string;
}) {
  if (hint === "diff") {
    // patch 文本：argsPreview 优先（apply_patch 的 SEARCH/REPLACE、write_file 新内容），
    // 空则回退 output。拿不到完整 before/after 时 DiffView 内部诚实降级。
    const patch = args || output;
    if (!patch) return null;
    return <DiffView text={patch} toolName={name} />;
  }

  if (hint === "json") {
    const body = prettyJson(output) || prettyJson(args);
    if (!body) return null;
    return (
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-muted">
        {body}
      </pre>
    );
  }

  // terminal / text：mono <pre> 流（终端先 pre，xterm 后置；read_file 文件内容 mono）。
  if (!output) return null;
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-text">
      {output}
    </pre>
  );
}
