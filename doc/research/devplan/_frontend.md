I now have a complete picture of all three documents. I have the full ArcEvent/ArcCommand/ArcAck contracts, the SSE/seq/epoch/resync semantics, the data model, the tool execution contract, the approval state machine, and the assistant-ui/AI SDK boundary. I have everything needed to produce the detailed Web frontend design. Let me write it directly as my output.

---

# arclightagent · Web 前端详细设计（阶段一 MVP：Web + 写代码）

> 严格对齐五份既有文档。栈：Next.js 15 App Router + @assistant-ui/react + @assistant-ui/react-ai-sdk + Vercel AI SDK v6 + Zustand。拓扑：本地优先 `arclight serve --repo`，同源 httpOnly cookie + loopback bearer，`CapabilityProfile.localSandbox=true`。诚实口径：本前端是产品级工程（实评 1500-3000+ 行），非薄接缝。
> **关键设计裁决（贯穿全文）：不采用 `@assistant-ui/react-ai-sdk` 的 AISDKRuntime + `useChat` 直连路径，改用 assistant-ui 的 `ExternalStoreRuntime`。** 理由见 §0.1——ArcEvent 是内核唯一真相源，带 `seq/epoch/resync/spillRef/permission.ask` 等 AI SDK `UIMessage` 协议无原生表达的语义，强行套 AISDKRuntime 会丢失 epoch 续接与审批往返。`react-ai-sdk` 仅在"把 ArcEvent 投影成 assistant-ui ThreadMessage"的 part 适配上参考其 mapping，不作运行时桥。

---

## 0. 总览与拓扑边界

### 0.1 为什么是 ExternalStoreRuntime 而非 AISDKRuntime（load-bearing 裁决）

`@assistant-ui/react` 提供三类 Runtime：`AISDKRuntime`（吃 AI SDK `useChat` 的 `messages`）、`LocalRuntime`（assistant-ui 自管模型调用）、`ExternalStoreRuntime`（你给一个 `messages` 数组 + `onNew`/`onCancel` 等回调，assistant-ui 只做渲染与交互编排）。

| 维度 | AISDKRuntime（react-ai-sdk） | **ExternalStoreRuntime（采用）** |
|---|---|---|
| 真相源 | AI SDK `UIMessage[]`（前端 `useChat` 持有） | **内核 `ArcEvent` → 自有 SessionReducer → 投影成 ThreadMessage** |
| seq/epoch 续接 | 无表达；`useChat` 自管流，刷新即丢未持久化 part | EpochTracker + Last-Event-ID 全量掌控 |
| permission.ask 往返 | UIMessage 无审批 part 类型，需 hack data part | reducer 直出 `approval` part，PermissionModal 经 CommandClient 回 `approve` 命令 |
| spillRef 按需拉取 | 无 | tool part 持 `spillRef`，富渲染懒加载 |
| 16ms coalescing / resync | 与 `useChat` 内部 batching 打架 | 自有 rAF 合批，完全可控 |

结论：**`ai`（Vercel AI SDK）只在内核侧用**（`streamText` 产 token，见 P0 §C 生命周期），前端**不跑 `useChat`**；前端经 `@arclight/client-core` 消费 ArcEvent SSE，投影进 ExternalStore。这把"对 `ai` 的依赖收敛进内核 adapter 层"（选型清单 §0.1 红线）落到前端：前端零 `ai` 运行时耦合，只 `import type` 共享类型。`@assistant-ui/react-ai-sdk` 包实际只用其 part 类型定义做映射参考，可不在前端运行时引入。

### 0.2 分层与依赖方向

```
┌─ Next.js App Router ─────────────────────────────────────────────────────┐
│  app/(chat)/[sessionId]/page.tsx   RSC 首屏(SSR 拉历史快照,不流式)       │
│   └─ <ChatClient/> 'use client' ── 注入 sessionId + bootstrap snapshot     │
│                                                                            │
│  ┌─ UI 层(React,assistant-ui primitives + 自有富渲染)──────────────────┐ │
│  │ <ArcRuntimeProvider> (ExternalStoreRuntime)                          │ │
│  │   ├ <Thread/>  (assistant-ui)                                         │ │
│  │   │   ├ <MessagePrimitive> → MarkdownText / ToolCallCard / Reasoning  │ │
│  │   │   └ ToolCallCard ⤷ DiffView(Monaco) | TerminalView | JsonView     │ │
│  │   ├ <PermissionModal/> (订阅 pending approvals)                       │ │
│  │   └ <Composer/> + <SessionStatusBar/>(epoch/连接态/usage)            │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│  ┌─ @arclight/client-core(纯 TS,端无关,各端复用)──────────────────────┐ │
│  │ ArcTransport ── EventStreamManager(SSE 重连/去重/coalesce)            │ │
│  │              ├─ SessionReducer(ArcEvent → SessionState)               │ │
│  │              ├─ CommandClient(C1 POST submit/interrupt/approve)        │ │
│  │              ├─ EpochTracker(乐观锁 baseEpoch / StaleEpochError)       │ │
│  │              └─ SpillFetcher(spillRef 按需拉取 + LRU 缓存)            │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────┬───────────────────────────────────────────────────────────────────┘
       │ C1: POST /api/commands     C2: GET /api/sessions/:id/events (SSE)
       │ spill: GET /api/artifacts/:id     bootstrap: GET /api/sessions/:id/snapshot
       ▼
   @arclight/core (Bun+Hono, 127.0.0.1:<port>)
```

**依赖纪律**：`client-core` 不 `import` 任何 React / Next；UI 层经 `ArcRuntimeProvider` 注入。Web 端**不 import** `@arclight/core` 内部模块，只经 HTTP/SSE 消费（FULL §4.1 复用边界）。`@arclight/protocol` 是唯一类型源，前后端共享，零 codegen（P0 一致性自检 / 选型 §2.4）。

### 0.3 现成 vs 自研边界（前端口径，对齐选型 §5 #8/#11/#13）

| 拿现成（npm，零自研） | 自研工程量（实评） |
|---|---|
| `next`/`react`/`react-dom`（壳/路由/RSC） | **ArcTransport + EventStreamManager**（SSE 重连/16ms coalesce/seq 去重/Last-Event-ID 续接/resync）~400-700 行 |
| `@assistant-ui/react`（Thread/Message/Composer primitives + ExternalStoreRuntime 编排） | **SessionReducer**（ArcEvent → part 级 ThreadMessage 投影）~300-500 行 |
| `@monaco-editor/react`（diff 渲染，懒加载） | **ToolCallCard 富渲染**（DiffView/TerminalView/JsonView + spill 懒拉）~500-900 行 |
| `marked`+`shiki`（markdown/高亮）或 assistant-ui 内置 markdown | **PermissionModal**（permission.ask → approve/deny 往返 + 过期处理）~200-400 行 |
| `zustand`（pending approvals / 连接态 store） | **CommandClient + EpochTracker**（C1 幂等/StaleEpoch）~150-250 行 |
| `@xterm/xterm`（终端流渲染，后期） | bootstrap/resync 全量重建逻辑 ~150-250 行 |

合计前端实评 ~1500-3000+ 行，与选型 §5 #13 一致。**分期降级**：富渲染先纯文本/JSON（DiffView→JsonView，TerminalView→`<pre>` 流），Monaco/xterm 后上（见 §3.5）。

---

## 1. ① ArcTransport —— 内核 ArcEvent SSE → assistant-ui ExternalStore

### 1.1 职责

`ArcTransport` 是 `client-core` 的门面，组合 EventStreamManager（订阅/重连）、SessionReducer（状态机）、CommandClient（C1）、EpochTracker、SpillFetcher。它对 UI 暴露一个 React 无关的 observable：`subscribe(listener) → SessionState`，以及命令方法 `submit/interrupt/approve`。`ArcRuntimeProvider`（薄 React 适配）把 `SessionState` 投影成 assistant-ui 的 `ExternalStoreAdapter`。

### 1.2 SessionState（reducer 输出，UI 唯一读取面）

```ts
// @arclight/client-core/state.ts
import type { ArcEvent, Usage, RiskClass, RiskTier } from '@arclight/protocol';

export type Connection =
  | { phase: 'connecting' }
  | { phase: 'open' }
  | { phase: 'reconnecting'; attempt: number; nextDelayMs: number }
  | { phase: 'resyncing' }              // epoch-jump / buffer-expired 全量拉取中
  | { phase: 'closed'; reason?: string };

export type ToolPart = {
  callId: string;
  name: string;
  status: 'requested' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
  argsPreview: string;
  progress?: { pct?: number; note?: string };
  output?: { ok: boolean; preview: string; spillRef?: string };   // spillRef 见 §3.4
  render?: ToolRenderHint;             // 'diff' | 'terminal' | 'json' | 'text' — 由 name 推断
};

export type MsgPart =
  | { type: 'text'; text: string }              // message.delta 累积
  | { type: 'reasoning'; text: string }         // reasoning.summary.delta(注:摘要,非真实CoT,FULL 决策v2.3)
  | { type: 'tool'; tool: ToolPart }
  | { type: 'approval'; askId: string };        // 占位,详情挂 pendingApprovals

export type ThreadMsg = {
  id: string;                   // turnId 或 messageId
  role: 'user' | 'assistant';
  parts: MsgPart[];
  status: 'streaming' | 'complete' | 'error' | 'interrupted';
};

export type Approval = {
  askId: string; risk: 'low'|'med'|'high'; cls: RiskClass;
  action: string; detail: Record<string, unknown>;
  expiresAt: number;            // 内核给的绝对时刻(P0:permission.ask 默认 60s),前端本地 expiry 处理见 §4.4
  state: 'pending' | 'deciding' | 'expired' | 'resolved';
};

export interface SessionState {
  sessionId: string;
  epoch: number;                // EpochTracker 维护;submit 时作 baseEpoch
  lastSeq: number;              // 续接书签
  connection: Connection;
  messages: ThreadMsg[];        // 给 assistant-ui ExternalStore
  pendingApprovals: Approval[];
  running: boolean;             // 是否有 active turn(同 session 同时只 1 个,P0 并发规则)
  usage?: Usage;                // turn.completed 累积,SessionStatusBar 展示(成本可观测,非计费)
  error?: { code: string; message: string };
}
```

### 1.3 ArcRuntimeProvider —— 投影进 assistant-ui

```tsx
// app 层(React 适配,薄)
import { useExternalStoreRuntime, AssistantRuntimeProvider } from '@assistant-ui/react';
import { useArcSession } from './useArcSession';   // 见 §2.5

export function ArcRuntimeProvider({ sessionId, bootstrap, children }: Props) {
  const arc = useArcSession(sessionId, bootstrap);   // 订阅 ArcTransport,返回 SessionState + actions

  const runtime = useExternalStoreRuntime({
    isRunning: arc.state.running,
    messages: arc.state.messages,                    // ThreadMsg[] → 经 convertMessage 映射
    convertMessage: toAuiMessage,                    // ThreadMsg → assistant-ui ThreadMessageLike
    onNew: async (msg) => {                          // 用户发新消息 = C1 submit
      await arc.submit(extractText(msg.content));
    },
    onCancel: async () => { await arc.interrupt('user'); },   // 中断当前 turn
    // 不提供 onEdit/onReload(MVP 不做重生成;后置)
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
      <PermissionModalHost approvals={arc.state.pendingApprovals} onDecide={arc.approve} />
      <SessionStatusBar connection={arc.state.connection} epoch={arc.state.epoch} usage={arc.state.usage} />
    </AssistantRuntimeProvider>
  );
}
```

`toAuiMessage`（ThreadMsg → assistant-ui `ThreadMessageLike`）是核心映射：text part → `{type:'text'}`；tool part → `{type:'tool-call', toolName, toolCallId, args, result, argsText}`（assistant-ui 用 `makeAssistantToolUI` 自定义渲染该 toolName，见 §3）；reasoning part → `{type:'reasoning'}`。assistant-ui 的 part 级 diffing 天然吃增量更新——只要 ThreadMsg 的 parts 引用按 part 更新（见 §2.4 reducer 不可变更新），assistant-ui 只重渲染变化的 part。

---

## 2. ② SSE 订阅 + reducer（coalescing / 退避 / 去重 / 续接 / resync）

### 2.1 EventStreamManager —— SSE 订阅（fetch+ReadableStream，非 EventSource）

**关键决策（FULL §4.1 硬约束②）**：不用 `EventSource`。原因：① 同源 httpOnly cookie 场景 EventSource 可用，但跨域/带 `Authorization` header（CLI/测试/远程）EventSource 无法设 header；② 我们需要统一一套既支持 cookie 又支持 bearer 的订阅。故用 **`fetch` + `ReadableStream` 手写 SSE 解析**（可带 `Authorization`，可带 `Last-Event-ID` header），并对每帧解析 `event:`/`id:`/`data:`。`@microsoft/fetch-event-source` 是可选成品（选型 §2.4 备选），但为零额外依赖 + 完全控制重连退避，自实现一个 ~120 行解析器更可控。

```ts
// @arclight/client-core/stream.ts
export class EventStreamManager {
  private lastEventId = 0;          // = lastSeq,续接书签
  private epoch = 0;
  private retry = 250;              // 250ms 起,指数退避封顶 ~8s(FULL §2.3 reducer 三纪律#2)
  private abort?: AbortController;

  constructor(
    private url: (afterSeq: number, epoch: number) => string,
    private auth: { mode: 'cookie' } | { mode: 'bearer'; token: string },
    private onFrame: (ev: ArcEvent, seq: number) => void,
    private onResync: (reason: 'epoch-jump'|'buffer-expired', snapshotUrl: string) => Promise<void>,
    private onConn: (c: Connection) => void,
  ) {}

  async connect(fromSeq = this.lastEventId, fromEpoch = this.epoch) {
    this.abort = new AbortController();
    this.onConn({ phase: this.lastEventId ? 'reconnecting' : 'connecting', attempt: 0, nextDelayMs: 0 } as any);
    try {
      const res = await fetch(this.url(fromSeq, fromEpoch), {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Last-Event-ID': String(fromSeq),               // 服务端 replay seq>fromSeq
          ...(this.auth.mode === 'bearer' ? { Authorization: `Bearer ${this.auth.token}` } : {}),
        },
        credentials: this.auth.mode === 'cookie' ? 'include' : 'omit',
        signal: this.abort.signal,
      });

      // 缓冲过期/epoch 跳跃: 内核回 409 {reason, snapshotUrl} (P0 §B 恢复/续接②④)
      if (res.status === 409) {
        const { reason, snapshotUrl } = await res.json();
        this.onConn({ phase: 'resyncing' });
        await this.onResync(reason, snapshotUrl);
        return; // resync 完成后由上层用新 lastSeq/epoch 重新 connect
      }
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);

      this.onConn({ phase: 'open' });
      this.retry = 250;                                    // 成功连上,退避复位
      await this.pump(res.body.getReader());                // 见 §2.2
    } catch (e) {
      if (this.abort?.signal.aborted) return;              // 主动关闭,不重连
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    const delay = this.retry;
    this.retry = Math.min(this.retry * 2, 8000);
    this.onConn({ phase: 'reconnecting', attempt: Math.log2(delay/250)|0, nextDelayMs: delay });
    setTimeout(() => this.connect(), delay);               // 带 jitter 见 §2.6
  }

  close() { this.abort?.abort(); this.onConn({ phase: 'closed' }); }
  setBookmark(seq: number, epoch: number) { this.lastEventId = seq; this.epoch = epoch; }
}
```

SSE 帧格式（P0 + FULL §2.3）：`event:<t>\nid:<seq>\ndata:<json>\n\n`；心跳 `:heartbeat\n\n`（P0 §B 不持久化，前端解析时丢弃，仅用于探活/重置空闲超时）。

### 2.2 帧解析 + 16ms coalescing（reducer 三纪律 #1）

`message.delta` 高频（内核侧已 100-250ms 合批写库，但 SSE 推流仍可能密集），前端按 **animation frame（~16ms）合批** 喂给 reducer，避免每 token 一次 React 渲染。

```ts
private buf = '';
private pendingFrames: Array<{ ev: ArcEvent; seq: number }> = [];
private rafScheduled = false;

private async pump(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { this.scheduleReconnect(); return; }       // 流自然结束=空闲断,续接
    this.buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 2);
      if (raw.startsWith(':')) continue;                  // 心跳,丢弃
      const { id, data } = parseSseBlock(raw);            // 取 id: 与 data:
      if (data === undefined) continue;
      const ev = JSON.parse(data) as ArcEvent;
      this.pendingFrames.push({ ev, seq: id });
    }
    if (!this.rafScheduled) {
      this.rafScheduled = true;
      const flush = () => {
        this.rafScheduled = false;
        const frames = this.pendingFrames; this.pendingFrames = [];
        for (const f of frames) this.dispatch(f.ev, f.seq);   // → §2.3 去重 → reducer
      };
      // 浏览器用 rAF;无 rAF(SSR/测试)回落 setTimeout 16ms
      (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (cb:any)=>setTimeout(cb,16))(flush);
    }
  }
}
```

### 2.3 按 seq 单调去重（reducer 三纪律 #3）

重连后服务端 replay `seq > Last-Event-ID`，但"幻影重复"可能发生（FULL §4.1 硬约束⑥）。去重在 dispatch 入口：

```ts
private maxSeq = 0;
private dispatch(ev: ArcEvent, seq: number) {
  if (seq <= this.maxSeq) return;          // 单调去重:已处理过的旧帧丢弃
  this.maxSeq = seq;
  this.setBookmark(seq, this.epoch);       // 更新书签(epoch 随 context.compacted 改,见 §2.4)
  this.onFrame(ev, seq);                   // → SessionReducer
}
```

### 2.4 SessionReducer —— ArcEvent → SessionState（part 级不可变更新）

纯函数 `reduce(state, ev, seq) → state`。要点：**part 级不可变更新**（只替换变化的 part 引用，其余共享），让 assistant-ui 精准 diff；epoch 跟踪交 EpochTracker。

```ts
// @arclight/client-core/reducer.ts
export function reduce(s: SessionState, ev: ArcEvent, seq: number): SessionState {
  switch (ev.t) {
    case 'session.started':
      return { ...s, sessionId: ev.sessionId, epoch: ev.epoch, lastSeq: seq };

    case 'turn.started':
      return { ...s, running: true, lastSeq: seq,
        messages: [...s.messages, { id: ev.turnId, role: 'assistant', parts: [], status: 'streaming' }] };

    case 'message.delta': {                              // token 增量 → 累积到 text part
      const m = lastMsg(s, ev.turnId); if (!m) return s;
      const parts = upsertTextPart(m.parts, ev.text);    // 末尾 text part 追加;无则新建
      return replaceMsg(s, m.id, { ...m, parts }, seq);
    }

    case 'reasoning.delta': {                            // 摘要增量(FULL v2.3:reasoning.summary.delta)
      const m = lastMsg(s, ev.turnId); if (!m) return s;
      return replaceMsg(s, m.id, { ...m, parts: upsertReasoningPart(m.parts, ev.text) }, seq);
    }

    case 'tool.requested': {                             // 新 tool part
      const m = lastMsg(s); if (!m) return s;
      const tool: ToolPart = { callId: ev.callId, name: ev.name, status: 'requested',
        argsPreview: ev.argsPreview, render: renderHintFor(ev.name) };   // §3.1 渲染推断
      return replaceMsg(s, m.id, { ...m, parts: [...m.parts, { type:'tool', tool }] }, seq);
    }
    case 'tool.progress':
      return patchTool(s, ev.callId, t => ({ ...t, status:'running', progress:{ pct: ev.pct, note: ev.note } }), seq);
    case 'tool.output':
      return patchTool(s, ev.callId, t => ({ ...t, status: ev.ok?'completed':'failed',
        output: { ok: ev.ok, preview: ev.preview, spillRef: ev.spillRef } }), seq);

    case 'permission.ask': {                             // → pendingApprovals + part 占位
      const ap: Approval = { askId: ev.askId, risk: ev.risk, cls: ev.cls, action: ev.action,
        detail: ev.detail, expiresAt: nowPlusDefault(ev), state: 'pending' };
      return { ...s, lastSeq: seq, pendingApprovals: [...s.pendingApprovals, ap] };
      // 注:tool part 同时被标 awaiting_approval(若 detail 关联 callId,见 §4.2)
    }

    case 'context.compacted':                            // 压缩边界 → epoch 递增,cache 前缀已变
      return { ...s, epoch: ev.epoch, lastSeq: seq };    // EpochTracker 同步,见 §2.7

    case 'turn.completed':
      return { ...s, running: false, usage: accUsage(s.usage, ev.usage), lastSeq: seq,
        messages: markComplete(s.messages, ev.turnId) };

    case 'interrupted':
      return { ...s, running:false, lastSeq: seq, messages: markStatus(s.messages, ev.turnId, 'interrupted') };

    case 'session.error':                                // 5键 envelope,不泄 traceback
      return { ...s, running:false, lastSeq: seq, error: { code: ev.code, message: ev.message } };

    // subagent.* : MVP 写代码单 agent,reducer 静默接收/可选 SubagentTray;未知 t 静默忽略(forward-compat)
    default: return { ...s, lastSeq: seq };
  }
}
```

`upsertTextPart`：若 parts 末尾是 text part 则返回 `[...head, {type:'text', text: last.text+delta}]`（新引用，其余共享）；否则 append 新 text part。这保证 assistant-ui 只重渲染最后一个 text part。

### 2.5 useArcSession —— React Hook（订阅 + 命令）

```ts
export function useArcSession(sessionId: string, bootstrap: SessionState) {
  const transportRef = useRef<ArcTransport>();
  const [state, setState] = useState(bootstrap);

  useEffect(() => {
    const t = new ArcTransport({ sessionId, initial: bootstrap, onChange: setState });
    transportRef.current = t;
    t.start();                                  // EventStreamManager.connect()
    const onVisible = () => { if (document.visibilityState === 'visible') t.ensureConnected(); };
    document.addEventListener('visibilitychange', onVisible);   // 标签页切回立即重连
    return () => { document.removeEventListener('visibilitychange', onVisible); t.dispose(); };
  }, [sessionId]);

  return {
    state,
    submit:    (text: string) => transportRef.current!.submit(text),     // C1 submit, baseEpoch=state.epoch
    interrupt: (reason: 'user'|'abort') => transportRef.current!.interrupt(reason),
    approve:   (askId: string, decision: 'allow'|'deny') => transportRef.current!.approve(askId, decision),
  };
}
```

### 2.6 250ms 重连退避（细节）

- 起始 250ms，指数 ×2 封顶 8s（§2.1）。
- **加 jitter**：实际 `delay = base * (0.5 + Math.random()*0.5)`，避免多标签页同时重连打内核。
- 成功连上后退避复位 250ms。
- `visibilitychange` → visible 时若处于 `reconnecting` 立即触发一次（不等退避计时器），即"切回标签页秒连"。
- **空闲超时**：SSE 长流靠内核心跳行（`:heartbeat`）保活；前端若 N 秒（如 90s，> 心跳间隔）无任何帧/心跳，主动断开重连（防半开连接）。

### 2.7 EpochTracker + 续接三路径（FULL §2.3 / P0 §B 恢复④）

三种续接路径在 EventStreamManager.connect 里统一处理（§2.1 已含 409 分支）：

| 路径 | 触发 | 行为 |
|---|---|---|
| **① 缓冲内增量 replay** | 断线重连，`afterSeq` 仍在 events 表 | `GET /api/sessions/:id/events?afterSeq=N&epoch=E` 200，服务端 replay `seq>N`，reducer 去重续上 |
| **② 缓冲过期全量 resync** | `afterSeq` 早于缓冲窗口（P0 ≥60s；P0 实际 server 重启后仍可从 SQLite 完整 replay，缓冲过期主要在远程拓扑） | 409 `{reason:'buffer-expired', snapshotUrl}` → `onResync` 拉 `GET snapshotUrl`（= `/api/sessions/:id/snapshot`）全量重建 state，重置 lastSeq/epoch，再 connect |
| **③ epoch 跳跃全量 resync** | 重连请求的 `epoch` 旧且 `afterSeq` 早于最近 `context.compacted`（cache 前缀失效） | 409 `{reason:'epoch-jump', snapshotUrl}` → 同②，全量拉取（压缩边界已变，增量无意义） |

**snapshot 端点**：`GET /api/sessions/:id/snapshot` 返回 `{ epoch, lastSeq, messages, pendingApprovals, usage }`（由内核从 SQLite messages/tool_calls/approvals 表重建，P0 §B⑤）。resync 后：`stream.setBookmark(snapshot.lastSeq, snapshot.epoch); transport.reset(snapshot); stream.connect()`。

### 2.8 刷新不丢（SSR bootstrap + 续接）

- **首屏 RSC**（`page.tsx`）服务端调 `/api/sessions/:id/snapshot` 拿到历史，作为 `bootstrap` 注入 `<ChatClient>`，SSR 渲染历史消息（不流式，避免 Vercel SSE 超时 / 首屏阻塞）。
- 客户端 `useArcSession` 用 `bootstrap.lastSeq` 作 `afterSeq` 起点连 SSE，**只续接刷新后的增量**——刷新不丢历史、不重复拉全量、不丢流式中途的 token（内核已持久化 message.delta，P0 §B event 持久化边界）。
- 若 `running:true`（刷新时 turn 仍在跑），SSE 续接后继续接收剩余 token / tool 事件，无缝。

---

## 3. ③ 工具调用富渲染（Monaco diff / 终端流 / spillRef 懒拉）

### 3.1 渲染分发：name → ToolRenderHint

P0 内置工具最小集：`read_file` / `write_file` / `apply_patch` / `bash`（P0 §C）。前端按 name 推断渲染：

```ts
export function renderHintFor(name: string): ToolRenderHint {
  switch (name) {
    case 'apply_patch': case 'write_file': return 'diff';      // DiffView(Monaco)
    case 'bash':                           return 'terminal';  // TerminalView(流)
    case 'read_file':                      return 'text';      // 折叠文本
    default:                               return 'json';      // 通用 JsonView 兜底
  }
}
```

assistant-ui 用 `makeAssistantToolUI({ toolName, render })` 注册每工具的自定义 UI；ToolCallCard 内部再按 `render` 选子组件。**未知工具一律走 JsonView 兜底**（forward-compat）。

### 3.2 ToolCallCard 组件骨架

```tsx
function ToolCallCard({ tool }: { tool: ToolPart }) {
  return (
    <Card>
      <Header status={tool.status} name={tool.name} preview={tool.argsPreview}/>
      {tool.status === 'running' && <ProgressBar pct={tool.progress?.pct} note={tool.progress?.note}/>}
      {tool.status === 'awaiting_approval' && <InlineApprovalHint/>}     {/* 联动 PermissionModal */}
      <Body>
        {tool.render === 'diff'     && <DiffView tool={tool}/>}
        {tool.render === 'terminal' && <TerminalView tool={tool}/>}
        {tool.render === 'text'     && <TextOutput tool={tool}/>}
        {tool.render === 'json'     && <JsonView tool={tool}/>}
      </Body>
    </Card>
  );
}
```

### 3.3 DiffView（Monaco DiffEditor，懒加载）

```tsx
const MonacoDiff = dynamic(() => import('@monaco-editor/react').then(m => m.DiffEditor), { ssr: false });

function DiffView({ tool }: { tool: ToolPart }) {
  const { original, modified, lang } = useDiffPayload(tool);   // 见下:来源
  if (!original && !modified) return <Skeleton/>;
  return <MonacoDiff original={original} modified={modified} language={lang}
            options={{ readOnly:true, renderSideBySide:true, automaticLayout:true }} height={320}/>;
}
```

diff 数据来源两条：① `apply_patch` 的 args 含 patch（SEARCH/REPLACE 块），可前端解析出 original/modified preview；② 完整 before/after 走 `tool.output.spillRef`（diff artifact，P0 artifacts.kind='diff'），按需拉（§3.4）。**懒加载纪律**：Monaco 经 `dynamic(ssr:false)` 仅在该 card 进视口时加载（IntersectionObserver 包一层），避免首屏 bundle 膨胀。**CSP**（FULL §4.1 坑⑦）：Monaco 用 worker，需 `worker-src 'self' blob:` + 预 bundle worker。

### 3.4 spillRef 按需拉取（P0 输出投影：>32KB 落 artifact）

内核侧：`tool.output` 超 32KB 落 `artifacts` 文件，事件只带 `preview`（前 16KB）+ `spillRef=artifact://<id>`，模型只见 preview（P0 §C 输出投影）。前端：

```ts
// @arclight/client-core/spill.ts
export class SpillFetcher {
  private cache = new LRU<string, Blob>({ max: 32 });
  async fetch(spillRef: string): Promise<Blob> {                 // 'artifact://<id>' → /api/artifacts/<id>
    const id = spillRef.replace('artifact://', '');
    if (this.cache.has(spillRef)) return this.cache.get(spillRef)!;
    const res = await fetch(`/api/artifacts/${id}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`spill ${res.status}`);
    const blob = await res.blob(); this.cache.set(spillRef, blob); return blob;
  }
}
```

UI 纪律：**默认只渲染 `preview`**（16KB，瞬时）；spill 只在用户点击"展开完整输出 / 查看完整 diff"时拉取（懒），拉取中显示 spinner，失败显示重试。终端长输出同理——preview 即出，完整 stdout/stderr 走 spillRef 懒拉。这与"模型只见 preview"对齐：UI 也默认轻量，按需重。

### 3.5 TerminalView（终端流渲染）+ 分期降级

- **MVP（纯文本）**：`bash` 的 `tool.progress.note`（stdout/stderr chunk，内核已合批）累积进一个 `<pre>` 流容器，自动滚底，ANSI 转义先 strip 或经 `ansi-to-html` 上色。这是降级路径，先上。
- **后期（富渲染）**：`@xterm/xterm` 真终端渲染（保留 ANSI、宽字符、resize）。`@xterm/xterm` 走 `dynamic(ssr:false)` 懒加载，按 §3.3 同样的 IntersectionObserver 策略。
- 完整输出（>preview）→ spillRef 懒拉，附"下载 stdout"。

**分期降级总表**（选型 §5 #13 回退路径）：

| 渲染 | MVP 降级（先上） | 富渲染（后上） |
|---|---|---|
| diff | `JsonView` / `<pre>` 展示 patch 文本 | Monaco DiffEditor（side-by-side） |
| 终端 | `<pre>` + ansi-to-html 流 | @xterm/xterm |
| 通用 tool | JsonView（折叠 JSON） | 按 name 专属卡片 |
| 大输出 | preview 16KB only | spillRef 懒拉 + 下载 |

---

## 4. ④ 权限审批模态（permission.ask → 对话框 → approve/deny 往返）

### 4.1 数据流

```
内核 streamText → 风险分类(confirm) → approvals.pending(60s) + emit permission.ask{askId,risk,cls,action,detail}
   → SSE → reducer 入 pendingApprovals → PermissionModal 弹出
   → 用户点 Approve/Deny → CommandClient POST /api/commands {k:'approve',askId,decision}
   → 内核改 approvals 状态 + 恢复/取消 turn → 后续 tool.progress/tool.output 经 SSE 回流
```

审批状态机（P0 §C）：`pending →(allow,未过期) allowed | →(deny) denied | →(过期) expired | →(turn 中断) cancelled`，后四态终态。前端镜像此机：`pending → deciding(乐观,点击后) → resolved | expired`。

### 4.2 PermissionModal 组件

```tsx
function PermissionModalHost({ approvals, onDecide }: Props) {
  const active = approvals.find(a => a.state === 'pending' || a.state === 'deciding');
  if (!active) return null;
  return <PermissionModal approval={active} onDecide={onDecide}/>;
}

function PermissionModal({ approval, onDecide }: { approval: Approval; onDecide: ApproveFn }) {
  const remaining = useCountdown(approval.expiresAt);            // 本地倒计时,见 §4.4
  const expired = remaining <= 0;
  return (
    <Dialog open modal>
      <RiskBadge risk={approval.risk} cls={approval.cls}/>        {/* 高危红色 / funds 强警示 */}
      <h3>{approval.action}</h3>
      <DetailView detail={approval.detail}/>                      {/* 命令全文/写入文件/diff 预览 */}
      {!expired ? (
        <>
          <Countdown ms={remaining}/>
          <Button variant="danger"  disabled={approval.state==='deciding'}
                  onClick={() => onDecide(approval.askId, 'allow')}>批准执行</Button>
          <Button variant="secondary" autoFocus
                  onClick={() => onDecide(approval.askId, 'deny')}>拒绝</Button>
        </>
      ) : (
        <ExpiredNotice onDismiss={/* 本地清理,见 §4.4 */}/>
      )}
    </Dialog>
  );
}
```

UI 纪律（对齐 FULL §2.3 fail-closed）：默认焦点在"拒绝"（误回车不放行）；`high`/`irreversible`/`funds` 类红色强警示；`detail` 展示足够信息让用户判断（bash 命令全文 / write_file 目标路径 + diff / apply_patch 改动范围）。**未知 `risk`→按 `high`，未知 `cls`→按 `irreversible`** 降级渲染（FULL §2.3）。

### 4.3 approve/deny 往返（CommandClient）

```ts
// @arclight/client-core/command.ts
async approve(askId: string, decision: 'allow'|'deny') {
  this.mutate(a => a.askId===askId ? { ...a, state:'deciding' } : a);   // 乐观置 deciding,防双击
  const res = await this.post({ k:'approve', v:1, commandId: uuid(), askId, decision });
  if (!res.ok) {
    // 审批已过期/已被其他端处理 → 内核回 nack/4xx
    this.mutate(a => a.askId===askId ? { ...a, state: res.code==='APPROVAL_EXPIRED' ? 'expired' : 'pending' } : a);
    return;
  }
  // 成功:reducer 不直接移除,等内核后续事件(tool.progress 恢复 或 tool.output APPROVAL_DENIED)
  // 但本地可乐观标 resolved 让 modal 关闭
  this.mutate(a => a.askId===askId ? { ...a, state:'resolved' } : a);
}
```

`commandId` 作幂等键（P0：turns 幂等 + ArcCommand approve）。POST `/api/commands`，同源带 cookie。返回 `ArcAck`（HTTP 端可选用；HTTP req-resp 自带关联，FULL §2.1）。

### 4.4 审批过期处理（双侧）

- **内核侧权威**：approvals 默认 60s `expiresAt`，过期内核自动转 `expired`（终态），并发 `tool.output{ok:false, error_class:'APPROVAL_EXPIRED'}`（ToolErrorEnvelope，P0 §C）。前端 reducer 收到该 tool.output → patchTool 标 failed + 把对应 approval 标 expired。
- **前端本地倒计时**：`useCountdown(expiresAt)` 仅做 UX 提示（显示剩余秒、到 0 切 ExpiredNotice），**不作权威判定**——真相以内核 `tool.output` / approve nack `APPROVAL_EXPIRED` 为准。这避免前后端时钟漂移误判。
- **过期后用户点击**：若本地已显示 expired，按钮禁用；若边界竞态（本地未过、内核已过），approve POST 返回 `APPROVAL_EXPIRED`，前端据此切 expired（§4.3）。
- **turn 中断时**：用户中断（interrupt）→ 内核把 pending approval 转 `cancelled`，发 interrupted 事件；前端清空 pendingApprovals 里属于该 turn 的项。

---

## 5. ⑤ 消息流式 part 级更新、组件树、状态管理

### 5.1 part 级流式更新机制

assistant-ui 的 ExternalStoreRuntime 对 `messages` 做 referential diff：reducer 每次只替换变化的 ThreadMsg 与其变化的 part（§2.4 不可变更新），其余引用不变。因此：

- `message.delta` 高频 → 经 16ms coalesce（§2.2）→ reducer 合批追加到末尾 text part → assistant-ui 只重渲染该 text part 的 `<MarkdownText>`。
- `tool.progress` → 只 patch 对应 tool part → 只重渲染该 ToolCallCard 的 ProgressBar / TerminalView 末尾。
- 不同 part 互不影响（一个 tool card 流式更新不会重渲染前面的 text）。

markdown 流式：用 assistant-ui 的 `MarkdownTextPrimitive`（或 `marked`+`shiki`），支持未闭合代码块的渐进渲染（流式 markdown 容错）。

### 5.2 组件树

```
<ChatClient sessionId bootstrap>                         'use client'
└─ <ArcRuntimeProvider>                                  ExternalStoreRuntime 注入
   ├─ <Thread>                                           assistant-ui
   │  ├─ <ThreadWelcome/>                                空会话引导
   │  ├─ <Messages>                                      虚拟化(消息多时 @tanstack/react-virtual)
   │  │  └─ <MessagePrimitive> (per ThreadMsg)
   │  │     ├─ role=user    → <UserMessage> (纯文本/附件)
   │  │     └─ role=assistant→ parts.map:
   │  │        ├─ text      → <MarkdownText/>             流式 markdown
   │  │        ├─ reasoning → <ReasoningAccordion/>       折叠摘要(可关)
   │  │        └─ tool      → <ToolCallCard/>             §3.2
   │  │           ├─ <DiffView/>      (Monaco, lazy)
   │  │           ├─ <TerminalView/>  (pre→xterm, lazy)
   │  │           ├─ <TextOutput/>
   │  │           └─ <JsonView/>
   │  ├─ <Composer/>                                     输入 + 发送 + 中断(running 时显 Stop)
   │  └─ <ScrollToBottom/>
   ├─ <PermissionModalHost/>                             §4.2(全局单例,叠加在 Thread 上)
   └─ <SessionStatusBar/>                                连接态/epoch/usage(成本可观测)
```

### 5.3 状态管理分工

| 状态 | 持有者 | 理由 |
|---|---|---|
| 会话真相（messages/approvals/epoch/连接态） | **ArcTransport（client-core）→ useArcSession** | 端无关，各端复用；React 仅订阅 |
| assistant-ui 渲染状态（编辑器/滚动/选区） | assistant-ui Runtime 内部 | 框架自管 |
| 跨组件轻量 UI（modal 开关、spill 展开态、当前 sessionId） | **Zustand** | 简单全局，避免 prop drilling |
| 富渲染懒加载缓存（spill blob LRU） | SpillFetcher（client-core） | 与传输同生命周期 |

**纪律**：业务状态只读自 client-core（单一真相源投影），UI store 不复制业务状态（防双源不一致，对齐 FULL §5.4 "单一真相源=内核 server"）。

### 5.4 SessionStatusBar（成本可观测，非计费 — FULL §5.6）

展示：连接态徽章（open/reconnecting+倒计时/resyncing/closed）、当前 epoch、本会话 usage（input/output/cache token + 估算成本）。**纪律**：阶段一只做"成本可观测"展示，**不做 quota 强制/账单**（FULL §5.6 防过度建设）。

---

## 6. 端点契约清单（前端依赖的内核 HTTP/SSE 面）

| 用途 | 方法/路径 | 载荷 | 来源 |
|---|---|---|---|
| C1 提交/中断/审批/续接 | `POST /api/commands` | `ArcCommand`（submit/interrupt/approve/resume/declareCap） | P0 §A/§C |
| C2 事件流 | `GET /api/sessions/:id/events?afterSeq=N&epoch=E` | SSE `event/id/data`；409 `{reason,snapshotUrl}` | P0 §B |
| 全量快照（resync + SSR bootstrap） | `GET /api/sessions/:id/snapshot` | `{epoch,lastSeq,messages,pendingApprovals,usage}` | P0 §B⑤ |
| spill 拉取 | `GET /api/artifacts/:id` | 二进制/文本 blob | P0 输出投影 |
| 能力协商 | `POST /api/commands {k:'declareCap'}` | `CapabilityProfile{localSandbox:true,...}` | FULL §2.6 |

**鉴权**（P0 §A）：同源 httpOnly cookie（首次 `?pair=<one-time>` 配对）为默认；CLI/测试用 `Authorization: Bearer`。前端 ArcTransport 的 `auth` 字段据部署模式选 `cookie`（本地优先 Web，默认）/`bearer`。CapabilityProfile：本地 Web `localSandbox:true`（经本地 Hono+nono），`fileSystem:'native'`（内核代理），`screenshot:'none'`，`background:'none'`，`terminal:true`（MVP 写代码）。

---

## 7. 前端 npm 依赖（对齐选型 §3，7 个 + 富渲染增补）

**选型清单既定 7 个**：`next`^15 / `react`^19 / `react-dom`^19 / `@assistant-ui/react` / `@assistant-ui/react-ai-sdk`（仅用其 part 映射类型，运行时可不用）/ `tailwindcss` / （`@serwist/next` 末期）。

**本设计富渲染增补**（懒加载，不进首屏 bundle）：`@monaco-editor/react`（diff，MIT，FULL §4.1 既列）、`@xterm/xterm`（终端，后期，MIT）、`zustand`（MIT，FULL §4.1 既列）、`marked`+`shiki`（markdown/高亮，MIT，FULL §4.1 既列）。这些均在 FULL §4.1 Web 技术选型表内，未越出文档选型。

**刻意不引**（对齐文档）：`effect`、LangChain/LangGraph、protobuf/buf、AG-UI 适配器、CopilotKit、`@serwist/next`（MVP 末期才加）、`resumable-stream`/Redis（MVP 只做"刷新不丢"）。前端**不在运行时引 `ai`**（收敛进内核，§0.1）。

---

## 8. 一致性自检（与五份文档对齐）

- **ArcEvent/ArcCommand/ArcAck** 字段与 FULL §2.1/§2.3、P0 §C 完全一致（含 `reasoning.summary.delta` 摘要口径、`cls` 四分类、5 键 error envelope）。
- **seq/epoch/resync**：per-session 单调 seq、SSE `id:`=seq、Last-Event-ID 续接、三续接路径（增量/buffer-expired/epoch-jump 全量）、409+snapshotUrl，与 FULL §2.3、P0 §B 一致。
- **reducer 三纪律**（16ms coalesce / 250ms 退避 / seq 单调去重）逐条落地（§2.2/§2.6/§2.3）。
- **spillRef**：>32KB 落 artifact、preview 16KB、`artifact://<id>` → `/api/artifacts/:id` 懒拉，与 P0 输出投影一致。
- **审批**：permission.ask→approve/deny→ArcCommand、60s 过期、状态机四终态、APPROVAL_EXPIRED envelope，与 P0 §C 审批状态机一致。
- **拓扑/鉴权**：本地优先 `localSandbox:true`、同源 httpOnly cookie + loopback bearer、不上 Auth.js（MVP），与 P0 §A、FULL 决策 v2.2 一致。
- **现成 vs 自研**：next/react/assistant-ui 拿现成；ArcTransport+reducer+富渲染+审批 UI 自研实评 1500-3000+ 行（非薄接缝），与选型 §5 #8/#11/#13 一致。
- **关键裁决**：ExternalStoreRuntime 而非 AISDKRuntime——这是对选型 §2.4 "AISDKRuntime 桥接"的**细化而非偏离**：文档说"把 ArcEvent 桥进 ExternalStore/AISDKRuntime"，本设计裁定走 ExternalStore（因 ArcEvent 的 epoch/resync/审批语义 AI SDK UIMessage 无原生表达），并把 `ai` 收敛进内核——正是选型清单反复强调的"对 `ai` 的依赖收敛进 adapter 层"。

**相关文档路径**（均绝对路径）：
- `/Users/fsm/project/arclightagent/FULL_PLATFORM_DESIGN.md`（§2 协议契约、§4.1 Web 端、§5 横切）
- `/Users/fsm/project/arclightagent/research/P0-基础三件套-拓扑-数据模型-工具契约.md`（数据模型、工具/审批契约、续接语义）
- `/Users/fsm/project/arclightagent/research/拿来即用-全栈选型清单.md`（§2.4/§3/§5 前端选型与自研量）