蓝图已经把本子系统的定调说得很清楚。我已掌握全部所需信息,直接产出选型清单。

---

# arclightagent · 会话持久化 + 流式协议(SSE/resumable) + 前端 AI UI 子系统 —— 拿来即用选型清单

> 总原则:现阶段最大化复用现成成熟实现,自研只留薄接缝;凡能拿现成的就拿现成的。
> 与蓝图一致:阶段一 MVP = Web 单端 + 写代码单能力 + 单用户 + 本地 SQLite;resumable(Redis)/durable 输入/AG-UI/OpenAPI→SDK 自动生成 **全部后置**。
> 库名/项目名/许可证/URL 保留原文。

---

## A. DB / ORM(会话持久化的存储底座)

### A1. Drizzle ORM + Bun 内置 SQLite

1) **直接采用的现成方案**
- **`drizzle-orm` + `drizzle-kit`**(npm,Apache-2.0,https://orm.drizzle.team)。提供:TS-first schema 定义、类型安全查询、`drizzle-kit` 迁移生成/执行(migrations 纪律)、`bun:sqlite` 驱动一等支持。
- **存储引擎**:Bun 内置 `bun:sqlite`(MVP 单用户本地;无需额外 npm 依赖)。需向量检索时加 `sqlite-vec`(MIT,opensquilla 同款),需词法检索用 SQLite 自带 FTS5。
- **从参考仓的复用判断**:opencode 用的正是 `Drizzle + effect-sqlite`,cline SDK 也走 SQLite——但它们的持久层都深绑各自框架(opencode 绑 Effect,cline 绑自有 SDK),**不可直接搬代码**;此处直接装 npm 官方 Drizzle 即可,无需从仓里借。

2) **集成成本**:拿来即用(schema + migrate 是标准用法)。

3) **成熟度与风险**:生产可用,生态最大。坑:Drizzle 迁移在分支并行开发时易产生迁移冲突,需纪律;`bun:sqlite` 与 `better-sqlite3` API 有差异,选定 `bun:sqlite` 后不要混用。

4) **最小自研接缝**:① 会话表 schema(session / message / event / tool_result),**第一天就加 `tenant_id` 字段建模**(蓝图硬性要求,即便单用户也预留);② **乐观锁 `epoch` 字段 + `StaleEpochError` 并发控制**——这是从 opensquilla `session/storage.py` **借设计、用 TS 重写**(Python 代码不可搬,但模式简单,自研成本极低)。

5) **现在不要自研 / 后置**:durable 输入模型(steer/queue + advisory wake,opencode `session_input` 那套)、会话树 fork/branch 非线性历史、cli replay、Postgres + RLS 多租户隔离——**全部后置到阶段二/阶段五**。MVP 只要"会话能存、能恢复列表、能继续对话"。

---

## B. 流式协议(SSE / resumable / 断线恢复)

### B1. Vercel AI SDK(`streamText` + `useChat`)—— 流式主干

1) **直接采用的现成方案**
- **`ai`(Vercel AI SDK)**(npm,Apache-2.0,https://ai-sdk.dev)。后端 `streamText` 产出 SSE/UIMessage 流;前端 `useChat` 自带流式渲染、`stop`、`reload`、工具 UI、结构化输出。**蓝图主选 v6**(`streamText/useChat`);v5 已稳定,v6 跟进时留意 breaking changes。
- 提供:provider 抽象(配合各家 provider 包)、agentic loop 控制(`stopWhen`/`prepareStep`)、UIMessage 流协议——前后端一体,网页优先 agent 的默认起点。

2) **集成成本**:拿来即用(后端 `streamText`→`toUIMessageStreamResponse()`,前端 `useChat` 直接消费)。

3) **成熟度与风险**:生产级,生态最大。坑:**SSE 无应用层 backpressure**(需 per-session token budget 限流);**长流在 LLM 思考间隙会被代理/LB 在 60–120s 空闲超时切断,必须每 15–30s 发心跳注释行**(这是自研接缝,见 B4)。

4) **最小自研接缝**:心跳行注入;token budget 限流;把内核 async-generator 主循环的事件桥接成 AI SDK 的 UIMessage 流(薄 adapter)。

5) **后置**:`useChat` 的 `resume` 选项要等 B3 的 resumable 后端就绪后才接(阶段二)。

### B2. `@microsoft/fetch-event-source` —— SSE 客户端(非 useChat 路径时)

1) **直接采用的现成方案**:**`@microsoft/fetch-event-source`**(npm,MIT,https://github.com/Azure/fetch-event-source)。比原生 `EventSource` 强:支持 POST + 自定义 header(带鉴权 token)、可读 `Last-Event-ID`、页面隐藏时不断流、可自定义重连。

2) **集成成本**:轻度封装。

3) **成熟度与风险**:成熟稳定,但**仓库久未更新**(功能足够、无活跃维护);浏览器侧够用,Node/Bun 服务间转发需注意。

4) **最小自研接缝**:重连退避 + `Last-Event-ID` 续传的封装。

5) **何时用 / 后置**:MVP 前端走 `useChat` 时**用不到它**——它是阶段四多端(CLI/桌面/插件壳)复用同一 SSE 端点、或自定义事件类型超出 useChat 表达力时的备选。MVP 可不引。

### B3. `vercel/resumable-stream` —— 断线恢复(**阶段二,不在 MVP**)

1) **直接采用的现成方案**:**`resumable-stream`**(npm,@vercel,MIT,https://github.com/vercel/resumable-stream)。pub/sub + 持久化 offset 把"生成"与"消费"解耦,按 token offset 精确续传,配 Redis。标准接线:`useChat({ resume })` + `GET /api/chat/[id]/stream`。

2) **集成成本**:需较多缝合(引入 Redis 依赖 + active-stream 生命周期管理)。

3) **成熟度与风险(诚实标注坑)**:**看似拿来即用、实则 bug 密度最高的特性**。坑:① 引入 Redis 运维面;② 谁是 active stream / 何时清理 `activeStreamId` 要自己管,`onFinish` 必须可靠清理否则出现"幽灵活跃流";③ 断线 replay 去重 + epoch 冲突合并 UX 复杂。**蓝图明确:这是 bug 密度最高处,不压最早期。**

4) **最小自研接缝**:active-stream 表 + 清理逻辑 + replay 去重。

5) **现在不要自研 / 后置**:**MVP 不引 Redis、不引 resumable-stream**。MVP 的"流恢复"只做**最朴素「刷新不丢」版**——服务端把当前流事件写进 SQLite 的 event 表(本就要持久化),刷新后从 DB 拉已落盘事件 + 重连续推。完整 resumable(Redis)、Durable Streams、Upstash Realtime 全部**后置到阶段二**。

---

## C. 前端 AI UI(直接用哪一个)

### C1. 直接采用:**assistant-ui** + **Vercel AI SDK UI**(`useChat`)

1) **直接采用的现成方案**
- **`@assistant-ui/react`**(npm,MIT,https://www.assistant-ui.com)。Radix 风格可组合 primitives,自带流式/自动滚动/重试/附件/markdown/代码高亮/无障碍;**`@assistant-ui/react-ai-sdk` 适配器直接对接 Vercel AI SDK**,与 B1 天然一体。50k+/月下载,生态最广,Thoughtworks 雷达收录。
- 运行时选 **`AISDKRuntime`(基于 useChat)**:状态由 AI SDK 持有,最省接线;复杂状态需求再换 `ExternalStoreRuntime`。

2) **集成成本**:拿来即用(assistant-ui primitives + AISDKRuntime + 后端 `streamText` 三件套接好即可出聊天 UI)。

3) **成熟度与风险**:生产级。坑:thread 云持久化/自建 DB thread 列表需自己接(但本项目持久化在内核 DB,正好自己控);primitives 可组合性强但定制深度 UI 有学习曲线。

4) **最小自研接缝**:工具调用的自定义渲染(写代码场景的 Monaco diff、终端 iframe)+ 权限对话框 UI——这些是业务 UI,不是轮子。

5) **后置**:语音、generative UI 动态组件后置。

### C2. 不直接采用(对比说明,避免选错)

- **CopilotKit / AG-UI**:CopilotKit(MIT)是 AG-UI 协议制定方,功能强(CoAgents/HITL/Generative UI),但**三层架构(前端 + 自托管 Copilot Runtime + Python SDK)对 MVP 偏重**,且会把 AG-UI 语义引入内核。**蓝图明确:AG-UI 仅作可选适配器,不绑架内核语义,后置到阶段二/四。** MVP **不引 CopilotKit、不引 AG-UI**。
- **opencode/cline 的前端**:opencode 是 SolidStart、cline 是 VSCode webview + gRPC-over-postMessage——技术栈不匹配(本项目 Next.js),**只借"server/client 分离 + SSE coalescing"设计思想**(16ms 帧 coalescing / 250ms 重连,蓝图已采纳),**不搬代码**。

---

## D. 协议 / SDK 生成(内核 ↔ 表层)

### D1. Hono —— 内核 HTTP/SSE server 框架

1) **直接采用的现成方案**:**`hono`**(npm,MIT,https://hono.dev)。轻量、Bun/Edge 一等公民、TS 原生;`hono/streaming` 的 `streamSSE` helper 直接产 SSE。蓝图主选后端框架。

2) **集成成本**:拿来即用。

3) **成熟度与风险**:生产级,Bun 生态首选。低风险。

4) **最小自研接缝**:把内核 async-generator 事件 → `streamSSE` 的桥接 + 心跳行。

### D2. openapi-typescript —— SDK 生成(**第二端才上,不在 MVP**)

1) **现成方案**:**`openapi-typescript` / `hono-openapi`(或 `@hono/zod-openapi`)**(npm,MIT)。Hono 产 OpenAPI spec → `openapi-typescript` 生成 TS 类型/client。

2) **集成成本**:需较多缝合。

3) **成熟度与风险(关键坑)**:**OpenAPI 对 SSE/流式事件表达力弱**——request/response 体能自动生成,但**流式事件 schema(token delta / 工具进度 / 权限请求等事件类型)OpenAPI 表达不了,这部分 codegen 不可避免要自研**(opencode 正是自建流式 codegen 才做到类型化多端)。所以"SDK 自动生成"**不是免费的**,需预留自建流式事件 codegen 预算。

4) **最小自研接缝**:**自建流式事件 codegen**(把内核事件的 discriminated-union TS 类型生成给各端)——这是范围内"不可避免的自研接缝",但只是 codegen,不是轮子。

5) **现在不要自研 / 后置**:**MVP 单 repo 直接共享 TS 类型,零 codegen**(Web 是唯一端,前后端同 repo,`import type` 即可)。OpenAPI→TS SDK 自动生成 + 自建流式 codegen **推迟到阶段五真有第二端(CLI/桌面/插件)时再做**。cline 的 gRPC-over-postMessage(protobuf,buf 生成)、codex 的 SQ/EQ + ts-rs **均过重,不采用**。

---

## 阶段一(Web + 写代码)MVP 最小依赖集

> 真正需要的最少现成件 —— 能装就装,不自研轮子:

| 用途 | 现成件(npm / 来源) | 许可证 | MVP 是否必需 |
|---|---|---|---|
| ORM + 迁移 | `drizzle-orm` + `drizzle-kit` | Apache-2.0 | ✅ |
| SQLite 引擎 | `bun:sqlite`(Bun 内置,零依赖) | — | ✅ |
| 流式后端 | `ai`(Vercel AI SDK,`streamText`) | Apache-2.0 | ✅ |
| 流式前端 | `ai/react` 的 `useChat` | Apache-2.0 | ✅ |
| AI 聊天 UI | `@assistant-ui/react` + `@assistant-ui/react-ai-sdk` | MIT | ✅ |
| 内核 HTTP/SSE server | `hono`(+ `hono/streaming` 的 `streamSSE`) | MIT | ✅ |
| 内核↔Web 协议 | **单 repo 共享 TS 类型(`import type`),零 codegen** | — | ✅(不引任何 codegen) |

**MVP 明确不引(后置)**:`resumable-stream` + Redis(阶段二)、`@microsoft/fetch-event-source`(阶段四多端壳)、`sqlite-vec`/FTS5 向量记忆(记忆 archival 后置)、`openapi-typescript` + 自建流式 codegen(阶段五第二端)、CopilotKit / AG-UI(阶段二/四可选适配器)、Postgres + RLS / durable 输入 / fork 历史树 / cli replay(阶段二/五)。

**MVP 仅有的自研接缝(都不是轮子)**:① 会话表 schema(含 `tenant_id` + `epoch` 乐观锁,借 opensquilla 设计、TS 重写);② 内核 async-generator 事件 → AI SDK UIMessage 流 / Hono `streamSSE` 的桥接 adapter;③ SSE 心跳行(15–30s)+ per-session token budget 限流;④ 最朴素「刷新不丢」流恢复(从 SQLite event 表拉已落盘事件 + 重连续推)。