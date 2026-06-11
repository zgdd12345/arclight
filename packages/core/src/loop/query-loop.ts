import { type ArcEvent, makeToolError, type Tool } from "@arclight/protocol";
import { previewJson } from "../util/text";
import type {
  ExecutedToolResult,
  LlmMessage,
  LoopDeps,
  LoopState,
  LoopToolContext,
  ProviderToolCall,
  TurnOutcome,
} from "./types";

// queryLoop（DEV_PLAN §2.1）：agent 心脏。借 pi agent-loop 的双层循环结构，
// 执行模型从 callback/emit 翻面为 async-generator yield（控制反转重写）。
// 不变式：emit（=appendEvent 包装）落库与 yield 同处。排序权威是事务内分配的 seq（= 持久顺序
//   = SSE replay 顺序）；tool.progress 走旁路 emit（不经 yield）但同样取 seq，故全局回放顺序一致。
// 工具执行 0% 交 AI SDK（schemas 不带 execute）；messages append-only；失败一律 5 键 envelope 回灌。
// slice2 范围：happy-path + 中断 + 错误恢复 + 审批接缝（完整状态机=U4；压缩/钩子面=U6）。

const TEXT_FLUSH_CHARS = 800; // 流式合批阈值（内核侧粗粒度；前端另有 16ms 合批）

export async function* queryLoop(
  st: LoopState,
  deps: LoopDeps,
): AsyncGenerator<ArcEvent, TurnOutcome> {
  const { emit, signal } = deps;
  const base = { v: 1 as const, sessionId: st.sessionId, turnId: st.turnId };

  const interruptedOutcome = function* (): Generator<ArcEvent, TurnOutcome> {
    yield emit({ ...base, t: "interrupted", reason: "abort" });
    return { status: "interrupted" };
  };

  yield emit({ ...base, t: "turn.started" });

  let retries = 0;
  let round = 0;
  let reflections = 0; // 连续工具全失败轮数（反射闭环计数）
  const maxReflections = deps.maxReflections ?? 3;
  // 外层 follow-up 队列位（U4+ 接 steering/followUp；slice2 单轮链）
  while (true) {
    if (signal.aborted) return yield* interruptedOutcome();

    // ── (A) 压缩边界：在两次 provider 调用之间（绝不在流式中途 / tool 配对未完成时）──
    if (deps.compaction) {
      const compacted = await deps.compaction.maybeCompact(st.messages);
      if (compacted) {
        yield emit({ ...base, t: "context.compacted", summarySeq: compacted.summarySeq });
      }
    }

    // ── (C) 单 turn provider 调用（流式 part → message.delta 合批）──
    const messageId = `m-${st.turnId}-${round}`;
    const gen = deps.callProvider(st.messages, deps.registry.schemas(), signal);
    let textBuf = "";
    let r = await gen.next();
    while (!r.done) {
      const part = r.value;
      if (part.type === "text-delta") {
        textBuf += part.text;
        if (textBuf.length >= TEXT_FLUSH_CHARS) {
          yield emit({ ...base, t: "message.delta", messageId, role: "assistant", delta: textBuf });
          textBuf = "";
        }
      }
      // reasoning-delta：阶段一不外发（events 协议未定义 reasoning 帧，U6 再议）
      r = await gen.next();
    }
    const res = r.value;
    if (textBuf.length > 0) {
      yield emit({ ...base, t: "message.delta", messageId, role: "assistant", delta: textBuf });
    }

    // ── (D) finishReason 分流（callProvider 永不 throw）──
    if (res.usage) deps.onUsage?.(res.usage); // usage 落库（每轮 provider 调用）
    if (res.finishReason === "aborted") return yield* interruptedOutcome();
    if (res.finishReason === "error") {
      if (res.retryable === true && retries < deps.maxRetries) {
        retries++;
        const delay = deps.retryDelayMs?.(retries) ?? Math.min(500 * 2 ** retries, 8000);
        if (delay > 0) await Bun.sleep(delay);
        continue;
      }
      yield emit({
        ...base,
        t: "session.error",
        error: makeToolError(
          "provider",
          "INTERNAL",
          res.errorMessage ?? "provider error",
          res.retryable === true,
        ),
      });
      return { status: "failed" };
    }
    retries = 0;

    // ── append-only：assistant 消息入列（含 tool_use）──
    if (res.toolCalls.length > 0) {
      st.messages.push({
        role: "assistant",
        content: res.text,
        toolCalls: res.toolCalls.map((c) => ({ callId: c.callId, name: c.name, args: c.rawArgs })),
      });
    } else {
      st.messages.push({ role: "assistant", content: res.text });
    }

    // ── (G) 无工具调用 → 完成 ──
    if (res.toolCalls.length === 0) {
      yield emit({ ...base, t: "turn.completed", status: "completed" });
      return { status: "completed" };
    }

    // ── (E) executeToolBatch：requested → 分批执行 → output + 回灌 ──
    for (const call of res.toolCalls) {
      const tool = deps.registry.get(call.name);
      yield emit({
        ...base,
        t: "tool.requested",
        callId: call.callId,
        name: call.name,
        argsPreview: previewJson(call.rawArgs),
        riskTier: tool?.meta.riskTier ?? "admin_only", // 未知工具按最高风险
        riskClass: tool?.meta.riskClass ?? "irreversible",
      });
    }
    const outputs = await executeBatch(st, deps, res.toolCalls);
    for (const call of res.toolCalls) {
      const out = outputs.get(call.callId);
      if (!out) continue; // 不可达：executeBatch 对每个 call 必有产出
      if (out.ok) {
        yield emit({
          ...base,
          t: "tool.output",
          callId: call.callId,
          status: "ok",
          preview: out.preview,
          ...(out.spillRef !== undefined ? { spillRef: out.spillRef } : {}),
        });
      } else {
        yield emit({
          ...base,
          t: "tool.output",
          callId: call.callId,
          status: "error",
          preview: out.envelope.user_message,
          error: out.envelope,
        });
      }
      // 配对回灌（成功 preview / 失败 envelope JSON 喂反射）
      st.messages.push({
        role: "tool",
        callId: call.callId,
        name: call.name,
        content: out.ok ? out.preview : JSON.stringify(out.envelope),
        isError: !out.ok,
      });
    }

    // ── 反射闭环上限（DEV_PLAN §2.3 ④）：本轮工具全失败 → 反射计数 +1；任一成功 → 复位。
    // 达上限即硬停，如实上报不假装成功——失败已在 tool.output 错误事件流中，turn 以 failed 收口。
    const allErrored = [...outputs.values()].every((o) => !o.ok);
    reflections = allErrored ? reflections + 1 : 0;
    if (reflections >= maxReflections) {
      yield emit({
        ...base,
        t: "session.error",
        error: makeToolError(
          "reflection",
          "EXEC_FAILED",
          `reached ${maxReflections} consecutive tool failures; stopping without success`,
          false,
        ),
      });
      yield emit({ ...base, t: "turn.completed", status: "failed" });
      return { status: "failed" };
    }
    if (signal.aborted) return yield* interruptedOutcome();
    round++;
  }
}

// ── 工具批执行：只读且 concurrency-safe 并发 ≤readConcurrency；其余（写）严格串行 ──
async function executeBatch(
  st: LoopState,
  deps: LoopDeps,
  calls: ProviderToolCall[],
): Promise<Map<string, ExecutedToolResult["output"]>> {
  const results = new Map<string, ExecutedToolResult["output"]>();
  const reads: { call: ProviderToolCall; tool: Tool<unknown, unknown> }[] = [];
  const writes: { call: ProviderToolCall; tool: Tool<unknown, unknown> }[] = [];

  for (const call of calls) {
    const tool = deps.registry.get(call.name);
    if (!tool) {
      results.set(call.callId, {
        ok: false,
        envelope: makeToolError(call.name, "VALIDATION", `unknown tool: ${call.name}`, false),
      });
      continue;
    }
    (tool.meta.isReadOnly && tool.meta.isConcurrencySafe ? reads : writes).push({ call, tool });
  }

  const runOne = async (call: ProviderToolCall, tool: Tool<unknown, unknown>) => {
    const ctx: LoopToolContext = {
      sessionId: st.sessionId,
      turnId: st.turnId,
      callId: call.callId,
      cwd: st.cwd,
      signal: deps.signal,
      emitProgress: (chunk, stream) => {
        // 进度帧直接持久化+bus 扇出，不经 generator yield（turn 叙事流之外的旁路）
        deps.emit({
          v: 1,
          t: "tool.progress",
          sessionId: st.sessionId,
          turnId: st.turnId,
          callId: call.callId,
          stream,
          chunk,
        });
      },
    };
    const decision = await deps.approvals.check(tool, call.rawArgs, ctx);
    if (decision.decision === "deny") {
      results.set(call.callId, {
        ok: false,
        envelope: makeToolError(
          call.name,
          decision.errorClass ?? "APPROVAL_DENIED",
          decision.reason,
          false,
        ),
      });
      return;
    }
    // 审批挂起期间可能被中断（TOCTOU）：批准返回后、执行前复查 signal——
    // 防"批准→立即中断→命令仍启动"。沙箱 run 内另有 spawn 前预检（双保险）。
    if (deps.signal.aborted) {
      results.set(call.callId, {
        ok: false,
        envelope: makeToolError(call.name, "CANCELLED", "interrupted before execution", false),
      });
      return;
    }
    // 写工具：执行前后检查点（pre 捕获改前态，post 捕获改后态，供 /undo /redo）
    const isWrite = !tool.meta.isReadOnly;
    if (isWrite && deps.checkpoint) await deps.checkpoint.pre(call.name);
    const out = await deps.executeTool(tool, call.rawArgs, ctx);
    results.set(call.callId, out);
    if (isWrite && deps.checkpoint && out.ok) await deps.checkpoint.post(call.name);
  };

  // 读批：并发池
  const limit = deps.readConcurrency ?? 8;
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, reads.length) }, async () => {
    while (next < reads.length) {
      const item = reads[next++];
      if (item) await runOne(item.call, item.tool);
    }
  });
  await Promise.all(workers);
  // 写批：严格串行
  for (const { call, tool } of writes) {
    await runOne(call, tool);
  }
  return results;
}

export function buildInterruptedEvent(
  sessionId: string,
  turnId: string,
): Omit<Extract<ArcEvent, { t: "interrupted" }>, "seq" | "ts" | "epoch"> {
  return { v: 1, t: "interrupted", sessionId, turnId, reason: "user" };
}

export type { LlmMessage };
