import { describe, expect, test } from "bun:test";
import { SharedRateLimiter } from "../rate-limiter";
import type { CallProvider, ProviderResult } from "../types";

describe("SharedRateLimiter", () => {
  test("并发槽限制在飞流数", async () => {
    const rl = new SharedRateLimiter({ maxConcurrent: 1 });
    const r1 = await rl.acquire();
    let second = false;
    const p2 = rl.acquire().then((rel) => {
      second = true;
      return rel;
    });
    await Promise.resolve();
    expect(second).toBe(false);
    r1();
    const r2 = await p2;
    expect(second).toBe(true);
    r2();
  });

  test("RPM 令牌桶：突发耗尽后按速率等待（注入时钟+sleep）", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const rl = new SharedRateLimiter({
      maxConcurrent: 10,
      rpm: 60, // 1 token/sec → refill 1/1000ms，突发容量 60
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < 60; i++) (await rl.acquire())(); // 抽干令牌桶
    expect(sleeps).toHaveLength(0);
    (await rl.acquire())(); // 第 61 个需等约 1000ms
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
  });

  test("acquire 中 abort → reject 且释放并发槽", async () => {
    const rl = new SharedRateLimiter({ maxConcurrent: 1 });
    const ac = new AbortController();
    ac.abort();
    await expect(rl.acquire(ac.signal)).rejects.toThrow("aborted");
    const rel = await rl.acquire(); // 槽未泄漏
    expect(rel).toBeDefined();
    rel();
  });

  test("wrap：发起前过闸（占槽），流期间持槽，流结束后释放", async () => {
    const rl = new SharedRateLimiter({ maxConcurrent: 1 });
    const fakeResult: ProviderResult = { text: "ok", toolCalls: [], finishReason: "stop" };
    let releaseProvider: () => void = () => {};
    const provider: CallProvider = async function* () {
      await new Promise<void>((r) => {
        releaseProvider = r;
      });
      return fakeResult;
    };
    const wrapped = rl.wrap(provider);
    const gen = wrapped([], [], new AbortController().signal);
    const pending = gen.next(); // 进入：占并发槽，provider 卡在 gate
    await new Promise((r) => setTimeout(r, 5));

    let got = false;
    const p2 = rl.acquire().then((rel) => {
      got = true;
      return rel;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toBe(false); // 槽被 wrap 持有

    releaseProvider();
    const res = await pending;
    expect(res.done).toBe(true);
    expect(res.value).toEqual(fakeResult);

    const rel2 = await p2; // 流结束 → 槽释放 → 第二个 acquire 解阻
    expect(got).toBe(true);
    rel2();
  });
});
