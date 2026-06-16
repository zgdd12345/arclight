import { describe, expect, test } from "bun:test";
import { runSubagent } from "../subagent";
import { makeCtx, scriptedProvider } from "./fixtures";

describe("runSubagent (nested queryLoop)", () => {
  test("returns the final assistant text as value on completion", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "the answer", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "compute" }, makeCtx({ provider }));
    expect(res).toEqual({ ok: true, value: "the answer" });
  });

  test("context isolation: child sees only its own system + user messages", async () => {
    const { provider, calls } = scriptedProvider([
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    await runSubagent({ prompt: "do the thing", label: "planner" }, makeCtx({ provider }));
    expect(calls).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const msgs = calls[0]!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]).toMatchObject({ role: "user", content: "do the thing" });
    // 子不见父历史/身份：消息内不出现父 session/turn 标识（parentSessionId="parent-s" / parentTurnId="parent-t"）。
    // 注：角色提示里含 "parent conversation" 字样，故须按标识符（parent-s/parent-t）精确匹配，不能裸搜 "parent"。
    expect(msgs.some((m) => "content" in m && /parent-[st]/.test(m.content))).toBe(false);
  });

  test("parent interrupt cascades to the child (returns interrupted)", async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, calls } = scriptedProvider([
      { result: { text: "should not run", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "x" }, makeCtx({ provider, signal: ac.signal }));
    expect(res).toEqual({ ok: false, status: "interrupted" });
    expect(calls).toHaveLength(0); // 预中断 → queryLoop 起步即返回 interrupted，provider 不被调用
  });
});
