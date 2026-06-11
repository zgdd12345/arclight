I now have the complete picture: pi's borrowable double-loop structure, its config-hook surface (steering/follow-up/prepareNextTurn/before-afterToolCall), the claudecode async-generator architecture (learn-only), the P0 contract (ArcEvent/ArcCommand/approval state machine/lifecycle), and the selection list boundaries (streamText as single-turn primitive, AI SDK ownership boundaries). I have enough to write the detailed design without further reads.

The task asks me to produce a Markdown design document as my output. I'll write it directly as my final response (not a file, per instructions).

# queryLoop() 详细设计 — arclightagent P0(Web + 写代码 MVP)

> 心脏件。诚实对齐 Codex 口径:实评 800-1500 行真工程,非薄接缝。架构基线 = pi `agent-loop.ts`(MIT,可借代码) + claudecode `query.ts`(闭源,仅学架构) + P0 工具执行契约 + AI SDK `streamText`(仅作单 turn provider 原语)。与 5 份文档严格一致,不另起炉灶。

---

## 0. 设计立场与边界(一句话锚点)

- **顶层是自研 async-generator `queryLoop()`**,逐 `yield ArcEvent`。`streamText` 被封装进一个 `callProvider()` 原语,只负责"一次 provider 调用 + 流式 part",**绝不**是顶层循环。
- **借 pi 的"纯函数双层循环 + config 钩子面"骨架**(外层 follow-up、内层 tool-call/steering),**改造点**=把 pi 的 `emit(AgentEvent)` 回调模型换成 `yield ArcEvent`(claudecode 的 generator 范式),把 pi 的 `streamSimple` 换成 AI SDK `streamText` adapter,把 P0 的审批状态机 / SandboxService / epoch 压缩 / artifact spill 缝进 pi 的 `beforeToolCall`/`afterToolCall`/`transformContext`/`shouldStopAfterTurn` 钩子位。
- **pi 借走的是结构,不是事件类型**:pi 的 `AgentEvent` 仅用作内部参考;对外只 yield 文档定义的 `ArcEvent`。`AgentMessage`/`ToolResultMessage` 等内部转写类型可直接借。

---

## 1. 状态机与事件流

### 1.1 turn 级状态机(对外 = `turns.status`)

```
queued → running → [awaiting_approval ⇄ running] → completed
                                              ↘ failed
running/awaiting_approval ──(interrupt)──→ interrupted
```

- `queued`:HTTP handler 落 turn,尚未进 loop。
- `running`:loop 正在 stream provider 或执行只读/已批准工具。
- `awaiting_approval`:某个 `confirm`/`admin_only` 工具命中,loop **挂起**等待 `approve` 命令(`tool_calls.status=awaiting_approval`)。可来回多次。
- 终态:`completed`(`shouldStopAfterTurn` 触发或无更多 tool call)/`failed`(provider error 且不可恢复)/`interrupted`(AbortController 触发)。

### 1.2 事件流不变式

loop 是唯一 `seq` 生产者。每个 `yield` 前在 **单 SQLite 事务**内 `appendEvent()`(读 `sessions.nextSeq+epoch` → insert `events` → `nextSeq=seq+1`),`yield` 的对象即落库对象,SSE `id:`=`seq`。这保证"yield 顺序 = 持久顺序 = SSE replay 顺序",epoch 单调,断线 `?afterSeq` 续推一致(P0 §B 恢复/续接)。

### 1.3 一个 turn 的 ArcEvent 序列(与 P0 完整生命周期时序一致)

```
turn.started
  └─(可选) context.compacted        // 进 turn 前压缩边界(epoch++)
  message.delta*                     // streamText text-delta,100-250ms 合批
  tool.requested                     // 每个 toolCall 一条
    ├─ permission.ask (若需审批) → [挂起] → (approve allow)
    ├─ tool.progress*                // sandbox stdout/stderr 合批;超大只落 artifact
    └─ tool.output                   // 含 preview + 可选 spillRef
  (回灌 tool_result,进入下一内层轮)
turn.completed | session.error | interrupted
```

---

## 2. 把 `streamText` 封装为单 turn provider 原语

**边界(选型清单 §0.2 #1 实锤)**:`streamText({ stopWhen })` 只是单 turn 工具循环原语,不提供可中断/压缩边界/steering 队列/per-turn 重建。**正确姿势**:`stopWhen: stepCountIs(1)`(或不让 AI SDK 自动续 step),工具执行/回灌全部由 `queryLoop()` 自己做。所有对 `ai` 的依赖收敛进单一 `ProviderAdapter`,锁 minor(隔离 v6→v7)。

```ts
// packages/core/src/loop/provider-adapter.ts  —— 唯一 import "ai" 的文件
import { streamText, stepCountIs, type ModelMessage } from "ai";

export interface ProviderTurnResult {
  text: string;
  toolCalls: ParsedToolCall[];               // {callId,name,rawArgs}
  finishReason: "stop"|"tool-calls"|"length"|"error"|"aborted";
  usage: { input:number; output:number; cacheRead:number; cacheWrite:number };
  rawAssistantMessage: AgentMessage;         // 回灌用,append-only
}

/** 单 turn provider 调用原语:一次模型调用,流式 part,不执行任何工具、不续 step。 */
export async function* callProvider(
  profile: AgentProfile,
  llmMessages: ModelMessage[],
  tools: ToolSpec[],                          // 已 materialize 的工具子集(仅 schema 暴露给模型)
  signal: AbortSignal,
): AsyncGenerator<ProviderPart, ProviderTurnResult> {
  const res = streamText({
    model: profile.model,
    system: profile.systemPrefix,             // cache 前缀置前(见 §9)
    messages: llmMessages,
    tools: toAISDKToolSchemas(tools),         // 只给 inputSchema,execute 不交给 AI SDK
    stopWhen: stepCountIs(1),                 // 关键:禁止 AI SDK 自跑工具循环
    abortSignal: signal,
    providerOptions: { anthropic: { cacheControl: profile.cacheBreakpoints } },
  });

  for await (const part of res.fullStream) {
    switch (part.type) {
      case "text-delta":      yield { k:"text",  text: part.text }; break;
      case "tool-call":       yield { k:"toolcall", callId: part.toolCallId, name: part.toolName, rawArgs: part.input }; break;
      case "reasoning-delta": yield { k:"thinking", text: part.text }; break;
      case "error":           yield { k:"error", error: part.error }; break;
    }
  }
  // streamText 的 promise 字段提供最终态(不 throw,失败编码进 finishReason —— 对齐 pi StreamFn 契约)
  return {
    text: await res.text, toolCalls: await collectToolCalls(res),
    finishReason: await res.finishReason, usage: normalizeUsage(await res.usage),
    rawAssistantMessage: await toAgentMessage(res),
  };
}
```

**关键纪律**:`callProvider` 对应 pi 的 `streamAssistantResponse` + `StreamFn` 契约 —— **不得 throw**,运行/模型/网络失败编码进 `finishReason="error"|"aborted"`,由顶层 loop 决定 `session.error` 还是恢复。`tool` 的 `execute` 一律传 `undefined`/不传(AI SDK 不执行),保证工具执行权 100% 在 `queryLoop()`。

---

## 3. 纯函数 loop + 有状态包装(借 pi 双层结构)

### 3.1 纯函数核心 `queryLoop()`(async generator)

```ts
// packages/core/src/loop/query-loop.ts
export async function* queryLoop(
  st: LoopState,                 // 可变状态对象,迭代顶部解构(claudecode 范式,避免多处 continue 各自赋值)
  deps: LoopDeps,                // 注入:ProviderAdapter / ToolRegistry / ApprovalService / SandboxService / Compactor / appendEvent
): AsyncGenerator<ArcEvent, TurnOutcome, void> {

  // 进入前:steering 可能已积压(用户在排队时打字)—— 对齐 pi runLoop 起始 getSteeringMessages
  let pending = deps.steering.drain(st.queueMode);   // QueueMode: "all" | "one-at-a-time"

  yield* emit(st, deps, { t:"turn.started", turnId: st.turnId, epoch: st.epoch });

  // 外层:follow-up 队列(agent 本会停下,但有后续追加任务)
  outer: while (true) {
    let hasMoreToolCalls = true;

    // 内层:tool-call 轮 + steering 注入
    while (hasMoreToolCalls || pending.length > 0) {

      // (A) 压缩边界检查 —— 单级压缩,满则摘要 + epoch++(见 §6)
      if (deps.compactor.shouldCompact(st)) {
        const c = await deps.compactor.compact(st);          // LLM 摘要,有损,留 JSONL 回溯
        st.epoch = c.newEpoch; st.messages = c.compactedMessages;
        yield* emit(st, deps, { t:"context.compacted", epoch: st.epoch, summarySeq: c.boundarySeq });
      }

      // (B) 注入 pending(steering / follow-up),append-only
      for (const m of pending) {
        st.messages.push(m);
        yield* emit(st, deps, { t:"message.user", role:"user", text: m.text });   // 可选投影
      }
      pending = [];

      // (C) 单 turn provider 调用 —— streamText 原语
      const llm = await deps.convertToLlm(st.messages);      // AgentMessage[] → ModelMessage[]
      const gen = callProvider(st.profile, llm, st.tools, st.signal);
      let batched = newDeltaBatcher();                        // 100-250ms 合批
      let res: ProviderTurnResult;
      while (true) {
        const n = await gen.next();
        if (n.done) { res = n.value; break; }
        const p = n.value;
        if (p.k === "text")     { if (batched.push(p.text)) yield* emit(st, deps, batched.flushEvent()); }
        if (p.k === "thinking") { /* 可选 message.delta(thinking) */ }
        if (p.k === "error")    { /* 编码进 res.finishReason,不在此 throw */ }
      }
      if (batched.hasResidual()) yield* emit(st, deps, batched.flushEvent());
      st.messages.push(res.rawAssistantMessage);              // append-only,护 cache
      yield* emit(st, deps, { t:"usage", ...res.usage });      // usage 落库

      // (D) provider 终态分流
      if (res.finishReason === "aborted") { yield* emit(st,deps,{t:"interrupted",turnId:st.turnId}); return { status:"interrupted" }; }
      if (res.finishReason === "error")   {
        if (deps.isRetryable(res) && st.retries < MAX_RETRIES) { st.retries++; continue; }   // 错误恢复(§7)
        yield* emit(st,deps,{t:"session.error", error: toEnvelope(res) }); return { status:"failed" };
      }

      // (E) 工具调用解析 + 执行 + tool_result 回灌
      hasMoreToolCalls = false;
      if (res.toolCalls.length > 0) {
        const batch = yield* executeToolBatch(st, deps, res);  // 见 §4,内部 yield 工具事件
        for (const tr of batch.results) st.messages.push(tr);  // tool_result 回灌(回到下一轮)
        hasMoreToolCalls = !batch.terminate;
        if (st.signal.aborted) { yield* emit(st,deps,{t:"interrupted",turnId:st.turnId}); return { status:"interrupted" }; }
      }

      yield* emit(st, deps, { t:"turn.completed", turnId: st.turnId });

      // (F) per-turn 重建钩子(prepareNextTurn:可切 model/profile/context —— 借 pi)
      const upd = await deps.prepareNextTurn?.(st);
      if (upd) applyTurnUpdate(st, upd);

      // (G) 优雅停止(上下文将满 / 任务完成信号)
      if (await deps.shouldStopAfterTurn?.(st)) return { status:"completed" };

      // (H) 内层末尾再 drain steering
      pending = deps.steering.drain(st.queueMode);
    }

    // 外层:agent 本会停 —— 查 follow-up 队列
    const followUp = deps.followUp.drain(st.queueMode);
    if (followUp.length > 0) { pending = followUp; continue outer; }
    break;
  }
  return { status:"completed" };
}
```

> `emit()` 是 generator helper:`async function* emit(st,deps,e){ const seq = await deps.appendEvent(st, e); yield { ...e, seq, epoch: st.epoch }; }` —— 落库与 yield 在同一处,seq 不变式集中守护。

### 3.2 有状态包装 `AgentRunner`(借 pi `Agent` 类语义)

```ts
// 持有两个队列 + AbortController,把 HTTP/SSE 层与纯 loop 解耦
export class AgentRunner {
  private steering = new MessageQueue();   // 运行中干预,turn 末注入
  private followUp = new MessageQueue();   // agent 欲停时注入
  private ac = new AbortController();
  private running = false;

  async *run(turn: TurnInput): AsyncGenerator<ArcEvent> {
    this.running = true;
    const st = buildLoopState(turn, this.ac.signal);
    const it = queryLoop(st, this.deps(this.steering, this.followUp));
    try {
      for await (const e of it) yield e;        // 透传 ArcEvent 给 SSE
    } finally {
      this.running = false;
      // it.return() 已由 for-await 的提前退出 / cancel() 触发 generator finally(见 §5)
    }
  }
  steer(text: string)    { this.steering.push(toUserMsg(text)); }   // ArcCommand submit(运行中)
  followup(text: string) { this.followUp.push(toUserMsg(text)); }
  approve(askId, decision) { this.deps.approvals.resolve(askId, decision); }  // 解阻 §4 挂起
  interrupt()            { this.ac.abort(); }                       // ArcCommand interrupt
}
```

---

## 4. 工具调用解析 + 审批 + 沙箱 + tool_result 回灌

`executeToolBatch` = pi `executeToolCalls` + P0 工具契约/审批状态机/SandboxService 的缝合点。**并发规则(P0 §C)**:只读且 concurrency-safe 并发上限 8;写工具(`bash`/`apply_patch`/`write_file`/`git`)一律串行。借 claudecode `partitionToolCalls` 分批思路。

```ts
async function* executeToolBatch(st, deps, res): AsyncGenerator<ArcEvent, ToolBatchResult> {
  // 解析:rawArgs → zod 校验(VALIDATION 错走 envelope,不 throw)
  const prepared = res.toolCalls.map(tc => prepareCall(st, deps, tc));   // 借 pi prepareToolCall
  const { readonly, writes } = deps.registry.partition(prepared);        // isConcurrencySafe 分批

  const results: ToolResultMessage[] = [];
  // 写工具:串行(含审批挂起)
  for (const p of writes) results.push(yield* runOne(st, deps, p));
  // 只读:并发上限 8(claudecode generators.all 思路)
  yield* runConcurrent(st, deps, readonly, 8, results);

  return { results, terminate: results.length>0 && results.every(r => r.terminate) };
}

async function* runOne(st, deps, p): AsyncGenerator<ArcEvent, ToolResultMessage> {
  yield* emit(st, deps, { t:"tool.requested", callId:p.callId, name:p.name, argsPreview:p.argsPreview });

  // (1) 风险分类:ToolMeta.riskTier + shell-quote 分词 + presets + 黑名单
  const decision = deps.registry.classify(p, st.profile, st.capability);
  if (decision === "deny")  return toolError(p, "PERMISSION_DENIED");
  if (decision === "ask") {
    // (2) 审批状态机:pending → permission.ask → 挂起等 approve
    const ask = await deps.approvals.create(p, { ttlMs: 60_000 });   // approvals.pending
    yield* emit(st, deps, { t:"permission.ask", askId: ask.id, risk: ask.risk, cls: ask.cls, action: ask.action });
    const verdict = await deps.approvals.await(ask.id, st.signal);   // 阻塞:allow|deny|expired|cancelled
    if (verdict === "deny")    return toolError(p, "APPROVAL_DENIED");
    if (verdict === "expired") return toolError(p, "APPROVAL_EXPIRED");
    if (verdict === "cancelled") return toolError(p, "CANCELLED");   // turn 中断 → 审批终态
    // verdict === "allow" → 继续
  }

  // (3) 执行:经 SandboxService(local-nono),stdout/stderr 回流为 tool.progress(合批)
  const onChunk = (c) => deps.progressBatcher.push(p.callId, c);     // 超大只落 artifact
  let out;
  try {
    out = await deps.registry.execute(p, {
      ...st.toolCtx, signal: st.signal,
      sandbox: deps.sandbox,                                         // SandboxService.run(req)
      emit: (e) => deps.progressBatcher.emit(e),
    });
  } catch (e) { return toolError(p, classifyExecError(e)); }         // TIMEOUT/SANDBOX_*/EXEC_FAILED
  for (const ev of deps.progressBatcher.flush(p.callId)) yield* emit(st, deps, ev);

  // (4) 输出投影:>32KB 落 artifacts,事件/模型只见 preview(前16KB)+ spillRef
  const proj = deps.artifacts.project(out, 32_000);
  yield* emit(st, deps, { t:"tool.output", callId:p.callId, preview: proj.preview, spillRef: proj.spillRef });

  // (5) 回灌:构造 tool_result message(模型只见 preview)
  return makeToolResult(p, proj.preview, /*isError*/ false);
}
```

**审批解阻机制**:`ApprovalService.await(askId, signal)` = 一个可被三方解决的 promise:`resolve(askId, allow|deny)`(来自 `ArcCommand approve`)、TTL 定时器(`expired`)、`signal.abort`(`cancelled`)。turn 在此 `await` 上挂起 = `awaiting_approval` 态,不占 provider 调用。

---

## 5. 可中断:AbortController + `.return()` 取消传播

两条独立中断路径,会合到同一 `AbortController`:

1. **`ArcCommand interrupt`** → `runner.interrupt()` → `ac.abort()`。`signal` 透传给:`callProvider`(AI SDK `abortSignal` → provider 流终止 → `finishReason="aborted"`)、`SandboxService`(nono kill process tree)、`ApprovalService.await`(解为 `cancelled`)。loop 在 (D)/(E) 的 `signal.aborted` 检查点 yield `interrupted` 后 `return`。

2. **消费者提前退出 / SSE 断连** → `for await` 的 `break` 触发 generator 的 `finally` 与 `.return()`,等价 claudecode `.return()` 提前完成。`runner.run` 的 `finally` 里 `ac.abort()` 清理在途 sandbox/审批。

**取消传播不变式**:任一中断后,(a) 当前 turn 必 yield `interrupted` 或工具 envelope `CANCELLED`;(b) 已 append 的 event 不回滚(SQLite 可 replay);(c) `turns.status=interrupted`,`tool_calls`/`approvals` 进 `cancelled` 终态;(d) **不**留悬挂 sandbox run(nono `cancel(runId)`)。

---

## 6. 单级压缩边界 + epoch yield

**P0 = 单级压缩(满即摘要)**,不做 claudecode 三级(snip/micro/auto)—— 那是阶段二+。

- **触发**:`compactor.shouldCompact(st)` = `estimateTokens(st.messages) > effectiveWindow`(`contextWindow - reservedForSummary`,token 计数用 `@anthropic-ai/tokenizer`/`tiktoken`,不自研)。
- **边界**:在内层 (A) 位、**两次 provider 调用之间**触发(不在流式中途)。LLM 生成摘要 → 写 `sessions.summary` + 一条 `compaction` message → **`epoch++`**,后续 `convertToLlm` 只取边界后消息。
- **yield**:`context.compacted{epoch, summarySeq}`,落 `events`。前端凭此 + `?afterSeq&epoch` 走 P0 §B 的 `epoch-jump`/`resync` 续接逻辑。
- **不变式**:压缩有损不可逆 → 原始消息留 JSONL/`messages` 表回溯;`epoch` 严格单调 `+1`;压缩绝不发生在工具执行未回灌完成时(否则 tool_use/tool_result 配对断裂)。

---

## 7. 错误恢复与取消传播

| 来源 | envelope/事件 | loop 行为 |
|---|---|---|
| provider 网络/5xx | `finishReason="error"` | `isRetryable` 且 `retries<MAX` → `continue` 重试同一轮(指数退避);否则 `session.error` |
| zod 校验失败 | `VALIDATION` envelope 回灌 | 不中断 turn,作为 tool_result 喂回模型自我修正 |
| 审批 deny/expired | `APPROVAL_DENIED`/`APPROVAL_EXPIRED` | 回灌 envelope,模型可改方案;turn 继续 |
| sandbox 不可用/拒绝 | `SANDBOX_UNAVAILABLE`/`SANDBOX_DENIED` | 回灌 envelope;turn 继续 |
| 超时 | `TIMEOUT` envelope + nono kill | 回灌;turn 继续 |
| 中断 | `interrupted` 事件 / `CANCELLED` envelope | `return`,turn 终态 interrupted |
| 内部 bug | `INTERNAL` envelope(**绝不泄 traceback**) | 回灌或 `session.error` |

**核心原则**(对齐 P0 5 键 envelope):工具层错误**回灌给模型**(可恢复,turn 不死);provider 层不可恢复错误才升级为 `session.error`(turn `failed`)。envelope 永远 5 键、`user_message` 友好、不泄 traceback。

---

## 8. 与工具契约 / 审批状态机 / SandboxService 的衔接(借 pi 钩子位)

pi 的 `AgentLoopConfig` 钩子面恰好是这些子系统的接缝,**逐一映射**:

| P0 子系统 | pi 钩子位 / loop 位 | 衔接内容 |
|---|---|---|
| 工具契约 `Tool<In,Out>`/`ToolMeta` | `prepareToolCall` + `ToolRegistry` | zod 校验、`isReadOnly`/`isConcurrencySafe` 分批、`toModelOutput` 投影 |
| 审批状态机 | `beforeToolCall`(block 语义)+ `runOne` (2) | `pending→allowed/denied/expired/cancelled`,`permission.ask`/`approve` |
| SandboxService | `runOne` (3) | `probe()/run(req)/cancel(runId)`,`onStdout/onStderr`→`tool.progress` |
| ArtifactStore | `afterToolCall` / `runOne` (4) | >32KB spill,`spillRef=artifact://id`,模型只见 preview |
| EpochGuard / 压缩 | `transformContext` + (A) 位 | epoch 乐观锁、压缩边界、`convertToLlm` 取边界后消息 |
| usage | (C) 末尾 | `result.usage`→`usage` 表,per-turn 成本 |

---

## 9. 每能力独立 agent profile(prompt 前缀 + 工具子集 + cache 前缀)

P0 仅 `agent:"code"`,但 loop **从第一天就按 `AgentProfile` 参数化**(为阶段二写作/调研留槽,避免 breaking)。`materialize tools` = `CapabilityProfile ∩ agentProfile.tools ∩ permissionRules`(P0 生命周期时序)。

```ts
export interface AgentProfile {
  id: "code";                          // 阶段二:"writing" | "research" | ...
  systemPrefix: string;                // prompt 前缀(可缓存段置前,护 cache)
  toolSubset: string[];                // P0 code: ["read_file","write_file","apply_patch","bash"]
  model: LanguageModel;                // 主力 claude-sonnet-4-x
  thinkingLevel: ThinkingLevel;        // applyThinkingLevel(借 pi,~20 行)
  cacheBreakpoints: CacheControl[];    // cache 断点排序(systemPrefix → 稳定工具 schema → 历史)
}
```

**cache 纪律(零依赖工程纪律)**:`systemPrefix` 与 `toolSubset` schema 稳定置前 → append-only 消息 → profile 切换才换 cache 前缀。这让每能力独立 profile 各自维持高 cache 命中。

---

## 10. 关键不变量(可断言)

1. **seq 单调且唯一**:`events(session_id,seq)` 唯一,loop 是唯一生产者,yield 顺序 = 落库顺序 = SSE id 顺序。
2. **epoch 单调**:仅压缩边界 `+1`;`baseEpoch≠sessions.epoch`→`StaleEpochError`(乐观锁)。
3. **tool_use/tool_result 严格配对**:每个 `tool.requested` 必有恰好一个回灌 `ToolResultMessage`(成功 preview 或 5 键 envelope),压缩不得切断配对。
4. **审批终态唯一**:`allowed/denied/expired/cancelled` 四态后不再变;一个 `awaiting_approval` 必落一个终态。
5. **中断后无悬挂**:abort 后无在途 sandbox run、无 pending 审批、turn 必达终态。
6. **append-only 消息**:`st.messages` 只追加不重写(护 cache);压缩通过 epoch 边界"逻辑截断"而非物理删除。
7. **streamText 不越界**:`stopWhen=stepCountIs(1)`,工具执行 0% 在 AI SDK。
8. **envelope 不泄密**:任何错误对外/对模型都是 5 键 envelope,无 traceback/env secret。
9. **同 session 单 active turn**:loop 运行期间该 session 不接受第二个 turn(durable queue 后置)。

---

## 11. 可测试点(Vitest,对齐 P0 ≥10 golden eval)

- **纯函数性**:注入 mock `LoopDeps`(fake `callProvider`/registry/approvals/sandbox),`queryLoop` 全程不碰真实 IO → 可对 `yield` 的 ArcEvent 序列做精确快照断言。
- **事件序列快照**:给定脚本化 provider 输出,断言 `turn.started → message.delta* → tool.requested → permission.ask → tool.output → turn.completed` 顺序与 seq 连续。
- **审批分支**:`allow`/`deny`/`expired`/`cancelled` 四条 → 对应 envelope/事件;断言挂起期间不调用 `callProvider`。
- **中断传播**:turn 中 `ac.abort()` → 断言 yield `interrupted`、sandbox `cancel` 被调、审批解为 `cancelled`、turn 终态 `interrupted`。
- **`.return()` 提前退出**:消费者 `break` → generator `finally` 执行 → `ac.abort()` 调用。
- **压缩边界**:伪造超窗 → 断言 `context.compacted` yield、`epoch+1`、后续 `convertToLlm` 只含边界后消息;断言不在流式中途触发。
- **错误恢复**:retryable error → 断言重试 ≤ MAX 后 `session.error`;VALIDATION → 断言回灌且 turn 不死。
- **并发分批**:混合只读/写 toolCall → 断言只读并发(≤8)、写串行、并发批 context 在批末合并。
- **回灌配对**:断言每 `tool.requested` 有唯一 `ToolResultMessage` 进 `st.messages`。
- **provider 边界隔离**:断言 `ProviderAdapter` 是唯一 import `"ai"` 的模块(architecture test / dependency-cruiser)。

---

## 12. 拿现成 / 薄自研 划线(诚实对齐 Codex)

| 拿现成(零/极少自研) | 薄自研 / 真工程(800-1500 行) |
|---|---|
| `ai` `streamText`(单 turn 原语,封进 `ProviderAdapter`)| **`queryLoop()` async-generator 顶层循环**(借 pi 结构,改 yield 模型 + 缝 P0 子系统)= 最被低估项 |
| `zod` v4(工具 inputSchema + 校验)| `emit()`/`appendEvent()` seq+epoch 事务守护 |
| pi `agent-loop.ts` 双层循环骨架 + 钩子面(MIT,可借)| steering/follow-up 双队列 + 注入时序 |
| pi `ThinkingLevel` + `applyThinkingLevel`(~20 行)| 审批挂起/解阻 + 可中断/取消传播 |
| `@anthropic-ai/tokenizer`/`tiktoken`(token 计数)| 单级压缩边界 + epoch yield(借 opencode 模板 ~200 行)|
| `@modelcontextprotocol/sdk` / `drizzle`+`bun:sqlite` / `nono` / `pino` / `shell-quote`(底层件)| 工具解析/并发分批/输出投影 + tool_result 回灌(借 claudecode 设计,~100 行)|
| claudecode `query.ts` 范式(闭源,**仅学不抄**)| 错误恢复分流 + 5 键 envelope + per-turn 重建 + AgentProfile materialize |

**结论(对齐 Codex 口径)**:`queryLoop()` 是 agent 心脏,实评 800-1500 行真工程。`streamText` 仅作单 turn provider 原语,绝非顶层循环;pi 提供可借的结构与钩子面,但"改成自有 ArcEvent 事件模型 + 缝进 P0 审批/沙箱/epoch/artifact"的活省不掉。前端(assistant-ui)与本主循环同为两处真工程,均不可当薄接缝。

---

**关联文件(绝对路径)**:
- 契约/数据模型/审批状态机/生命周期:`/Users/fsm/project/arclightagent/research/P0-基础三件套-拓扑-数据模型-工具契约.md`
- 可借 MIT 双层循环 + 钩子面:`/Users/fsm/project/arclightagent/pi/packages/agent/src/agent-loop.ts`、`/Users/fsm/project/arclightagent/pi/packages/agent/src/types.ts`
- 仅学不抄的 generator 范式:`/Users/fsm/project/arclightagent/claudecode/query.ts`
- streamText 边界与依赖集:`/Users/fsm/project/arclightagent/research/拿来即用-全栈选型清单.md`(§0.2 #1、§2.1、§5.1)
- 建议落地路径:`packages/core/src/loop/query-loop.ts`(纯函数)、`provider-adapter.ts`(唯一 import `ai`)、`runner.ts`(有状态包装)