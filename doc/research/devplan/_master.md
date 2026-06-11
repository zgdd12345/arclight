All five referenced documents exist. I have the complete synthesized material in context. I'll write the development plan directly as my final output.

# arclightagent 开发方案（阶段一）

> 全平台个人 AI Agent · 阶段一 = Web + 写代码 MVP · 本地优先 `arclight serve --repo`
> 本方案严格对齐既有 5 份文档（`ARCHITECTURE_BLUEPRINT.md` / `FULL_PLATFORM_DESIGN.md` / `research/拿来即用-全栈选型清单.md` / `research/P0-基础三件套-拓扑-数据模型-工具契约.md` / `research/P0-沙箱方案-拿来即用.md`），不另起炉灶。诚实对齐 Codex 口径：MVP 自研实评 **6000-9000+ 行**，主循环（`queryLoop`）与前端（`ArcTransport` + 渲染 + 审批）是**真工程，非薄接缝**。

---

## 0. 执行摘要（一页讲清开发方案）

**做什么**：把架构蓝图与 P0 施工图细化为可直接施工的阶段一开发方案。阶段一只交付两件用户可感知的能力——**本地优先的 Web 聊天界面** + **写代码 Agent**（读文件 / 改文件 / 跑命令 / 自校正闭环）。其余平台能力（写作 / 调研 / 桌面 / 移动 / 远程拓扑）一律推迟。

**技术栈（全部拿现成，自研推迟到产品成熟后）**：

| 层 | 选型 | 角色 |
|---|---|---|
| 运行时 | **Bun** | 内核进程、`bun:sqlite`、`bun --hot`、`bun --compile`（P2） |
| 内核 HTTP/SSE | **Hono** ^4 | `POST /api/commands`（C1）+ `GET /api/sessions/:id/events`（C2 SSE） |
| 持久化 | **drizzle-orm** + `bun:sqlite` | 12 张表，事务内 seq 生成 |
| 模型调用 | **Vercel AI SDK（`ai` ~6）** | 仅作**单 turn provider 原语**，收敛进内核单一 adapter |
| MCP | **@modelcontextprotocol/sdk** ^1 | 外部工具接入 + Tool Poisoning 审计 |
| 前端壳 | **Next.js 15 App Router** | RSC 首屏 + `'use client'` 流式 |
| 前端聊天 | **@assistant-ui/react** | `ExternalStoreRuntime`（**非** AISDKRuntime，见 §2.2） |
| 沙箱 | **nono**（拿来即用） | `local-nono` 后端，`localSandbox=true` |

**拓扑**：`arclight serve --repo <path>` 在 `localhost` 同托管【内核 Hono】+【Web UI】+【nono 沙箱】+【SQLite】。本地部署的 Web `CapabilityProfile.localSandbox=true`，鉴权走同源 httpOnly cookie + loopback bearer。运行时目录统一落 `.arclight/`。

**切片主线（slice0 → slice6）**：骨架贯通 → SSE 续接闭环 → 写代码最小核（SEARCH/REPLACE + bash@nono）→ 审批往返 → 检查点 + 编辑健壮性 → RepoMap 上下文 → 反射闭环 + 10 条 golden eval。每个 slice 带可演示 demo 与硬验收。

**总工作量量级**：自研实评 **6000-9000+ 行**，三大主体——
- `queryLoop()` 主循环 **800-1500 行**（agent 心脏，借 pi 双层循环结构 + 钩子面，改 yield ArcEvent 模型，缝 P0 审批/沙箱/epoch/artifact）；
- 前端 `ArcTransport` + reducer + 富渲染 + 审批 UI **1500-3000+ 行**；
- 编码能力链（RepoMap / Edit / Checkpoint / bash+PTY+反射）**2000-2800 行**。
余量为协议层 / 持久化事务 / 沙箱编排 / 工具注册 / 配置 / 测试 harness。

---

## 1. 工程结构与 Monorepo 布局

### 1.1 包边界（Bun Workspaces）

```
@arclight/protocol      类型层(ArcEvent / ArcCommand / ArcAck / ToolMeta / zod schema)  —— 零运行时依赖
@arclight/core          内核(Hono + queryLoop + ToolRegistry + drizzle + nono 编排)
@arclight/client-core   端共享(reducer / SSE 重连 / discovery / useSession)  —— 不 import core
@arclight/web           Next.js(assistant-ui + ArcTransport + 审批 UI)  —— 只经 HTTP/SSE 触达 core
@arclight/cli           CLI 壳(P2 占位,bun --compile 入口)
```

**依赖纪律**：`protocol` 是唯一类型源，所有包 `import type`，零 codegen；`core` 不 import 任何端包；`client-core` 不 import `core`，三环境（Node/Bun/浏览器）可跑；`web` 不直接 import `core` 实现，单向依赖无环。

```
@arclight/protocol  ←(import type)──┬─ @arclight/core
                                    ├─ @arclight/client-core
                                    └─ @arclight/web ←── @arclight/cli(P2)
```

### 1.2 目录树（可直接 mkdir + touch）

```
arclightagent/
├── package.json                    # 根 workspace
├── bun.lock  biome.json  tsconfig.base.json  vitest.workspace.ts
├── .env.example  .gitignore  NOTICE   # NOTICE: Apache-2.0 归因(ai/drizzle/aider/cline 摘录)
│
├── packages/
│   ├── protocol/src/
│   │   ├── events.ts  commands.ts  ack.ts  tool.ts  capability.ts  schema.ts
│   │   └── __tests__/schema.test.ts
│   │
│   ├── core/src/
│   │   ├── server/
│   │   │   ├── app.ts                       # Hono app factory + serveStatic
│   │   │   ├── routes/{commands,events,sessions,health,snapshot,artifacts}.ts
│   │   │   ├── middleware/{auth,requestContext}.ts
│   │   │   └── serverJson.ts                # server.json 读写(chmod 0600 + owner check)
│   │   ├── loop/
│   │   │   ├── query-loop.ts                # ★ 主循环(纯函数 async-generator, 800-1500 行)
│   │   │   ├── provider-adapter.ts          # ★ 唯一 import "ai" 的文件
│   │   │   ├── runner.ts                    # AgentRunner(有状态包装 + 双队列 + AbortController)
│   │   │   ├── compaction.ts                # 单级压缩(借 opencode 模板 ~200 行)
│   │   │   ├── memory.ts  epoch-guard.ts
│   │   ├── tools/
│   │   │   ├── registry.ts                  # 元数据 / 并发分批 / 输出投影
│   │   │   ├── builtin/{readFile,writeFile,applyPatch,bash}.ts
│   │   │   ├── mcp/{adapter,audit,credentialProxy}.ts
│   │   │   └── skill/{loader,hooks}.ts
│   │   ├── coding/                          # ★ 编码能力链(2000-2800 行)
│   │   │   ├── repomap/{tag-extractor,cache,builder,types}.ts
│   │   │   ├── edit/{parser,guard,apply}.ts
│   │   │   ├── checkpoint/{git-operations,tracker}.ts
│   │   │   └── exec/{pty-manager,bash-tool,reflection}.ts
│   │   ├── approval/{service,presets,policy}.ts
│   │   ├── sandbox/
│   │   │   ├── service.ts                    # SandboxService interface: probe/run/cancel
│   │   │   ├── backends/{localNono,dockerFallback,remoteVercel}.ts
│   │   │   └── profiles/p0-local.json        # nono sandbox profile(随代码版本化)
│   │   ├── db/
│   │   │   ├── schema.ts                     # 12 张表(来自 P0 施工图)
│   │   │   ├── client.ts  migrate.ts  appendEvent.ts  sseReplay.ts
│   │   │   └── migrations/
│   │   ├── artifacts/store.ts                # 超限落盘 + spillRef
│   │   ├── usage/tracker.ts  config/load.ts
│   │   ├── serve.ts                          # arclight serve --repo 入口
│   │   └── __tests__/golden/                 # ≥10 golden 编码 case(eval 红线)
│   │
│   ├── client-core/src/
│   │   ├── transport/{stream,sseTransport,httpClient}.ts   # ★ ArcTransport
│   │   ├── store/{reducer,sessionStore}.ts                 # ★ SessionReducer
│   │   ├── spill.ts  command.ts  epoch.ts
│   │   ├── discovery/serverDiscovery.ts
│   │   └── hooks/useArcSession.ts
│   │
│   ├── web/src/
│   │   ├── app/
│   │   │   ├── layout.tsx  page.tsx
│   │   │   ├── chat/[sessionId]/page.tsx                   # RSC 首屏 + bootstrap snapshot
│   │   │   └── api/proxy/[...path]/route.ts                # MVP 透传 localhost Hono
│   │   ├── components/
│   │   │   ├── chat/{ArcRuntimeProvider,ArcThread,MessageParts}.tsx
│   │   │   ├── tools/{ToolCallCard,DiffView,TerminalView,JsonView}.tsx
│   │   │   ├── approval/{PermissionModal,RiskBadge}.tsx
│   │   │   └── session/{SessionList,SessionStatusBar}.tsx
│   │   └── lib/{arcClient,assistantRuntime}.ts
│   │
│   └── cli/src/index.ts                      # commander 骨架占位(P2)
│
└── .arclight/                                # 运行时目录(gitignore)
    ├── arclight.sqlite  server.json(0600)
    ├── audit/<run_id>.jsonl  artifacts/{stdout,diff,snapshot}/
    ├── sandbox/{profiles/p0-local.json,tmp/}  cache/repomap/
    ├── checkpoints/<cwdHash>.git/            # shadow-git 检查点仓
    ├── memory/MEMORY.md  skills/
```

### 1.3 关键配置约定

- **根 `package.json`**：`workspaces: [packages/*]`；脚本 `dev`（并行起 core `bun --hot` + web `next dev`）、`build`、`test`（vitest）、`check`（biome）、`db:generate` / `db:migrate`。
- **`tsconfig.base.json`**：`strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`，`moduleResolution: Bundler`，`composite` references 串联 protocol → core/client-core/web。
- **`biome.json`**：space/2/lineWidth 100，`noExplicitAny: warn`，`noConsoleLog: warn`（web override off），忽略 `db/migrations/`。
- **`.arclight/` gitignore 纪律**：`arclight.sqlite` / `server.json` / `audit/` / `artifacts/` / `sandbox/tmp/` / `cache/` 全忽略；`sandbox/profiles/p0-local.json` 与 `skills/` 可版本化。**`ANTHROPIC_API_KEY` 及任何 OAuth token 绝不写入 `server.json`**——后者仅含进程发现信息（pid/port/origin/token/workspaceId/repoPath），`chmod 0600` + 启动校验 `owner === process.uid`。
- **配置优先级**：`process.env` > `.arclight/config.json`（repo 级）> `~/.config/arclightagent/config.json`（用户级）> 内置默认；zod parse，缺 `anthropicApiKey` 启动即失败并打印缺失字段。

### 1.4 npm 依赖边界（对齐选型清单）

- **core**：`ai`~6 / `@ai-sdk/anthropic` / `hono` / `drizzle-orm` / `@modelcontextprotocol/sdk` / `web-tree-sitter` + `tree-sitter-typescript` / `graphology`(+pagerank) / `diff-match-patch` / `simple-git` / `node-pty` / `shell-quote` / `gray-matter` / `pino` / `zod`^4。
- **web**：`next`^15 / `react`^19 / `@assistant-ui/react` / `tailwindcss`^4；**运行时不引 `ai`**（收敛进内核）。富渲染懒加载增补：`@monaco-editor/react`（diff）/ `@xterm/xterm`（终端，后期）/ `zustand` / `marked`+`shiki`——均在 `FULL_PLATFORM_DESIGN.md §4.1` 选型表内。
- **刻意不引**：`effect` / LangChain·LangGraph / protobuf·buf / AG-UI / CopilotKit / `resumable-stream`·Redis（MVP 只做"刷新不丢"）。

---

## 2. 三大自研件详设

### 2.1 主循环 `queryLoop()`（agent 心脏，800-1500 行）

**设计立场**：顶层是**自研 async-generator `queryLoop()`**，逐 `yield ArcEvent`。`streamText` 被封进 `callProvider()` 原语，只负责"一次 provider 调用 + 流式 part"，**绝非顶层循环**。借 pi `agent-loop.ts`（MIT，可借代码）的纯函数双层循环 + config 钩子面骨架，改造点 = 把 pi 的 `emit(AgentEvent)` 回调换成 `yield ArcEvent`（claudecode generator 范式，仅学不抄），把 pi 的 `streamSimple` 换成 AI SDK `streamText` adapter，把 P0 审批状态机 / SandboxService / epoch 压缩 / artifact spill 缝进 pi 的 `beforeToolCall`/`afterToolCall`/`transformContext`/`shouldStopAfterTurn` 钩子位。

**turn 级状态机**（对外 = `turns.status`）：

```
queued → running → [awaiting_approval ⇄ running] → completed
                                              ↘ failed
running/awaiting_approval ──(interrupt)──→ interrupted
```

**事件流不变式**：loop 是唯一 `seq` 生产者。每个 `yield` 前在**单 SQLite 事务**内 `appendEvent()`（读 `sessions.nextSeq+epoch` → insert `events` → `nextSeq=seq+1`），yield 对象即落库对象，SSE `id:`=`seq`。这保证"yield 顺序 = 持久顺序 = SSE replay 顺序"，epoch 单调，断线 `?afterSeq` 续推一致。

**`streamText` 边界收敛**（选型清单 §0.2 #1 红线）：

```ts
// packages/core/src/loop/provider-adapter.ts —— 唯一 import "ai" 的文件
export async function* callProvider(profile, llmMessages, tools, signal) {
  const res = streamText({
    model: profile.model, system: profile.systemPrefix, messages: llmMessages,
    tools: toAISDKToolSchemas(tools),       // 只给 inputSchema, execute 不交给 AI SDK
    stopWhen: stepCountIs(1),               // ★ 关键: 禁止 AI SDK 自跑工具循环
    abortSignal: signal,
    providerOptions: { anthropic: { cacheControl: profile.cacheBreakpoints } },
  });
  for await (const part of res.fullStream) { /* text-delta / tool-call / reasoning-delta / error → yield */ }
  // 失败不 throw, 编码进 finishReason="error"|"aborted"(对齐 pi StreamFn 契约)
  return { text, toolCalls, finishReason, usage, rawAssistantMessage };
}
```

**纯函数 loop 骨架**（外层 follow-up 队列 / 内层 tool-call + steering）：

```ts
export async function* queryLoop(st: LoopState, deps: LoopDeps): AsyncGenerator<ArcEvent, TurnOutcome> {
  let pending = deps.steering.drain(st.queueMode);
  yield* emit(st, deps, { t:"turn.started", turnId: st.turnId, epoch: st.epoch });
  outer: while (true) {
    let hasMoreToolCalls = true;
    while (hasMoreToolCalls || pending.length > 0) {
      // (A) 压缩边界: shouldCompact → compact → epoch++ → yield context.compacted
      // (B) 注入 pending(steering/follow-up), append-only
      // (C) 单 turn provider 调用(callProvider), message.delta 100-250ms 合批 yield
      // (D) finishReason 分流: aborted→interrupted/return; error→重试或 session.error
      // (E) executeToolBatch: 审批挂起 + nono 执行 + tool_result 回灌
      // (F) prepareNextTurn?(切 model/profile/context)   (G) shouldStopAfterTurn?→completed
    }
    const followUp = deps.followUp.drain(st.queueMode);
    if (followUp.length > 0) { pending = followUp; continue outer; }
    break;
  }
  return { status:"completed" };
}
// emit() = generator helper: appendEvent 落库与 yield 同处, seq 不变式集中守护
```

**工具批执行 + 审批 + 沙箱**（`executeToolBatch`）：解析 `rawArgs → zod 校验`（VALIDATION 走 envelope，不 throw）→ `partition` 分批（**只读并发上限 8，写工具 `bash`/`apply_patch`/`write_file`/`git` 一律串行**）→ 风险分类（`ToolMeta.riskTier` + `shell-quote` 分词 + presets + 黑名单）→ 命中 `ask` 则 `permission.ask` 挂起等 `approve`（`awaiting_approval` 态，不占 provider 调用）→ 经 `SandboxService(local-nono)` 执行，stdout/stderr 合批为 `tool.progress` → 输出投影（>32KB 落 `artifacts`，事件/模型只见 preview + `spillRef`）→ 构造 `tool_result` 回灌。

**可中断**：两条路径汇于同一 `AbortController`——① `ArcCommand interrupt` → `ac.abort()`（透传 `callProvider` abortSignal / nono kill process tree / 解阻审批为 `cancelled`）；② 消费者提前退出 / SSE 断连 → `for await` 的 `break` 触发 generator `finally` 与 `.return()`，`runner.run` 的 `finally` 里 `ac.abort()` 清理在途。

**单级压缩**（P0 不做三级）：`estimateTokens(messages) > effectiveWindow`（`@anthropic-ai/tokenizer` 计数，不自研）→ 在两次 provider 调用之间（不在流式中途）LLM 摘要 → `epoch++` → yield `context.compacted{epoch, summarySeq}`。前端凭此走 epoch-jump/resync 续接。

**10 条关键不变量**（可断言 / 可测）：seq 单调唯一 · epoch 仅压缩边界 +1 · tool_use/tool_result 严格配对 · 审批四终态唯一 · 中断后无悬挂 sandbox run · 消息 append-only(护 cache) · `streamText` 工具执行 0% · envelope 5 键不泄 traceback · 同 session 单 active turn。

**关键坑**：① `streamText` 越界——必须 `stopWhen: stepCountIs(1)`，工具执行 0% 交 AI SDK；② provider adapter 是唯一 import `"ai"` 的模块，用 dependency-cruiser 架构测试守护，隔离 v6→v7；③ 压缩绝不发生在 tool_use/tool_result 未配对完成时，否则配对断裂；④ `callProvider` 不得 throw，失败编码进 `finishReason`。

### 2.2 前端 `ArcTransport` + 渲染 + 审批（1500-3000+ 行）

**Load-bearing 裁决：采用 assistant-ui 的 `ExternalStoreRuntime`，不用 AISDKRuntime + `useChat`。** 理由：ArcEvent 是内核唯一真相源，带 `seq/epoch/resync/spillRef/permission.ask` 等 AI SDK `UIMessage` 协议无原生表达的语义，强行套 AISDKRuntime 会丢 epoch 续接与审批往返。`ai`（Vercel AI SDK）**只在内核侧用**；前端经 `@arclight/client-core` 消费 ArcEvent SSE，投影进 ExternalStore，前端零 `ai` 运行时耦合（只 `import type`）。这是对选型清单 §2.4"把 ArcEvent 桥进 ExternalStore/AISDKRuntime"的**细化裁定而非偏离**。

**分层**：

```
@arclight/client-core(纯 TS, 端无关):
  ArcTransport ── EventStreamManager(SSE 重连/去重/16ms coalesce)
               ├─ SessionReducer(ArcEvent → SessionState, 纯函数)
               ├─ CommandClient(C1 POST submit/interrupt/approve)
               ├─ EpochTracker(乐观锁 baseEpoch / StaleEpochError)
               └─ SpillFetcher(spillRef 按需拉取 + LRU)
↓ ArcRuntimeProvider(薄 React 适配, useExternalStoreRuntime)
@assistant-ui/react: <Thread> → MarkdownText / ToolCallCard / Reasoning
                     + <PermissionModalHost> + <SessionStatusBar>
```

**① ArcTransport / EventStreamManager**：**不用 `EventSource`**（无法设 `Authorization` header），用 `fetch` + `ReadableStream` 手写 SSE 解析（~120 行），可带 cookie 或 bearer，可带 `Last-Event-ID`。
- **16ms coalescing**（reducer 纪律 #1）：`message.delta` 高频 → 按 `requestAnimationFrame` 合批喂 reducer，避免每 token 一次渲染。
- **250ms 退避**（纪律 #2）：起始 250ms 指数 ×2 封顶 8s，加 jitter（`base*(0.5+random*0.5)`）防多标签页同时重连；成功复位；`visibilitychange` → visible 立即重连。
- **seq 单调去重**（纪律 #3）：`dispatch` 入口 `if (seq <= maxSeq) return`，重连 replay 去幻影重复。

**② SessionReducer**（ArcEvent → SessionState，part 级不可变更新）：`message.delta` → `upsertTextPart`（只替换末尾 text part 引用，其余共享，assistant-ui 精准 diff）；`tool.requested/progress/output` → `patchTool`；`permission.ask` → 入 `pendingApprovals`；`context.compacted` → `epoch` 递增；未知 `t` 静默忽略（forward-compat）。

**续接三路径**（EpochTracker，统一在 `connect` 的 409 分支）：

| 路径 | 触发 | 行为 |
|---|---|---|
| ① 增量 replay | `afterSeq` 仍在缓冲 | 200，replay `seq>N`，去重续上 |
| ② buffer-expired 全量 | `afterSeq` 早于缓冲窗 | 409 `{reason,snapshotUrl}` → 拉 `/snapshot` 全量重建 |
| ③ epoch-jump 全量 | epoch 旧且早于最近 `context.compacted` | 409 → 同 ②（cache 前缀已失效，增量无意义） |

**刷新不丢**：首屏 RSC 调 `/api/sessions/:id/snapshot` 拿历史作 `bootstrap` 注入（SSR 不流式），客户端用 `bootstrap.lastSeq` 作 `afterSeq` 起点连 SSE，只续接刷新后的增量。

**③ 工具富渲染**：按 name 推断 `ToolRenderHint`（`apply_patch`/`write_file`→diff，`bash`→terminal，`read_file`→text，未知→json 兜底）。assistant-ui `makeAssistantToolUI` 注册每工具 UI。DiffView = `@monaco-editor/react` `dynamic(ssr:false)` + IntersectionObserver 懒加载（CSP 需 `worker-src 'self' blob:`）。**spillRef 懒拉**：默认只渲染 preview（16KB），用户点"展开完整输出"才拉 `/api/artifacts/:id`（LRU 缓存）。**分期降级**：diff 先 `<pre>` patch 文本→后 Monaco；终端先 `<pre>`+ansi-to-html 流→后 `@xterm/xterm`。

**④ 权限审批往返**：

```
内核 → 风险分类(confirm) → approvals.pending(60s) + emit permission.ask
   → SSE → reducer 入 pendingApprovals → PermissionModal 弹出
   → 用户点 Approve/Deny → POST /api/commands {k:'approve',askId,decision}
   → 内核改 approvals 状态 + 恢复/取消 turn → 后续事件回流
```
UI 纪律（fail-closed）：默认焦点在"拒绝"（误回车不放行）；`high`/`irreversible`/`funds` 红色强警示；未知 `risk`→按 `high`，未知 `cls`→按 `irreversible`。**过期双侧**：内核权威（60s 转 `expired` 发 `APPROVAL_EXPIRED` envelope），前端本地倒计时仅 UX 提示，不作权威判定（避时钟漂移误判）。

**状态管理分工**：会话真相（messages/approvals/epoch/连接态）在 ArcTransport→`useArcSession`；跨组件轻量 UI（modal 开关 / spill 展开）用 `zustand`；**业务状态只读自 client-core，UI store 不复制业务状态**（防双源不一致）。`SessionStatusBar` 只做"成本可观测"展示，**不做 quota 强制/账单**（防过度建设）。

**关键坑**：① 不用 EventSource（带不了 bearer）；② Monaco worker 需 CSP 放行 + 预 bundle worker；③ reducer 必须 part 级不可变更新，否则 assistant-ui 全量重渲染掉帧；④ resync 后必须 `setBookmark(snapshot.lastSeq, snapshot.epoch)` 再 connect。

### 2.3 编码能力链（RepoMap / Edit / Checkpoint / bash+反射，2000-2800 行）

四件统一接 `Tool<In,Out>` 契约 + `ToolErrorEnvelope`（5 键）+ `SandboxService` + `artifacts` + `checkpoints` 表 + `ArcEvent` 流。Python(aider)/VSCode(cline) 来源**仅借算法/机制，TS 重写**，Apache-2.0 落 NOTICE。`AgentLspClient ~300` 与 RRF 向量链已推迟阶段二，本设计不含。

**① RepoMap**（~400 行，借 aider `repomap.py`）：`web-tree-sitter` 抽 Tag → `graphology` MultiDiGraph → pagerank → 二分裁剪到 token 预算 → `bun:sqlite` mtime 缓存。**pagerank 权重逐字对齐 aider 不可改**：mentioned/长标识符 `×10`，私有名 `_` / 过度定义 `×0.1`，chat referencer `×50`，`num_refs→sqrt`，无 ref 的 def 自环 `weight=0.1`，personalize `=100/num_files`。二分裁剪 `mid = floor(maxTokens/25)`，容差 0.15。**坑**：`Parser.init()` 全局仅一次 + Bun `locateFile` 指回 node_modules；每语言独立 `Language.load`；`tree.delete()` 必调（WASM 无 GC）；MVP 只装 `tree-sitter-typescript`；`tags.scm` 复用 aider query。

**② Edit**（~350 行，借 aider `editblock_coder.py`）：`HEAD/DIVIDER/UPDATED` 正则（`<{5,9}`/`={5,9}`/`>{5,9}` 容错）解析 SEARCH/REPLACE → EditGuard（省略号配对检测 + 截断启发）→ fuzzy 阶梯（① 逐字完美 → ② 容忍前导空白 → ③ 省略号配对 → ④ diff-match-patch fuzzy）。**MVP S1 只跑阶梯 1-3**（aider 当前默认关 edit-distance fuzzy，L183 提前 return），fuzzy 作 **S2 显式 opt-in 回退**（`Match_Threshold=0.2` ≈ similarity 0.8，`patch_apply` 全 true 才接受）。失败必抛 envelope（`VALIDATION`，`retry_allowed:true`，含 `find_similar_lines` 0.6 的 "Did you mean"），喂反射循环，**绝不静默乱改**。`apply_patch`（opencode/cline 格式）作第二解析器，产出统一 `EditBlock[]`。

**③ shadow-git 检查点**（~350 行，借 cline `CheckpointTracker`，剥 VSCode）：shadow 仓在 `.arclight/checkpoints/<cwdHash>.git`，`core.worktree` 指向真实工作区（零干扰用户 `.git`）。执行前后各 `commit("pre/post-edit")`，落 `checkpoints(backend:"shadow-git", ref=sha, changed_files, turnId)`。`/undo` → 二分定位 sha → `git reset --hard`（O(log n)）。**剥 VSCode 是真活**：删 `MultiRootCheckpointManager`/folder-lock/gRPC 事件，`vscode.workspace`→`ToolContext.cwd`，`globby`→`Bun.Glob`，`sendCheckpointEvent`→`ctx.emit`。**坑**：嵌套 `.git` 临时禁用（`**/.git`→`.git_disabled`，`finally`+3 次重试复原，否则当 submodule）；依赖宿主 `git` 二进制；`--allow-empty --no-verify`；`commit.gpgSign=false`。nono atomic snapshot 作补充（`backend:"nono-snapshot"`），不互斥。

**④ bash/PTY + 反射闭环**（~300 行，借 aider 反射 + P0 SandboxService）：`bash` 一律经 `SandboxService.run(local-nono)`，**绝不裸跑**；需 TTY 用 `node-pty`，非交互直接 `Bun.spawn`@nono。`bash` 工具 `isConcurrencySafe:false`（串行），`riskTier:"confirm"`，超 512KB 落 spillRef。**反射闭环**（借 aider `run_one`，`max_reflections=3`）：

```
edit(②解析应用) → 失败 did-you-mean 自校正
  → checkpoint post-edit(③)
  → lint(eslint/tsc --noEmit) → test(vitest) 经 nono(④)
  → 读失败 stdout/stderr preview 作 reflected 喂回下一轮 → 最多 MAX 次
  → 收敛 turn.completed / 达上限如实上报(不假装成功)
```
**坑**：Bun + node-pty N-API **第一周强制 smoke test**，不通降级 `Bun.spawn`（丢 TTY）；nono 不可用 → docker-fallback → opt-in 远程 → 拒绝返回 `SANDBOX_UNAVAILABLE`；`interrupt`→`abort()`→node-pty `kill()` + nono `kill_process_tree_on_exit`；lint/test 输出超 32KB 落 artifacts；test 仅 lint 通过才跑（省 token）。

---

## 3. 工程实践与测试 / eval 策略

### 3.1 TDD 与单元/集成分层

vitest 分两套 config：**单元测**（`pool:forks`，30s timeout，v8 coverage 70%/70%/60%）+ **集成测**（`singleFork:true`，120s）。核心可测性设计：`queryLoop()` 用 `async function*` + 依赖注入（`LoopDeps` 注入 `callProvider/registry/approvals/sandbox/compactor/appendEvent`），单元测全 mock，**无需启动 HTTP server，也无需调真实 API**，对 yield 的 ArcEvent 序列做精确快照断言。前端 `SessionReducer` / `foldEventsToMessages` 抽为纯函数独立 vitest；组件层用 MSW mock SSE endpoint。

**queryLoop 可测点**：事件序列快照（`turn.started→message.delta*→tool.requested→permission.ask→tool.output→turn.completed` 顺序 + seq 连续）；审批四分支（allow/deny/expired/cancelled，挂起期间不调 callProvider）；中断传播；`.return()` 提前退出触发 `ac.abort()`；压缩边界（epoch+1，不在流式中途）；错误恢复（retryable ≤MAX）；并发分批（只读 ≤8 / 写串行）；回灌配对；provider 边界隔离（dependency-cruiser 断言唯一 import `"ai"`）。

### 3.2 Golden Eval Harness（CI 红线）

目录：`evals/fixtures/<repo>/`（git submodule 固定 commit）+ `evals/cases/case-NN-*/`（task.json + expected/ + judge.ts）+ `evals/runner/`（harness + sse-client + fixture-reset + report）。**10 条基准 case**：add-function / fix-bug / refactor-extract / add-types / py-fix-import / py-add-docstring / py-type-hints / multi-file-bug / **approval-write（含 blacklist ssh 拒绝链路）** / **checkpoint-restore（interrupt + shadow-git 恢复）**。**每条走 `arclight serve` 真实 HTTP/SSE/tool/nono 链路**（非薄接缝）。

**二级 judge**：确定性 judge（file-exists / ast-parseable / test-pass / no-new-lint-error）作 **CI hard gate**；LLM judge 只写报告不 gate。metrics（inputTokens/outputTokens/cacheReadTokens/costUsdMicros/durationMs/turns）每次写 `results/summary.json`。**通过标准**：MVP 目标 **≥8/10**，发布里程碑 **10/10**，平均 **≤25k tokens/case**，**p95 ≤60s**。

### 3.3 Bun 原生模块 Smoke Test（第一周强制）

`scripts/smoke-test-native.ts` 5 case：

| 测试 | 验证 | 失败回退 | 阻塞 |
|---|---|---|---|
| bun:sqlite | 内置 | N/A | blocking |
| drizzle + bun:sqlite | 12 表建表 | N/A | blocking |
| node-pty | spawn+onData+onExit | `Bun.spawn` pipe(丢 TTY) | **P0 blocking** |
| web-tree-sitter WASM | 解析 10 行 TS | 纯正则粗提取(降精度) | **P0 blocking** |
| nono | `nono run --profile p0-local -- echo ok` | docker-fallback | **P0 blocking** |
| sqlite-vec | 阶段二预探路 | 仅 FTS5 BM25 | non-blocking |

Blocking 项任一 FAIL → `exit(1)` 并输出具体降级方案。

### 3.4 CI / 可观测 / 分支策略

- **三 workflow**：`ci.yml`（PR+main：install → biome check → tsc --noEmit → vitest unit → smoke → integration，20min）；`eval.yml`（push main + manual：完整 10 case，60min，PR 自动 comment）；`license-gate.yml`（拦截 GPL/LGPL/AGPL/EUPL，MPL-2.0 人工豁免 allowlist）。CI 沙箱用 **docker-fallback**（GH Actions 装 nono 复杂，fallback 更稳）。
- **可观测**：`pino`（dev pino-pretty / 生产 NDJSON，serializers 脱敏 token/apiKey/secret）；独立 `auditLog` 写 `.arclight/audit/`，覆盖 14 种安全敏感 AuditEventKind；W3C `traceparent` 经 Hono 中间件注入 ToolContext → ArcEvent.meta（为 OTel 留接口，业务零改动）。
- **分支**：main squash merge，`feat/fix/refactor/chore` 四类，lefthook pre-commit 并行跑 biome check + tsc。

---

## 4. 阶段一详细 WBS 与可演示切片计划

> 每个 slice 独立可演示、可验收；前序 slice 的 demo 是后序的回归基线。slice0-2 是骨架与闭环主线，slice3-6 是能力填充。

### slice0 — 工程骨架贯通 + 健康路由

- **WBS**：建 5 包 + 根配置（package.json/tsconfig.base/biome/vitest.workspace）；`protocol` 落 `events.ts`/`commands.ts`/`ack.ts`/`tool.ts` 骨架 + zod schema + schema.test；`core` 起 Hono `app.ts` + `/health` + `serve.ts`（写 `server.json` 0600）；`db/schema.ts` 12 张表 + `migrate.ts`；**跑 `scripts/smoke-test-native.ts`**（bun:sqlite / drizzle / node-pty / web-tree-sitter / nono）。
- **Demo**：`bun run dev:core` 启动 → `curl /health` 返回 ok；`db:migrate` 建 12 表成功；smoke test 全绿（或明确降级）。
- **验收**：5 blocking smoke 项通过；`biome check` + `tsc --noEmit` 零错；`server.json` 权限 0600 + owner 校验。

### slice1 — SSE 续接闭环（事件流脊柱）

- **WBS**：`appendEvent.ts`（事务内 seq+epoch，`StaleEpochError`）；`routes/events.ts`（C2 SSE replay + heartbeat，409 epoch-jump）；`routes/commands.ts`（C1 submit 落 turn）；`routes/snapshot.ts`；client-core `EventStreamManager`（fetch+ReadableStream + 16ms coalesce + 250ms 退避 + seq 去重）+ `SessionReducer` + `EpochTracker`。
- **Demo**：脚本 POST submit → 内核 yield 一串 mock `message.delta` → `curl -N /events?afterSeq=0` 收到有序帧；**中途 kill 连接重连 `?afterSeq=N` 无缝续上、无重复**。
- **验收**：seq 单调唯一（events 表唯一约束）；reducer 三纪律单测通过；断线重连 replay 一致；409 epoch-jump → snapshot 全量重建。

### slice2 — 写代码最小核（闭环可跑 eval）

- **WBS**：`provider-adapter.ts`（callProvider，`stepCountIs(1)`）；`queryLoop.ts` 主干（turn.started → message.delta → tool.requested → tool.output → turn.completed）+ `runner.ts`；`tools/registry.ts` + builtin `read_file`/`write_file`/`apply_patch`（SEARCH/REPLACE 阶梯 1-3，无 fuzzy）/`bash`；`sandbox/backends/localNono.ts` + `profiles/p0-local.json`；`artifacts/store.ts`（>32KB spill）。
- **Demo**：真实跑——用户说"在 X 文件加一个函数 foo" → Agent 读文件 → apply_patch → bash 跑 `tsc --noEmit` → 返回结果；前端 ExternalStore 流式显示 text + ToolCallCard。
- **验收**：golden case-01（add-function）走真实 HTTP/SSE/tool/nono 链路通过；写工具串行、只读并发 ≤8；bash 经 nono 不裸跑；apply_patch 失败抛 5 键 envelope。

### slice3 — 权限审批往返（fail-closed）

- **WBS**：`approval/service.ts`（pending→allowed/denied/expired/cancelled 状态机，60s TTL）+ `presets.ts`（RiskTier + 黑名单 + shell-quote 分词）+ `policy.ts`；queryLoop 缝审批挂起/解阻；client-core `CommandClient.approve`；web `PermissionModal` + `RiskBadge`。
- **Demo**：Agent 试跑 `rm -rf build/` → 弹审批模态（命令全文 + 风险徽章，焦点在"拒绝"）→ 点批准 → 执行回流；点拒绝 → envelope 回灌 Agent 改方案；**`ssh`/`~/.ssh` 类命中黑名单直接拒绝**。
- **验收**：golden case-09（approval-write + blacklist ssh 拒绝链路）通过；审批四终态唯一；挂起期间不调 callProvider；过期 60s 自动 `APPROVAL_EXPIRED`。

### slice4 — 检查点 + 编辑健壮性

- **WBS**：`coding/checkpoint/{git-operations,tracker}.ts`（shadow-git，剥 VSCode，`core.worktree`，嵌套 git 禁用）+ `checkpoints` 表写入；queryLoop 写操作前后 commit；`/undo` 命令（二分定位 sha + `reset --hard`）；`coding/edit/{guard,apply}.ts`（EditGuard 省略号检测 + diff-match-patch fuzzy 阶梯 4 opt-in）；web `DiffView`（Monaco 懒加载）。
- **Demo**：Agent 改 3 个文件 → 用户 `/undo` 一键回滚到改前；前端 Monaco side-by-side 显示 diff；fuzzy 容忍缩进偏移成功 apply。
- **验收**：golden case-10（checkpoint-restore：interrupt + shadow-git 恢复）通过；`core.worktree` 不干扰用户 `.git`；嵌套 git 复原 finally 重试；fuzzy `patch_apply` 全 true 才接受。

### slice5 — RepoMap 上下文增强

- **WBS**：`coding/repomap/{tag-extractor,cache,builder}.ts`（tree-sitter → graphology pagerank → 二分裁剪 → bun:sqlite mtime 缓存）；queryLoop 进 turn 前注入 RepoMap 上下文；缓存目录 `.arclight/cache/repomap/`。
- **Demo**：在中型 TS 仓提问"哪里定义了 X" → Agent 凭 RepoMap 定位相关符号，无需全量读文件；token 用量明显低于无 RepoMap。
- **验收**：pagerank 权重对齐 aider（单测断言 ×50/×10/×0.1）；二分裁剪命中 token 预算（容差 0.15）；mtime 缓存命中跳过解析；`tree.delete()` 无内存泄漏。

### slice6 — 反射闭环 + 10 条 golden eval + 可观测收口

- **WBS**：`coding/exec/{pty-manager,reflection}.ts`（edit→lint/test→读失败→自校正，`max_reflections=3`）接进 queryLoop；`usage/tracker.ts` + `SessionStatusBar`（成本可观测）；compaction（单级压缩 + epoch yield）；补齐 10 条 golden case + `eval.yml`；`license-gate.yml`；pino + auditLog + traceparent。
- **Demo**：用户说"修复这个 bug" → Agent 改代码 → 跑 test 失败 → 读失败输出自校正 → 再跑 test 通过（≤3 反射）；前端显示 usage + 成本。
- **验收**：**golden ≥8/10**（发布里程碑 10/10），平均 ≤25k tokens/case，p95 ≤60s；反射达上限如实上报不假装成功；CI 三 workflow 全绿。

---

## 5. 里程碑与 P0 完成定义（Definition of Done）

### 5.1 里程碑

| 里程碑 | 对应 slice | 标志 |
|---|---|---|
| **M0 骨架可跑** | slice0-1 | 健康路由 + SSE 续接闭环 + smoke 全绿 |
| **M1 写代码闭环** | slice2-3 | 真实"加函数 / 跑命令 / 审批"端到端 demo |
| **M2 安全网就位** | slice4-5 | 检查点 `/undo` + RepoMap 上下文 |
| **M3 阶段一发布** | slice6 | 反射闭环 + golden 10/10 + CI 全绿 |

### 5.2 Definition of Done（阶段一交付硬指标）

1. **功能**：`arclight serve --repo <path>` 一条命令拉起 localhost 内核 + Web + nono + SQLite；Web 聊天可读文件 / 改文件 / 跑命令 / 自校正闭环。
2. **正确性**：golden eval **≥8/10**（发布 10/10），全部走真实 HTTP/SSE/tool/nono 链路；queryLoop 10 条不变量全部有断言测试。
3. **续接**：断线 / 刷新 / epoch-jump 三路径续接无缝、无重复、不丢历史。
4. **安全**：写 / 高危命令必经审批（fail-closed，焦点拒绝）；黑名单（`rm -rf ~` / `~/.ssh` / `docker.sock` / `sudo`）直接拒绝；bash 一律经 nono 不裸跑；`ANTHROPIC_API_KEY` 不入 `server.json`；envelope 5 键不泄 traceback。
5. **可回滚**：shadow-git 检查点 + `/undo` 一键回任意时刻，零干扰用户 `.git`。
6. **工程质量**：`biome check` + `tsc --noEmit` 零错；coverage 70%/70%/60%；CI 三 workflow 全绿；license-gate 无 GPL/LGPL/AGPL。
7. **可观测**：pino 结构化日志 + auditLog + usage 成本展示（不做 quota 强制）。

### 5.3 Demo 场景（发布验收剧本）

> **「在一个真实 TS 仓里修复一个有测试覆盖的 bug」**：
> ① `arclight serve --repo ~/proj` → 浏览器自动开 Web；② 输入"`auth.ts` 的 token 校验有 bug，修一下并确保测试通过"；③ Agent 用 RepoMap 定位 → 读文件 → checkpoint pre-edit → apply_patch（Monaco diff 实时显示）→ 跑 `vitest`（终端流实时回显）→ **失败 → 读失败输出自校正 → 再跑通过**；④ 中途 Agent 想 `rm` 临时文件 → 弹审批 → 用户批准；⑤ 完成后用户 `/undo` 回滚验证 → 再 redo；⑥ 刷新浏览器 → 历史无缝恢复。全程 usage / 成本可见。

---

## 6. 构建期风险登记

| # | 风险 | 等级 | 表现 | 缓解 |
|---|---|---|---|---|
| R1 | **Bun + node-pty N-API** | 高 | spawn/onData 在 Bun 下崩或不返数据 | 第一周 smoke 强制；FAIL → `Bun.spawn` pipe（丢 TTY，交互终端降阶段二）；bash 主路不依赖 TTY |
| R2 | **Bun + web-tree-sitter WASM** | 高 | `Parser.init()` locateFile 失败 / `tree.delete` 泄漏 | smoke 强制；FAIL → 纯正则粗提取（降精度，不阻塞主链路，RepoMap 是增强非必需） |
| R3 | **nono 成熟度** | 中高 | 安装复杂 / profile 不兼容 / CI 跑不起 | 三级回退 `local-nono → docker-fallback → opt-in 远程`，不可用返回 `SANDBOX_UNAVAILABLE`；**CI 直接用 docker-fallback** |
| R4 | **queryLoop 被低估为薄接缝** | 高 | 误把 `streamText` 当顶层循环，审批/中断/压缩缝不进 | 守住 800-1500 行预算；`stepCountIs(1)` + dependency-cruiser 断言唯一 import `ai`；10 条不变量先写测试 |
| R5 | **前端富渲染膨胀首屏** | 中 | Monaco/xterm 进首屏 bundle，掉帧 | `dynamic(ssr:false)` + IntersectionObserver 懒加载；MVP 先 `<pre>`/JsonView 降级；CSP `worker-src 'self' blob:` |
| R6 | **SSE 续接 / 幻影重复** | 中高 | 重连丢帧 / 重复渲染 / epoch 错乱 | reducer 三纪律（16ms/250ms/seq 去重）单测；三续接路径 golden 回归；seq 表唯一约束兜底 |
| R7 | **剥 VSCode（cline checkpoint）余量** | 中 | folder-lock/gRPC/multi-root 删不干净 | 单 workspace 单进程简化；嵌套 git 复原 finally+重试；依赖宿主 `git`（CI 预装） |
| R8 | **aider 算法移植偏差** | 中 | pagerank 调参 / 二分裁剪 / fuzzy 误改 | 权重逐字对齐 + 单测断言；fuzzy 默认关（S2 opt-in，`patch_apply` 全 true 才接受） |
| R9 | **AI SDK v6→v7 breaking** | 低中 | `streamText` 接口变动 | 收敛进单一 `provider-adapter.ts`，锁 `ai` minor，隔离爆炸半径 |
| R10 | **自研量超预算** | 中 | 6000-9000 行膨胀拖期 | 切片可演示交付，slice5/6（RepoMap/反射）可作为弹性范围；LSP/向量链已推迟阶段二 |

---

## 7. 与现有 5 份文档的衔接索引

| 主题 | 权威文档（绝对路径） | 本方案落点 |
|---|---|---|
| 架构总览 / 平台分层 | `/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md` | §0 执行摘要、§1 包边界 |
| 协议契约（ArcEvent/Command/Ack）、Web 端、横切 | `/Users/fsm/project/arclightagent/FULL_PLATFORM_DESIGN.md`（§2 协议 / §4.1 Web / §5 横切） | §2.1 主循环事件流、§2.2 前端、§5 DoD |
| 数据模型 12 表 / 工具契约 / 审批状态机 / 续接语义 / 拓扑鉴权 | `/Users/fsm/project/arclightagent/research/P0-基础三件套-拓扑-数据模型-工具契约.md` | §1.2 db/schema、§2.1 appendEvent、§2.2 续接三路径、§2.3 编码件接线 |
| 全栈选型 / 许可证 / 自研量 / 第一周 smoke | `/Users/fsm/project/arclightagent/research/拿来即用-全栈选型清单.md`（§0.2 / §2.4 / §3 / §5） | §0 栈表、§1.4 依赖、§2 三大件自研量、§3.3 smoke |
| nono 沙箱 / SandboxService / 三级回退 | `/Users/fsm/project/arclightagent/research/P0-沙箱方案-拿来即用.md` | §1.2 sandbox 目录、§2.3 bash@nono、§6 R3 |
| 可借代码（MIT/Apache，仅借不抄闭源） | `pi/packages/agent/src/agent-loop.ts`（双层循环 + 钩子，MIT，可借）；`claudecode/query.ts`（generator 范式，闭源，仅学）；`aider/aider/`（repomap/editblock，Apache）；`cline/`（CheckpointTracker，Apache，剥 VSCode） | §2.1 主循环、§2.3 编码链；归因落 `NOTICE` |
| 工程实践 / 测试 / eval | `/Users/fsm/project/arclightagent/research/工程实践与测试eval策略.md` | §3 全节 |

**一致性声明**：本方案所有契约字段（ArcEvent / ArcCommand / ArcAck / 5 键 envelope / `cls` 四分类）、seq/epoch/resync 语义、spillRef（>32KB / preview 16KB）、审批四终态、拓扑鉴权（localhost 同托管 + httpOnly cookie + loopback bearer + `localSandbox=true`）、现成 vs 自研边界（自研实评 6000-9000+ 行，主循环与前端非薄接缝）均与上述 5 份文档逐条对齐，未另起炉灶。`ExternalStoreRuntime`（而非 AISDKRuntime）是对选型清单 §2.4 的**细化裁定**——把 `ai` 收敛进内核 adapter 层，正是选型清单反复强调的红线。