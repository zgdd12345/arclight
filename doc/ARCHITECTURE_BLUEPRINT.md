> 本文为 arclightagent 全平台个人 AI Agent 的架构蓝图与路线图(已经对抗式评审修订)

# arclightagent 架构蓝图 + 分阶段路线图(最终交付版)

> 全平台个人 AI Agent(写代码 / 写文章 / deep research / computer use / 日常规划),CLI + 桌面 + 网页 + 浏览器/IDE 插件全平台。**网页端先发、优先级最高。** 本文为对抗式评审后的最终交付版:逐条落实"必须修复",采纳合理"建议改进",按真实许可证(已逐文件核验)修订 fork/借用决策,补齐认证/计费/隔离/eval/密钥五块地基,删减过度设计,把第一阶段 MVP 重新定界为现实可交付的范围。

---

## 决策修订记录（v2 · 2026-06-09，后续决策以本节为准；与下文如有冲突以本节为准）

> 本节汇总主蓝图交付后的关键决策更新（沙箱定案、拿来即用全栈选型、P0 施工图、Codex 审阅修正）。权威细节见配套文档：`research/P0-沙箱方案-拿来即用.md`、`research/拿来即用-全栈选型清单.md`、`research/P0-基础三件套-拓扑-数据模型-工具契约.md`。

1. **总原则**：现阶段**最大化复用现成、自研推迟到产品成熟后**（用户指令「拿来即用」）。
2. **沙箱定案**：本地**整体采用 nono**（Apache-2.0，Landlock/Seatbelt，`brew install nono`，自带 credential proxy + 审计）；远程 opt-in 用 **Vercel Sandbox / E2B SDK**；浏览器侧 **Pyodide**；**Docker 兜底**。**零自研隔离原语。** → 因 nono 走 Landlock 不碰 bwrap，**§3.4「Linux 规避 codex LGPL bubblewrap」整节失效**、**§3.6 红线 ② 关于 bwrap 的项作废**（仍保留「CI 拦 GPL/LGPL 入树」作通用纪律）。
3. **全栈选型 + MVP 最小依赖**：内核 **17 个 + 前端 7 个 npm 包**（全部 MIT/Apache/ISC/BSD/MIT-0，零 GPL/AGPL）。核心：`ai`+`@ai-sdk/anthropic`+`zod`+`@modelcontextprotocol/sdk`+`hono`+`drizzle-orm`/`bun:sqlite`+`web-tree-sitter`/`graphology`+`simple-git`/`node-pty`+前端 `next`/`react`/`@assistant-ui/react`。
4. **自研量诚实修正**：MVP 自研**实评 6000-9000+ 行**（非早先估的 3000-3500）；**agent 主循环（800-1500 行）与聊天前端（ArcTransport+工具富渲染+权限 UI，1500-3000+ 行）是真·产品工程，不是薄接缝**。方向（无现成 agent 框架可整体装、刻意不用 LangGraph）仍成立。
5. **许可证修正**：`web-push`=**MPL-2.0**（非 MIT，阶段四、不改源仅依赖则低风险）；`node-cron`=**ISC**；opensquilla SKILL 以**每文件 `provenance` 头**为准（`THIRD_PARTY_NOTICES.md` 汇总自相矛盾不采信），其 `deep-research`/docx/pptx 等 11 个为 **MIT-0 可直接搬**。
6. **P0 拓扑/数据/契约（施工图）**：P0=**本地优先** `arclight serve --repo <path>`（localhost 同托管 Hono 内核 + Web UI + nono + SQLite）。**澄清 localSandbox 矛盾**：本地部署下 **Web 的 `localSandbox = true`**（经本地内核+nono）；旧表述「Web localSandbox:false」**只对远程部署成立**。数据模型=12 张表 Drizzle schema（`events(session_id,seq)` 唯一 + `epoch` 乐观锁）；工具执行契约=ArcCommand/Tool 接口 + 5 键错误 envelope + 审批状态机 + 完整生命周期时序。
7. **Codex 审阅小修**：`reasoning.delta` 应输出**摘要**而非真实思维链（→ `reasoning.summary.delta`）；**loopback token 是机密**（泄露=完全接管内核），原生端宜用 Unix domain socket、浏览器端用 pairing+origin allowlist+CSRF，不依赖 TCP-loopback 的 PID 绑定硬保证。
8. **工期口径**：阶段一「6-8 周」是范围/团队相关估算，详设 Web 端「~10 周」是**单端含公共基建**口径——按单端口径理解，二者不矛盾。
9. **阶段一开发方案（最细，开工以它为准）**见 `DEV_PLAN.md`：monorepo 5 包结构 + 三大自研件详设（queryLoop/前端/编码链）+ 切片计划 slice0-6 + DoD + 12 风险；总量 6000-9000+ 行、1-3 人约 3-5 月。其评审又定两条修正（以 `DEV_PLAN.md` 为准）：① **前端 runtime 改用 `@assistant-ui/react` 的 `ExternalStoreRuntime`（非 AISDKRuntime）**，`useChat` resume 路线作废、改自研 SSE EventStreamManager（前端不直接依赖 `ai`/`react-ai-sdk`）；② 阶段一 **MCP 仅 interface stub、单 provider(Anthropic)**，均正式降阶段二。

---

## 0) 执行摘要

**一句话结论:不 fork 任何基座,以 TypeScript/Bun 自研一个 UI 无关的内核服务(headless agent server),把 opencode 的 server/client 分离架构作为"骨架蓝本",按子系统逐一移植 11 个仓库中各自最优的模块设计;网页端先发,其余各端是同一内核服务的薄客户端。第一阶段 MVP 严格收窄为「Web 单端 + 写代码单能力 + 单用户 + 本地优先沙箱」,把多端 SDK 生成、resumable/durable、多代理 deep research、computer-use 全部后置。**

| 决策项 | 推荐 | 一句话理由 |
|---|---|---|
| **构建策略** | **自研内核 + 借用模块**(非 fork、非纯从零) | 11 仓全部专精写代码,fork 即继承软件工程技术债并要硬塞另外四能力;但 agent 循环/工具/压缩/沙箱/provider 已被打磨成熟,不重造 |
| **语言/运行时** | **TypeScript + Bun**(内核服务端);沙箱辅助二进制可用 **Rust** | 网页优先=前后端同构同语言;5 个 TS 仓提供海量可直接移植实现;沙箱不妥协,必要时 Rust helper。**承认这是「TS 编排 + 受控多语言 sidecar」架构,而非纯同构**(见 §2.3) |
| **核心骨架** | **headless 内核服务 + 统一事件流 + 类型化 SDK 自动生成**(opencode 路线) | 后端写一次,Web/CLI/桌面/插件全部消费同一 server,网页一等公民。**注意:SDK 自动生成是「第二端」才需要的基建,MVP 单 repo 共享 TS 类型即可(见裁剪)** |
| **主循环** | **async-generator 单循环**(claudecode)+ 纯函数分层(pi) | 流式/工具进度/压缩边界/中断统一成一条可中断事件流。**MVP 直接自研最小 async-generator,不引 LangGraph(避免「先增后拆」)** |
| **provider** | **MVP 用 AI SDK + LiteLLM Proxy;后续下沉为独立 `@arclight/llm` 包** | provider 中立、可作远程网关。**承认「provider 中立」与「极致 KV-cache」存在张力,caching 优化只对主力 provider(Anthropic)做(见 §2.4)** |
| **第一阶段交付** | **网页端 MVP(收窄版)**:内核服务 + Next.js 前端 + **仅写代码一项能力** + 单用户认证 + 本地沙箱 + 最小 eval | 先证明「单内核 + 网页优先 + 一条能力端到端」骨架,把高风险持久化/多代理特性后置 |

**为什么是这个组合(三句话):**(1) 网页优先这一最高约束直接排除大半候选——claudecode 网页靠 bridge 远程驱动 CLI(其自身分析明确标为短板)、aider/MetaGPT 无 Web、codex/gemini-cli 以 CLI 表层为主,只有 opencode 和 OpenHands 是真正 server/client 分离、网页一等公民。(2) 但 opencode 有三个硬伤(正处 V1→V2 大重写中间态、深绑 Effect 4.x beta + Bun 小众生态、专精编码),决定了"借蓝本不 fork 底座"。(3) 用 TS/Bun 自研内核把各仓 best_pick 作为模块设计来源逐一移植,沙箱借 codex **架构思路**(但 Linux 路径只 exec 系统 bwrap、绝不 vendoring 其 LGPL 源码,见 §3.4),写作/调研借 opensquilla、computer-use 借 OpenHands+cline、日常规划自建。

**本次评审吸收的五条关键修订:**
1. **范围现实化**:原 6-8 周「五端骨架 + 双能力」是 3-5 人团队 4-6 个月的量。MVP 砍约 70% 范围,重定界为 Web 单端 + 写代码单能力 + 单用户 + 本地沙箱;多代理 deep research 本身作为独立后续阶段。
2. **安全模型硬化**:凭证一律在沙箱外、按动作签名放行(沙箱内零真实凭证);截图流走独立二进制 WS/WebRTC 通道(JPEG/WebP + 帧差),不混入 token SSE;SaaS 沙箱改为 opt-in、本地沙箱为默认并文档化数据流。
3. **合规两处真漏修复**:Linux 沙箱只 exec 系统安装的 bwrap(规避 codex vendored bubblewrap 的 **LGPL-2.0** 拖入);所有 Apache-2.0 源逐文件复制落实 NOTICE/attribution 义务;OpenClaw 派生的那批 SKILL(sub-agent/cron/github/...)attribution 追到 OpenClaw,**但本项目要移植的 paper-* 流水线经核验为 opensquilla-original(Apache-2.0),不涉 OpenClaw**(见 §3.5)。
4. **五块地基补齐**:认证/授权、计费/计量、多租户隔离、eval baseline、密钥管理——从「缺失」升为一等设计。
5. **过度设计删减**:mem0/AG-UI 自动 SDK 生成/ToolExposure 四态/三级压缩/resumable+durable+fork 历史树/`@arclight/llm` 独立包——MVP 全部后置,只保留最朴素必需版。

---

## 1) 调研综述精要:借鉴什么 / 避免什么

### 1.1 按子系统的最佳借鉴来源(11 仓 best_pick 收敛)

| 子系统 | 借鉴(best_pick) | 关键机制 | 避免 |
|---|---|---|---|
| Agent 主循环 | **claudecode** + pi | async-generator 统一事件流(可 `.return()`/AbortController 中断)+ 纯函数循环 + 有状态包装 | aider 同步阻塞循环 |
| 工具系统 | **codex** + claudecode + opensquilla | 元数据(isReadOnly/isConcurrencySafe/isDestructive/maxResultSizeChars)驱动并发/权限/落盘;输出落盘投影 + 5 键错误 envelope;ToolExposure 四态(**工具数 >30 才启用,后置**) | 改源码当工具(aider) |
| 上下文/记忆 | **claudecode** + opencode + opensquilla | 单级压缩(满即摘要,MVP)→ 三级压缩(snip→microcompact→autocompact,后置);Context Epoch 稳定前缀;混合检索(向量+BM25+jieba,中文友好) | qwen-code 关键词 recall(弱) |
| Provider 抽象 | **opencode** + pi + aider | MVP 用 AI SDK + LiteLLM;后续独立 LLM 包(protocol+route+transport);ThinkingLevel 6 档统一;model-settings.yml 声明式差异 | 单厂商绑定 |
| 执行/沙箱 | **codex(仅架构思路)** + OpenHands | 统一 PermissionProfile + deny-default + 网络代理白名单;多后端可插拔(local→cloud 同接口)。**Linux 实现只 exec 系统 bwrap,不 vendoring codex LGPL 源码** | opencode/cline/pi 无真沙箱;**把 SaaS 沙箱当默认** |
| **UI/各端(网页优先)** | **opencode** + OpenHands + cline | server/client 彻底分离;截图流走**独立二进制 WS/WebRTC**(JPEG/WebP+帧差);带 token 的 iframe 内嵌 IDE;强类型协议 | **claudecode 网页桥接 CLI 进程(反面教材)**;**PNG 截图混入 token SSE** |
| 扩展/插件 | **claudecode(仅学设计)** + codex + opencode + pi | Skills(SKILL.md,1% 预算发现)+ Hooks;MCP 双向 native;jiti 运行时 TS 扩展 | aider 无插件(改源码) |
| 多智能体 | **codex** + claudecode + MetaGPT | orchestrator-subagent + thread_spawn_depth 防递归;fork 共享父 prompt cache;coordinator 独立对抗式验证 | peer-to-peer mesh |
| 会话持久化 | **opensquilla** + opencode + codex/pi | 乐观锁 epoch 防并发覆盖 + migrations + cli replay;durable 输入(后置);ForkSnapshot 非线性历史树(后置) | Markdown 文件存储(aider) |
| 权限/安全 | **codex** + opensquilla + claudecode(学设计) | approval presets + execpolicy 渐进信任;RiskTier 三档 × 渠道矩阵 fail-closed;规则 + LLM 分类器 + 硬黑名单三道闸 | 仅命令黑名单 |
| 跨平台打包 | **codex(arg0 multicall 思路)** + Tauri | 一二进制 multicall + 仅分发预编译 shim | Electron sidecar(包体大) |
| computer-use | **OpenHands** + cline | DOM/AX 优先 + 视觉兜底;BrowserSession(CDP)协议;**浏览器用已隔离的 Browserbase/Steel,不再叠 E2B** | 纯截图坐标点击优先;**E2B→远程浏览器双层远程** |
| 非编码产出 | **opensquilla** + MetaGPT + claudecode(学设计) | paper-* 全流程写作 skill(**opensquilla-original / Apache-2.0**)+ meta-paper-write 编排;ActionNode 结构化输出 + 自校正;Plan/Act + Cron + 心跳 | 裸 FileWrite 写作 |

### 1.2 五大能力覆盖现状(11 仓共同空白)

| 能力 | 现状 | 关键空白 |
|---|---|---|
| 写代码 | 全仓强项(11/11) | 无,可大量复用 |
| 写文章 | 仅 **opensquilla** 成体系(paper-* skill);其余裸 FileWrite | 结构化写作流水线需移植 + 富文本 UI 自建 |
| 调研 | opensquilla / MetaGPT / claudecode 中强 | **引用核验**(CitationAgent)需作独立阶段自建 |
| computer use | OpenHands/cline 浏览器;**全桌面 GUI 全仓皆弱** | 桌面坐标级控制需自建 + 必须跑沙箱内 |
| 日常规划 | 全仓仅"软件任务规划"(plan/TODO) | **日历/提醒/GTD 生活域全仓空白**,需完全自建 |

### 1.3 必须避免的反面教材(有据)

1. **claudecode 网页靠 bridge 远程驱动 CLI 进程**——引入延迟、状态同步、连接可靠性复杂度。**内核必须做成独立服务,绝不桥接终端进程。**
2. **Electron sidecar 桌面壳**——opencode/cline 均提及包体大、资源占用高。桌面选 **Tauri**。
3. **单厂商 provider 绑定**——provider 抽象必须第一天就独立成网关层(但承认与 KV-cache 的张力,见 §2.4)。
4. **(新增)PNG 截图流混入 token SSE**——多分钟 computer-use 会话每步一帧数百 KB,几十步即数十 MB 打爆 SSE 与出口带宽。截图必须独立二进制通道 + 增量编码。
5. **(新增)把 SaaS 沙箱当默认**——用户任意代码/文件/密钥流向第三方是个人 Agent 的信任硬伤;本地沙箱为默认,SaaS 为 opt-in。
6. **(新增)vendoring codex 的 LGPL bubblewrap 源码**——会把 copyleft 拖进二进制;Linux 沙箱只 exec 系统包 bwrap。

### 1.4 2025-2026 SOTA 对齐(用现成轮子的地方,且标注语言边界)

- **执行层不造轮子**(注意语言异构,见 §2.3):浏览器自动化优先 **Stagehand v3(TS,与栈同构)**,browser-use(Python)仅作备选;代码沙箱 E2B / Vercel Sandbox 为 **opt-in SaaS**,本地默认用 nono(Landlock+Seatbelt)/系统 bwrap。
- **记忆层**:**MVP 不引 mem0**(写代码/调研为会话内上下文,archival 无收益);mem0 的供应商自报 benchmark(LoCoMo 对话记忆基准)与本项目场景不重合,不写成既定收益;待阶段四日常规划真需跨会话长期记忆时再评估 mem0 / Zep / Graphiti。
- **协议三件套各司其职**:AG-UI(接前端,**仅作可选适配器,不绑架内核语义**)/ MCP(接工具)/ A2A(接 agent 间)。
- **Deep Research 骨架**(后置阶段)参考 LangChain open_deep_research(Scope→Research→Write)+ Anthropic Orchestrator-Subagent。
- **KV-cache 命中率是主力 provider 上的头号成本指标**(10× 差距):稳定前缀 + append-only + mask 不删工具;**承认 caching 是各厂强绑定,网关层只保证不破坏前缀稳定性**。

---

## 2) 技术栈 / 运行时推荐

### 2.1 推荐栈(唯一,明确)

| 层 | 选择 | 论证 | 被否决方案及理由 |
|---|---|---|---|
| **语言/运行时** | **TypeScript + Bun**(内核服务);沙箱 helper 可 **Rust** | 网页优先=前后端同构、生态最大、迭代最快;5 个 TS 仓提供可直接移植实现 | **Rust(codex)**:迭代陡、~120 crate 负担过大,仅借架构原则;**Python(MetaGPT/OpenHands/opensquilla)**:前后端割裂,仅作子系统设计参考移植 |
| **后端框架** | **Hono**(轻量、Bun/Edge 友好、TS 原生) | 与 Bun 一等公民、可部署本地/远程/Workers 边缘 | Express(性能弱)、Next.js API routes(与前端耦合) |
| **前端框架** | **Next.js (App Router)** 主选 | TS 全栈、生态/招聘最大、assistant-ui & Vercel AI SDK 原生适配、PWA 可"安装到桌面" | SolidStart(生态小);纯 React SPA(失 SSR) |
| **前端 AI 层** | **assistant-ui**（`ExternalStoreRuntime`）+ 自研 **EventStreamManager**（手写 fetch+ReadableStream SSE）；内核侧仍用 `ai` v6（`streamText`，**仅内核侧**） | ArcEvent epoch/resync/审批语义无法硬套 UIMessage 协议；ExternalStore 保语义完整；前端不引 `ai`/`react-ai-sdk` | ~~`AISDKRuntime`（`@assistant-ui/react-ai-sdk`）+ `useChat resume`~~（丢 epoch 续接与审批往返）；自写流式 UI（重复造轮子）。（选型修订 D1/D2，见 DEV_PLAN §7.2） |
| **内核↔表层协议** | **MVP:单 repo 共享 TS 类型 + HTTP/SSE。后续:OpenAPI→TS SDK 自动生成 + AG-UI 适配器** | MVP 只有 Web 一端,零 codegen;真有第二端再上 SDK 生成。**注意 OpenAPI 对 SSE/流式事件表达力弱,SDK 自动生成不是「免费」的,需预留自建 codegen 预算**(见 B4) | codex SQ/EQ + ts-rs;cline gRPC-over-postMessage(protobuf 重) |
| **数据层** | **SQLite(本地/单用户)→ Postgres(多端/服务化)**,ORM 用 Drizzle | 单机够用 + 乐观锁 epoch;服务化撞墙时平滑迁 Postgres。**多租户隔离另有专门设计(见 §5.6),epoch 是并发控制不是隔离** | 纯文件 JSONL(无并发/查询);纯向量库(失结构化事务) |
| **缓存/流恢复** | **MVP:仅「刷新不丢」最朴素版(服务端 buffer + 重连续推)。后续:Redis + vercel/resumable-stream** | 把 SSE 断线重连后的事件 replay 去重 + epoch 冲突合并 UX 这类高 bug 密度特性后置到阶段二 UX 验证之后 | MVP 期全量 durable(把最高风险压最早期) |
| **记忆 archival** | **MVP 不引;阶段四再评估 mem0 / Zep / Graphiti** | 写代码/调研为会话内上下文,archival 无验证收益,且多一个 Python 服务 | MVP 即上 mem0(过度设计) |
| **provider 网关** | **MVP:AI SDK + LiteLLM Proxy。后续:独立 `@arclight/llm` 包** | 快速上线、provider 中立 | 业务代码绑 provider 原生 SDK(锁定);MVP 即自研网关(过度工程) |
| **代码沙箱** | **默认本地:nono(Landlock+Seatbelt)/ 系统 bwrap(exec,非 vendoring)。opt-in SaaS:E2B microVM / Vercel Sandbox** | 个人 Agent 默认数据不出本机;SaaS 数据驻留必须 opt-in 且文档化数据流 | 宿主进程直接 eval(共同弱点);SaaS 当默认(信任硬伤) |
| **浏览器自动化** | **Stagehand v3(TS,与栈同构)**;browser-use(Python)备选 | 不造轮子,DOM+AX 混合,self-healing,且避免无谓 Python 边界 | 自写 Puppeteer 全套(脆弱) |
| **云浏览器(computer-use)** | **Browserbase / Steel(本身已隔离)** | 浏览器场景**不再叠 E2B**(双层远程冗余,见 M4);代码执行才用 E2B | E2B microVM 内再驱动远程 Chrome(延迟/故障面叠加) |
| **桌面壳** | **Tauri 2.0**(~12MB,系统 WebView) | 包体小、覆盖 iOS/Android、生态成熟 | **Electron**(opencode/cline 痛点) |
| **CLI 分发** | **Bun --compile** 单二进制 + **arg0 multicall**(借 codex 思路) | 零依赖、启动快、一二进制多形态 | 分发多个二进制(运维负担) |
| **认证/授权** | **MVP:单用户本地(localhost 信任)/ 自托管单租户。多端起:Auth.js (NextAuth) / Clerk + OAuth2.1** | 「用户登录 arclightagent 本身」是 P0 地基,不可只把 OAuth 用在 MCP 工具(见 §5.5) | 无用户身份体系(原蓝图缺口) |
| **密钥管理** | **本地:OS keychain(Keychain/DPAPI/libsecret)加密存储;多租户:KMS/Vault + 信封加密 + 轮换** | provider key / MCP OAuth token / 用户 Google 凭证不可明文存 `~/.config`(网页多租户泄漏面) | 明文 `~/.config`(原蓝图缺口) |
| **计费/计量** | **每用户 token/沙箱时长/云浏览器会话/外部调用 metering + quota + cost-attribution** | LLM/E2B/Browserbase 全真金白银,多代理 ~15× token 放大问题 | 无 metering(原蓝图缺口) |
| **可观测性** | **Langfuse(trace)+ 结构化日志聚合 + 指标(Prometheus/OTel)+ 统一审计日志去向 + 告警** | 单次 research 可产 40-200 span;且认证失败/权限提权/计费事件审计统一落地 | 仅 trace、审计只挂 computer-use(原蓝图不全) |
| **评测(eval)** | **MVP 即建 ≥10 条 golden case 的 eval harness** | 证明移植模块无能力退化;为模型分层路由提供成本-质量基线 | 无 eval(无法证明退化、盲调路由) |

### 2.2 关于"自研 LLM 网关 vs LiteLLM"的明确取舍

MVP 直接用 **Vercel AI SDK v6 的 provider 抽象**(前端)+ **LiteLLM Proxy**(后端统一 gateway),零自研快速上线;待多端/缓存策略/ThinkingLevel 统一需求明确(阶段五)后,再把 provider 抽象下沉为**独立 `@arclight/llm` 包**(opencode protocol+route+transport 思路)。**因此架构图中 `@arclight/llm` 标为后续组件,不在 MVP 核心层画成既定,避免团队提前投入。**

### 2.3 关于"Bun 同构"的诚实定性(吸收 M3)

本架构的准确描述是 **「TS 编排内核 + 受控多语言 sidecar」**,而非纯前后端同构:LiteLLM Proxy(Python)、E2B/Browserbase/Langfuse(独立服务)在 MVP 即为外部进程。为把语言边界压到最小,采取三条纪律:
1. **执行层优先选 TS 原生实现**:浏览器自动化用 Stagehand(TS)而非 browser-use(Python);记忆 MVP 不引 mem0(Python)。
2. **承认的 sidecar 只有 LiteLLM**(可被 AI SDK 直连 provider 替代,作为可拆除项)与可观测/沙箱的独立服务——这些是「服务」不是「语言运行时」,通过稳定 HTTP 契约隔离,不渗入内核类型。
3. **「同构」的真实收益锁定在前后端共享 TS 类型 + 单语言编排心智**,不夸大为「零异构进程」。

### 2.4 关于"provider 中立 vs 极致 KV-cache"的张力(吸收 B3)

二者天然冲突:prompt caching 是各家强绑定的(Anthropic 显式 `cache_control`、OpenAI 自动前缀缓存、Gemini 配置不同)。明确取舍:
- **caching 优化只对主力 provider(Anthropic)做满**(显式 `cache_control` 断点 + 稳定前缀);
- **网关层对所有 provider 只保证一件事:不破坏前缀稳定性**(append-only、不重排系统消息、mask 不删工具);
- KV-cache 命中率作为「主力 provider 上的头号成本指标」监控,不假装在全 provider 都能拿到同等收益。

---

## 3) 构建策略(明确结论)

### 3.1 结论:自研内核 + 借用模块

**三选一拍板 = 自研内核 + 借用模块。不 fork 任何单一基座,也不纯从零。**

### 3.2 强论证(逐条 + 仓库证据)

**为什么不 fork 任何现有基座:**

1. **能力维度根本不匹配**:11 仓**全部专精写代码**。fork 任一基座 = 继承一个"软件工程心智模型"的工具集、system prompt、UI,再硬塞另外四大能力,技术债从第一天起。
2. **claudecode 闭源不可复用**:核验确认 `claudecode/` 下**无 LICENSE、无任何 `*.json`(无 package.json)**,`commands.ts`/`setup.ts` 实测含 `USER_TYPE === 'ant'` 内部门控。**只能架构学习,不可复用代码;并且连逐字照搬其 prompt 文本/工具描述/SKILL 文案都属于复制——架构思想可借,文本资产不可借。**
3. **codex 工程体量过重 + 单厂商绑定 + 内嵌 LGPL**:~120 crate + Bazel/Cargo 双构建;client.rs 深绑 OpenAI Responses API。**且 codex `codex-rs/vendor/bubblewrap/` vendoring 了完整 bubblewrap C 源码(`bubblewrap.c`/`bind-mount.c`),`COPYING` 为 GNU Library GPL v2(LGPL-2.0),并有独立构建目标 `codex-rs/bwrap/`(含 `build.rs`/`Cargo.toml`/`BUILD.bazel`)——它是编译/链接,不是 shell 调系统二进制。** 其价值是架构蓝本,而非 fork 底座;许可证 Apache-2.0,模块/思路可借,**但 Linux 沙箱路径绝不连带其 LGPL 源码(见 §3.4)**。
4. **opencode 处半成品中间态**:正处 V1→V2 大重写,task/LSP/plan_exit/share 多项 TODO 待移植;深绑 Effect 4.x **beta** + Bun + 大量 catalog/patch。许可证 MIT,**借其架构蓝本与模块设计、不 fork 其 dev 分支**。子包 `packages/http-recorder`、`packages/docs` 另有独立 LICENSE,若借需单独核对。
5. **MetaGPT/OpenHands 是 Python 后端**:多端表层缺失。OpenHands 核心 MIT,**`enterprise/` 目录为 PolyForm Free Trial License 1.0.0(非开源,仅试用,Copyright 2026 All Hands AI),含 analytics/integrations/Dockerfile/alembic 等——构建中必须显式排除整个 `enterprise/` 树,且其中 `integrations/` 恰可能是想参考的部分,那些尤其碰不得**。其 web computer-use/sandbox/skills 设计作参考移植到 TS。

**为什么不纯从零:** Agent 循环、工具系统、上下文压缩、沙箱、provider 抽象这些内核机制已被反复打磨成熟,重造是浪费。**自研编排骨架与五大能力产品层,借用经过验证的底层机制设计。**

### 3.3 蓝本与模块来源(指名道姓 + 已核验许可证)

- **架构骨架蓝本**:opencode(**MIT**)server/client 分离 + 类型化 SDK 生成思路 + SSE coalescing。借设计,不 fork dev 分支。
- **主循环**:claudecode(**闭源,仅学架构,文本资产不可借**)+ pi(**MIT,可借代码**)。
- **工具/可见性**:codex(**Apache-2.0**)+ opensquilla(**Apache-2.0**)落盘投影/5 键 envelope + claudecode(学设计)元数据契约。
- **沙箱**:codex(**Apache-2.0,但其 Linux bwrap 路径含 vendored LGPL,不连带**)三平台原生**思路** + OpenHands(**MIT**)多后端可插拔 ABC;实现用 nono / 系统 bwrap(exec)/ E2B(opt-in)。
- **写作**:opensquilla paper-* skill(**经核验为 opensquilla-original,Apache-2.0**)移植为 SKILL.md。
- **computer-use**:OpenHands(**MIT**)截图流 + cline(**Apache-2.0**)BrowserSession 协议设计;执行层用 Stagehand。
- **多智能体**:codex(**Apache-2.0**)orchestrator + claudecode(学设计)fork/coordinator + MetaGPT(**MIT**)TeamLeader 总线。

### 3.4 合规动作之一:Linux 沙箱规避 codex 的 LGPL bubblewrap

> ⚠️ **本节已被「决策修订记录(v2)」作废**：沙箱改为整体采用 nono（走 Landlock，不依赖/不编译 bwrap），本项目根本不碰 codex 的 bubblewrap 路径，故下述 LGPL 规避动作不再适用。保留本节仅作历史记录。详见 `research/P0-沙箱方案-拿来即用.md`。

**问题(评审实证)**:codex 不是 shell 调系统 bwrap,而是在 `codex-rs/vendor/bubblewrap/` 内 vendoring 完整 C 源码并经 `codex-rs/bwrap/` 自建编译,`COPYING` 为 LGPL-2.0(GNU Library GPL v2)。若「借 codex 三平台沙箱」连带其 Linux 路径,会把 LGPL 源码静态编译进本项目二进制,触发 copyleft(静态链接需开放对应目标文件以允许替换)。

**修复(强制纪律)**:
1. **Linux 沙箱只通过 `exec` 调用「系统包管理器安装的」bwrap 二进制**(独立进程调用,不 vendoring、不链接、不分发其源码)——彻底规避 LGPL 拖入。
2. 或在不可用 bwrap 的环境改用纯 MIT/无依赖隔离路径(nono 的 Landlock/Seatbelt、容器、microVM)。
3. **本项目仓库零 bubblewrap 源码**;CI 加一条检查:禁止任何 GPL/LGPL 源码进入构建树。

### 3.5 合规动作之二:Apache-2.0 NOTICE 与 SKILL attribution 链

**Apache-2.0 源逐文件复制义务(原蓝图缺落地动作)**:aider/cline/codex/gemini-cli/qwen-code/opensquilla 均为 Apache-2.0。逐文件复制(如 aider `repomap.py`)时必须:**保留原版权头 + 保留/附加 NOTICE 文件 + 标注修改**。`repomap.py` 文件头无 license 标记(依赖根 LICENSE),复制时务必附 attribution。本项目根目录维护 `NOTICE` 文件,记录每个被复制/派生文件的上游与许可证。

**SKILL.md attribution 链(评审实证 + 本次精确核验)**:
- opensquilla `THIRD_PARTY_NOTICES.md` 明确:**OpenClaw 派生(MIT, Copyright 2025 Peter Steinberger)的是 `sub-agent`/`cron`/`github`/`nano-pdf`/`skill-creator`/`summarize`/`tmux`/`weather` 这 8 个**——若移植这批,attribution 必须追到 OpenClaw,而非 opensquilla。
- **本项目要移植的写作流水线 `meta-paper-write` + `paper-*`(outline/section/abstract/citation/refbib/revision/source-curator/preference/experiment/plot)经核验列在 `THIRD_PARTY_NOTICES.md` 的「OpenSquilla-original」节,为 Apache-2.0,不涉 OpenClaw**——按 Apache-2.0 NOTICE 义务处理即可。
- `tokenjuice` 派生自 `github.com/vincentkoc/tokenjuice`(MIT, Copyright 2026 Vincent Koc),规则 JSON redistribute 需带 `LICENSE.tokenjuice`;`SquillaRouter V4 模型 bundle` 另有单独条款,本项目阶段五已决定丢弃(用轻启发式替),正确。

### 3.6 许可证总判

无 AGPL / GPLv3 / BSL / Elastic,大盘可控。**本项目若开源采用 Apache-2.0 或 MIT**(与多数借鉴源兼容)。强制清单:① 禁复制 claudecode 任何代码与文本资产;② Linux 沙箱不 vendoring bwrap(规避 LGPL);③ 排除 OpenHands `enterprise/`(PolyForm,含 integrations/);④ Apache-2.0 源复制落实 NOTICE/attribution;⑤ OpenClaw 派生 SKILL 追 attribution(paper-* 不在其列);⑥ tokenjuice 规则带 MIT 声明;⑦ CI 拦截 GPL/LGPL 源码入树。

---

## 4) 分层架构

### 4.1 架构图(ASCII)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                              各端表层 (薄客户端)                                  │
│   ★ MVP 仅 Web 一端;CLI/桌面/插件为后续阶段(虚线=后置)                          │
│  ┌──────────┐ ┌ ─ ─ ─ ─ ┐ ┌ ─ ─ ─ ─ ┐ ┌ ─ ─ ─ ─ ┐ ┌ ─ ─ ─ ─ ─ ─ ─ ─ ┐        │
│  │ Web (★先发)│  CLI       │  桌面      │  VSCode    │  Chrome 扩展(MV3)│        │
│  │ Next.js   │  Bun        │  Tauri 2   │  Chat       │  side panel +    │        │
│  │ +AI SDK   │ │--compile│ │(WebView)│ │Participant│ │ service worker │         │
│  │ assistant-ui│ +OpenTUI  │            │  +MCP      │                  │        │
│  └─────┬─────┘ └ ─ ─ ─ ─ ┘ └ ─ ─ ─ ─ ┘ └ ─ ─ ─ ─ ┘ └ ─ ─ ─ ─ ─ ─ ─ ─ ┘        │
└────────┼────────────────────────────────────────────────────────────────────────┘
         │  MVP: 单 repo 共享 TS 类型 + HTTP/SSE(token/工具进度)
         │  后续: AG-UI 适配器 + OpenAPI→TS SDK(第二端才上)
         │  ── computer-use 截图: 独立二进制 WS/WebRTC 通道(JPEG/WebP+帧差) ──┐
         │      [认证网关: 用户登录 → session↔user 绑定 → 每请求租户上下文]    │
  ┌──────▼──────────────────────────────────────────────────────────────────┐  │
  │           内核服务 (headless agent server, Bun+Hono)                       │  │
  │  ┌──────────────────────────────────────────────────────────────────┐    │  │
  │  │  Agent Runtime — async-generator 单循环 (可中断/流式, 自研最小版)   │    │  │
  │  │  纯函数 loop (pi) + 有状态包装;Gather→Act→Verify                   │    │  │
  │  │  每能力 = 独立 agent profile(独立 prompt 前缀 + 工具子集, 防污染)   │    │  │
  │  │  [后续] orchestrator-subagent + fork(共享父 cache) + 深度限制       │    │  │
  │  └──────────────────────────────────────────────────────────────────┘    │  │
  │  ┌────────────┐ ┌──────────────┐ ┌──────────────────────┐                 │  │
  │  │ 工具系统    │ │ 上下文/记忆   │ │ provider 抽象         │                 │  │
  │  │ Schema+元数据│ │ MVP:单级压缩  │ │ MVP: AI SDK+LiteLLM   │                 │  │
  │  │ 落盘投影    │ │ [后续]三级压缩 │ │ [后续] @arclight/llm  │                 │  │
  │  │ [后续]四态  │ │ +Context Epoch│ │ +ThinkingLevel        │                 │  │
  │  └────────────┘ └──────────────┘ └──────────────────────┘                 │  │
  │  ┌────────────┐ ┌──────────────┐ ┌──────────────────────┐                 │  │
  │  │ 权限/安全   │ │ 会话持久化    │ │ 扩展系统              │                 │  │
  │  │ approval+   │ │ 乐观锁 epoch  │ │ Skills(SKILL.md)+    │                 │  │
  │  │ 命令黑名单  │ │ +migrations   │ │ MCP 双向 + Hooks     │                 │  │
  │  │ +渠道矩阵   │ │ [后续]durable │ │ [后续] jiti 扩展      │                 │  │
  │  │ +凭证签名放行│ │  /fork 历史树 │ │                      │                 │  │
  │  └────────────┘ └──────────────┘ └──────────────────────┘                 │  │
  │  ┌─── 横切地基(一等设计, 非事后补丁)──────────────────────────────────┐  │  │
  │  │ 认证/授权 · 多租户隔离 · 计费/计量+quota · 密钥管理(KMS/keychain)    │  │  │
  │  │ · 统一审计日志 · 速率限制 · eval harness · 数据导出/删除            │  │  │
  │  └────────────────────────────────────────────────────────────────────┘  │  │
  │  ┌──── 能力层(MVP 仅「写代码」;其余为后续阶段)────────────────────────┐  │  │
  │  │ ★写代码  [P2]写文章  [P2]调研  [P3]computer-use  [P4]日常规划       │  │  │
  │  └────────────────────────────────────────────────────────────────────┘  │  │
  └────────────────────────────┬──────────────────────────────────────────────┘  │
                               │                                                  │
  ┌──────────────┐  ┌──────────▼─────┐  ┌────────────────┐  ┌────────────────────┐
  │ 执行沙箱       │  │ 数据层          │  │ MCP servers    │  │ 外部 provider       │
  │ 默认: nono /   │  │ SQLite→Postgres │  │ (工具/搜索/    │  │ Anthropic/OpenAI/  │
  │ 系统bwrap(exec)│  │ +租户隔离       │  │ 日历/邮件)     │  │ Gemini/本地(Ollama)│
  │ opt-in: E2B    │  │ [后续]Redis流恢复│  │ Streamable     │  │ 经 LiteLLM/网关     │
  │ 浏览器:Browserbase│ +向量(sqlite-vec│ │ HTTP+OAuth2.1  │  │                     │
  │ /Steel(已隔离) │  │ /pgvector)+BM25 │  │ (凭证在沙箱外) │  │                     │
  └────────────────┘  └────────────────┘  └────────────────┘  └────────────────────┘
       ↑ 沙箱内零真实凭证;凭证代理在沙箱外, 按动作签名放行
```

### 4.2 逐层职责与选型(摘要)

**① 内核 Agent Runtime**:async-generator 单循环(借 pi 纯函数 + claudecode `query()→queryLoop()` 模式),`yield` token/工具进度/压缩边界,`AbortController` 中断、`.return()` 提前结束。**MVP 直接自研最小版,不引 LangGraph**(避免「先增后拆」,见 §2.1 与风险表 M7)。每能力为独立 agent profile(独立 prompt 前缀 + 工具子集 + 独立 cache 前缀),把「五能力同栈污染」作为一等约束而非事后补丁(吸收 B5)。orchestrator-subagent + fork 为后续阶段。

**② 工具系统与 MCP**:`Tool<In,Out>` Schema 化 + 元数据(isReadOnly/isConcurrencySafe/isDestructive/maxResultSizeChars)驱动并发/权限/落盘;超限落盘 + 投影回灌(借 opensquilla);**5 键失败 envelope 绝不泄露 traceback**。MVP 工具数 <20,**全量暴露,ToolExposure 四态/Deferred 后置到工具爆炸时**。MCP 接入经 Streamable HTTP + OAuth 2.1/PKCE,与内置工具同走 dispatch/policy/沙箱/审批管线;防 Tool Poisoning(白名单审计)。**关键:MCP 拿到的外部凭证(日历/邮件 token)存于沙箱外凭证代理,不进执行域**。

**③ 记忆与上下文**:**MVP 单级压缩(满即摘要)+ Context Epoch(baseline 不可变作 cache 前缀)**;三级压缩(snip→microcompact→autocompact)与 cache-editing microcompact 为阶段二;archival(mem0/Zep)推迟到阶段四并需先验证收益。纪律:KV-cache 命中率为主力 provider 头号成本指标(§2.4)。

**④ provider 抽象**:MVP 用 AI SDK + LiteLLM Proxy;独立 `@arclight/llm` 包(protocol+route+transport+cache-policy)+ ThinkingLevel 6 档统一为阶段五下沉。

**⑤ 执行沙箱**:统一 `SandboxService` ABC(本地→云同接口,命名端口 AGENT_SERVER/VSCODE/WORKER 约定,借 OpenHands)。**默认本地实现(nono / 系统 bwrap exec),SaaS(E2B/Vercel)为 opt-in 且文档化数据流;浏览器用已隔离的 Browserbase/Steel,不叠 E2B(见 M4)**。强隔离原则:deny-default + 网络代理白名单 + 沙箱内零真实凭证。

**⑥ 横切地基**:认证、多租户隔离、计费、密钥、审计、限流、eval、数据导出删除——见 §5.5/§5.6。

**⑦ 各端表层**:见 §7。

---

## 5) 网页优先落地设计

### 5.1 服务端运行时

- **内核做成可独立运行的服务进程**(Bun + Hono),**绝不桥接 CLI 进程**。server 可部署本地(`localhost`)、远程(自托管 VPS)、边缘(Workers)。
- **headless agent server**:reasoning loop + tools + memory + 持久化全在服务端,对外暴露 SSE 事件流(MVP)/ 后续 AG-UI 适配。
- 前端 **Next.js App Router**:Server Component 首屏,Client Component(assistant-ui)订阅事件流。PWA Manifest 让用户"安装到桌面",MVP 期无需原生壳。

### 5.2 流式(SSE / WebSocket / 流恢复)

- **默认 SSE**(单向 token/工具进度推送)+ **每 15-30s 心跳**防代理超时;前端 **16ms 帧 coalescing + 250ms 重连**避免高频重渲染。
- **WebSocket 仅在双向控制需求时叠加**(语音 Realtime、computer-use 控制面板)。
- **computer-use 截图绝不混入 token SSE**(吸收 M1):截图走**独立二进制 WS/WebRTC 通道**,**JPEG/WebP + 帧差增量**;高保真长会话可直接用云浏览器的 CDP/VNC 远程渲染(多租户云浏览器场景 VNC 反而更省带宽,纠正原蓝图把 VNC 一概当反面教材的错误)。
- **流恢复 MVP 只做「刷新不丢」最朴素版**(服务端短缓冲 + 重连续推);**完整 resumable-stream(Redis)+ 断线 replay 去重后置到阶段二**(这是 bug 密度最高处,不压最早期)。

### 5.3 会话与持久化

- **乐观锁 epoch(`StaleEpochError`)防并发覆盖**(借 opensquilla)+ migrations 纪律(Drizzle)+ cli replay。**注意:epoch 是并发控制,不是租户隔离**(隔离见 §5.6)。
- **durable 输入(steer/queue + advisory wake)与会话树 fork/branch 后置**(高复杂度,非 MVP 必需)。
- 存储:SQLite(单用户 MVP)→ Postgres(多租户)。

### 5.4 内核做成各端共享服务的关键纪律

1. 内核**零 UI 依赖**(不含任何 ink/DOM 组件)。
2. **MVP 单 repo 直接共享 TS 类型(零 codegen)**;**OpenAPI→TS SDK 自动生成推迟到真有第二端**,且因 OpenAPI 对 SSE 表达力弱(B4),需预留**自建流式事件 codegen** 预算(opencode 正是自建 codegen 才做到)。
3. **能力一次建、多处用**:工具/压缩/记忆/沙箱/权限/持久化全在内核。

### 5.5 认证 / 授权 / 密钥(P0 地基,原蓝图缺口)

- **用户身份**:OAuth 2.1/PKCE 不止用于 MCP 工具,**「用户登录 arclightagent 本身」是一等体系**。MVP 单用户(localhost 信任 / 自托管单租户);多端起接 **Auth.js (NextAuth) 或 Clerk**,session↔user 强绑定,每个内核请求携带租户上下文。
- **密钥管理**:provider API key / MCP OAuth token / 用户 Google 凭证——**本地用 OS keychain(Keychain/DPAPI/libsecret)加密;多租户用 KMS/Vault + 信封加密 + 轮换策略**;**禁止明文 `~/.config`**(对网页多租户是泄漏面)。computer-use 与 MCP 的外部凭证存于**沙箱外凭证代理,按动作签名放行,沙箱内零真实凭证**(吸收 M1)。
- **速率限制 / 滥用防护**:公开网页服务必备(每用户/每 IP 配额、突发限流)。
- **数据导出 / 删除**:个人 Agent 持有日历/邮件/写作等私人数据,提供 per-user 导出与删除(GDPR-类),纳入审计。

### 5.6 多租户数据隔离(原蓝图缺口)

- **租户边界**:Postgres 用 **Row-Level Security(RLS)+ 每查询强制 tenant_id** 或 schema-per-tenant;**沙箱 per-tenant 隔离**(不同用户的代码/浏览器会话不共享执行域)。
- **会话历史 + computer-use 凭证严格按租户隔离**,防跨租户泄漏(高危)。
- MVP 单用户不需 RLS,但**数据访问层从第一天就以 `tenant_id` 维度建模**,避免后期撕裂。

### 5.7 computer-use 在 web 上的安全执行方案(吸收 M1/M4,后续阶段)

- **架构**:DOM/accessibility-tree 优先(Stagehand/Playwright MCP,省 token)+ 视觉 grounding 兜底(OmniParser v2);闭环 = AX 树/截图快照 → 推理 → 动作 → 再快照。
- **隔离不叠层**:**浏览器 computer-use 用本身已隔离的 Browserbase/Steel,不再套 E2B microVM**(避免 microVM→远程浏览器双层远程冗余);**代码执行才用 E2B**,两条路径分开。
- **截图呈现**:**独立二进制 WS/WebRTC + JPEG/WebP + 帧差**(不混 token SSE);带 token 的 iframe 内嵌 IDE/终端(命名端口约定)。
- **硬安全边界 = 凭证不在执行域**:进程沙箱无法防 prompt injection(模型被注入后会主动绕过应用层白名单)。真正硬边界是**沙箱内零真实凭证 + 凭证代理在沙箱外按动作签名放行**;应用层 HITL 强确认 + 域名白名单 + 审计日志为纵深防御**之上**的补充,而非唯一依赖。默认不信任页面内容里的"指令",对页面文本做来源标注/隔离;二次 LLM 审查。
- **权限回传**:高危确认走前端模态对话框(借 cline `bridgePermissionCallbacks` 远程回传思路)。

---

## 6) 五大能力模块设计

> **MVP 仅交付「写代码」;写文章/调研/computer-use/日常规划为后续阶段(§9 排期)。** 以下为完整设计,供分阶段落地。

### 6.1 写代码(★ MVP 唯一能力)

```
[网页 IDE 表层 Monaco/CodeMirror diff] —SSE→ [CodeAgent]
 ├ RepoMap (tree-sitter AST→引用图→PageRank→token 预算二分裁剪)
 ├ 多格式编辑 (SEARCH/REPLACE 默认;大文件≥6 处降级 Script Generation 省 3.5× token)
 ├ LSP (goToDefinition/findReferences/getDiagnostics)
 ├ 反射验证闭环 (edit→lint/test→读失败→自校正, max_reflections)
 ├ 沙箱执行 (默认本地 nono/系统 bwrap; opt-in E2B; bash/PTY)
 └ Git (auto-commit + AI commit msg + shadow-git 检查点 + /undo)
```
- **借鉴**:aider `repomap.py`(personalization 权重 chat×50/mentioned×10/私有名×0.1,mtime 持久化 diskcache;**复制须附 NOTICE/attribution**)+ model-settings.yml 按模型路由;**cline shadow-git 检查点**(工作区外独立 shadow git 仓,零干扰 .git,O(log n) 回任意时刻,生产底线必抄);codex apply_patch + unified_exec(PTY);LSP(opencode schema);claudecode `partitionToolCalls` 并发分批(只读批并发上限 10,写串行)。
- **关键点**:SEARCH 逐字精确 + deterministic edit-guard(行数验证 + 省略号检测);RepoMap token 预算设上限;**沙箱默认本地不在宿主 eval**;保留 human-in-the-loop(Devin 3.0 仍 ~33% PR 需人工)。
- **网页端**:Monaco diff;沙箱命名端口 iframe 内嵌终端;SSE 增量 + 16ms coalescing。
- **eval(MVP 必带)**:≥10 条 golden 编码任务(多文件改 + 跑测试 + 验证 + 回滚),作为移植无退化的回归基线。

### 6.2 写文章(11 仓共同弱项,阶段二自建流水线)

```
[网页富文本/Markdown 编辑器] —SSE→ [WritingAgent]
 ├ 写作流水线: Outline → Section草稿 → Revision精修 → Citation引用
 ├ 结构化输出引擎 (字段+类型+指令声明→约束输出→auto review/revise 自校正)
 ├ 文档生成 (docx/pptx/xlsx/pdf/latex/html-to-pdf)
 └ outputStyle 人格切换
```
- **借鉴**:**opensquilla paper-* skill 体系(经核验 opensquilla-original / Apache-2.0,直接移植为 SKILL.md,按 NOTICE 义务处理)**——outline/section/abstract/citation/refbib/revision/source-curator + meta-paper-write 拓扑编排;**MetaGPT ActionNode**(带类型+指令节点树 + auto/human review→revise 自校正);STORM(多专家视角驱动大纲)。
- **关键点**:结构化产出 + 自校正闭环替代自由文本;长文用结构化压缩模板(Goal/Constraints/Progress/Next/Files)防失忆;Meta-Skill 失败回退普通轮。
- **网页端**:所见即所得编辑器,章节级流式渲染(marked + shiki);大纲→草稿→精修分阶段可审批 UI;引用做可点击溯源脚注;长文 `background` 异步 + SSE 增量推章节。

### 6.3 调研(Deep Research,阶段三独立交付——本身即一个 MVP)

```
[网页调研面板] —SSE→ [ResearchOrchestrator]
 Plan(澄清范围) → Fan-out Search(并行子代理) → Read → Reflect
   → Verify(CitationAgent) → Synthesize(长文报告)
 ├ LeadResearcher (Opus 级, 规划+综合) + N 个并行检索子代理 (Sonnet/Haiku, 独立上下文)
 ├ web_search + web_fetch(readability) + MCP 数据源(Tavily/Exa/Firecrawl)
 ├ CitationAgent (独立阶段, 句级可溯源验证)
 └ 异步任务持久化 + 断点续研
```
- **借鉴**:Orchestrator-Subagent(Anthropic,+90.2%,子代理独立上下文避免污染);LangChain open_deep_research(Scope→Research→Write);MetaGPT Researcher SOP;opensquilla deep-research meta-skill;**CitationAgent 独立验证**(治 statement/citation 幻觉——OpenAI Deep Research 引用准确率仅 ~78%);MCP 驱动工具层(换源不改 agent)。
- **关键点**:检索召回率是最大瓶颈(agentic search 子查询分解 + 迭代检索);**token 预算自适应子代理数(简单 1、复杂 10+,多 agent ~15× 消耗)+ prompt caching + 计费 metering 把成本归到 per-user**;HITL 置于研究计划审批(fan-out 前)。**评审定性:多代理 deep research + 断点续研工程量大,作为独立阶段而非塞进首个 MVP。**
- **网页端**:`background` + SSE 推 thought/搜索进度/子报告;规划阶段流式展示 subtopics 供审批;任务持久化 + 断点续研;报告引用可点击溯源。

### 6.4 Computer Use(11 仓覆盖最弱,阶段四自建)

```
[网页 computer use 面板] —SSE(控制)+ 独立WS/WebRTC(截图)→ [ComputerUseAgent]
 闭环: AX树/截图快照 → 推理 → 动作 → 再快照
 ├ 执行层: Stagehand v3 (TS, 封装 Playwright/CDP, 多模型后端)
 ├ 感知: DOM/AX-tree 优先 (省 token) + 视觉兜底 (OmniParser v2)
 ├ 模型: Claude computer-use (OSWorld 最强) / Gemini 2.5 CU (成本低)
 ├ 浏览器: Browserbase/Steel(本身已隔离, 不叠 E2B)
 └ 硬边界: 沙箱内零凭证(凭证代理外置签名放行) + HITL强确认 + 域名白名单 + 审计
```
- **借鉴**:cline BrowserSession(CDP launch/screenshot/click/type/scroll 完整协议,直接抄设计);OpenHands web computer-use(截图流 + 内嵌 IDE);gemini-cli BrowserAgent 防注入规则;执行层 Stagehand v3(TS 同构,避免 browser-use 的 Python 边界);模型 Claude(OSWorld 66.3%)主力 / Gemini 2.5 CU 备 / UI-TARS-2(Apache-2.0 自托管)。
- **关键点**:DOM 优先视觉兜底;**prompt injection 未解,硬边界是凭证不在执行域,sandbox 只限爆炸半径**;成本工程化(AX 树快照减视觉调用 + 限最大步数 + 分段检查点)。
- **网页端**:**截图流独立二进制通道(JPEG/WebP+帧差)或云浏览器 CDP/VNC 远程渲染,不混 token SSE**;浏览器在云沙箱,网页只是观测+控制面板;全平台扩展路径:web 循环打牢后复用到桌面(OSWorld)/Android(AndroidWorld),差异仅执行后端。

### 6.5 日常规划(生活域全仓空白,阶段五自建)

```
[网页规划面板/日历视图] —SSE→ [PlanningAgent]
 ├ Plan/Act 双模式 (plan 只读探索产计划 → 显式授权 act 执行)
 ├ 结构化 TODO (task_progress checklist 持久化 + 文件监听防目标漂移)
 ├ Cron 调度器 (定时 agent 任务 + 心跳协调)
 ├ 主动提醒 (事件合并 + 优先级带 + 活跃时段掩码, 防刷屏/夜间打扰)
 ├ 生活域工具 (日历/邮件/提醒 — 经 MCP 接 Google Calendar/Gmail, 凭证沙箱外)
 └ 长期记忆 (目标分解; 此处才评估 mem0/Zep + Dream 巩固)
```
- **借鉴**:Plan/Act 双模式(codex Plan Mode `<proposed_plan>` + PlanDelta;cline `plan_mode_respond`;OpenHands PLAN agent + PLAN.md);cline FocusChain(checklist 持久化 + chokidar 监听防目标漂移);**opensquilla 心跳协调器(事件 coalesce + 优先级带冷却 + 活跃时段掩码夜间不打扰,poll 驱动非常驻)** + APScheduler/croniter cron;生活域经 MCP 接 Google Calendar/Gmail(11 仓共同空白);记忆 mem0/Zep + Dream(证据门控,receipts/quarantine 防污染)。
- **关键点**:主动行为必须节流;Plan 模式产可审阅计划再显式授权;目标分解 + 长期记忆需自建结构化层;记忆巩固证据门控 + TTL 防过时事实放大。**此阶段才是 archival memory 真有需求处(MVP 不引)。**
- **网页端**:日历视图 + 看板/checklist UI;主动提醒经 Web Push;durable session + 心跳 poll 断连恢复;多端并发输入用 durable 输入模型。

### 6.6 跨能力共享基础设施(一次建,多处用)

| 共享件 | MVP 机制 | 后续升级 | 主参考 |
|---|---|---|---|
| Agent 主循环 | 自研最小 async-generator,可中断/流式 | orchestrator-subagent + fork | claudecode + pi |
| 工具系统 | Schema + 元数据 + 落盘投影,全量暴露 | ToolExposure 四态 + ToolSearch | codex + claudecode + opensquilla |
| 上下文/记忆 | 单级压缩 + Context Epoch | 三级压缩 + cache-editing + archival | claudecode + opencode + opensquilla |
| provider | AI SDK + LiteLLM | `@arclight/llm` + ThinkingLevel | opencode + pi + aider |
| 沙箱/权限 | 本地 nono/系统 bwrap + 命令黑名单 + 凭证外置 | 多后端 ABC + 渠道矩阵 + 渐进信任 | codex(思路) + opensquilla |
| 扩展 | SKILL.md + MCP 双向 + Hooks | jiti 运行时扩展 + marketplace | opensquilla + codex + opencode |
| 会话持久化 | SQLite + 乐观锁 epoch + migrations | durable 输入 + fork 历史树 + Postgres | opensquilla + opencode + cline |
| 多端协议 | 单 repo 共享 TS 类型 + SSE | AG-UI 适配器 + 自建流式 codegen SDK | opencode + cline |
| 横切地基 | 认证 + 租户建模 + 计费 + 密钥 + 审计 + eval | RLS + KMS + 限流 + 导出删除 | 自建(原蓝图缺,本次补) |

---

## 7) 跨平台策略

**核心原则:同一内核服务,各端只换壳。** 内核做成 MCP server(Streamable HTTP + stdio 双模式)+ 事件流,无 UI 依赖。**MVP 仅交付 Web;其余端按优先级后置。**

| 端 | 方案 | 论证 | 优先级 |
|---|---|---|---|
| **Web(先发)** | Next.js App Router + Vercel AI SDK v6 + assistant-ui,调用内核 HTTP/SSE server;PWA Manifest "安装到桌面" | 网页优先标准答案,验证完 UX 再做原生壳 | **P0(MVP)** |
| **CLI** | Bun --compile --bytecode 单二进制 + arg0 multicall;TUI 用 OpenTUI | 零依赖、启动快、一二进制多形态 | P2 |
| **桌面** | **Tauri 2.0**(系统 WebView,~12MB);spawn 本地内核 sidecar 或连远程 server | Electron sidecar 包体大/资源高;Tauri 覆盖 iOS/Android | P3(先 PWA 过渡) |
| **VSCode 插件** | Chat Participants API(@arclightagent)+ MCP server 注册 | 复用 Copilot 订阅、零聊天 UI 开发 | P3 |
| **Chrome 扩展(MV3)** | side panel 主 UI + background service worker;WS 连本地内核 | MV3 禁 eval/远程 JS,推理经外部 API;computer-use 浏览器侧天然载体 | P4 |

**跨端共享配置**:存 `~/.config/arclightagent/`(XDG;**密钥不明文存此,见 §5.5**),CLI/桌面直接读写,Chrome 扩展经本地内核中转。**桌面壳明确结论:Tauri 2.0,不用 Electron**;纯 TS 团队可先 PWA "安装到桌面"过渡。

---

## 8) 关键技术决策表

| 决策 | 选择 | 理由 | 权衡/修订 |
|---|---|---|---|
| 构建策略 | 自研内核 + 借用模块 | 11 仓全专精写代码;内核机制已成熟 | 前期搭骨架慢于 fork,但避免半成品/技术债 |
| 语言/运行时 | TS + Bun(承认 TS 编排+受控 sidecar) | 网页优先前后端同构;迭代快 | **不夸大「零异构」;Stagehand 选 TS 压低 Python 边界** |
| 核心骨架 | headless 内核服务 + SSE | 后端写一次多端复用 | **MVP 单 repo 共享类型,SDK 自动生成/AG-UI 后置** |
| 主循环 | 自研最小 async-generator | 流式/中断统一;避免「先增后拆」 | **MVP 不引 LangGraph**(原蓝图引入再拆是净负) |
| provider | MVP 用 LiteLLM+AI SDK,后下沉 | provider 中立、快速上线 | **caching 只对主力 provider 做满,网关只保前缀稳定** |
| 记忆 archival | **MVP 不引;阶段四再评估** | 写代码/调研为会话内上下文 | mem0 benchmark 是供应商自报,不写成既定收益 |
| 沙箱 | 默认本地(nono/系统 bwrap exec)+ opt-in E2B | 个人 Agent 数据默认不出本机 | **Linux 不 vendoring bwrap(LGPL);SaaS opt-in 文档化数据流** |
| 浏览器自动化 | Stagehand v3(TS) | 不造轮子,DOM+AX 混合 | **浏览器用 Browserbase/Steel,不叠 E2B(避双层远程)** |
| computer-use 截图 | 独立二进制 WS/WebRTC + JPEG/WebP 帧差 | PNG 混入 SSE 会打爆带宽 | 长会话可用云浏览器 CDP/VNC 远程渲染 |
| computer-use 安全 | 沙箱内零凭证 + 凭证代理外置签名放行 | prompt injection 不可彻底解决,硬边界是凭证不在执行域 | HITL/白名单/审计为纵深防御补充,非唯一依赖 |
| 认证/密钥 | 用户身份一等体系 + keychain/KMS | 网页多租户的 P0 地基 | **原蓝图缺口,本次补;禁明文 ~/.config** |
| 多租户隔离 | RLS/schema-per-tenant + 沙箱 per-tenant | epoch 是并发控制不是隔离 | **MVP 即按 tenant_id 建模,避免后期撕裂** |
| 计费/计量 | per-user token/沙箱/会话 metering + quota | 多代理 ~15× token 放大成本 | **原蓝图缺口,本次补** |
| eval | MVP 即建 ≥10 golden case | 证明移植无退化;路由前必建 | **原蓝图缺口;无 eval 不谈自动降级路由** |
| 数据层 | SQLite→Postgres + 乐观锁 epoch | 单机够用,服务化平滑迁 | Redis 流恢复后置到阶段二 |
| 桌面壳 | Tauri 2.0 | 包体小、覆盖移动 | MVP 先 PWA 过渡 |

---

## 9) 分阶段路线图(已按评审重新定界)

> 模型分层纪律(全程强制):central 综合/架构决策 → Opus;执行类中等任务 → Sonnet;读文档/抽列表等机械工作 → Haiku/Flash。多 agent 编排按 subagent 角色分配模型层级。
>
> **核心修订:原「6-8 周五端骨架 + 双能力」经评审定性为 3-5 人团队 4-6 个月的量,严重失真。下面把首个 MVP 砍约 70% 范围,并把高风险持久化/多代理/computer-use 拆为独立后续阶段。**

### 阶段一:网页端 MVP(收窄版,~6-8 周,1-3 人)

**范围(重定界)**:Web **单端** + **写代码单能力** + **单用户** + **本地优先沙箱**。证明「单内核 + 网页优先 + 一条能力端到端 + 地基不缺」。

**交付物**:
1. **内核服务**(Bun+Hono):**自研最小 async-generator 主循环**(不引 LangGraph)+ 工具系统(Schema + 元数据 + 全量暴露,工具 <20)+ provider 抽象(AI SDK + LiteLLM,至少 Anthropic/OpenAI/Gemini)+ **单级压缩**(满即摘要)+ SQLite 持久化 + 乐观锁 epoch + **按 tenant_id 建模**。
2. **网页前端**(Next.js + AI SDK v6 + assistant-ui):聊天 + 工具渲染 + 权限对话框 + 消息流;**SSE + 心跳 + 「刷新不丢」最朴素流恢复**(不上 Redis resumable)。**单 repo 共享 TS 类型,零 codegen**。
3. **写代码能力**:RepoMap(tree-sitter+PageRank)+ SEARCH/REPLACE + **本地沙箱(nono/系统 bwrap exec)默认**执行 + Monaco diff + shadow-git 检查点 + 反射验证闭环。
4. **地基(一等,不可省)**:单用户**认证**(localhost/自托管单租户)+ **密钥管理(OS keychain,禁明文)** + **计费/计量骨架**(per-user token 计数 + quota)+ **统一审计日志去向** + **基础限流** + **eval harness(≥10 golden 编码 case)** + Langfuse trace + 结构化日志。
5. **MCP 接入**(Streamable HTTP,**外部凭证沙箱外存储**)+ 基础 Skills(SKILL.md)+ 基础权限(approval + 命令黑名单)。

**验收标准**:
- 网页端完成真实编码任务(改多文件 + 跑测试 + 验证 + 检查点回滚),**全程沙箱默认本地、零真实凭证进执行域**。
- eval harness 上 ≥10 golden case 通过,作为后续移植不退化的基线。
- 同一内核 server 可被一个最小 CLI 客户端连上(证明骨架解耦)。
- KV-cache 命中率(对 Anthropic)可观测;计费/审计/认证事件落到统一去向。
- **合规自检通过**:仓库零 GPL/LGPL 源码(CI 拦截)、Apache-2.0 复制文件均有 NOTICE。

**明确后置(不在阶段一)**:resumable/durable 输入/fork 历史树、多代理 deep research、computer-use、写作、日常规划、AG-UI、OpenAPI→TS SDK 自动生成、mem0、ToolExposure 四态、三级压缩、`@arclight/llm` 独立包。

### 阶段二:持久化加固 + 上下文升级 + 写作能力(~5-7 周)

**范围**:把阶段一后置的高风险持久化做扎实,补写作能力,升级压缩。
**交付物**:**resumable-stream(Redis)+ 断线 replay 去重 + durable 输入(steer/queue)+ epoch 冲突合并 UX**(UX 已在阶段一验证后再上);**三级压缩(含 cache-editing microcompact)+ Context Epoch**;**opensquilla paper-* skill 移植(Apache-2.0,按 NOTICE)** + MetaGPT ActionNode 结构化输出 + 网页富文本编辑器 + 分阶段审批 UI + 文档生成(docx/pptx/pdf/latex)。
**验收**:刷新/切设备/断线不丢生成且无重复事件;网页端从一句话需求产出带引用、可分阶段审批的长文;长会话 cache 命中率与成本显著改善。

### 阶段三:Deep Research(独立 MVP,~5-7 周)

**范围**:多代理调研(评审定性为本身即一个独立 MVP)。
**交付物**:Orchestrator-Subagent(LeadResearcher Opus + 并行子代理 Sonnet/Haiku,独立上下文)+ web_search/web_fetch + MCP 数据源 + **独立 CitationAgent**(句级溯源)+ 异步任务持久化 + 断点续研 + 流式 subtopics 审批 UI + **自适应子代理数 + per-user token 计费**。
**验收**:网页端完成一次 deep research(规划审批→并行检索→可点击溯源引用长文),3-30 分钟任务断点续研;成本归到 per-user,多 agent token 可观测。

### 阶段四:computer-use + 沙箱强化 + 日常规划(~6-8 周)

**范围**:web computer-use(安全模型按 M1/M4)+ 生活域规划 + 主动性。
**交付物**:ComputerUseAgent(DOM/AX 优先 + 视觉兜底)+ Stagehand v3 执行层 + **Browserbase/Steel(已隔离,不叠 E2B)** + **独立 WS/WebRTC 截图流(JPEG/WebP 帧差)/ 云浏览器 CDP-VNC** + **凭证外置签名放行 + HITL 强确认 + 域名白名单 + 审计**;sandbox 升级多后端可插拔 ABC;Plan/Act + FocusChain + **心跳协调器(事件合并 + 优先级带 + 活跃时段掩码)** + cron;MCP 接 Google Calendar/Gmail(凭证沙箱外);**此阶段才评估并接入 archival memory(mem0/Zep + Dream,先验证收益再上)**;日历视图 + 看板 + Web Push。
**验收**:浏览器自动化任务到确认前一步,高危动作强制确认且沙箱内无真实凭证,完整审计;agent 定时产每日简报、按规划主动提醒(夜间不打扰)。

### 阶段五:全平台壳 + 多租户服务化 + 高级编排 + 省钱(~6-8 周)

**范围**:CLI/桌面/插件 + 多端协议基建 + 多租户化 + 编排/成本强化。
**交付物**:**第二端起上 OpenAPI→TS SDK 自动生成(预留自建流式 codegen 预算)+ AG-UI 适配器**;CLI(Bun --compile + multicall + OpenTUI)、桌面(Tauri 2.0,先 PWA 过渡)、VSCode 插件(Chat Participants + MCP)、Chrome 扩展(MV3);**数据层迁 Postgres + RLS/schema-per-tenant + 沙箱 per-tenant + KMS/Vault 密钥 + 多租户计费/quota**;多智能体升级(fork 共享父 cache + coordinator 独立验证 + TeamLeader 总线 + thread_spawn_depth);Plugins marketplace + Hooks + jiti;**provider 网关下沉为 `@arclight/llm` + ThinkingLevel**;**基于已建 eval 的分层路由(选最便宜可胜任模型 + KV-cache anti-downgrade,先有 eval 再调路由)**。
**验收**:五端全部连同一内核 server;全平台用户配置共享;多租户隔离与计费经审计验证;多智能体性能与成本优于早期阶段且有 eval 佐证。

---

## 10) 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| **MVP 范围超载(原 6-8 周实为 4-6 月)** | 高 | **已按评审重定界**:阶段一砍约 70%——Web 单端 + 写代码单能力 + 单用户 + 本地沙箱;多代理 research / computer-use / 持久化加固拆为独立阶段 |
| **prompt injection(computer-use 根本风险)** | 高 | **硬边界 = 沙箱内零真实凭证 + 凭证代理外置按动作签名放行**;HITL 强确认 + 域名白名单 + 审计 + 二次 LLM 审查为纵深补充,非唯一依赖 |
| **网页端任意代码执行的数据驻留(SaaS 沙箱)** | 高 | **本地沙箱默认,SaaS opt-in 且文档化数据流**;Linux 用系统 bwrap(exec)/nono |
| **截图流打爆 SSE/带宽** | 高 | **独立二进制 WS/WebRTC + JPEG/WebP + 帧差**;长会话用云浏览器 CDP/VNC 远程渲染;绝不混 token SSE |
| **认证/计费/多租户隔离/密钥/eval 地基缺失** | 高 | **已升为一等设计**(§5.5/§5.6/§2.1):用户身份体系、per-user metering+quota、RLS/沙箱 per-tenant、keychain/KMS、≥10 golden eval、统一审计 |
| **多 agent token 成本失控(~15×)** | 高 | 自适应子代理数 + prompt caching + 模型分层 + 最大步数 + **per-user 计费归因 + Langfuse 成本追踪**;且 deep research 后置为独立阶段 |
| **codex vendored bubblewrap LGPL-2.0 拖入** | 高 | **Linux 沙箱只 exec 系统包 bwrap,零 vendoring/零链接/零分发其源码;CI 拦截 GPL/LGPL 源码入树** |
| **Apache-2.0 复制缺 NOTICE / OpenClaw attribution 漏追** | 中 | 根 `NOTICE` 记录每个派生文件;OpenClaw 派生 SKILL(sub-agent/cron/...)追 attribution;**paper-* 经核验为 opensquilla-original(Apache-2.0),不涉 OpenClaw** |
| **「先增后拆」LangGraph 净负** | 中 | **MVP 不引 LangGraph,直接自研最小 async-generator**(已有 pi/claudecode 设计可抄) |
| **「Bun 同构」被 Python sidecar 打破** | 中 | 诚实定性为「TS 编排 + 受控 sidecar」;执行层优先 TS(Stagehand);承认的 sidecar 仅 LiteLLM(可拆)与独立服务,经稳定 HTTP 契约隔离 |
| **provider 中立 vs KV-cache 张力** | 中 | caching 只对主力 provider(Anthropic)做满,网关层只保前缀稳定;命中率作主力 provider 头号指标 |
| **OpenAPI→TS SDK 对 SSE 表达力弱** | 中 | MVP 单 repo 共享类型零 codegen;第二端起预留自建流式事件 codegen 预算 |
| **mem0 收益未验证 + 多一个 Python 服务** | 中 | MVP 不引;阶段四真需 archival 时先验证收益再上(mem0/Zep 备选) |
| **多端并发覆盖会话** | 中 | 乐观锁 epoch + durable 输入(后置到阶段二),与 RLS 租户隔离区分清楚 |
| **Bun/Effect 生态小众** | 中 | 不引 Effect 4.x beta;Bun 仅用稳定特性,关键路径保留 Node 兼容回退 |
| **SQLite 多租户撞墙** | 中 | 数据层从第一天按 tenant_id 建模;阶段五迁 Postgres + RLS |
| **五能力同栈 system prompt 污染** | 中 | **升为内核一等约束(非风险表补丁)**:每能力 = 独立 agent profile + 工具子集 + 独立 cache 前缀 |
| **AG-UI 年轻/16 事件覆盖不全** | 中 | 内核用自定义事件模型,AG-UI 仅作可选第三方适配器,不绑架内核语义 |
| **OpenHands enterprise/(PolyForm)误用** | 中 | 构建显式排除整个 `enterprise/` 树(含 integrations/) |
| **无 eval 时做自动降级路由是盲调** | 低 | 先建 eval(阶段一)再谈分层路由(阶段五) |

---

**核心拍板复述(已对抗式评审修订)**:不 fork 任何基座(11 仓全专精写代码 + claudecode 闭源无 LICENSE/无 package.json/含 `USER_TYPE==='ant'` + codex Apache-2.0 但工程重且 vendored bubblewrap 为 LGPL-2.0 + opencode MIT 但半成品中间态),用 TypeScript/Bun 自研 UI 无关的 headless 内核服务,以 opencode 的 server/client 分离为骨架蓝本,按子系统移植各仓 best_pick 模块设计;网页端先发,五端共享同一内核但 **MVP 只交付 Web 单端 + 写代码单能力 + 单用户 + 本地沙箱**;写作借 opensquilla paper-*(opensquilla-original / Apache-2.0)、调研作独立后续阶段、computer-use 借 OpenHands+cline 且**截图走独立二进制通道、凭证一律沙箱外签名放行**、日常规划自建(MCP 补日历/邮件);沙箱借 codex **思路**但 **Linux 只 exec 系统 bwrap 规避 LGPL**、默认本地 SaaS opt-in、浏览器用已隔离的 Browserbase/Steel 不叠 E2B;桌面用 Tauri 不用 Electron;**认证/计费/多租户隔离/密钥/eval 五块地基从第一天即为一等设计**;**不引 LangGraph(避免先增后拆)、MVP 不引 mem0/AG-UI 自动 SDK/ToolExposure 四态/三级压缩/durable 输入(全部后置)**。所有 load-bearing 论断与许可证结论均已逐文件核验(LGPL bubblewrap、OpenClaw vs opensquilla-original SKILL 归属、PolyForm enterprise、claudecode 闭源、各仓根 LICENSE 一致)。
