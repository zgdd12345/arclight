import { countTokens } from "@anthropic-ai/tokenizer";
import type { CallProvider, LlmMessage } from "./types";

// 单级压缩（DEV_PLAN §2.1，借 opencode 结构化摘要模板）。
// 触发：estimateTokens(messages) > effectiveWindow。
// 时机铁律：只在两次 provider 调用之间，绝不在 tool_use/tool_result 未配对完成时压缩
//   （否则配对断裂，模型收到悬挂 tool_use）。
// 动作：LLM 摘要早期消息 → 替换为单条 summary → 调用方 epoch++ + yield context.compacted。
// 注：token 计数用 @anthropic-ai/tokenizer 作估计（GLM 实际 tokenizer 不同，但触发阈值用估计足够）。

export const DEFAULT_EFFECTIVE_WINDOW = 120_000; // 阶段一保守窗口
const KEEP_RECENT = 4; // 保留最近 N 条原样（含当前轮上下文）
const COMPACT_TRIGGER_RATIO = 1.0;

export function estimateTokens(messages: readonly LlmMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += countTokens(messageText(m)) + 4; // 每条少量结构开销
  }
  return total;
}

function messageText(m: LlmMessage): string {
  if (m.role === "tool") return m.content;
  if (m.role === "assistant" && "toolCalls" in m) {
    return m.content + m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(" ");
  }
  return m.content;
}

/** 配对完整性：assistant 的每个 tool_use 必须有对应 tool result 才可在此切分压缩。 */
export function isPairingComplete(messages: readonly LlmMessage[]): boolean {
  const pendingCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && "toolCalls" in m) {
      for (const c of m.toolCalls) pendingCallIds.add(c.callId);
    } else if (m.role === "tool") {
      pendingCallIds.delete(m.callId);
    }
  }
  return pendingCallIds.size === 0;
}

export function shouldCompact(
  messages: readonly LlmMessage[],
  effectiveWindow: number = DEFAULT_EFFECTIVE_WINDOW,
): boolean {
  if (messages.length <= KEEP_RECENT + 1) return false;
  if (!isPairingComplete(messages)) return false; // 配对未完成，绝不压缩
  return estimateTokens(messages) > effectiveWindow * COMPACT_TRIGGER_RATIO;
}

export type CompactResult = {
  messages: LlmMessage[];
  summaryText: string;
  droppedCount: number;
};

const SUMMARY_PROMPT = `You are compacting a coding agent's conversation to save context.
Summarize the conversation so far into a dense brief that preserves: the user's goal,
key files and symbols touched, decisions made, what worked, what failed, and any
constraints. Be specific (file paths, function names). Output only the summary.`;

/** 压缩：保留 system + 最近 KEEP_RECENT 条，其余 LLM 摘要为单条 summary。
 *  切分点选在配对边界（不切断 tool_use/result）。compactProvider 失败则原样返回（不阻断 turn）。 */
export async function compact(
  messages: LlmMessage[],
  compactProvider: CallProvider,
  signal: AbortSignal,
): Promise<CompactResult | null> {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length <= KEEP_RECENT + 1) return null;

  // 切分点：从 rest.length - KEEP_RECENT 向前找配对完整的边界
  let cut = rest.length - KEEP_RECENT;
  while (cut > 0 && !isPairingComplete(rest.slice(0, cut))) cut--;
  if (cut <= 0) return null;

  const toSummarize = rest.slice(0, cut);
  const recent = rest.slice(cut);

  const summaryInput: LlmMessage[] = [
    { role: "system", content: SUMMARY_PROMPT },
    {
      role: "user",
      content: toSummarize
        .map((m) => `[${m.role}] ${messageText(m)}`)
        .join("\n\n")
        .slice(0, 60_000),
    },
  ];

  let summaryText = "";
  try {
    const gen = compactProvider(summaryInput, [], signal);
    let r = await gen.next();
    while (!r.done) {
      if (r.value.type === "text-delta") summaryText += r.value.text;
      r = await gen.next();
    }
    // 最终文本以 result.text 为准（provider 可能只 return 不流式 yield）
    summaryText = r.value.text || summaryText;
    if (r.value.finishReason === "error" || summaryText.trim() === "") return null;
  } catch {
    return null; // 压缩失败不阻断主流程
  }

  const compacted: LlmMessage[] = [
    ...system,
    { role: "user", content: `[Prior conversation summary]\n${summaryText}` },
    ...recent,
  ];
  return { messages: compacted, summaryText, droppedCount: toSummarize.length };
}
