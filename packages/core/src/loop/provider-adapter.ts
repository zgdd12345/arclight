// ★ 本文件是全仓唯一 import "ai" 的模块（架构守护测试断言此边界，隔离 v6→v7 爆炸半径）。
// callProvider = 单 turn provider 原语：一次调用 + 流式 part，绝非顶层循环。
// 红线（选型清单 §0.2 #1）：stopWhen stepCountIs(1)——工具执行 0% 交 AI SDK。
// 契约：永不 throw，失败编码进 finishReason（对齐 pi StreamFn）。
import { createAnthropic } from "@ai-sdk/anthropic";
import { type ModelMessage, stepCountIs, streamText, type ToolSet, tool } from "ai";
import type { z } from "zod";
import type {
  CallProvider,
  LlmMessage,
  ProviderResult,
  ProviderStreamPart,
  ProviderToolCall,
} from "./types";

export type ProviderProfile = {
  apiKey: string;
  model: string; // 阶段一单 provider 协议：Anthropic Messages（D4）
  systemPrompt: string;
  baseUrl?: string; // 协议兼容端点（如智谱 bigmodel，D4 补充记账）；缺省 Anthropic 官方
  maxOutputTokens?: number;
};

export function makeCallProvider(profile: ProviderProfile): CallProvider {
  const anthropic = createAnthropic({
    apiKey: profile.apiKey,
    ...(profile.baseUrl !== undefined ? { baseURL: profile.baseUrl } : {}),
  });

  return async function* callProvider(
    messages,
    tools,
    signal,
  ): AsyncGenerator<ProviderStreamPart, ProviderResult> {
    let text = "";
    const toolCalls: ProviderToolCall[] = [];
    try {
      const res = streamText({
        model: anthropic(profile.model),
        system: profile.systemPrompt,
        messages: toModelMessages(messages),
        tools: toAiTools(tools),
        stopWhen: stepCountIs(1), // ★ 禁止 AI SDK 自跑工具循环
        abortSignal: signal,
        ...(profile.maxOutputTokens !== undefined
          ? { maxOutputTokens: profile.maxOutputTokens }
          : {}),
      });
      for await (const part of res.fullStream) {
        switch (part.type) {
          case "text-delta":
            text += part.text;
            yield { type: "text-delta", text: part.text };
            break;
          case "reasoning-delta":
            yield { type: "reasoning-delta", text: part.text };
            break;
          case "tool-call": {
            const call: ProviderToolCall = {
              callId: part.toolCallId,
              name: part.toolName,
              rawArgs: part.input,
            };
            toolCalls.push(call);
            yield { type: "tool-call", ...call };
            break;
          }
          case "error":
            return errorResult(part.error, text, toolCalls);
          default:
            break; // start/end/finish 等元帧不外发
        }
      }
      const usage = await res.usage;
      // 真实 finishReason 必须透传（BUG3）：被 maxOutputTokens 截断时 AI SDK 报 "length"，
      // 绝不能伪装成 "stop"（否则截断静默，下游无从感知）。tool-call 收尾仍归一为 tool-calls。
      const aiFinish = await res.finishReason;
      const finishReason =
        aiFinish === "length" ? "length" : toolCalls.length > 0 ? "tool-calls" : "stop";
      // cache 计量（BUG5）：cachedInputTokens=命中（读）；Anthropic providerMetadata 携带写入量。
      const meta = await res.providerMetadata;
      const cacheWriteTokens = Number(
        (meta?.anthropic as { cacheCreationInputTokens?: number } | undefined)
          ?.cacheCreationInputTokens ?? 0,
      );
      return {
        text,
        toolCalls,
        finishReason,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cachedInputTokens ?? 0,
          cacheWriteTokens: cacheWriteTokens,
        },
      };
    } catch (e) {
      if (signal.aborted) return { text, toolCalls, finishReason: "aborted" };
      return errorResult(e, text, toolCalls);
    }
  };
}

function errorResult(e: unknown, text: string, toolCalls: ProviderToolCall[]): ProviderResult {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    text,
    toolCalls,
    finishReason: "error",
    retryable: isRetryable(e),
    errorMessage: sanitize(msg),
  };
}

/** 重试性判定：429/5xx/网络抖动可重试；4xx 配置类错误不可 */
function isRetryable(e: unknown): boolean {
  const any = e as { statusCode?: number; isRetryable?: boolean; message?: string };
  if (typeof any?.isRetryable === "boolean") return any.isRetryable;
  const status = any?.statusCode;
  if (typeof status === "number") return status === 429 || status >= 500;
  const m = (any?.message ?? "").toLowerCase();
  return /timeout|econnreset|enotfound|fetch failed|socket/.test(m);
}

/** 错误消息脱敏：剥 API key 形态片段，绝不带 stack */
function sanitize(msg: string): string {
  return msg.replace(/sk-[\w-]{8,}/g, "sk-***").slice(0, 500);
}

// ── 形状转换 ──

function toModelMessages(messages: readonly LlmMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.callId,
            toolName: m.name,
            output: m.isError
              ? { type: "error-text", value: m.content }
              : { type: "text", value: m.content },
          },
        ],
      });
    } else if (m.role === "assistant" && "toolCalls" in m) {
      out.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.callId,
            toolName: c.name,
            input: c.args,
          })),
        ],
      });
    } else {
      out.push({ role: m.role, content: m.content } as ModelMessage);
    }
  }
  return out;
}

function toAiTools(
  schemas: readonly { name: string; description: string; inputSchema: unknown }[],
): ToolSet {
  const set: ToolSet = {};
  for (const s of schemas) {
    // 只给 inputSchema，execute 永不交给 AI SDK（不变式 7）
    set[s.name] = tool({
      description: s.description,
      inputSchema: s.inputSchema as z.ZodType,
    });
  }
  return set;
}
