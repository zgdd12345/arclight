// 反射闭环上限不变量（DEV_PLAN §2.3 ④）：连续工具全失败达上限 → 硬停，如实上报不假装成功。
import { describe, expect, test } from "bun:test";
import type { ArcEvent, Tool } from "@arclight/protocol";
import { z } from "zod";
import { queryLoop } from "../query-loop";
import type { CallProvider, LoopDeps, LoopState, ProviderResult } from "../types";

function makeEmit() {
  const events: ArcEvent[] = [];
  let seq = 0;
  const emit: LoopDeps["emit"] = (draft) => {
    const e = { ...draft, seq: ++seq, epoch: 0, ts: 1 } as ArcEvent;
    events.push(e);
    return e;
  };
  return { events, emit };
}

const failTool: Tool<unknown, unknown> = {
  meta: {
    name: "flaky",
    description: "",
    isReadOnly: false,
    isConcurrencySafe: false,
    executesShellCommands: false,
    mutatesWorkspace: true,
    riskTier: "safe",
    riskClass: "write",
    timeoutMs: 1000,
    maxResultSizeBytes: 1024,
  },
  inputSchema: z.object({}),
  outputSchema: z.any(),
  execute: async () => {
    throw new Error("always fails");
  },
};

function makeRegistry(tools: Tool<unknown, unknown>[]) {
  const m = new Map(tools.map((t) => [t.meta.name, t]));
  return {
    schemas: () => tools.map((t) => ({ name: t.meta.name, description: "", inputSchema: {} })),
    get: (n: string) => m.get(n),
  };
}

function alwaysCallsFlaky(): CallProvider {
  // biome-ignore lint/correctness/useYield: 纯 return generator
  return async function* (): AsyncGenerator<never, ProviderResult> {
    return {
      text: "retrying",
      toolCalls: [{ callId: `c${Math.random()}`, name: "flaky", rawArgs: {} }],
      finishReason: "tool-calls",
    };
  };
}

async function drain(state: LoopState, deps: LoopDeps) {
  const events: ArcEvent[] = [];
  const gen = queryLoop(state, deps);
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, outcome: r.value };
}

const baseState = (): LoopState => ({
  sessionId: "s",
  turnId: "t",
  cwd: "/tmp",
  messages: [{ role: "user", content: "go" }],
});

const baseDeps = (over: Partial<LoopDeps>): LoopDeps => {
  const { emit } = makeEmit();
  return {
    emit,
    callProvider: alwaysCallsFlaky(),
    registry: makeRegistry([failTool]),
    approvals: { check: async () => ({ decision: "allow" }) },
    executeTool: async () => ({
      ok: false,
      envelope: {
        status: "error",
        tool: "flaky",
        error_class: "EXEC_FAILED",
        user_message: "fail",
        retry_allowed: true,
      },
    }),
    signal: new AbortController().signal,
    maxRetries: 2,
    ...over,
  };
};

describe("反射闭环上限", () => {
  test("连续工具全失败达 maxReflections → 硬停 failed，不无限循环", async () => {
    const { events, outcome } = await drain(baseState(), baseDeps({ maxReflections: 3 }));
    // 反射上限触发：session.error + turn.completed(failed)
    expect(outcome.status).toBe("failed");
    const err = events.find((e) => e.t === "session.error") as
      | Extract<ArcEvent, { t: "session.error" }>
      | undefined;
    expect(err?.error.user_message).toContain("consecutive tool failures");
    // tool.requested 轮数 = maxReflections（每轮一次工具调用），证明被有界
    const requests = events.filter((e) => e.t === "tool.requested");
    expect(requests.length).toBe(3);
  });

  test("maxReflections=1 即停", async () => {
    const { events, outcome } = await drain(baseState(), baseDeps({ maxReflections: 1 }));
    expect(outcome.status).toBe("failed");
    expect(events.filter((e) => e.t === "tool.requested").length).toBe(1);
  });

  test("BUG A：中断恰落在达反射上限那轮 → interrupted 优先于 failed（abort-wins）", async () => {
    // 被中断的工具回灌 CANCELLED envelope（ok:false），与真失败一样计入 allErrored。
    // maxReflections=1 时这一轮即达上限——若反射失败路径抢先结算，会把中断误标 failed
    // 并吞掉 interrupted 事件。修复后 abort 必须先于反射判定胜出。
    const ac = new AbortController();
    const { events, outcome } = await drain(
      baseState(),
      baseDeps({
        signal: ac.signal,
        maxReflections: 1,
        executeTool: async () => {
          ac.abort(); // 中断恰在工具执行期间发生
          return {
            ok: false,
            envelope: {
              status: "error",
              tool: "flaky",
              error_class: "CANCELLED",
              user_message: "interrupted",
              retry_allowed: false,
            },
          };
        },
      }),
    );
    expect(outcome.status).toBe("interrupted");
    expect(events.at(-1)?.t).toBe("interrupted"); // 终态是 interrupted，绝非 turn.completed
    // 绝不被反射上限误标为 failed
    expect(
      events.some(
        (e) =>
          e.t === "turn.completed" &&
          (e as Extract<ArcEvent, { t: "turn.completed" }>).status === "failed",
      ),
    ).toBe(false);
    // 反射闭环的 session.error（"consecutive tool failures"）也不应发出
    expect(
      events.some(
        (e) =>
          e.t === "session.error" &&
          (e as Extract<ArcEvent, { t: "session.error" }>).error.user_message.includes(
            "consecutive tool failures",
          ),
      ),
    ).toBe(false);
  });

  test("工具成功则反射计数复位（不误停）", async () => {
    let calls = 0;
    // 第 1 轮失败，第 2 轮成功，第 3 轮无工具收尾
    // biome-ignore lint/correctness/useYield: provider mock 直接 return 结果，无流式增量可 yield
    const provider: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
      calls++;
      if (calls <= 2) {
        return {
          text: "",
          toolCalls: [{ callId: `c${calls}`, name: "flaky", rawArgs: {} }],
          finishReason: "tool-calls",
        };
      }
      return { text: "done", toolCalls: [], finishReason: "stop" };
    };
    let exec = 0;
    const { outcome } = await drain(
      baseState(),
      baseDeps({
        callProvider: provider,
        maxReflections: 2,
        executeTool: async () => {
          exec++;
          return exec === 1
            ? {
                ok: false,
                envelope: {
                  status: "error",
                  tool: "flaky",
                  error_class: "EXEC_FAILED",
                  user_message: "x",
                  retry_allowed: true,
                },
              }
            : { ok: true, preview: "ok" };
        },
      }),
    );
    expect(outcome.status).toBe("completed"); // 第 2 轮成功复位，未误触上限
  });
});

describe("usage 回传", () => {
  test("provider usage → onUsage 回调", async () => {
    const seen: { inputTokens: number; outputTokens: number }[] = [];
    // biome-ignore lint/correctness/useYield: provider mock 直接 return 结果，无流式增量可 yield
    const provider: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
      return {
        text: "hi",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    };
    await drain(baseState(), baseDeps({ callProvider: provider, onUsage: (u) => seen.push(u) }));
    expect(seen).toEqual([{ inputTokens: 100, outputTokens: 20 }]);
  });

  test("BUG5：cacheRead/cacheWrite 透传到 onUsage", async () => {
    const seen: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }[] = [];
    // biome-ignore lint/correctness/useYield: provider mock 直接 return 结果，无流式增量可 yield
    const provider: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
      return {
        text: "hi",
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 40,
          cacheWriteTokens: 60,
        },
      };
    };
    await drain(baseState(), baseDeps({ callProvider: provider, onUsage: (u) => seen.push(u) }));
    expect(seen).toEqual([
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 60 },
    ]);
  });
});
