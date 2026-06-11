// queryLoop 不变量测试（test-first：先于实现编写，DEV_PLAN §2.1 关键坑⑤）。
// 覆盖 10 条不变量中 slice2 可测的 9 条；"审批四终态唯一" 的完整状态机绑 Unit 4，
// 此处先测 allow/deny 接缝；"同 session 单 active turn" 在 C1 层（tests/sse-resume 已覆盖）。
import { describe, expect, test } from "bun:test";
import { type ArcEvent, type Tool, ToolErrorEnvelopeSchema } from "@arclight/protocol";
import { z } from "zod";
import { queryLoop } from "../query-loop";
import type {
  ApprovalSeam,
  CallProvider,
  LlmMessage,
  LoopDeps,
  LoopState,
  ProviderResult,
  ProviderStreamPart,
} from "../types";

// ── 测试夹具 ──

function makeEmit() {
  const events: ArcEvent[] = [];
  let seq = 0;
  const emit: LoopDeps["emit"] = (draft) => {
    const e = { ...draft, seq: ++seq, epoch: 0, ts: 1_700_000_000_000 + seq } as ArcEvent;
    events.push(e);
    return e;
  };
  return { events, emit };
}

/** 按脚本逐轮返回的 provider：每轮 = {parts, result} */
function scriptedProvider(
  rounds: { parts?: ProviderStreamPart[]; result: ProviderResult }[],
): CallProvider & { calls: { messages: LlmMessage[]; toolsHadExecute: boolean }[] } {
  const calls: { messages: LlmMessage[]; toolsHadExecute: boolean }[] = [];
  let i = 0;
  const fn = async function* (
    messages: readonly LlmMessage[],
    tools: readonly unknown[],
    _signal: AbortSignal,
  ): AsyncGenerator<ProviderStreamPart, ProviderResult> {
    calls.push({
      messages: structuredClone(messages) as LlmMessage[],
      toolsHadExecute: tools.some(
        (t) => typeof (t as { execute?: unknown }).execute === "function",
      ),
    });
    const round = rounds[Math.min(i, rounds.length - 1)];
    i++;
    if (!round) throw new Error("no script round");
    for (const p of round.parts ?? []) yield p;
    return round.result;
  };
  return Object.assign(fn, { calls });
}

const echoTool: Tool<{ text: string }, { echoed: string }> = {
  meta: {
    name: "echo",
    description: "echo back",
    isReadOnly: true,
    isConcurrencySafe: true,
    riskTier: "safe",
    riskClass: "read",
    timeoutMs: 1000,
    maxResultSizeBytes: 1024,
  },
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  execute: async (input) => ({ echoed: input.text }),
};

const allowAll: ApprovalSeam = { check: async () => ({ decision: "allow" }) };

function makeRegistry(tools: Tool<unknown, unknown>[]) {
  const map = new Map(tools.map((t) => [t.meta.name, t]));
  return {
    schemas: () =>
      tools.map((t) => ({ name: t.meta.name, description: t.meta.description, inputSchema: {} })),
    get: (name: string) => map.get(name),
  };
}

type ExecLog = { name: string; start: number; end: number }[];

/** 默认 executeTool：直接跑 tool.execute，成功转 preview，失败转 envelope（计时供并发断言） */
function makeExecuteTool(log: ExecLog = []): LoopDeps["executeTool"] {
  let clock = 0;
  return async (tool, rawArgs, ctx) => {
    const start = clock++;
    const parsed = tool.inputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      log.push({ name: tool.meta.name, start, end: clock++ });
      return {
        ok: false,
        envelope: {
          status: "error",
          tool: tool.meta.name,
          error_class: "VALIDATION",
          user_message: "invalid args",
          retry_allowed: true,
        },
      };
    }
    try {
      const out = await tool.execute(parsed.data, {
        ...ctx,
        // biome-ignore lint/suspicious/noExplicitAny: 测试夹具
      } as any);
      log.push({ name: tool.meta.name, start, end: clock++ });
      return { ok: true, preview: JSON.stringify(out) };
    } catch (e) {
      log.push({ name: tool.meta.name, start, end: clock++ });
      return {
        ok: false,
        envelope: {
          status: "error",
          tool: tool.meta.name,
          error_class: "EXEC_FAILED",
          user_message: e instanceof Error ? e.message : "tool failed",
          retry_allowed: false,
        },
      };
    }
  };
}

function makeState(): LoopState {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: "/tmp",
    messages: [{ role: "user", content: "hi" }],
  };
}

function makeDeps(over: Partial<LoopDeps> & Pick<LoopDeps, "callProvider">): LoopDeps {
  const { emit } = makeEmit();
  return {
    emit,
    registry: makeRegistry([echoTool as Tool<unknown, unknown>]),
    approvals: allowAll,
    executeTool: makeExecuteTool(),
    signal: new AbortController().signal,
    maxRetries: 2,
    retryDelayMs: () => 0,
    ...over,
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

// ── 不变量 ──

describe("不变量 1+2：事件序快照 / seq 连续 / epoch 仅压缩边界（slice2 恒 0）", () => {
  test("纯文本 turn：turn.started → message.delta+ → turn.completed", async () => {
    const provider = scriptedProvider([
      {
        parts: [
          { type: "text-delta", text: "你" },
          { type: "text-delta", text: "好" },
        ],
        result: { text: "你好", toolCalls: [], finishReason: "stop" },
      },
    ]);
    const { events, outcome } = await drain(makeState(), makeDeps({ callProvider: provider }));
    expect(events.map((e) => e.t)).toEqual(["turn.started", "message.delta", "turn.completed"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]); // 连续无缺口
    expect(events.every((e) => e.epoch === 0)).toBe(true); // 无压缩不 +1
    expect(outcome.status).toBe("completed");
  });
});

describe("不变量 3：tool_use / tool_result 严格配对", () => {
  test("工具轮次后每个 tool.requested 都有同 callId 的 tool.output，且结果回灌 messages", async () => {
    const provider = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [{ callId: "c1", name: "echo", rawArgs: { text: "a" } }],
          finishReason: "tool-calls",
        },
      },
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    const state = makeState();
    const { events, outcome } = await drain(state, makeDeps({ callProvider: provider }));
    const requested = events.filter((e) => e.t === "tool.requested");
    const outputs = events.filter((e) => e.t === "tool.output");
    expect(requested).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect((outputs[0] as { callId: string }).callId).toBe("c1");
    // 回灌配对：assistant tool_use 之后紧跟 tool result
    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ callId: "c1", isError: false });
    expect(outcome.status).toBe("completed");
  });
});

describe("不变量 6：messages append-only（护 prompt cache）", () => {
  test("第二轮 provider 收到的 messages 严格前缀扩展第一轮", async () => {
    const provider = scriptedProvider([
      {
        result: {
          text: "calling",
          toolCalls: [{ callId: "c1", name: "echo", rawArgs: { text: "a" } }],
          finishReason: "tool-calls",
        },
      },
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    await drain(makeState(), makeDeps({ callProvider: provider }));
    expect(provider.calls).toHaveLength(2);
    const first = provider.calls[0]?.messages ?? [];
    const second = provider.calls[1]?.messages ?? [];
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.slice(0, first.length)).toEqual(first); // 前缀不可变
  });
});

describe("不变量 7：streamText 工具执行 0%（schema 不带 execute）", () => {
  test("provider 收到的 tools 无任何 execute 函数", async () => {
    const provider = scriptedProvider([
      { result: { text: "x", toolCalls: [], finishReason: "stop" } },
    ]);
    await drain(makeState(), makeDeps({ callProvider: provider }));
    expect(provider.calls[0]?.toolsHadExecute).toBe(false);
  });
});

describe("不变量 8：envelope 5 键不泄 traceback", () => {
  test("工具抛错 → tool.output 携带严格 5 键 envelope 并以 isError 回灌", async () => {
    const bomb: Tool<unknown, unknown> = {
      ...echoTool,
      meta: { ...echoTool.meta, name: "bomb" },
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error("boom with secret stack");
      },
    } as Tool<unknown, unknown>;
    const provider = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [{ callId: "c1", name: "bomb", rawArgs: {} }],
          finishReason: "tool-calls",
        },
      },
      { result: { text: "ok", toolCalls: [], finishReason: "stop" } },
    ]);
    const state = makeState();
    const { events } = await drain(
      state,
      makeDeps({ callProvider: provider, registry: makeRegistry([bomb]) }),
    );
    const out = events.find((e) => e.t === "tool.output") as Extract<
      ArcEvent,
      { t: "tool.output" }
    >;
    expect(out.status).toBe("error");
    expect(ToolErrorEnvelopeSchema.strict().safeParse(out.error).success).toBe(true); // 5 键收口
    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ isError: true });
  });
});

describe("不变量 10：retryable 错误 ≤MAX 重试", () => {
  test("retryable=true：重试 maxRetries 次后 session.error，outcome failed", async () => {
    const provider = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [],
          finishReason: "error",
          retryable: true,
          errorMessage: "rate limited",
        },
      },
    ]);
    const { events, outcome } = await drain(
      makeState(),
      makeDeps({ callProvider: provider, maxRetries: 2 }),
    );
    expect(provider.calls).toHaveLength(3); // 1 + 2 重试
    expect(events.at(-1)?.t).toBe("session.error");
    expect(outcome.status).toBe("failed");
  });

  test("不可重试：单次调用即 session.error", async () => {
    const provider = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [],
          finishReason: "error",
          retryable: false,
          errorMessage: "invalid api key",
        },
      },
    ]);
    const { events, outcome } = await drain(makeState(), makeDeps({ callProvider: provider }));
    expect(provider.calls).toHaveLength(1);
    const err = events.find((e) => e.t === "session.error") as Extract<
      ArcEvent,
      { t: "session.error" }
    >;
    expect(ToolErrorEnvelopeSchema.strict().safeParse(err.error).success).toBe(true);
    expect(outcome.status).toBe("failed");
  });
});

describe("不变量 5：中断后无悬挂（abort 双路径）", () => {
  test("流式中途 abort → interrupted 事件 + outcome interrupted", async () => {
    const ac = new AbortController();
    const provider: CallProvider = async function* (_m, _t, signal) {
      yield { type: "text-delta", text: "开始" };
      ac.abort(); // 模拟用户中断
      if (signal.aborted) return { text: "开始", toolCalls: [], finishReason: "aborted" };
      return { text: "", toolCalls: [], finishReason: "stop" };
    };
    const { events, outcome } = await drain(
      makeState(),
      makeDeps({ callProvider: provider, signal: ac.signal }),
    );
    expect(events.at(-1)?.t).toBe("interrupted");
    expect(outcome.status).toBe("interrupted");
  });

  test("工具执行中 abort → 工具收到 signal，无悬挂 run，turn interrupted", async () => {
    const ac = new AbortController();
    let sawAbort = false;
    const slow: Tool<unknown, unknown> = {
      ...echoTool,
      meta: { ...echoTool.meta, name: "slow", isReadOnly: false, isConcurrencySafe: false },
      inputSchema: z.object({}),
      execute: () => new Promise(() => {}), // 永不自行返回，只能被 abort
    } as Tool<unknown, unknown>;
    const executeTool: LoopDeps["executeTool"] = (_tool, _args, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          sawAbort = true;
          resolve({
            ok: false,
            envelope: {
              status: "error",
              tool: "slow",
              error_class: "CANCELLED",
              user_message: "interrupted",
              retry_allowed: false,
            },
          });
        });
        setTimeout(() => ac.abort(), 10); // 执行中触发中断
      });
    const provider = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [{ callId: "c1", name: "slow", rawArgs: {} }],
          finishReason: "tool-calls",
        },
      },
      { result: { text: "", toolCalls: [], finishReason: "stop" } },
    ]);
    const { events, outcome } = await drain(
      makeState(),
      makeDeps({
        callProvider: provider,
        registry: makeRegistry([slow]),
        executeTool,
        signal: ac.signal,
      }),
    );
    expect(sawAbort).toBe(true);
    expect(events.at(-1)?.t).toBe("interrupted");
    expect(outcome.status).toBe("interrupted");
  });

  test("消费者提前 return()（SSE 断连路径）→ generator 清理且不再产出", async () => {
    const provider = scriptedProvider([
      {
        parts: [
          { type: "text-delta", text: "a" },
          { type: "text-delta", text: "b" },
        ],
        result: { text: "ab", toolCalls: [], finishReason: "stop" },
      },
    ]);
    const gen = queryLoop(makeState(), makeDeps({ callProvider: provider }));
    await gen.next(); // turn.started
    const r = await gen.return({ status: "interrupted" });
    expect(r.done).toBe(true);
    const after = await gen.next();
    expect(after.done).toBe(true); // finally 已清理，无残余产出
  });
});

describe("不变量 9（并发分批）：只读并发 ≤8，写串行", () => {
  test("10 个只读调用最大并发 ≤8；写工具与任何执行不重叠", async () => {
    let live = 0;
    let maxLive = 0;
    const spans: { name: string; s: number; e: number }[] = [];
    let tick = 0;
    const executeTool: LoopDeps["executeTool"] = async (tool) => {
      live++;
      maxLive = Math.max(maxLive, live);
      const s = tick++;
      await Bun.sleep(5);
      const e = tick++;
      spans.push({ name: tool.meta.name, s, e });
      live--;
      return { ok: true, preview: "ok" };
    };
    const writeTool: Tool<unknown, unknown> = {
      ...echoTool,
      meta: { ...echoTool.meta, name: "write", isReadOnly: false, isConcurrencySafe: false },
      inputSchema: z.object({}),
    } as Tool<unknown, unknown>;
    const calls = [
      ...Array.from({ length: 10 }, (_, i) => ({
        callId: `r${i}`,
        name: "echo",
        rawArgs: { text: "x" },
      })),
      { callId: "w1", name: "write", rawArgs: {} },
      { callId: "w2", name: "write", rawArgs: {} },
    ];
    const provider = scriptedProvider([
      { result: { text: "", toolCalls: calls, finishReason: "tool-calls" } },
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    await drain(
      makeState(),
      makeDeps({
        callProvider: provider,
        registry: makeRegistry([echoTool as Tool<unknown, unknown>, writeTool]),
        executeTool,
      }),
    );
    expect(maxLive).toBeLessThanOrEqual(8); // 只读批并发上限
    const writes = spans.filter((x) => x.name === "write");
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      const overlapping = spans.filter((o) => o !== w && o.s < w.e && w.s < o.e);
      expect(overlapping).toHaveLength(0); // 写工具完全串行
    }
  });
});

describe("审批接缝（完整四终态状态机绑 Unit 4）", () => {
  test("deny → 工具不执行，APPROVAL_DENIED envelope 回灌", async () => {
    let executed = 0;
    const executeTool: LoopDeps["executeTool"] = async () => {
      executed++;
      return { ok: true, preview: "should not happen" };
    };
    const approvals: ApprovalSeam = {
      check: async () => ({ decision: "deny", reason: "user said no" }),
    };
    const provider = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [{ callId: "c1", name: "echo", rawArgs: { text: "a" } }],
          finishReason: "tool-calls",
        },
      },
      { result: { text: "ok", toolCalls: [], finishReason: "stop" } },
    ]);
    const state = makeState();
    const { events } = await drain(
      state,
      makeDeps({ callProvider: provider, approvals, executeTool }),
    );
    expect(executed).toBe(0);
    const out = events.find((e) => e.t === "tool.output") as Extract<
      ArcEvent,
      { t: "tool.output" }
    >;
    expect(out.status).toBe("error");
    expect(out.error?.error_class).toBe("APPROVAL_DENIED");
    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ isError: true }); // 回灌喂模型改方案
  });
});
