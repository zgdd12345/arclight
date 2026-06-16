import { describe, expect, test } from "bun:test";
import { runSubagent } from "../subagent";
import { makeCtx, scriptedProvider } from "./fixtures";

describe("M6：runSubagent 把 ctx.onUsage 穿透进 LoopDeps（budget 记账地基）", () => {
  test("provider 每轮 usage 经 ctx.onUsage 回传（input+output 可被宿主累加）", async () => {
    const charged: number[] = [];
    const { provider } = scriptedProvider([
      {
        result: {
          text: "done",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 40 },
        },
      },
    ]);
    const ctx = makeCtx({ provider });
    ctx.onUsage = (u) => charged.push(u.inputTokens + u.outputTokens);
    const res = await runSubagent({ prompt: "x" }, ctx);
    expect(res).toEqual({ ok: true, value: "done" });
    expect(charged).toEqual([140]);
  });

  test("ctx.onUsage 未设时 runSubagent 正常（向后兼容，no-op）", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "ok", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "y" }, makeCtx({ provider }));
    expect(res).toEqual({ ok: true, value: "ok" });
  });
});
