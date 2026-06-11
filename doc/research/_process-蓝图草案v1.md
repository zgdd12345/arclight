所有 load-bearing 论断均已被原始数据佐证(许可证、半成品状态、闭源门控、能力偏科、写作流水线归属)。证据充分,现在产出完整蓝图。

# arclightagent 架构蓝图 + 分阶段路线图

> 全平台个人 AI Agent(写代码 / 写文章 / deep research / computer use / 日常规划),CLI + 桌面 + 网页 + 浏览器/IDE 插件全平台。**网页端先发、优先级最高。** 技术栈与构建策略已由架构师拍板,本文给出唯一推荐 + 强论证 + 分阶段落地。

---

## 0) 执行摘要

**一句话结论:不 fork 任何基座,以 TypeScript/Bun 自研一个 UI 无关的内核服务(headless agent server),把 opencode 的 server/client 分离架构作为"骨架蓝本",按子系统逐一移植 11 个仓库中各自最优的模块设计;网页端先发,其余各端是同一内核服务的薄客户端。**

| 决策项 | 推荐 | 一句话理由 |
|---|---|---|
| **构建策略** | **自研内核 + 借用模块**(非 fork、非纯从零) | 11 仓全部专精写代码,fork 即继承软件工程技术债并要硬塞另外四能力;但 agent 循环/工具/压缩/沙箱/provider 已被打磨成熟,不重造 |
| **语言/运行时** | **TypeScript + Bun**(内核服务端);沙箱辅助二进制可用 **Rust** | 网页优先=前后端同构同语言;5 个 TS 仓提供海量可直接移植实现;沙箱不妥协,必要时 Rust helper |
| **核心骨架** | **headless 内核服务 + 统一事件流 + 类型化 SDK 自动生成**(opencode 路线) | 后端写一次,Web/CLI/桌面/插件全部消费同一 server,网页一等公民 |
| **主循环** | **async-generator 单循环**(claudecode)+ 纯函数分层(pi),映射 SSE | 流式/工具进度/压缩边界/中断统一成一条可中断事件流 |
| **provider** | **独立 LLM 网关包**(opencode @opencode-ai/llm 思路)+ ThinkingLevel(pi) | provider 中立,可作远程网关,所有端共用 |
| **第一阶段交付** | **网页端 MVP**:内核服务 + Next.js/SolidStart 前端 + 写代码 + 调研两大能力跑通,SSE + resumable streams + durable session | 验证"单内核多端"骨架与网页优先体验,最高优先级 |

**为什么是这个组合(三句话):**(1) 网页优先这一最高约束直接排除大半候选——claudecode 网页靠 bridge 远程驱动 CLI(其自身分析明确标为短板)、aider/MetaGPT 无 Web、codex/gemini-cli 以 CLI 表层为主,只有 opencode 和 OpenHands 是真正 server/client 分离、网页一等公民。(2) 但 opencode 有三个硬伤(正处 V1→V2 大重写中间态 task/LSP/plan_exit/share 多项 TODO 待移植、深绑 Effect 4.x beta + Bun 小众生态、专精编码其余四能力为零),决定了"借蓝本不 fork 底座"。(3) 用 TS/Bun 自研内核把各仓 best_pick 作为模块设计来源逐一移植,沙箱借 codex 思路,五大能力中写作/调研借 opensquilla、computer-use 借 OpenHands+cline、日常规划自建。

---

## 1) 调研综述精要:借鉴什么 / 避免什么

### 1.1 按子系统的最佳借鉴来源(11 仓 best_pick 收敛)

| 子系统 | 借鉴(best_pick) | 关键机制 | 避免 |
|---|---|---|---|
| Agent 主循环 | **claudecode** + pi | async-generator 统一事件流(可 `.return()`/AbortController 中断)+ 纯函数循环 + 有状态包装 | aider 同步阻塞循环 |
| 工具系统 | **codex** + claudecode + opensquilla | ToolExposure 四态 + Deferred/tool_search 延迟发现;元数据(isReadOnly/isConcurrencySafe/isDestructive/maxResultSizeChars);输出落盘投影 + 5 键错误 envelope | 改源码当工具(aider) |
| 上下文/记忆 | **claudecode** + opencode + opensquilla | 三级压缩(snip→microcompact→autocompact),cache-editing microcompact 按 tool_use_id 原地清;Context Epoch 稳定前缀;混合检索(向量+BM25+jieba,中文友好)+ Dream 巩固 | qwen-code 关键词 recall(弱) |
| Provider 抽象 | **opencode** + pi + aider | 独立 LLM 包(protocol+route+transport,可作网关);ThinkingLevel 6 档统一;model-settings.yml 声明式差异 | codex/gemini-cli/claudecode 单厂商绑定 |
| 执行/沙箱 | **codex** + OpenHands | 三平台原生(seatbelt/landlock+bwrap/Windows ACL)+ 统一 PermissionProfile + deny-default + 网络代理白名单;多后端可插拔(docker→k8s 同接口) | opencode/cline/pi 无真沙箱 |
| **UI/各端(网页优先)** | **opencode** + OpenHands + codex/cline | server/client 彻底分离 + 类型化 SDK 自动生成 + SSE coalescing;web 截图流(base64 PNG)+ 带 token 的 iframe 内嵌 IDE;强类型协议(ts-rs / gRPC) | **claudecode 网页桥接 CLI 进程(反面教材)** |
| 扩展/插件 | **claudecode** + codex + opencode + pi | Plugins marketplace + Skills(SKILL.md,1% 预算发现)+ ToolSearch + Hooks;MCP 双向 native;jiti 运行时 TS 扩展 | aider 无插件(改源码) |
| 多智能体 | **codex** + claudecode + MetaGPT | orchestrator-subagent + thread_spawn_depth 防递归;fork 共享父 prompt cache;coordinator 独立对抗式验证;TeamLeader 总线 send_to/cause_by 双过滤 | peer-to-peer mesh |
| 会话持久化 | **opensquilla** + opencode + codex/pi | 乐观锁 epoch 防并发覆盖 + migrations + cli replay;durable 输入(steer/queue + advisory wake);ForkSnapshot 非线性历史树 | Markdown 文件存储(aider) |
| 权限/安全 | **codex** + opensquilla + claudecode | approval presets + execpolicy 渐进信任(前缀 allowlist + turn 内临时提权);RiskTier 三档 × 渠道矩阵 fail-closed;规则 + LLM 分类器 + 硬黑名单三道闸 | 仅命令黑名单 |
| 跨平台打包 | **codex** + Tauri | 一二进制 multicall(arg0 dispatch)+ 仅分发预编译 shim | Electron sidecar(包体大,opencode/cline 痛点) |
| computer-use | **OpenHands** + cline | web 截图流 + 内嵌 IDE(无需 VNC);BrowserSession(Puppeteer+CDP,远程 Chrome) | 纯截图坐标点击优先 |
| 非编码产出 | **opensquilla** + MetaGPT + claudecode | paper-* 全流程写作 skill + meta-paper-write 编排;ActionNode 结构化输出 + 自校正;plan 模式 + TodoWrite + Cron + proactive `<tick>` 心跳 | 裸 FileWrite 写作 |

### 1.2 五大能力覆盖现状(11 仓共同空白)

| 能力 | 现状 | 关键空白 |
|---|---|---|
| 写代码 | 全仓强项(11/11) | 无,可大量复用 |
| 写文章 | 仅 **opensquilla** 成体系(paper-* skill);其余裸 FileWrite | 结构化写作流水线需移植 + 富文本 UI 自建 |
| 调研 | opensquilla / MetaGPT / claudecode 中强 | **引用核验**(CitationAgent)需作独立阶段自建 |
| computer use | OpenHands/cline 浏览器;**全桌面 GUI 全仓皆弱** | 桌面坐标级控制需自建 + 必须跑沙箱内 |
| 日常规划 | 全仓仅"软件任务规划"(plan/TODO) | **日历/提醒/GTD 生活域全仓空白**,需完全自建 |

### 1.3 必须避免的三个反面教材(有据)

1. **claudecode 网页靠 bridge 远程驱动 CLI 进程**——引入延迟、状态同步、连接可靠性复杂度,其自身分析明确标"网页优先是其短板"。**内核必须做成独立服务,绝不桥接终端进程。**
2. **Electron sidecar 桌面壳**——opencode/cline 均提及包体大、资源占用高。桌面选 **Tauri**。
3. **单厂商 provider 绑定**(codex 绑 OpenAI Responses API、claudecode 仅 Anthropic 系)——provider 抽象必须第一天就独立成网关层。

### 1.4 2025-2026 SOTA 对齐(用现成轮子的地方)

- **执行层不造轮子**:浏览器自动化用 browser-use(Python,~98k stars,WebVoyager ~89%)或 Stagehand v3(TS,act/extract/observe/agent 四原语 + self-healing);代码沙箱用 E2B Firecracker microVM / Vercel Sandbox。
- **记忆层接 mem0**(LoCoMo 上比 OpenAI memory 高 26% 准确率、低 91% 延迟、省 90% token)作为 archival 层。
- **协议三件套各司其职**:AG-UI(接前端)/ MCP(接工具)/ A2A(接 agent 间),角色严格不混用。
- **Deep Research 骨架**参考 LangChain open_deep_research(Scope→Research→Write)+ Anthropic Orchestrator-Subagent(LeadResearcher Opus + 并行子代理 Sonnet,+90.2% 性能)。
- **KV-cache 命中率是头号成本指标**(10× 差距):稳定前缀 + append-only + mask 不删工具。

---

## 2) 技术栈 / 运行时推荐

### 2.1 推荐栈(唯一,明确)

| 层 | 选择 | 论证 | 被否决方案及理由 |
|---|---|---|---|
| **语言/运行时** | **TypeScript + Bun**(内核服务);沙箱 helper 可 **Rust** | 网页优先=前后端同构、生态最大、迭代最快;opencode/cline/pi/gemini-cli/qwen-code 五个 TS 仓提供可直接移植的工具/压缩/provider/扩展实现 | **Rust(codex)**:迭代曲线陡、~120 crate 负担过大,与快速迭代相悖,仅借架构原则;**Python(MetaGPT/OpenHands/opensquilla)**:前后端割裂、网页要另写 TS 前端,仅作子系统设计参考移植 |
| **后端框架** | **Hono**(轻量、Bun/Edge 友好、TS 原生) 承载内核 HTTP/SSE/WS | 与 Bun 一等公民、可部署本地/远程/Workers 边缘,契合"server 可本地/远程/边缘"目标 | Express(Node 时代、性能弱)、Next.js API routes(与前端耦合,不利内核独立) |
| **前端框架** | **Next.js (App Router)** 主选;SolidStart 作技术验证参考 | TS 全栈、生态/招聘最大、assistant-ui & Vercel AI SDK 原生适配、PWA 可"安装到桌面" | SolidStart(opencode 用,生态小);纯 React SPA(失 SSR/路由能力) |
| **前端 AI 层** | **Vercel AI SDK v6**(streamText/useChat/Agent)+ **assistant-ui**(Radix 可组合 chat primitives) | 3M+ 周下载、provider 抽象、useChat resume、AG-UI 适配;assistant-ui 50k+/月,支持 AI SDK/LangGraph 适配器 | 自写流式 UI(重复造轮子) |
| **内核↔表层协议** | **HTTP + SSE(主)/ WebSocket(双向控制) + 自动生成 TS 类型(OpenAPI→SDK)**;事件模型对齐 **AG-UI** | opencode 路线:类型化 SDK 生成保证多端类型一致;AG-UI 约 16 种标准事件已被 LangGraph/CrewAI/Mastra 接入 | codex SQ/EQ + ts-rs(Rust 绑定);cline gRPC-over-postMessage(protobuf 重,适合 IDE webview 不适合纯 web) |
| **数据层** | **SQLite(本地/单用户)→ Postgres(多端/服务化)**,ORM 用 Drizzle;向量检索 sqlite-vec / pgvector + BM25 混合 | opensquilla 证明 SQLite 单机个人场景够用 + 乐观锁 epoch;服务化撞墙时平滑迁 Postgres | 纯文件 JSONL 作主存(aider,无并发/查询);纯向量库(失结构化事务) |
| **缓存/流恢复** | **Redis** + vercel/resumable-stream(断线恢复) | 网页优先刷新/切设备不丢生成,第一天设计进去 | 无(用户体验硬伤) |
| **记忆 archival** | **mem0** | 生产验证、多 LLM、benchmark 透明 | 自建向量记忆(初期不值);Zep/Graphiti 作强时序关系需求的备选 |
| **provider 网关** | **自研独立 LLM 包**(opencode 思路)+ 可叠 **LiteLLM Proxy** 作后端统一 gateway | provider 中立、可作远程网关、所有端共用;LiteLLM 140+ provider、P95 8ms | 业务代码绑 provider 原生 SDK(锁定) |
| **代码沙箱** | **E2B Firecracker microVM**(通用)/ **Vercel Sandbox**(web 零配置);本地 CLI 用 **nono**(Landlock+Seatbelt);自管强隔离借 **codex** 三平台原生思路 | 硬件级隔离 ~150ms 冷启动;computer-use 与任意代码执行必须内核级隔离 | 宿主进程直接 eval(aider/cline/opencode 共同弱点) |
| **浏览器自动化** | **Stagehand v3**(TS,与栈同构)/ **browser-use**(Python 备选) | 不造轮子,DOM+AX 混合,self-healing | 自写 Puppeteer 全套(脆弱,仅借 cline BrowserSession 协议设计) |
| **桌面壳** | **Tauri 2.0**(~12MB,系统 WebView) | 包体小、覆盖 iOS/Android、生态成熟 | **Electron**(opencode/cline 痛点:包体大、资源高) |
| **CLI 分发** | **Bun --compile** 单二进制 + **codex multicall**(arg0 dispatch) | 零依赖、启动快 5-8×、一二进制多形态分发、版本一致 | 分发多个二进制(运维负担) |
| **可观测性** | **Langfuse**(开源、框架无关) | 单次 research 可产 40-200 span,不上 tracing 等于盲飞 | 无 tracing |

### 2.2 关于"自研 LLM 网关 vs LiteLLM"的明确取舍

第一阶段(MVP)直接用 **Vercel AI SDK v6 的 provider 抽象**(前端)+ **LiteLLM Proxy**(后端统一 gateway),零自研快速上线;待多端/缓存策略/ThinkingLevel 统一需求明确后,再把 provider 抽象下沉为**独立 `@arclight/llm` 包**(opencode protocol+route+transport 思路),把 cache-policy 与 transport 收进包内。这样既不在 MVP 期过度工程,又保留演进到"可作远程模型网关"的路径。

---

## 3) 构建策略(明确结论)

### 3.1 结论:自研内核 + 借用模块

**三选一拍板 = 自研内核 + 借用模块。不 fork 任何单一基座,也不纯从零。**

### 3.2 强论证(逐条 + 仓库证据)

**为什么不 fork 任何现有基座:**

1. **能力维度根本不匹配**:11 仓(含 claudecode/codex/cline/opencode)**全部专精写代码**。fork 任一基座 = 继承一个"软件工程心智模型"的工具集、system prompt、UI(diff 视图/terminal/file tree),再硬塞另外四大能力,技术债从第一天起。原始数据中 opencode/codex/claudecode/opensquilla 的 `weaknesses_avoid` 字段**均明确点出**"写文章/computer use/日常规划要么外置要么缺位"。

2. **claudecode 闭源不可复用**:原始数据确认其"无 OSS LICENSE 文件,这是 Anthropic 专有商业代码,遍布 `USER_TYPE==='ant'`/`feature(...)` 内部门控,许多路径脱离 Anthropic 基础设施后是 stub"。**只能架构学习,不可复用代码**;且"网页靠 bridge 远程驱动 CLI"正是要避免的妥协。

3. **codex 工程体量过重 + 单厂商绑定**:原始数据确认"~120 crate + Bazel/Cargo 双构建 + Nix flake + 大量 OpenAI 内部基建;client.rs 深绑 OpenAI Responses API(WS v2/previous_response_id/sticky-routing),主路径并非真正多 provider 中立"。全量 fork 负担过大、迭代慢,与网页优先快速迭代相悖。**其价值是架构蓝本(内核即库 + 事件流协议 + 三平台沙箱 + multicall),而非 fork 底座。** 许可证 Apache-2.0,模块/思路可借用。

4. **opencode 处半成品中间态**:原始数据确认"正处 V1→V2 大重写中间态,task(子代理)/LSP/plan_exit/share 发布/fuzzy edit 多项以 TODO 标注'待移植',直接基于 dev 分支会踩半成品;深绑 Effect 4.x **beta** + Bun + 大量 catalog/patch,生态小众、升级风险高、团队上手慢"。fork 它 = 继承半成品重写 + 仍要自建大半能力层。许可证 MIT,**借其架构蓝本与模块设计、不 fork 其 dev 分支**。

5. **MetaGPT/OpenHands 是 Python 后端**:多端表层缺失或重度绑定容器,"全平台"部分基本要从零做。OpenHands 核心 MIT(enterprise/ 目录为 PolyForm 试用许可,不碰即可),其 web computer-use/sandbox/skills 设计作参考移植到 TS。

**为什么不纯从零:** Agent 循环、工具系统、上下文压缩、沙箱、provider 抽象这些内核机制已被反复打磨成熟,重造是浪费。**自研编排骨架与五大能力产品层,借用经过验证的底层机制设计。**

### 3.3 蓝本与模块来源(指名道姓 + 许可证)

- **架构骨架蓝本**:opencode(MIT)的 server/client 分离 + 类型化 SDK 生成 + SSE coalescing。**借设计,不 fork dev 分支。**
- **主循环**:claudecode(闭源,仅学架构)async-generator + pi(MIT,可借代码)纯函数分层。
- **工具/可见性**:codex(Apache-2.0)ToolExposure + opensquilla(Apache-2.0)落盘投影/5 键 envelope + claudecode(学设计)元数据契约。
- **沙箱**:codex(Apache-2.0)三平台原生思路 + OpenHands(MIT)多后端可插拔 ABC;实现用 E2B / nono。
- **写作**:opensquilla(Apache-2.0,注意 tokenjuice 源自上游 MIT,二次分发核对 THIRD_PARTY_NOTICES)paper-* skill 移植为 SKILL.md。
- **computer-use**:OpenHands(MIT)截图流 + cline(Apache-2.0)BrowserSession 协议设计;执行层用 Stagehand/browser-use。
- **多智能体**:codex(Apache-2.0)orchestrator + claudecode(学设计)fork/coordinator + MetaGPT(MIT)TeamLeader 总线。

**许可证注意**:本项目若开源建议 **Apache-2.0 或 MIT**(与多数借鉴源兼容);**禁止复制 claudecode 任何代码**(闭源);opensquilla 的 tokenjuice 与媒体/渠道依赖需核对第三方声明;OpenHands enterprise/ 目录(PolyForm)不得借用。

---

## 4) 分层架构

### 4.1 架构图(ASCII)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                              各端表层 (薄客户端)                                  │
│                                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Web (★先发)│  │  CLI     │  │ 桌面     │  │ VSCode    │  │ Chrome 扩展(MV3) │  │
│  │ Next.js   │  │ Bun      │  │ Tauri 2  │  │ Chat      │  │ side panel +     │  │
│  │ +AI SDK   │  │ --compile│  │ (WebView)│  │ Participant│  │ service worker  │  │
│  │ assistant-ui│ │ +OpenTUI │  │          │  │ +MCP      │  │                  │  │
│  └─────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬────┘  └────────┬─────────┘  │
└────────┼─────────────┼─────────────┼─────────────┼────────────────┼────────────┘
         │             │             │             │                │
         └─────────────┴──── AG-UI 事件流 (SSE/WS) + 类型化 SDK ─────┴───────────┐
                                       │ (OpenAPI→TS 自动生成,多端类型一致)      │
                  ┌────────────────────▼─────────────────────────────────────┐  │
                  │           内核服务 (headless agent server, Bun+Hono)       │  │
                  │                                                            │  │
                  │  ┌──────────────────────────────────────────────────────┐ │  │
                  │  │  Agent Runtime — async-generator 单循环 (可中断/流式)  │ │  │
                  │  │  纯函数 loop (pi) + 有状态包装;Gather→Act→Verify      │ │  │
                  │  │  orchestrator-subagent + fork(共享父 cache) + 深度限制 │ │  │
                  │  └──────────────────────────────────────────────────────┘ │  │
                  │  ┌────────────┐ ┌──────────────┐ ┌──────────────────────┐  │  │
                  │  │ 工具系统    │ │ 上下文/记忆   │ │ provider 网关         │  │  │
                  │  │ ToolExposure│ │ 三级压缩      │ │ @arclight/llm        │  │  │
                  │  │ 四态+defer  │ │ +Context Epoch│ │ protocol+route+      │  │  │
                  │  │ 元数据驱动  │ │ +mem0 archival│ │ transport+cache      │  │  │
                  │  │ 落盘投影    │ │ +KV-cache 友好│ │ +ThinkingLevel       │  │  │
                  │  └────────────┘ └──────────────┘ └──────────────────────┘  │  │
                  │  ┌────────────┐ ┌──────────────┐ ┌──────────────────────┐  │  │
                  │  │ 权限/安全   │ │ 会话持久化    │ │ 扩展系统              │  │  │
                  │  │ approval+   │ │ 乐观锁 epoch  │ │ Skills(SKILL.md)+    │  │  │
                  │  │ execpolicy+ │ │ +durable 输入 │ │ MCP 双向 + Hooks     │  │  │
                  │  │ 渠道矩阵    │ │ +fork 历史树  │ │ + jiti 运行时扩展     │  │  │
                  │  └────────────┘ └──────────────┘ └──────────────────────┘  │  │
                  │  ┌──────────────── 能力层 (五大能力) ─────────────────────┐ │  │
                  │  │ 写代码  写文章  调研  computer-use  日常规划            │ │  │
                  │  │ (RepoMap)(paper-*)(Orch+Cite)(截图流) (Plan/Act+心跳)  │ │  │
                  │  └──────────────────────────────────────────────────────┘ │  │
                  └────────────────────────────┬─────────────────────────────┘  │
                                               │                                │
         ┌─────────────────────────────────────┼────────────────────────────────┘
         │                                     │
  ┌──────▼────────┐  ┌──────────────┐  ┌───────▼────────┐  ┌────────────────────┐
  │ 执行沙箱       │  │ MCP servers  │  │ 数据层          │  │ 外部 provider       │
  │ E2B microVM   │  │ (工具/搜索/   │  │ SQLite→Postgres │  │ Anthropic/OpenAI/  │
  │ /Vercel Sandbox│ │ 日历/邮件)    │  │ +Redis(流恢复)  │  │ Gemini/本地(Ollama)│
  │ /nono(本地)    │  │ Streamable    │  │ +向量(sqlite-vec│  │ 经 LiteLLM/网关     │
  │ /云浏览器      │  │ HTTP+OAuth2.1 │  │  /pgvector)+BM25│  │                     │
  └───────────────┘  └──────────────┘  └────────────────┘  └────────────────────┘
```

### 4.2 逐层职责与选型

**① 内核 Agent Runtime**
- **职责**:主循环、子代理编排、把内部事件流映射为 AG-UI 帧。
- **关键组件**:`agent-loop`(纯函数双层循环,借 pi)+ `Agent` 有状态包装;`query()→queryLoop()` async-generator 模式(借 claudecode),`yield` token/工具进度/压缩边界/子代理通知,`AbortController` 中断、`.return()` 提前结束;orchestrator-subagent + `thread_spawn_depth` 防递归(借 codex)+ fork 共享父 prompt cache(借 claudecode)。
- **选型**:第一阶段可用 **LangGraph** 提供 checkpointer/HITL/流式作为编排底座快速起步;待主循环稳定后用自研 async-generator 替换核心 loop(LangGraph 仍可作长任务 checkpoint 后端)。

**② 工具系统与 MCP**
- **职责**:统一工具抽象、动态注册/发现、输出膨胀防护、外部 MCP 接入。
- **关键组件**:`Tool<In,Out>` Schema 化接口 + 元数据(isReadOnly/isConcurrencySafe/isDestructive/maxResultSizeChars,借 claudecode)驱动并发调度/权限/落盘三件事;**ToolExposure 四态 + Deferred/tool_search 延迟发现**(借 codex,控首轮 token);scoped 动态注册热插拔(借 opencode);超限落盘 + 投影回灌 + handle 可回取(借 opensquilla/claudecode);**5 键失败 envelope 绝不泄露 traceback**(借 opensquilla)。
- **MCP**:所有外部接入(搜索/日历/邮件/GitHub/数据库)经 **MCP server(Streamable HTTP + OAuth 2.1/PKCE,委托 Auth0/Clerk)** 封装,与内置工具同走 dispatch/policy/沙箱/审批管线;防 Tool Poisoning(白名单审计)。

**③ 记忆与上下文**
- **职责**:短期压缩、长期记忆、KV-cache 经济学。
- **关键组件**:**三级压缩**(snip→microcompact→autocompact,借 claudecode),microcompact 用 cache-editing API 按 tool_use_id 原地清内容、保 prompt cache;**Context Epoch**(baseline 不可变作 cache 前缀,环境/日期漂移只发增量系统消息,借 opencode)——对 computer-use 屏幕漂移、日常规划时间漂移尤其关键;**长期记忆混合检索**(向量+BM25+jieba,中文友好)+ Dream 离线巩固(借 opensquilla),archival 层接 **mem0**;filesystem-as-memory + just-in-time 检索。
- **纪律**:KV-cache 命中率为头号成本指标(稳定前缀 + append-only + mask 不删工具)。

**④ provider 抽象**
- **职责**:provider 中立、可作网关、统一 thinking 抽象。
- **关键组件**:独立 `@arclight/llm` 包(protocol 适配器 + Route{endpoint/auth/transport/cache-policy} + http/ws 双 transport,借 opencode);**ThinkingLevel 6 档统一**(Anthropic budget_tokens / OpenAI reasoning_effort / Google thinking_config,借 pi);model-settings 声明式差异(借 aider)。MVP 期用 LiteLLM Proxy + AI SDK 抽象,后续下沉。

**⑤ 执行沙箱**
- **职责**:任意代码与 computer-use 的强隔离、多后端可插拔。
- **关键组件**:统一 `SandboxService` ABC(本地 docker→云 k8s 同接口,命名端口 AGENT_SERVER/VSCODE/WORKER 约定,借 OpenHands,让 web 端内嵌 IDE/终端/浏览器);实现 E2B microVM(通用)/ Vercel Sandbox(web)/ nono(本地);强隔离原则借 codex(deny-default + 网络代理白名单 + 拒绝即降级)。

**⑥ 各端表层**:见第 7 节。

---

## 5) 网页优先落地设计

### 5.1 服务端运行时

- **内核做成可独立运行的服务进程**(Bun + Hono),**绝不桥接 CLI 进程**(claudecode 反面教材)。server 可部署本地(`localhost`)、远程(自托管 VPS)、边缘(Cloudflare Workers),前端只做连接 + 事件 reducer。
- **headless agent server**:reasoning loop + tools + memory + 持久化全在服务端,对外仅暴露 AG-UI 事件流 + 类型化 SDK。
- 前端 **Next.js App Router**:Server Component 做首屏,Client Component(assistant-ui)订阅事件流。PWA Manifest 让用户"安装到桌面",MVP 期无需原生壳。

### 5.2 流式(SSE / WebSocket / resumable streams)

- **默认 SSE**(单向 token/工具进度/子报告推送)+ **每 15-30s 心跳**防代理超时;前端 **16ms 帧 coalescing + 8ms yield + 250ms 重连**(借 opencode server-sdk)避免高频重渲染。
- **WebSocket 仅在双向控制需求时叠加**(语音 Realtime、computer-use 实时控制面板、多人协作)。
- **Resumable / Durable Streams 第一天设计进去**:Redis + vercel/resumable-stream + useChat `resume` 选项,刷新页面/切设备不丢生成。
- 事件模型对齐 **AG-UI**(message/tool-call/state-patch/lifecycle ~16 种标准事件),为多端复用与第三方接入铺路。

### 5.3 多租户会话与持久化

- **durable sessions + 乐观锁 epoch**(借 opensquilla):`StaleEpochError` 防并发覆盖——这是多端(网页+手机同时操作)刚需;migrations 纪律(yoyo/Drizzle)+ cli replay 回放。
- **durable 输入模型**(借 opencode):用户在 agent 忙时插话走 steer 合并 / queue FIFO + advisory wake;崩溃可恢复。
- **会话树 fork/branch**(借 codex ForkSnapshot / pi navigateTree):调研/规划探索不同路径。
- 存储:SQLite(单用户)→ Postgres(多租户);会话状态可叠 LangGraph checkpointer(Postgres/Redis 后端)支持时间回溯调试。

### 5.4 内核做成各端共享服务的关键纪律

1. 内核**零 UI 依赖**(不含任何 ink/DOM 组件);各端只换壳。
2. **类型从一处生成**:OpenAPI schema → 自动生成 TS SDK,Web/CLI/桌面/插件共用,类型不漂移。
3. **能力一次建、五处用**:工具/压缩/记忆/沙箱/权限/持久化全在内核,前端只渲染。

### 5.5 computer-use 在 web 上的安全执行方案

- **架构**:DOM/accessibility-tree 优先(Playwright MCP/Stagehand,省 token、稳)+ 视觉 grounding 兜底(OmniParser v2,canvas/老旧站点);闭环 = 截图/AX 树快照 → 推理 → 动作 → 再快照。
- **web 呈现**:浏览器跑在**云沙箱**(Browserbase/Steel/E2B),**base64 PNG 截图流经 SSE 推前端渲染,无需 VNC**(借 OpenHands/cline);带 token 的 iframe 内嵌 IDE/终端(命名端口约定)。
- **安全门(一等公民)**:进程沙箱无法防 prompt injection(OpenAI 承认"不太可能被彻底解决")。叠加纵深防御:**高危动作(支付/删除/外发/改密码)强制前端模态 HITL 确认 + 域名白名单 + 凭证隔离 + 完整动作审计日志**;默认不信任页面内容里的"指令",对页面读取文本做来源标注/隔离;二次 LLM 审查。
- **权限回传**:高危确认走前端模态对话框,沿 `bridgePermissionCallbacks` 远程权限回传思路(借 cline)。

---

## 6) 五大能力模块设计

### 6.1 写代码

```
[网页 IDE 表层 Monaco/CodeMirror diff] —SSE→ [CodeAgent]
 ├ RepoMap (tree-sitter AST→引用图→PageRank→token 预算二分裁剪)
 ├ 多格式编辑 (SEARCH/REPLACE 默认;大文件≥6 处降级 Script Generation 省 3.5× token)
 ├ LSP (goToDefinition/findReferences/getDiagnostics)
 ├ 反射验证闭环 (edit→lint/test→读失败→自校正, max_reflections)
 ├ 沙箱执行 (E2B microVM, bash/PTY)
 └ Git (auto-commit + AI commit msg + shadow-git 检查点 + /undo)
```
- **借鉴**:aider `repomap.py`(personalization 权重:chat 文件 ×50、mentioned ×10、私有名 ×0.1,以 mtime 持久化 diskcache,**直接抄**);aider 多 edit format + model-settings.yml 按模型路由;**cline shadow-git 检查点**(工作区外独立 shadow git 仓,零干扰用户 .git,O(log n) 回任意时刻,**生产底线必抄**);codex apply_patch(.lark 语法)+ unified_exec(PTY);LSP(opencode schema);claudecode `partitionToolCalls` 并发分批(只读批并发上限 10,写串行)。
- **关键点**:SEARCH 部分逐字精确 + deterministic edit-guard(行数验证 + 省略号检测 + lost-in-the-middle);RepoMap token 预算设上限防爆;沙箱用 microVM 不在宿主 eval;保留 human-in-the-loop(Devin 3.0 仍 ~33% PR 需人工)。
- **网页端**:Monaco diff;沙箱命名端口 iframe 内嵌 IDE/终端;SSE 增量 + 16ms coalescing。

### 6.2 写文章(11 仓共同弱项,必须自建流水线)

```
[网页富文本/Markdown 编辑器] —SSE→ [WritingAgent]
 ├ 写作流水线: Outline → Section草稿 → Revision精修 → Citation引用
 ├ 结构化输出引擎 (字段+类型+指令声明→约束输出→auto review/revise 自校正)
 ├ 素材/风格记忆 (mem0 存写作偏好)
 ├ 文档生成 (docx/pptx/xlsx/pdf/latex/html-to-pdf)
 └ outputStyle 人格切换
```
- **借鉴**:**opensquilla paper-* skill 体系**(outline/section/abstract/citation/refbib/revision + meta-paper-write 拓扑编排,**11 仓唯一成体系写作流水线,直接移植为 SKILL.md**);**MetaGPT ActionNode**(带类型+指令节点树 + 内置 auto/human review→revise 自校正,**报告/PRD 类比裸 prompt 可靠**);MetaGPT TutorialAssistant(大纲→分章);STORM(多专家视角对话驱动大纲);claudecode outputStyles。
- **关键点**:结构化产出 + 自校正闭环替代自由文本;长文用结构化压缩模板(Goal/Constraints/Progress/Next Steps/Relevant Files)保留大纲防失忆;Meta-Skill 失败回退普通轮保证不脆。
- **网页端**:网页是写作最佳载体——所见即所得编辑器,章节级流式渲染(marked + shiki);大纲→草稿→精修可视化分阶段 UI,每阶段可人工审批;引用做可点击溯源脚注;长文 `background=True` 异步 + SSE 增量推章节。

### 6.3 调研(Deep Research)

```
[网页调研面板] —SSE→ [ResearchOrchestrator]
 Plan(澄清范围) → Fan-out Search(并行子代理) → Read → Reflect
   → Verify(CitationAgent) → Synthesize(长文报告)
 ├ LeadResearcher (Opus 级, 规划+综合)
 ├ N 个并行检索子代理 (Sonnet/Haiku 级, 独立上下文窗口)
 ├ web_search + web_fetch(readability) + MCP 数据源(Tavily/Exa/Firecrawl)
 ├ CitationAgent (独立阶段, 句级可溯源验证)
 └ 异步任务持久化 + 断点续研
```
- **借鉴**:**Orchestrator-Subagent**(Anthropic,+90.2%,子代理独立上下文窗口避免污染;codex multi_agents_v2;claudecode explore + fork 共享父 cache + coordinator 强制独立对抗验证);LangChain open_deep_research(Scope→Research→Write 骨架);MetaGPT Researcher SOP(CollectLinks→WebBrowseAndSummarize→ConductResearch→.md);opensquilla deep-research meta-skill;**CitationAgent 独立验证**(为每条声明存 source chunk 指针,治 statement/citation hallucination——OpenAI Deep Research 引用准确率仅 ~78%);MCP 驱动工具层(Tavily/Exa/Firecrawl 包成 MCP server,换源不改 agent)。
- **关键点**:检索召回率是最大瓶颈(用 agentic search 子查询分解 + 迭代检索,非静态单次 RAG);token 预算自适应子代理数(简单 1 个、复杂 10+,多 agent ~15× 消耗)+ prompt caching;HITL 置于研究计划审批环节(fan-out 前)。
- **网页端**:`background=True` + SSE 推 thought/搜索进度/子报告片段;规划阶段流式展示 subtopics 供审批;**任务持久化 + 断点续研 + 重连状态恢复**(状态存 DB);报告引用可点击溯源 UI。

### 6.4 Computer Use(11 仓覆盖最弱,结合 SOTA 自建)

```
[网页 computer use 面板] —SSE→ [ComputerUseAgent]
 闭环: 截图/AX树快照 → 推理 → 动作 → 再快照
 ├ 执行层: Stagehand v3 / browser-use (封装 Playwright/CDP, 多模型后端)
 ├ 感知: DOM/AX-tree 优先 (Playwright MCP, 省 token) + 视觉兜底 (OmniParser v2)
 ├ 模型: Claude computer-use (OSWorld 最强) / Gemini 2.5 CU (成本低+分步安全)
 ├ 沙箱: E2B microVM / Browserbase / Steel (按会话隔离)
 └ 安全门: 高危动作 HITL 强确认 + 域名白名单 + 凭证隔离 + 审计日志
```
- **借鉴**:**cline BrowserSession**(Puppeteer+CDP,launch/screenshot/click/type/scroll,本地/远程 Chrome,`browser.proto` 完整操作协议,**11 仓最完整,协议设计直接抄**);**OpenHands web computer-use**(base64 PNG 截图流 + 内嵌 IDE,**纯 web 无需 VNC**);gemini-cli BrowserAgent(MCP+Playwright + 防注入规则);执行层用 Stagehand v3(TS 同构)/ browser-use;模型 Claude(OSWorld 66.3%)主力 / Gemini 2.5 CU 备 / UI-TARS-2(Apache-2.0 自托管)。
- **关键点**:DOM 优先,视觉仅回退(纯截图坐标点击成本与脆弱性都更高);**prompt injection 未解根本风险**,sandbox 只限爆炸半径,必叠 HITL + 白名单 + 凭证隔离 + 审计;成本工程化(AX 树快照减视觉调用 + 限最大步数 + 分段检查点)。
- **网页端**:截图流 base64 PNG 经 SSE,浏览器在云沙箱,网页只是观测+控制面板;**全平台扩展路径**:web 打牢"截图→推理→动作"循环后,复用同一循环扩展到桌面(OSWorld)/Android(AndroidWorld),差异仅在执行后端(CDP vs OS 注入 vs ADB)。

### 6.5 日常规划(生活域全仓空白,组合机制 + 自建)

```
[网页规划面板/日历视图] —SSE→ [PlanningAgent]
 ├ Plan/Act 双模式 (plan 只读探索产计划 → 显式授权 act 执行)
 ├ 结构化 TODO (task_progress checklist 持久化 + 文件监听防目标漂移)
 ├ Cron 调度器 (定时 agent 任务 + 心跳协调)
 ├ 主动提醒 (事件合并 + 优先级带 + 活跃时段掩码, 防刷屏/夜间打扰)
 ├ 生活域工具 (日历/邮件/提醒 — 经 MCP 接 Google Calendar/Gmail)
 └ 长期记忆 (目标分解, mem0 + Dream 巩固)
```
- **借鉴**:**Plan/Act 双模式**(codex Plan Mode decision-complete `<proposed_plan>` + PlanDelta 流式;cline `plan_mode_respond`;OpenHands 一等公民 PLAN agent + PLAN.md,**"先想后做、规划阶段只读、显式授权执行"产品化直接抄**);**cline FocusChain**(task_progress checklist 持久化 + chokidar 监听防长任务目标漂移,对所有长任务通用);**opensquilla 心跳协调器**(事件 coalesce + 优先级带冷却 + **活跃时段掩码夜间不打扰**,poll 驱动非常驻后台,**主动提醒标准模式必抄**)+ APScheduler+croniter cron;claudecode TaskCreate/Cron + proactive `<tick>` 心跳;opensquilla meta-daily-operator-brief;**生活域经 MCP 接 Google Calendar/Gmail(11 仓共同空白,用 MCP 补)**;记忆 mem0 + Dream(证据门控,receipts/quarantine 防污染)。
- **关键点**:主动行为必须节流(事件合并 + 优先级带 + 活跃时段掩码);Plan 模式产可审阅计划再显式授权;目标分解 + 长期记忆需自建结构化层(11 仓普遍缺);记忆巩固证据门控 + TTL 防过时事实放大。
- **网页端**:日历视图 + 看板/checklist UI(远胜 CLI);主动提醒经 Web Push;durable session + 心跳 poll 驱动断连恢复;多端并发输入用 durable 输入模型(steer/queue + advisory wake)。

### 6.6 跨五大能力的共享基础设施(一次建,五处用)

| 共享件 | 机制 | 主参考 |
|---|---|---|
| Agent 主循环 | async-generator 单循环,可中断/流式/可恢复 | claudecode + gemini-cli + pi |
| 工具系统 | Schema 化 + scoped 动态注册 + 落盘投影 + ToolSearch 延迟发现 | opencode + codex + claudecode |
| 上下文/记忆 | 三级压缩 + KV-cache 友好 + mem0 + filesystem-as-memory | claudecode + opencode + opensquilla |
| 多智能体 | orchestrator-subagent + fork 共享 cache + 独立验证契约 | codex + claudecode + MetaGPT |
| provider 网关 | protocol+route+transport+cache + ThinkingLevel 统一 | opencode + pi + aider |
| 沙箱/权限 | 三平台原生 + microVM + 两段校验 + 渠道矩阵 + 渐进信任 | codex + opensquilla + claudecode |
| 扩展 | SKILL.md + MCP 双向 + Hooks 生命周期 + jiti | opensquilla + codex + opencode + pi |
| 会话持久化 | JSONL/SQLite + 会话树 + shadow-git + 乐观锁 epoch + durable 输入 | opensquilla + opencode + cline |
| 多端协议 | 内核即服务 + 统一事件流(AG-UI)+ 自动生成类型化 SDK | opencode + codex + cline |

---

## 7) 跨平台策略

**核心原则:同一内核服务,各端只换壳。** 内核做成 MCP server(Streamable HTTP + stdio 双模式)+ AG-UI 事件流,无 UI 依赖。

| 端 | 方案 | 论证 | 优先级 |
|---|---|---|---|
| **Web(先发)** | Next.js App Router + Vercel AI SDK v6 + assistant-ui + AG-UI,调用内核 HTTP server;PWA Manifest "安装到桌面" | 网页优先标准答案,验证完 UX 再做原生壳 | P0 |
| **CLI** | **Bun --compile --bytecode 单二进制** + **codex multicall(arg0 dispatch)**;TUI 用 OpenTUI | 零依赖、启动快 5-8×、一二进制多形态、版本一致;仿 Claude Code 分发 | P1 |
| **桌面** | **Tauri 2.0**(系统 WebView,~12MB);main 进程 spawn 本地内核 sidecar 或连远程 server | **结论:Tauri 而非 Electron**——opencode/cline 均证实 Electron sidecar 包体大、资源高;Tauri 覆盖 iOS/Android、生态成熟 | P2 |
| **VSCode 插件** | **Chat Participants API(@arclightagent)+ MCP server 注册**(VSCode 1.102+),走 ACP 协议 | 复用 Copilot 订阅、零聊天 UI 开发;webview 产物跨 VSCode/JetBrains 复用 | P2 |
| **Chrome 扩展(MV3)** | side panel 承载主 UI + background service worker 消息路由,WebSocket 连本地内核保持存活 | MV3 禁 eval/远程 JS,所有推理经外部 API;computer-use 浏览器侧天然载体 | P3 |

**跨端共享配置**:存 `~/.config/arclightagent/`(XDG 标准),CLI/桌面直接读写,Chrome 扩展经本地内核中转。

**桌面壳明确结论:Tauri 2.0,不用 Electron。** 若纯 TS 团队不想碰 Rust 且需极速验证,可先用 PWA"安装到桌面"过渡,但正式桌面壳定为 Tauri。

---

## 8) 关键技术决策表

| 决策 | 选择 | 理由 | 权衡 |
|---|---|---|---|
| 构建策略 | 自研内核 + 借用模块 | 11 仓全专精写代码,fork 即继承技术债 + 硬塞四能力;内核机制已成熟不重造 | 前期搭骨架慢于 fork,但避免半成品/技术债,长期可控 |
| 语言/运行时 | TypeScript + Bun | 网页优先前后端同构;5 个 TS 仓可移植;迭代快 | 沙箱强隔离需 Rust helper;Bun 生态较 Node 小 |
| 核心骨架 | headless 内核服务 + 类型化 SDK + AG-UI/SSE | 后端写一次多端复用,网页一等公民 | 比 claudecode 桥接 CLI 工程量大,但避免延迟/状态同步坑 |
| 主循环 | async-generator 单循环 + 纯函数分层 | 流式/中断/压缩边界统一,易映射 SSE | 比同步循环复杂;Effect 等重运行时不引入 |
| provider | 独立 LLM 网关(MVP 用 LiteLLM+AI SDK,后下沉) | provider 中立、可作网关、共享 | 自研网关有工程成本,故 MVP 先用现成 |
| 编排底座 | MVP 用 LangGraph,稳定后自研 loop 替核心 | checkpointer/HITL/流式快速起步 | LangGraph 较重,需后续解耦核心 loop |
| 记忆 archival | mem0 | 生产验证、多 LLM、省 90% token | 强时序关系场景需补 Zep/Graphiti |
| 沙箱 | E2B/Vercel Sandbox(web)+ nono(本地)+ codex 三平台思路 | microVM 硬件隔离;computer-use 必须强隔离 | E2B/Vercel 商用 SaaS 有成本,本地用 nono 降本 |
| 浏览器自动化 | Stagehand v3(TS)/ browser-use(Py) | 不造轮子,DOM+AX 混合 self-healing | 引入外部依赖;协议设计借 cline 自控 |
| 写作 | opensquilla paper-* skill 移植 + MetaGPT ActionNode | 11 仓唯一成体系写作流水线;结构化产出更可靠 | Python→TS 移植成本 |
| 调研 | Orchestrator-Subagent + 独立 CitationAgent | +90.2% 性能;治引用幻觉 | 多 agent ~15× token,需自适应子代理数 |
| 日常规划 | Plan/Act + 心跳协调器 + MCP 接日历/邮件 | 借现成机制 + 生活域用 MCP 补空白 | 结构化目标分解层需自建 |
| 桌面壳 | Tauri 2.0 | 包体小、生态成熟、覆盖移动 | 需少量 Rust;故 MVP 先 PWA 过渡 |
| 数据层 | SQLite→Postgres + Redis + 乐观锁 epoch | 单机够用,服务化平滑迁;多端并发刚需 | SQLite 多租户撞墙,故预留 Postgres 迁移 |
| 流恢复 | SSE + resumable-stream + Redis | 刷新/切设备不丢生成,第一天设计 | 增 Redis 依赖 |
| computer-use 安全 | HITL + 白名单 + 凭证隔离 + 审计(纵深防御) | prompt injection 不可彻底解决,只限爆炸半径 | 高危动作打断心流,需平衡确认频率 |

---

## 9) 分阶段路线图

> 模型分层纪律(全程强制):central 综合/架构决策 → Opus;执行类中等任务 → Sonnet;读文档/抽列表等机械工作 → Haiku/Flash。多 agent 编排里按 subagent 角色分配模型层级。

### 阶段一:网页端 MVP(最高优先级,~6-8 周)

**范围**:打通"单内核多端"骨架 + 网页优先体验 + 五大能力中最易出价值的两项(写代码 + 调研)。

**交付物**:
1. **内核服务**(Bun+Hono):async-generator 主循环(MVP 可基于 LangGraph)+ 工具系统(Schema 化 + 元数据 + 基础 ToolSearch)+ provider 网关(LiteLLM+AI SDK 抽象,至少 Anthropic/OpenAI/Gemini)+ 单级上下文压缩 + SQLite 持久化 + 乐观锁 epoch。
2. **AG-UI 事件流 + 类型化 SDK 自动生成**(OpenAPI→TS)。
3. **网页前端**(Next.js + Vercel AI SDK v6 + assistant-ui):聊天 + 工具渲染 + 权限对话框 + 消息流;**SSE + 心跳 + resumable-stream(Redis)断线恢复**。
4. **写代码能力**:RepoMap(tree-sitter+PageRank)+ SEARCH/REPLACE 编辑 + E2B/Vercel Sandbox 执行 + Monaco diff + shadow-git 检查点 + 反射验证闭环。
5. **调研能力**:Orchestrator-Subagent(LeadResearcher Opus + 并行子代理 Sonnet)+ web_search/web_fetch + 独立 CitationAgent + 异步任务持久化 + 断点续研 + 流式 subtopics 审批 UI。
6. **MCP 接入**(Streamable HTTP)+ 基础 Skills(SKILL.md)+ 基础权限模型(approval + 命令黑名单)。

**验收标准**:
- 网页端能完成一次真实编码任务(改多文件 + 跑测试 + 验证 + 检查点回滚)。
- 网页端能完成一次 deep research(规划审批 → 并行检索 → 带可点击溯源引用的长文报告),3-30 分钟任务刷新页面不丢、可断点续研。
- 同一内核 server 可被一个最小 CLI 客户端连上(证明骨架解耦)。
- KV-cache 命中率可观测;Langfuse tracing 接入。

### 阶段二:写作 + 五能力补全 + 上下文升级(~4-6 周)

**范围**:补齐写作能力,升级记忆与压缩。
**交付物**:opensquilla paper-* skill 移植(outline→section→revision→citation + meta-paper-write 编排)+ MetaGPT ActionNode 结构化输出;网页富文本/Markdown 编辑器 + 分阶段可视化 UI;**三级压缩(含 cache-editing microcompact)**+ Context Epoch;**mem0 archival + 混合检索(向量+BM25+jieba)**;文档生成(docx/pptx/pdf/latex)。
**验收**:网页端从一句话需求产出带引用、可分阶段审批的长文/报告;长会话 cache 命中率与成本显著改善。

### 阶段三:computer-use + 沙箱强化(~4-6 周)

**范围**:web 端 computer-use + 强隔离。
**交付物**:ComputerUseAgent(DOM/AX 优先 + 视觉兜底)+ Stagehand v3/browser-use 执行层 + 云浏览器(Browserbase/Steel/E2B)+ base64 PNG 截图流 SSE 呈现 + 内嵌 IDE iframe;**安全门(HITL 强确认 + 域名白名单 + 凭证隔离 + 审计日志)**;sandbox 升级为多后端可插拔 ABC(本地→云)+ codex 式三平台原生隔离原则。
**验收**:网页端完成一次浏览器自动化任务(如填表/查询/下单到确认前),高危动作强制确认,完整审计日志。

### 阶段四:日常规划 + 主动性 + 调度(~4-5 周)

**范围**:生活域规划 + 主动 agent。
**交付物**:Plan/Act 双模式 + FocusChain(目标漂移防护)+ **心跳协调器(事件合并 + 优先级带 + 活跃时段掩码)**+ APScheduler/croniter cron;MCP 接 Google Calendar/Gmail;mem0 + Dream 记忆巩固;网页日历视图 + 看板/checklist + Web Push;durable 输入模型(steer/queue)。
**验收**:agent 能定时产出每日简报、按规划主动提醒(夜间不打扰)、多端并发派活可中断/排队/恢复。

### 阶段五:全平台壳 + 高级编排(~5-7 周)

**范围**:CLI/桌面/插件 + 多智能体强化 + 省钱。
**交付物**:**CLI**(Bun --compile + multicall + OpenTUI)、**桌面**(Tauri 2.0,先 PWA 过渡)、**VSCode 插件**(Chat Participants + MCP)、**Chrome 扩展**(MV3 side panel);多智能体升级(fork 共享父 cache + coordinator 独立验证契约 + TeamLeader 总线 + thread_spawn_depth 防递归);Plugins marketplace + Hooks + jiti 运行时扩展;provider 网关下沉为独立 `@arclight/llm` 包 + ThinkingLevel;本地分层路由(选最便宜可胜任模型 + KV-cache anti-downgrade + 抱怨升级,用轻启发式替 opensquilla 脆弱 ONNX);数据层迁 Postgres 支持多租户。
**验收**:五端全部连同一内核 server;全平台用户配置共享;多智能体调研性能与成本可观测优于阶段一。

---

## 10) 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| **自研内核工程量大,MVP 延期** | 高 | 阶段一用 LangGraph/AI SDK/LiteLLM/mem0/E2B 等现成轮子起步,只自研编排骨架与能力层;async-generator 核心 loop 稳定后再替换 |
| **prompt injection(computer-use 根本风险)** | 高 | 承认不可彻底解决,只限爆炸半径:HITL 强确认 + 域名白名单 + 凭证隔离 + 审计 + 二次 LLM 审查 + 默认不信任页面"指令" |
| **多 agent token 成本失控(~15×)** | 高 | 自适应子代理数(简单 1、复杂 10+)+ prompt caching + 模型分层(Opus 综合/Sonnet 执行/Haiku 机械)+ 最大步数限制 + Langfuse 成本追踪 |
| **opensquilla/MetaGPT Python→TS 移植成本(写作流水线)** | 中 | 移植"设计与流程"而非代码,以 SKILL.md(Markdown,语言无关)承载写作能力,降低重写量 |
| **多端并发覆盖会话** | 中 | 乐观锁 epoch(StaleEpochError)+ durable 输入模型第一天设计进去 |
| **Bun/Effect 生态小众、依赖升级风险** | 中 | 不引入 Effect 4.x beta(opencode 硬伤);Bun 仅用稳定特性,关键路径保留 Node 兼容回退 |
| **KV-cache 未命中导致成本/延迟暴涨** | 中 | 稳定前缀 + append-only + mask 不删工具 + Context Epoch;cache 命中率作头号指标监控 |
| **SQLite 多租户撞墙** | 中 | 数据层抽象,阶段五迁 Postgres+pgvector;乐观锁逻辑兼容 |
| **沙箱 SaaS(E2B/Browserbase)成本与依赖** | 中 | 本地场景用 nono(零 overhead)+ Vercel Sandbox(web 零配置);云沙箱仅 computer-use/不可信代码用 |
| **借鉴源许可证合规** | 中 | 禁复制 claudecode(闭源);opensquilla tokenjuice 与媒体/渠道依赖核对 THIRD_PARTY_NOTICES;OpenHands enterprise/(PolyForm)不碰;本项目用 Apache-2.0/MIT |
| **五大能力同栈导致 system prompt/工具互相污染** | 中 | 能力以 Skill + 独立 agent profile 隔离,ToolExposure 四态按能力上下文按需暴露,避免工具爆炸与心智模型串味 |
| **LangGraph 后续解耦困难** | 低 | 阶段一即把核心 loop 接口化(纯函数 agent-loop),LangGraph 仅作 checkpoint/编排适配器,便于替换 |

---

**核心拍板复述**:不 fork 任何基座(11 仓全专精写代码 + claudecode 闭源 + codex 过重 + opencode 半成品中间态),用 TypeScript/Bun 自研 UI 无关的 headless 内核服务,以 opencode 的 server/client 分离为骨架蓝本,按子系统移植 12 个 best_pick 模块设计;网页端(Next.js + AI SDK + assistant-ui + AG-UI/SSE + resumable streams)先发,五端共享同一内核;写作/调研借 opensquilla、computer-use 借 OpenHands+cline、日常规划自建(MCP 补日历/邮件);沙箱借 codex 三平台思路 + E2B/nono 实现;桌面用 Tauri 不用 Electron;第一阶段 MVP 聚焦"单内核多端骨架 + 写代码 + 调研"两大能力跑通。所有 load-bearing 论断已对照 `/Users/fsm/project/arclightagent/research/data/` 下 22 个原始文件佐证(许可证、半成品状态、闭源门控、能力偏科、写作流水线归属均一致)。