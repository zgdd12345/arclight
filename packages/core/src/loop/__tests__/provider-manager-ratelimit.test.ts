import { describe, expect, test } from "bun:test";
import { ProviderManager } from "../provider-manager";
import type { CallProvider } from "../types";

const PROFILE = { apiKey: "test-key", model: "glm-4.6", systemPrompt: "x", thinking: false };
const TMP_DIR = "/tmp/arclight-m2-nonexistent"; // 构造不写盘（仅 update() 才持久化）

describe("ProviderManager × SharedRateLimiter 接线", () => {
  test("传入 rateLimiter 时 callProvider 走 wrap(base)", () => {
    let wrapCalls = 0;
    let captured: CallProvider | undefined;
    // biome-ignore lint/correctness/useYield: sentinel 仅作身份检测，从不调用
    const sentinel: CallProvider = async function* () {
      return { text: "", toolCalls: [], finishReason: "stop" };
    };
    const fakeLimiter = {
      wrap(base: CallProvider): CallProvider {
        wrapCalls += 1;
        captured = base;
        return sentinel;
      },
    };
    const pm = new ProviderManager(PROFILE, TMP_DIR, fakeLimiter);
    expect(wrapCalls).toBe(1);
    expect(typeof captured).toBe("function"); // 被 wrap 的是稳定委托
    expect(pm.callProvider).toBe(sentinel); // callProvider 即包装结果
  });

  test("不传 rateLimiter 时 callProvider 为稳定委托（向后兼容）", () => {
    const pm = new ProviderManager(PROFILE, TMP_DIR);
    expect(typeof pm.callProvider).toBe("function");
  });
});
