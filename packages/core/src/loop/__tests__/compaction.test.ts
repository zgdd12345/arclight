import { describe, expect, test } from "bun:test";
import { compact, estimateTokens, isPairingComplete, shouldCompact } from "../compaction";
import type { CallProvider, LlmMessage, ProviderResult } from "../types";

const sys: LlmMessage = { role: "system", content: "system prompt" };
const user = (s: string): LlmMessage => ({ role: "user", content: s });
const asst = (s: string): LlmMessage => ({ role: "assistant", content: s });
const asstTool = (callId: string): LlmMessage => ({
  role: "assistant",
  content: "calling",
  toolCalls: [{ callId, name: "read_file", args: {} }],
});
const toolRes = (callId: string): LlmMessage => ({
  role: "tool",
  callId,
  name: "read_file",
  content: "ok",
  isError: false,
});

// 摘要器：返回固定 summary
// biome-ignore lint/correctness/useYield: 纯 return generator（契约要求 async generator）
const summarizer: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
  return { text: "SUMMARY: user wanted X, edited a.ts", toolCalls: [], finishReason: "stop" };
};

describe("isPairingComplete", () => {
  test("无工具调用 → 完整", () => {
    expect(isPairingComplete([sys, user("hi"), asst("hello")])).toBe(true);
  });
  test("tool_use 有配对 result → 完整", () => {
    expect(isPairingComplete([asstTool("c1"), toolRes("c1")])).toBe(true);
  });
  test("tool_use 缺 result → 不完整", () => {
    expect(isPairingComplete([asstTool("c1")])).toBe(false);
  });
  test("多工具部分配对 → 不完整", () => {
    expect(isPairingComplete([asstTool("c1"), toolRes("c1"), asstTool("c2")])).toBe(false);
  });
});

describe("shouldCompact", () => {
  test("消息少 → 不压缩", () => {
    expect(shouldCompact([sys, user("hi")], 100)).toBe(false);
  });
  test("超窗口且配对完整 → 压缩", () => {
    const msgs = [sys, ...Array.from({ length: 20 }, (_, i) => user("x".repeat(50) + i))];
    expect(shouldCompact(msgs, 10)).toBe(true);
  });
  test("超窗口但 tool 配对未完成 → 不压缩（铁律）", () => {
    const msgs = [
      sys,
      ...Array.from({ length: 20 }, (_, i) => user("y".repeat(50) + i)),
      asstTool("open"),
    ];
    expect(shouldCompact(msgs, 10)).toBe(false);
  });
});

describe("compact", () => {
  test("摘要早期消息，保留 system + 最近若干条", async () => {
    const msgs: LlmMessage[] = [
      sys,
      user("turn 1"),
      asst("reply 1"),
      user("turn 2"),
      asst("reply 2"),
      user("turn 3"),
      asst("reply 3"),
      user("turn 4 recent"),
      asst("reply 4 recent"),
    ];
    const r = await compact(msgs, summarizer, new AbortController().signal);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.messages[0]).toEqual(sys); // system 保留
    expect(r.messages[1]?.content).toContain("SUMMARY"); // 摘要单条
    expect(r.messages.at(-1)?.content).toContain("recent"); // 最近保留
    expect(r.droppedCount).toBeGreaterThan(0);
    // 压缩后 token 应明显下降
    expect(estimateTokens(r.messages)).toBeLessThan(estimateTokens(msgs));
  });

  test("切分点避开 tool 配对（不切断 tool_use/result）", async () => {
    const msgs: LlmMessage[] = [
      sys,
      user("start"),
      asstTool("c1"),
      toolRes("c1"),
      asst("done 1"),
      user("more"),
      asst("done 2"),
      user("recent 1"),
      asst("recent 2"),
    ];
    const r = await compact(msgs, summarizer, new AbortController().signal);
    expect(r).not.toBeNull();
    if (!r) return;
    // 压缩结果整体配对完整
    expect(isPairingComplete(r.messages)).toBe(true);
  });

  test("摘要器失败 → 返回 null（不阻断 turn）", async () => {
    // biome-ignore lint/correctness/useYield: 纯 return generator（契约要求 async generator）
    const failing: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
      return {
        text: "",
        toolCalls: [],
        finishReason: "error",
        retryable: false,
        errorMessage: "boom",
      };
    };
    const msgs = [sys, ...Array.from({ length: 8 }, (_, i) => user(`m${i}`))];
    const r = await compact(msgs, failing, new AbortController().signal);
    expect(r).toBeNull();
  });

  test("消息太少 → 返回 null", async () => {
    const r = await compact(
      [sys, user("hi"), asst("bye")],
      summarizer,
      new AbortController().signal,
    );
    expect(r).toBeNull();
  });
});
