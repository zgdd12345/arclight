Hi Alba,

This is a synthesis task — combining the eight subsystem selection lists already provided in the prompt into one master document. I have all the material I need inline; no file exploration is required. Let me produce the master Markdown directly.

---

# arclightagent 全栈"拿来即用"选型主清单

> 总原则(用户明确指令):「尽量使用现有的工作,不自研,等我们的产品成熟之后再自研。」
> 现阶段最大化复用现成成熟实现(库/工具/SDK/可复用代码),自研只留"薄接缝";凡能拿现成的就拿现成的,把自研推迟到产品成熟后。
> 项目:arclightagent 全平台个人 AI Agent(写代码/写文章/调研/computer use/日常规划),网页优先,内核 TS/Bun。
> MVP = Web 单端 + 写代码单能力 + 单用户 + 本地沙箱。沙箱子系统已单独定案,本清单引用不重复论证。

---

## 0. 执行摘要

### 0.1 整体"拿现成 vs 自研"占比判断

按"代码量"与"风险面"两个维度评估,arclightagent 的全栈构成大致是:

- **约 85% 拿现成**:provider 调用、流式、MCP、schema、编辑器、文档生成、浏览器自动化、云浏览器、搜索抓取、cron、推送、向量/全文检索、ORM、PTY、git、tree-sitter、LSP——这些**核心能力件全部由成熟 npm 库/SDK/二进制承载**,几乎零自研。
- **约 15% 自研薄接缝**:agent 主循环、工具元数据调度、MCP 安全审计 + 凭证代理、Skill/Hook 加载器、压缩、记忆混合检索、CitationAgent、ResearchOrchestrator、RepoMap、Plan/Act、心跳协调、各端 transport 桥接、截图通道、权限审批。**这 15% 没有一行是"造轮子",全部是把现成件粘合进内核事件模型的胶水**。

**一句话**:本项目几乎没有"可整体安装的 agent 框架"能用(也刻意不用 LangGraph/Mastra),但**每一个底层能力件都有成熟现成实现**;自研只发生在"内核 async-generator 事件模型 ↔ 现成库"的接缝处。

### 0.2 最该警惕的"伪轻量"(看似拿来即用,实则要大量缝合)

按踩坑严重度排序:

| # | "伪轻量"陷阱 | 真相 | 正确姿势 |
|---|---|---|---|
| 1 | **Vercel AI SDK 的 "agent 循环"** | `streamText({ stopWhen })` 只是单 turn 工具循环原语,**不提供可中断/压缩边界/steering 队列/per-turn 重建**。被 marketing 包装成"agent 框架"。 | 当作 turn 原语,顶层 async-generator 主循环自研(约 300-400 行) |
| 2 | **resumable-stream(断线恢复)** | **本子系统 bug 密度最高处**:引 Redis 运维面、active-stream 生命周期/清理/幽灵流、replay 去重 + epoch 合并 UX 复杂。 | MVP **不引**;只做"刷新不丢"最朴素版(SQLite event 表 + 重连续推),Redis 版后置阶段二 |
| 3 | **open_deep_research / GPT-Researcher / browser-use** | 看似"现成 deep research / 浏览器自动化",**全是 Python**,引入 = Python sidecar + 跨语言边界。 | 仅借设计,TS 侧用 Vercel AI SDK 复现 pipeline(~500 行);浏览器用 TS 原生 Stagehand |
| 4 | **OpenAPI → TS SDK 自动生成** | OpenAPI **对 SSE/流式事件 schema 表达力弱**,流式 codegen 不可避免要自建,"自动生成"不是免费的。 | MVP 单 repo 直接 `import type`,零 codegen;第二端时再自建流式 codegen |
| 5 | **Auth.js (NextAuth) v5** | 长期 beta、文档 v4/v5 混杂、callback/session 策略 + Drizzle adapter 接线需较多调试。 | MVP 用 loopback bearer token(零库);多端起再上 Auth.js |
| 6 | **权限审批 policy 引擎(OPA/Cedar)** | 都不是为"agent 命令审批 + 渐进信任 allowlist + turn 内提权"设计,硬套更重。 | 借 codex/opensquilla 设计,TS 薄自研 presets + 黑名单 |
| 7 | **OmniParser v2(视觉 grounding)** | **唯一无 TS SDK 的组件**,Python 模型,需自建 sidecar 或 ONNX 导出。 | 仅作 AX-tree 失效的兜底,P3 才引;MVP/P3 主路径不需要 |
| 8 | **Postgres RLS 多租户** | policy 写错 = 静默跨租户泄漏(高危);连接池下需 `SET LOCAL` + 事务,否则串租户。 | MVP 不开 RLS,只全表 `tenant_id` 建模;RLS 后置阶段五 |
| 9 | **LiteLLM Proxy 版本迭代** | 一年 1349+ 版本,配置格式偶变,路由失败是静默 fallback。 | 锁定小版本;MVP 单 provider 时可不起 Proxy,AI SDK 直连 Anthropic |
| 10 | **MV3 Service Worker 持久连接** | SW 30s 休眠,不可维持传统持久连接。 | `chrome.alarms` 唤醒 + WS keepalive + 状态持久化恢复 |

---

## 1. 全栈选型总表

| 子系统 | 直接采用的现成方案 | 许可证 | 集成成本 | 仅保留的自研接缝 | 成熟度/风险 |
|---|---|---|---|---|---|
| **沙箱(已定案)** | 本地 nono / 远程 Vercel Sandbox·E2B SDK / 浏览器 Pyodide / Docker 兜底 | 各自 | 已定案 | (本清单不重复) | 已定案 |
| **内核主循环** | `ai`(Vercel AI SDK,单 turn 工具原语)+ `@anthropic-ai/sdk`(直连) | Apache-2.0 / MIT | 部分采用 | async-generator `queryLoop()`(~300-400 行,借 pi MIT 代码) | AI SDK 生产可用;循环必须自研,别被"agent 框架"误导 |
| **工具/schema** | `zod` v4 + AI SDK `tool({inputSchema,execute})` | MIT / Apache-2.0 | 拿来即用 | `Tool<In,Out>` 元数据 + 只读并发/写串行分批 + 超限落盘(~100 行) | 生产可用;元数据调度 AI SDK 全不管 |
| **MCP** | `@modelcontextprotocol/sdk`(客户端+服务端双向) | MIT | 拿来即用~轻度封装 | MCP→内核工具适配器 + 白名单审计 + 凭证沙箱外代理 | 行业标准(97M 月下载);spec 迭代快、Tool Poisoning 安全自建 |
| **Skills/Hooks** | SKILL.md 规范(agentskills.io)+ `gray-matter` + `jiti`(后置) | 开放规范 / MIT | 轻度封装 | Skill 加载器(1% 预算注入)+ Hooks 分发(2-3 事件) | 无运行时库;Skill/Hook = 任意代码执行面,需 ssrfGuard |
| **压缩** | 无 npm 库;`@anthropic-ai/tokenizer` / `tiktoken` 计 token | Apache-2.0 / MIT | 轻度封装 | 单级压缩 `compaction.ts`(借 opencode MIT 模板代码,~200 行) | opencode 模板生产可用;摘要有损不可逆,留 JSONL 回溯 |
| **长期记忆** | **MVP 不引**;MEMORY.md 文件(~30 行)。阶段四评估 mem0/Zep/Letta | MIT / Apache-2.0 | MVP 拿来即用 | MEMORY.md 读写 + session 注入(~30 行,0 依赖) | MVP 不需 archival;阶段四 A/B 再选 |
| **检索** | `sqlite-vec`(向量)+ SQLite FTS5(BM25,内置)+ AI SDK `embed()` / `@xenova/transformers` | Apache-2.0/MIT / Public Domain / Apache-2.0 | 拿来即用 | sqlite-vec+FTS5+RRF 融合(借 opensquilla 设计,~150 行) | 生产可用;百万级向量后不如 Qdrant,单用户够用 |
| **Provider 路由** | `ai` + `@ai-sdk/anthropic`(主力);可选 LiteLLM Proxy / `@openrouter/ai-sdk-provider` / Ollama | Apache-2.0 / MIT | 拿来即用~轻度封装 | `applyThinkingLevel()`(借 pi MIT 的 ThinkingLevel,~20 行)+ cache 断点排序(~10 行) | 生产可用;LiteLLM 版本迭代快需锁版本;OpenRouter 数据留存需配置 |
| **会话持久化** | `drizzle-orm` + `drizzle-kit` + `bun:sqlite` | Apache-2.0 / 内置 | 拿来即用 | 会话表 schema(含 `tenant_id`+`epoch` 乐观锁,借 opensquilla 设计 TS 重写) | 生产可用;迁移并行冲突需纪律 |
| **流式协议** | `ai`(`streamText`+`useChat`)+ `hono`(`streamSSE`);备选 `@microsoft/fetch-event-source` | Apache-2.0 / MIT | 拿来即用 | 内核事件→UIMessage 流桥接 + 心跳行(15-30s)+ token budget 限流 + "刷新不丢"恢复 | 生产可用;SSE 无 backpressure、长流空闲超时需心跳 |
| **前端 AI UI** | `@assistant-ui/react` + `@assistant-ui/react-ai-sdk`(AISDKRuntime) | MIT | 拿来即用 | 工具调用自定义渲染(Monaco diff/终端)+ 权限对话框 UI | 生产可用;深度定制有学习曲线;**不引 CopilotKit/AG-UI** |
| **认证** | **MVP loopback bearer token**(零库);多端起 `next-auth` v5 或 Clerk | — / ISC·MIT / 商业 | 纯接缝 / 轻度封装 | 认证中间件解出 `userId`+`tenantId` + loopback token pid 绑定 | Auth.js v5 长期 beta、接线需调试 |
| **密钥** | `@napi-rs/keyring`(OS keychain);多租户 Infisical/Vault/云 KMS | MIT / MIT·BUSL·商业 | 拿来即用 / 需缝合 | 沙箱外凭证代理(按动作签名放行)+ `SecretStore` 统一接口 | `@napi-rs/keyring` Bun 友好;`keytar` 维护停滞+gyp 风险 |
| **计费计量** | AI SDK `result.usage` + 自建 `usage` 表 + quota;成熟期 OpenMeter+Stripe | Apache-2.0 / Apache-2.0·MIT | 拿来即用 / 轻度封装 | usage 埋点 + quota 强制 + per-subagent 成本归因(借 opensquilla `cost_rollup`) | SDK usage 零风险;多代理 ~15× token 放大需归因 |
| **可观测** | `langfuse` + `pino` + OTel JS(`@opentelemetry/*`)+ `prom-client`(后置) | MIT / MIT / Apache-2.0 | 拿来即用 / 轻度封装 | W3C traceparent 跨端透传 + 统一审计去向 | 生产可用;OTel auto-instrument 在 Bun 兼容性需验证,只用手动 span |
| **Eval** | **Vitest** 写 ≥10 golden 编码 case;promptfoo 后置 | MIT / MIT | 拿来即用 | 10 条 golden case 输入/期望/校验(项目专属数据) | 阶段一一等交付不可省;红线:无 eval 不谈自动降级路由 |
| **多租户** | `drizzle-orm` + 全表 `tenant_id` 建模;Postgres RLS 后置 | Apache-2.0 | 拿来即用 / 需缝合 | tenant_id 下沉数据层 + per-tenant 沙箱隔离编排 | RLS 写错=静默泄漏,MVP 不开 RLS |
| **权限审批** | **薄自研** presets + 命令黑名单 + `shell-quote` 分词 | — / MIT | 轻度封装 | approval presets×profile + 渐进 allowlist + RiskTier×渠道 fail-closed + SSE 审批模态 | 最像有现成实则必须自研;借 codex/opensquilla 设计 |
| **编码:AST** | `web-tree-sitter` + `tree-sitter-{typescript,python}` | MIT | 拿来即用 | `TagExtractor`(def/ref 收集,~150 行) | 生产可用(Neovim/VSCode/Cursor 在用) |
| **编码:RepoMap** | `graphology` + graphology pagerank(无现成 npm RepoMap 库) | MIT | 需较多缝合 | `RepoMapBuilder`(tags→图→pagerank→二分裁剪,~400 行,借 aider 算法) | 算法 aider 多年生产;TS 移植新实现需自测 |
| **编码:编辑格式** | SEARCH/REPLACE(借 aider)+ `diff-match-patch` + `diff`;apply_patch 可搬 opencode/cline | Apache-2.0 / Apache-2.0 / BSD | 轻度封装 / 可直接复用 | `EditBlockParser` + `EditGuard`(行数验证+省略号检测,~280 行) | 生产可用;Codex `.lark` 语法不可直接用 |
| **编码:LSP** | `vscode-languageserver-protocol` + `vscode-jsonrpc`;LS 本体 `typescript-language-server`/`pyright` | MIT | 轻度封装 | `LspManager` + `AgentLspClient`(~300 行) | 生产可用;`vscode-languageclient` headless 有坑,用 protocol+jsonrpc 更薄 |
| **编码:shadow-git/git** | `simple-git`(借 cline CheckpointTracker) | MIT / Apache-2.0(cline) | 轻度封装 | `CheckpointTracker`(剥 VSCode 依赖,~250 行)+ `GitService`(~100 行) | `simple-git` 800万周下载;依赖系统 git 二进制 |
| **编码:PTY** | `node-pty` | MIT | 拿来即用 | `PtyManager`(生命周期+输出截断,~150 行) | 生产可用(VSCode 终端底层);原生模块 Bun N-API 需锁版本 |
| **写作:流水线** | opensquilla `paper-*` SKILL.md(11 个)+ MetaGPT ActionNode(借设计)+ STORM(借设计) | Apache-2.0(original) / MIT | 轻度封装 / 借设计 | MetaSkill 编排器 + `StructuredOutputNode`(Zod,~300+150 行) | 生产可用;阶段二交付 |
| **写作:编辑器** | `marked` + `shiki`(渲染)+ `@tiptap/react`+`@tiptap/starter-kit`(WYSIWYG) | MIT | 拿来即用 / 轻度封装 | TipTap `FootnoteNode` Extension(~150 行) | 生产可用;**不引 BlockNote(MPL-2.0)** |
| **写作:文档生成** | `docx` + `pptxgenjs` + `exceljs` + `puppeteer-core`(HTML→PDF);LaTeX 走系统 xelatex | MIT / MIT / MIT / Apache-2.0 | 拿来即用 / 轻度封装 | 各 generate 工具薄封装(~50-100 行/个) | 生产可用;**不引 python-docx/WeasyPrint(LGPL)** |
| **写作:引用** | `citation-js` + `@citation-js/plugin-bibtex` | MIT | 拿来即用 / 需缝合 | CitationAgent 句级核验(借 FACTUM 设计,~300 行,阶段三) | 引用格式化生产可用;引用幻觉无法消除只能标注 |
| **调研:编排** | `ai`(v6,`streamText`+`maxSteps`)+ `@anthropic-ai/sdk`(借 open_deep_research 设计) | Apache-2.0 / MIT | 轻度封装 | `ResearchOrchestrator`(三阶段,~500 行) | AI SDK 生产可用;open_deep_research 是 Python 仅借设计 |
| **调研:搜索抓取** | `@tavily/core`(主)+ `exa-js`(语义)+ `@mozilla/readability`+`jsdom`;Firecrawl opt-in | MIT / MIT / Apache-2.0·MIT / MIT | 拿来即用 | `SearchTool` 统一封装 + `FetchAndExtract`(~200 行) | 生产可用;SaaS 数据经第三方需 opt-in + 本地降级 |
| **computer-use:浏览器** | `@browserbasehq/stagehand`(主)+ `playwright` + `@playwright/mcp`(备选) | MIT / Apache-2.0 / Apache-2.0 | 拿来即用 | computer-use Agent Loop 适配内核事件流 | 生产可用;**选 Stagehand 而非 browser-use(Python)避语言边界**;P3 才引 |
| **computer-use:云浏览器** | `@browserbasehq/sdk`(主)/ `steel-sdk`(自托管) | MIT / Apache-2.0 | 拿来即用 / 轻度封装 | (云浏览器已隔离,不再套 E2B) | 生产可用;Browserbase=opt-in SaaS,数据驻留需评估 |
| **computer-use:视觉 grounding** | OmniParser v2(无 TS SDK) | MIT | 需较多缝合 | OmniParser sidecar 接口(仅兜底时) | 唯一无 TS SDK 件;仅 AX-tree 失效兜底,P3 |
| **computer-use:模型** | Claude computer-use(主,`computer-use-2025-11-24` beta)/ Gemini 2.5 CU / UI-TARS-2(自托管) | 商业 / 商业 / Apache-2.0 | 拿来即用 / 需缝合 | 截图独立 WS/WebRTC 通道 + provider 版本兼容层 + HITL 确认 | Claude OSWorld 66.3% SOTA;beta header 迭代;截图不混 SSE |
| **规划:cron** | `node-cron`;BullMQ/Temporal 后置 | MIT | 拿来即用 | `CronJobRegistry`(SQLite 持久化+防重复,~100 行) | 4M+ 周下载;进程内重启丢 job(单用户可接受) |
| **规划:日历邮件** | Google Calendar/Gmail MCP server 或 `googleapis` SDK | MIT / Apache-2.0 | 轻度封装 | `CredentialProxy`(OAuth token 进 KMS,签名放行,~80 行) | 官方维护;社区 MCP server 质量参差需审查 |
| **规划:推送** | `web-push`(VAPID)+ `@serwist/next`;APNs/FCM 后置 | MIT / MIT | 拿来即用 | `NotificationDispatcher`(内核决策+按端投递,~80 行) | 700K 周下载;iOS Safari 仅 PWA 装主屏生效 |
| **规划:Plan/Act+心跳** | `chokidar`(文件监听,借 cline/codex/opensquilla 设计) | MIT | 借设计自写 | `PlanActController`(~200)+ `HeartbeatCoordinator`(~150,移植 opensquilla heartbeat) | 设计成熟;均仅借设计不搬代码(Python/VSCode 绑定) |
| **端:Web** | `next` + `react` + `@assistant-ui/react` + `ai` + `@serwist/next` | MIT / MIT / MIT / Apache-2.0 / MIT | 拿来即用 / 轻度封装 | `ArcTransport`(ArcEvent→assistant-ui,~200 行) | 生产可用;P0 MVP |
| **端:CLI** | `opentui`(或 `ink`)+ `commander` + `@clack/prompts` + Bun `--compile` | MIT | 轻度封装 | CLI 入口 + `ArcCommand`/`ArcEvent` stdio JSONL 编解码 | 生产可用;OpenTUI 生态小;P2 |
| **端:桌面** | `@tauri-apps/cli`+`@tauri-apps/api` + 官方插件(store/shell/notification/updater) | MIT·Apache-2.0 | 需较多缝合 | `sidecar.rs`(spawn 内核+读 server.json,~3-5 天 Rust) | v2 GA;三平台 WebView CSS 差异;移动端非 first-class;P3(先 PWA) |
| **端:VSCode** | VSCode Extension API + Chat Participants + `vscode.lm` + 内置 MCP(1.102+) | 免费官方 | 轻度封装 | `ArcHostBridge`(postMessage→HTTP/SSE,~80 行) | 生产可用;Chat Participants=放弃 provider 控制权;P3 |
| **端:Chrome** | `wxt`(或 `plasmo`)+ Side Panel API + Messaging API + Content Script | MIT | 拿来即用 / 需较多缝合 | `background/sw.ts`(WS+重连+pairing,~150 行) | 生产可用;MV3 SW 30s 休眠;content script 操控真实会话使"零凭证"边界失效;P4 |
| **MCP 协议层(各端共享)** | `@modelcontextprotocol/sdk`(stdio + Streamable HTTP) | MIT | 拿来即用 | 内核 `--stdio` server 暴露 + MCP Hub | 2000万+ 周下载;prompt injection/tool poisoning 需鉴权隔离 |

---

## 2. 逐子系统要点(精炼)

### 2.1 内核运行时(主循环 + 工具 + MCP + 扩展)

- **真正拿来即用的只有 4 件**:`@modelcontextprotocol/sdk`(MIT)、`ai`(Apache-2.0)、`zod`(MIT)、`gray-matter`(MIT)。
- **agent 主循环必须自研**:AI SDK 的 `stopWhen` 循环不提供可中断/压缩边界/steering 队列/per-turn 重建。设计照搬 claudecode `query.ts`(**闭源,仅学架构,一字不抄**)+ pi `agent-loop.ts`(**MIT,可借代码**)。
- **工具元数据调度自研**:`isReadOnly`/`isConcurrencySafe`/超限落盘/5 键错误 envelope —— AI SDK 全不管,借 claudecode/codex 设计 TS 自写(codex 是 Rust,Apache-2.0 落 NOTICE)。
- **MCP 是本子系统最干净的现成件**,但 **Tool Poisoning(CVE-2025-54136)审计 + 外部凭证沙箱外代理**是安全关键自研接缝,不可省。
- **Skills/Hooks 是规范+约定不是库**,自己写加载器;**禁复制 claudecode 任何 SKILL 文案**;`paper-*` 经核验为 opensquilla-original(Apache-2.0)。

### 2.2 上下文与记忆

- **压缩**:无 npm 库;直接复用 **opencode `compaction.ts`(MIT,结构化 Markdown 模板 + KEEP_TOKENS=8000)** 代码;token 计数用 `@anthropic-ai/tokenizer` / `tiktoken`,不自研。
- **长期记忆**:**MVP 根本不需要 archival**(写代码是会话内任务)。用 MEMORY.md(~30 行,0 依赖)。阶段四三选一(mem0 首选 / Zep·Graphiti / Letta),**现在一个都不引**。
- **检索**:`sqlite-vec`(Apache-2.0/MIT)+ SQLite FTS5(内置)+ RRF 融合,与 SQLite 数据栈契合,零额外向量库服务。
- **KV-cache 纪律**(零依赖,工程纪律):append-only 消息数组、工具集稳定(mask 不删)、系统 prompt 可缓存段置前。

### 2.3 Provider 抽象与路由

- **主路**:`ai` + `@ai-sdk/anthropic`(Apache-2.0)。**单 provider 成本最优 = Anthropic claude-sonnet-4-x**(原生 prompt caching 省 90% token、工具调用最稳)。
- **可选 LiteLLM Proxy**(MIT,Python 唯一承认的 sidecar,HTTP 隔离):MVP 单 provider 可不起,2+ provider 或统一 key 管理时起,锁小版本。
- **ThinkingLevel**:直接复制 **pi `ThinkingLevel` 类型(MIT,6 档)** + 手写 `applyThinkingLevel()`(~20 行);opencode `@opencode-ai/llm` 深绑 Effect,**仅借设计不搬代码**。
- **Prompt caching**:不自研,按各 provider 规范配 `cacheControl`;借 aider `chat_chunks.py` 的分段 cache header 设计(Apache-2.0)。

### 2.4 会话持久化 + 流式 + 前端 UI

- **存储**:`drizzle-orm`+`bun:sqlite`,会话表**第一天就加 `tenant_id`+`epoch` 乐观锁**(借 opensquilla `storage.py` 设计 TS 重写)。
- **流式**:`ai` `streamText`+`useChat` + `hono` `streamSSE`;**MVP 不引 resumable-stream/Redis**,只做"刷新不丢"(SQLite event 表+重连续推)。
- **前端 UI**:`@assistant-ui/react`+`@assistant-ui/react-ai-sdk`(MIT,AISDKRuntime);**不引 CopilotKit/AG-UI**(对 MVP 偏重、绑架内核语义)。
- **协议**:MVP 单 repo `import type` 零 codegen;OpenAPI→SDK 后置(且 SSE 流式 schema 需自建 codegen)。

### 2.5 权限安全 + 横切地基

- **唯二真正"安装即用"的库**:`@napi-rs/keyring`(密钥,MIT)、`langfuse`(可观测,MIT);外加栈内已有的 `ai`/`drizzle-orm`/`pino`/`vitest`。
- **认证/计费/审批/多租户四块全是借设计的薄自研接缝**:loopback token、usage 表+quota、presets+黑名单、tenant_id 建模。
- **重型现成方案全部后置阶段五**:Auth.js/Clerk、KMS/Vault/Infisical、OpenMeter/Stripe、Prometheus/OTel 全套、promptfoo、Postgres RLS。
- **红线**:eval 是阶段一一等交付(≥10 golden case),无 eval 不谈自动降级路由。
- **从 codex/opensquilla 借的全是设计而非代码**(Rust/Python 语言不匹配),不触发 NOTICE 义务。

### 2.6 编码能力件

- **核心算法由现成库承载**:`web-tree-sitter`(AST)、`graphology`+pagerank(图)、`diff-match-patch`(fuzzy)、`simple-git`、`node-pty`、`vscode-jsonrpc`+protocol(LSP)全部直接安装。
- **可直接复用代码**:opencode `apply-patch`(MIT)、cline `CheckpointTracker`/`apply_patch`(Apache-2.0,剥 VSCode 依赖+保留声明)。
- **仅借算法思路自写 TS**:aider `repomap.py`/`editblock_coder.py`(Apache-2.0,Python→TS 无逐行搬运)。
- **总自研约 1600 行**,8 个薄接缝,无一是轮子。

### 2.7 写作能力件(阶段二)

- **流水线**:直接搬 opensquilla `paper-*` SKILL.md(11 个,Apache-2.0,需 NOTICE);MetaGPT ActionNode / STORM 仅借设计。
- **编辑器**:`marked`+`shiki`(渲染)、`@tiptap/react`+`starter-kit`(WYSIWYG,MIT)。**不引 BlockNote(MPL-2.0 文件级 copyleft)**。
- **文档生成**:`docx`/`pptxgenjs`/`exceljs`/`puppeteer-core` 全 npm;**不引 opensquilla 的 Python 实现(python-docx/WeasyPrint LGPL)**,只参考其 SKILL.md 思路。
- **引用**:`citation-js`(格式化)+ CitationAgent(句级核验,借 FACTUM 设计,阶段三建)。
- **合规要点**:opensquilla docx/pptx/xlsx/html-to-pdf 的 origin 是 `clawhub-mit0`,**不能当 Apache-2.0 代码移植**,仅作思路参考。

### 2.8 调研能力件(阶段三)

- **TS 侧可直接装**:`@anthropic-ai/sdk` + `ai` + `@tavily/core` + `exa-js` + `@mozilla/readability` + `jsdom`(新增仅 4 个)。
- **open_deep_research/GPT-Researcher 是 Python,仅借设计**(Scope→Research→Write 三阶段),TS 复现 ~500 行,**反对为此加 Python sidecar**。
- **抓取分层**:静态页 `@mozilla/readability`(零成本离线)→ JS 渲染/反爬 Firecrawl(opt-in SaaS)。
- **诚实风险**:检索召回率瓶颈(最优 agent 仅检索到 20.92% 专家引用)、引用幻觉无法消除(Claude+Search ~94%)、多 agent ~15× token 放大需预算熔断。

### 2.9 computer-use(P3)

- **浏览器自动化选 Stagehand v3(MIT,TS 原生)而非 browser-use(Python)**,避语言边界。
- **云浏览器 Browserbase(主)/ Steel(自托管)**,本身已隔离,不再套 E2B。
- **模型 Claude computer-use(OSWorld 66.3% SOTA)**;Gemini 2.5 CU 成本优化备选;UI-TARS-2(Apache-2.0)自托管后置。
- **OmniParser v2 是唯一无 TS SDK 件**,仅 AX-tree 失效兜底,P3 才引。
- **强制纪律**:截图走**独立 WS/WebRTC 通道,不混 SSE**;Prompt injection 业界承认无法根除,以 HITL+沙箱+域名白名单+凭证代理控爆炸半径。

### 2.10 日常规划(阶段四)

- **阶段一不交付**,只预留 schema 槽 + 接口占位符(`CredentialProxy`/`HeartbeatCoordinator`/`scheduled_jobs` 表)避免后续 breaking migration。
- **阶段四最小实装**:`node-cron` + `web-push` + Google Calendar/Gmail MCP(或 `googleapis`)+ `chokidar` + 4 个薄接缝(~530 行)。
- **凭证强制**:Google OAuth token 永不下发任何端,只存内核凭证代理 KMS 信封加密。
- **心跳协调器移植 opensquilla `heartbeat.py` 设计**(~150 行,夜间静默+coalesce+优先级带)。

### 2.11 各端表层壳

- **Web(P0)**:`next`+`react`+`@assistant-ui/react`+`ai`+`@serwist/next`。
- **CLI(P2)**:`opentui`(或 `ink`)+`commander`+`@clack/prompts`+Bun `--compile`(单二进制五平台);可搬 opencode `packages/tui/`(MIT,替换 Effect/SolidStart 依赖)。
- **桌面(P3,先 PWA 过渡)**:Tauri 2.0 + 官方插件,前端零重写复用 Next.js 产物。
- **VSCode(P3)**:Extension API + Chat Participants(注意=放弃 provider 控制权)+ 内置 MCP。
- **Chrome(P4)**:`wxt` + Side Panel + content script(注意操控真实会话使"零凭证"边界失效)。
- **可搬代码**:cline `WebviewProvider` postMessage envelope(Apache-2.0)、gemini-cli `hookSystem.ts`(Apache-2.0),均需保留 copyright + NOTICE。

---

## 3. 阶段一 Web + 写代码 MVP 最小现成依赖集("装这些就能起步")

> 把所有子系统里 MVP 真正需要的现成件汇成一份。日常规划/写作/调研/computer-use 全部**不在阶段一**。

```jsonc
// ============ 内核(Bun + Hono headless server)============
{
  // —— 主循环 / provider / 工具 / schema ——
  "ai":                          "^6",        // Apache-2.0 — provider 流式 + 单 turn 工具原语 + tool()
  "@ai-sdk/anthropic":           "^*",        // Apache-2.0 — 主力 provider(claude-sonnet-4-x)
  "zod":                         "^4",        // MIT        — 工具 inputSchema + 校验
  "@anthropic-ai/sdk":           "^*",        // MIT        — 极致 KV-cache 时直连后端(可选)

  // —— MCP / 扩展 ——
  "@modelcontextprotocol/sdk":   "^*",        // MIT        — MCP 客户端 + 内核暴露为 server(双向)
  "gray-matter":                 "^4",        // MIT        — SKILL.md frontmatter 解析

  // —— HTTP/SSE server ——
  "hono":                        "^4",        // MIT        — 内核 HTTP/SSE(streamSSE)

  // —— 存储 / ORM ——
  "drizzle-orm":                 "^*",        // Apache-2.0 — TS-first ORM(bun:sqlite 驱动)
  "drizzle-kit":                 "^*",        // Apache-2.0 — 迁移生成/执行
  // bun:sqlite                                // 内置,零依赖

  // —— 检索(可选,RepoMap 已够则可缓上)——
  "sqlite-vec":                  "^*",        // Apache-2.0/MIT — 向量检索
  // SQLite FTS5                                // 内置,BM25
  // @xenova/transformers 或 AI SDK embed()     // 本地/云 embedding

  // —— 编码能力件 ——
  "web-tree-sitter":             "^*",        // MIT — AST 解析
  "tree-sitter-typescript":      "^*",        // MIT — TS/JS grammar
  "graphology":                  "^*",        // MIT — RepoMap 图 + pagerank
  "diff-match-patch":            "^*",        // Apache-2.0 — SEARCH/REPLACE fuzzy
  "diff":                        "^*",        // BSD-3 — unified diff 展示
  "simple-git":                  "^*",        // MIT — git + shadow-git 检查点
  "node-pty":                    "^*",        // MIT — PTY 交互终端
  "vscode-languageserver-protocol": "^*",     // MIT — LSP 协议类型
  "vscode-jsonrpc":              "^*",        // MIT — LSP JSON-RPC 连接

  // —— 横切地基 ——
  "@napi-rs/keyring":            "^*",        // MIT — OS keychain 存 provider key
  "langfuse":                    "^*",        // MIT — LLM trace
  "pino":                        "^*",        // MIT — 结构化日志 + 统一审计去向
  "shell-quote":                 "^*",        // MIT — 命令安全分词(审批)
  // —— dev ——
  "vitest":                      "^*",        // MIT — ≥10 golden 编码 case(阶段一一等交付)
  "playwright":                  "^*"         // Apache-2.0 — dev,写代码沙箱内测试运行(非 computer-use)
}
```

```jsonc
// ============ 前端(Next.js App Router)============
{
  "next":                        "^15",       // MIT
  "react":                       "^19",       // MIT
  "react-dom":                   "^19",       // MIT
  "@assistant-ui/react":         "^*",        // MIT — 聊天 UI primitives
  "@assistant-ui/react-ai-sdk":  "^*",        // MIT — AI SDK 适配器(AISDKRuntime)
  "@serwist/next":               "^*",        // MIT — PWA(可 MVP 末期加)
  "tailwindcss":                 "^*"         // MIT — 样式(可选,推荐)
}
```

**分发**:Bun `--compile`(内置,无 npm 包)。
**外部进程(可选,非硬依赖)**:LiteLLM Proxy(单 provider 可不起)、Ollama(本地调试)。

**统计**:内核约 22 个直接依赖(含 dev),前端约 8 个;**无运行时 Python/Rust 进程侵入内核**(LiteLLM 是可选 HTTP 隔离 sidecar)。

**MVP 明确排除**:`langchain`/`langgraph`/`mastra`、`mem0`/`zep`/`letta`、`vercel/resumable-stream`+`redis`、`@tauri-apps/*`、`wxt`/`plasmo`、`opentui`/`ink`、`@browserbasehq/*`、`@tavily/core`、`@tiptap/*`、`docx`/`pptxgenjs`、`next-auth`、Postgres RLS、promptfoo、OmniParser。

---

## 4. 许可证合规快照

### 4.1 总体结论:零 GPL/AGPL 进入产品的风险(MVP 范围内)

MVP 全栈拟用现成件**全部为 MIT / Apache-2.0 / ISC / BSD / Public Domain**,对再分发友好。**没有任何 GPL/AGPL 进入 MIT/Apache 产品**。

### 4.2 需注意条款的现成件

| 现成件 | 许可证 | 注意事项 | 处置 |
|---|---|---|---|
| `nodejieba` | **LGPL-2.1** | 中文分词,动态链接可用但需声明 | MVP 写代码英文为主,**后置**;若需要选 `tiny-segmenter`(BSD)替代 |
| **BlockNote** | **MPL-2.0** | 文件级 copyleft,涉分发需开放修改文件 | **不引**,用 TipTap(MIT)替代 |
| **WeasyPrint** | **LGPL-2.1** | opensquilla html-to-pdf 用,且 Python | **不引**,用 `puppeteer-core`(Apache-2.0) |
| python-docx/pptx/openpyxl/reportlab/pdfplumber | 各异(部分 Python 生态) | opensquilla 服务端用,TS 项目不需要 | **不引**,用 `docx`/`pptxgenjs`/`exceljs`(MIT) |
| **HashiCorp Vault** | **BUSL-1.1** | 自用 OK,再分发需法务确认 | 阶段五可选项,有 Infisical(MIT)/云 KMS 替代 |
| Apache-2.0 全体(`ai`/`drizzle`/`puppeteer`/`playwright`/`web-tree-sitter`/`graphology` 等) | Apache-2.0 | 复制代码须附 NOTICE + 保留 copyright header | 根目录维护 `NOTICE` 文件 |

### 4.3 参考仓代码复用边界(NOTICE/attribution 义务)

| 仓 | 许可证 | 可搬代码 | 义务 |
|---|---|---|---|
| **pi** | MIT | ✅ agent-loop 双队列 / skills 加载 / tool 工厂 / ThinkingLevel | 保留 copyright |
| **opencode** | MIT | ✅ `compaction.ts` / `apply-patch` / `packages/tui/`(替换 Effect 依赖) | 保留 copyright;`@opencode-ai/llm` 深绑 Effect 仅借设计 |
| **cline** | Apache-2.0 | ✅ `CheckpointTracker` / `apply_patch` / `WebviewProvider` envelope(剥 VSCode 依赖) | NOTICE + copyright header |
| **gemini-cli** | Apache-2.0 | ✅ `hookSystem.ts` / `ThemeManager` | NOTICE + copyright header |
| **codex** | Apache-2.0 | ⚠️ Rust,需 TS 重写,仅借设计;`plan.md` 提示词可直接复用 | 复制提示词落 NOTICE |
| **opensquilla** | Apache-2.0(original) | ✅ `paper-*` SKILL.md;`compaction.py`/`store.py`/`heartbeat.py` 移植为 TS | NOTICE;**严格区分 opensquilla-original vs OpenClaw 派生 vs clawhub-mit0** |
| **aider** | Apache-2.0 | ⚠️ Python,仅借算法思路(repomap/editblock),`model-settings.yml` 格式可参考 | 逐字搬运须保留 header |
| **claudecode** | **闭源/无 LICENSE** | ❌ **代码与文本资产一律不可搬,仅学架构** | 禁复制任何 SKILL 文案/工具描述 |

**合规红线**:① **claudecode 一字不抄**(query 循环/压缩/权限/Hooks 仅学设计);② opensquilla SKILL 移植须按 origin 批次区分(`paper-*`=original Apache-2.0 可搬;docx 等=`clawhub-mit0` 仅参考;sub-agent/cron/github 等 8 个=OpenClaw MIT 派生需追 attribution);③ 从 codex/opensquilla 借的设计(Rust/Python)因语言不匹配不触发义务,但搬其提示词/SKILL 文本仍需 NOTICE。

---

## 5. 诚实的自研清单

### 5.1 即便最大化复用,仍不得不自研的薄层(MVP 阶段一)

> 全部是"内核事件模型 ↔ 现成库"的胶水,无一是造轮子。合计约 **3000-3500 行 TS**。

| # | 自研接缝 | 行数 | 为什么必须自研(没有现成可拿) |
|---|---|---|---|
| 1 | **async-generator 主循环 `queryLoop()`** | ~300-400 | AI SDK 的 `stopWhen` 循环不提供可中断/压缩边界/steering 队列/per-turn 重建;没有"现成的 agent-loop 库" |
| 2 | **`Tool<In,Out>` 元数据 + 只读并发/写串行分批 + 超限落盘** | ~100 | AI SDK `tool()` 不管 `isConcurrencySafe`/落盘投影/5 键错误 envelope |
| 3 | **MCP→内核工具适配器 + 白名单审计 + 凭证沙箱外代理** | ~150 | 安全关键;SDK 不替你审计第三方 server 的 tool description(Tool Poisoning) |
| 4 | **Skill 加载器 + Hooks 分发(2-3 事件)** | ~150 | SKILL.md 是规范不是库;无运行时 |
| 5 | **单级压缩 + 5 键失败 envelope** | ~200 | 借 opencode 模板,但触发阈值/boundary 标记需自接 |
| 6 | **MEMORY.md 读写 + session 注入** | ~30 | 0 依赖伪记忆 |
| 7 | **会话表 schema(tenant_id + epoch 乐观锁)** | ~150 | 借 opensquilla 设计 TS 重写(Python 不可搬) |
| 8 | **内核事件→UIMessage/streamSSE 桥接 + 心跳 + token 限流 + 刷新不丢恢复** | ~200 | 内核 async-generator 事件与 AI SDK/Hono 流的 adapter |
| 9 | **认证中间件(loopback token + userId/tenantId 注入)** | ~50 | MVP 单用户不引 Auth.js |
| 10 | **usage 表埋点 + quota 强制 + per-subagent 成本归因** | ~100 | SDK 给 usage,归因/限额是项目逻辑 |
| 11 | **权限审批 presets + 命令黑名单 + SSE 审批模态** | ~150 | 无适配 agent 场景的现成 policy 引擎 |
| 12 | **编码 8 接缝**(TagExtractor/RepoMapBuilder/EditBlockParser/EditGuard/CheckpointTracker/AgentLspClient/PtyManager/GitService) | ~1600 | 核心算法由库承载,但 agent 友好封装 + RepoMap 算法(无现成 npm 库)必须自写 |
| 13 | **ArcTransport(ArcEvent→assistant-ui)** | ~200 | ExternalStore/Transport 适配内核事件格式 |
| 14 | **10 条 golden 编码 case** | (数据) | 项目专属 eval,红线交付 |

### 5.2 推迟到"产品成熟后"才自研的部分(明确点名)

| 阶段 | 推迟自研项 | 现在用什么替代 |
|---|---|---|
| 阶段二+ | 三级压缩(snip→microcompact→autocompact)+ cache-editing microcompact + Context Epoch | 单级压缩(满即摘要) |
| 阶段二+ | durable 输入(steer/queue + advisory wake)+ resumable-stream(Redis)+ TurnTransitionError per-turn 重建 | "刷新不丢"最朴素版 |
| 阶段二 | OpenAPI→TS SDK + 自建流式事件 codegen | 单 repo `import type` |
| 阶段四 | orchestrator-subagent / fork 共享父 cache / coordinator 独立验证 | 单 agent |
| 阶段四 | archival 记忆引擎(mem0/Zep/Letta 评估后) | MEMORY.md |
| 阶段四 | sleep-time / offline consolidation(Letta Dream 风格) | 无 |
| 阶段五 | `@arclight/llm` 独立 provider 包(opencode protocol+route+transport 三层) | AI SDK + LiteLLM(过早自研=再造一个 LiteLLM) |
| 阶段五 | 智能语义路由 / 语义缓存(Redis vector) / 本地 ONNX 路由分类器 | 硬编码主力模型静态路由 |
| 阶段五 | Postgres RLS / schema-per-tenant / 跨租户迁移工具 | 全表 tenant_id 建模 |
| 阶段五 | 完整可观测 pipeline(Langfuse trace + Prometheus + 告警) | Langfuse + pino |
| 阶段五 | 计量聚合引擎 / 发票订阅收款(OpenMeter+Stripe) | usage 表 + quota |
| 成熟后 | ToolExposure 四态 + ToolSearch / code-mode(V8 isolate) | 内置工具 <20 个全量暴露 |
| 成熟后 | LLM 摘要压缩质量优化器(ACON 风格) | 结构化模板 |
| 成熟后 | 知识图谱记忆层(Zep/Graphiti) | sqlite-vec 混合检索 |
| 成熟后 | RL 训练 deep research / 写作 agent(DeepResearcher 路线) | Vercel AI SDK 编排 pipeline |
| 成熟后 | 写作质量自动评分/幻觉检测(FACTUM 全套) | CitationAgent 基础句级核验 |
| 成熟后 | 自研浏览器自动化/视觉 grounding/云浏览器/computer-use 模型 | Stagehand/OmniParser/Browserbase/Claude CU |
| 成熟后 | UI-TARS 自托管推理 | 云 API |
| 成熟后 | Typst 排版深度集成 / BibTeX 库 UI / 通用写作风格引擎 | 系统 xelatex + citation-js |

---

**核心判断**:用户"尽量用现成、自研推迟"的指令在 arclightagent 上**高度可执行**——MVP 阶段一只需安装约 30 个成熟 npm 包(全 MIT/Apache/BSD/ISC,零 GPL/AGPL),所有底层能力件(provider/流式/MCP/schema/AST/图/diff/git/PTY/LSP/ORM/检索/UI)都拿现成;自研严格收敛在约 3000-3500 行的薄接缝,没有一行是造轮子。唯一需要持续警惕的是那 10 处"伪轻量"——尤其是把 Vercel AI SDK 当 agent 框架、过早上 resumable-stream/Redis、以及为 Python deep research/browser-use 引入跨语言 sidecar——这三处是最容易让"薄接缝"膨胀成"撕掉重写"的地方。