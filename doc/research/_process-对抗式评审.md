Important nuance confirmed: codex **vendors the full bubblewrap C source** (`bubblewrap.c`, `bind-mount.c`) under **GNU Library GPL v2 (LGPL-2.0)** and has its own `codex-rs/bwrap/` build target — meaning codex compiles/links it, not just shells out to a system binary. This is a real copyleft consideration the blueprint completely omits. I have all the evidence I need.

# arclightagent 蓝图对抗式架构评审

> 评审基准:已用 Bash 逐一核验 `/Users/fsm/project/arclightagent/` 下 11 个仓库的真实 LICENSE 文件(见"许可证风险"节附证据路径)。下面所有许可证结论均有文件级证据,非二手转述。

---

## 一、必须修复(硬伤,不改会出事)

### M1. 沙箱与 computer-use 的「网页端任意代码执行」安全模型被严重低估,且选型自相矛盾
蓝图一边说「任意代码与 computer-use 必须内核级隔离」,一边把隔离实现散落成 **E2B(SaaS)/ Vercel Sandbox(SaaS)/ nono(本地)+ codex 三平台原生思路** 四套并存,却没有一条贯穿的信任边界定义。问题:
- **prompt injection 你自己也承认「不可彻底解决」,但缓解措施全压在应用层 HITL + 域名白名单上**——这恰恰是最不可靠的一层(模型被注入后会主动绕过白名单的呈现)。真正的硬边界应该是:沙箱内**没有任何真实凭证**(凭证代理在沙箱外、按动作签名放行),而蓝图写的是「凭证隔离」却把云浏览器 session、Gmail/Calendar MCP token 都放进了同一执行域。
- **「base64 PNG 截图流经 SSE」对一个多分钟 computer-use 会话是带宽与成本灾难**:1080p PNG 单帧数百 KB,闭环每步一帧,几十步就是几十 MB,且 PNG 无法增量。OpenHands 能这么做是因为它是单用户本地;网页多租户下这条会直接打爆 SSE 通道和出口带宽。**修复**:截图走独立的二进制 WebSocket/WebRTC 通道 + JPEG/WebP + 帧差,绝不混在 token SSE 里;或干脆用 VNC/CDP 的远程渲染(你把 VNC 当反面教材是错的——VNC 在多租户云浏览器里恰恰更省)。
- **E2B/Vercel Sandbox 是第三方 SaaS,意味着用户的任意代码 + 文件 + 可能的密钥流向第三方**。对一个「个人 AI Agent」这是合规和信任硬伤,蓝图只字未提数据驻留。**修复**:MVP 阶段就要明确「本地优先沙箱」是默认,SaaS 沙箱是 opt-in,且文档化数据流。

### M2. 「单内核同时支撑五端 + 流式 + 持久化」的工程量被乐观估计了一个量级
- **6-8 周 MVP 要同时交付**:headless 内核 + async-generator 主循环 + 工具系统(含元数据/并发调度/落盘投影)+ provider 网关 + 单级压缩 + SQLite + **乐观锁 epoch** + OpenAPI→TS SDK 自动生成 + AG-UI 事件流 + SSE 心跳 + **resumable-stream(Redis)** + Next.js/assistant-ui 前端 + **RepoMap(tree-sitter+PageRank)** + SEARCH/REPLACE + E2B 执行 + Monaco diff + **shadow-git** + 反射闭环 + **Orchestrator-Subagent 多代理调研** + CitationAgent + 断点续研 + MCP 接入 + Skills + 权限模型。这不是 6-8 周,这是一个 3-5 人团队 4-6 个月的工作量。**多代理 deep research + 断点续研** 本身就是一个独立 MVP。
- **resumable streams + durable session + 多端并发 epoch 冲突**这三件,蓝图说「第一天设计进去」,但它们的正确实现(尤其是 SSE 断线重连后的事件 replay 去重 + epoch 冲突的用户侧合并 UX)是出 bug 最多的地方,放进第一阶段是把最高风险压在最早期。**修复**:MVP 砍到「单端(Web)+ 单能力(写代码)+ 单用户 + 会话内存态可丢」,把 resumable/durable/多端 SDK 生成挪到阶段二验证过 UX 之后。

### M3. 选型不自洽:Bun + Hono 内核 vs. 大量 Python/重运行时依赖
- 蓝图核心卖点是「TS/Bun 前后端同构」,但实际执行层全是**异构进程**:browser-use(Python)、mem0(主力 Python)、LiteLLM Proxy(Python)、E2B(独立服务)、Langfuse(独立服务)。**所谓「同构」在 MVP 第一天就被打破**——你的内核要 spawn/HTTP 调一堆 Python 服务,运维和打包复杂度和直接用 Python 后端没本质区别,反而多了一层语言边界。要么承认这是「TS 编排 + 多语言 sidecar」架构(那 Bun 同构的论证就站不住),要么真的用 TS 原生替代(Stagehand TS、自建记忆),二选一,不能两头占。
- **同时引入 LangGraph(Python 生态重)做编排底座,又说阶段二要拆掉换自研 async-generator**——这是明确的「先增后拆」反模式。LangGraph 的 checkpointer/状态模型会渗进你的会话持久化层,「接口化后好替换」在实践中几乎从不成立(M7 详述)。**修复**:MVP 如果选 TS/Bun,就别引 LangGraph;直接写最小 async-generator 循环(你已经有 pi/claudecode 的设计可抄),反而比「引入再拆」省。

### M4. computer-use 的执行层 Stagehand v3 / browser-use 选型与「沙箱内运行」要求冲突
蓝图要求 computer-use「必须跑沙箱内」,但 Stagehand/browser-use 都假设直连一个可控浏览器。把它们塞进 E2B microVM 里再驱动 Browserbase 远程 Chrome,是**双层远程**(microVM → 远程浏览器),延迟和故障面叠加,且 Browserbase 本身就是隔离浏览器——**E2B 这层在浏览器场景是冗余的**。修复:浏览器 computer-use 用 Browserbase/Steel(已隔离),代码执行用 E2B,两条路径分开,别叠。

---

## 二、建议改进

- **B1. AG-UI 还很年轻,「16 种标准事件」覆盖不了 computer-use 截图流、diff 视图、引用溯源这些富交互**。把它当唯一对外协议会过早锁死。建议:内部事件模型自定义,AG-UI 只作为一个可选适配器(给第三方接入用),不要让内核语义被 AG-UI 的 16 事件绑架。
- **B2. mem0 的 benchmark 数字(高 26%/低 91% 延迟/省 90% token)是供应商自报,且 LoCoMo 是对话记忆基准,与你的「写代码 RepoMap / 调研引用」场景不重合**。别把它写成既定收益。MVP 不需要 archival memory,这是过度设计(见裁剪项)。
- **B3. KV-cache 命中率被反复强调为「头号成本指标」,但你的 provider 网关(LiteLLM + 多 provider 中立)与 prompt caching 是天然冲突的**——caching 是各家强绑定的(Anthropic 显式 cache_control、OpenAI 自动前缀缓存、Gemini 又不同)。「provider 中立」和「极致 KV-cache」不可兼得,蓝图把两者都列为第一优先却没承认张力。建议:明确「caching 优化只对主力 provider(Anthropic)做,网关层只保证不破坏前缀稳定性」。
- **B4. 自动生成 TS SDK(OpenAPI→TS)对 SSE/流式事件类型生成支持很差**(OpenAPI 对 server-sent events 表达力弱)。opencode 能做是因为它有自定义 codegen。别假设这是「免费」的,留出自建 codegen 的预算。
- **B5. 「五大能力同栈 system prompt 互相污染」蓝图已识别(风险表),但缓解(Skill + agent profile 隔离)是对的方向却放在风险表而非架构核心**——它应该是内核的一等设计约束(每个能力是独立的 agent profile + 工具子集 + 独立 cache 前缀),而不是事后补丁。

---

## 三、许可证风险(逐仓核验,附证据路径)

| 仓库 | 实际许可证(已核验) | 证据路径 | 对「基座/借用」的影响 |
|---|---|---|---|
| **aider** | **Apache-2.0** | `aider/LICENSE.txt` | 蓝图说「repomap.py 直接抄」——**Apache-2.0 允许,但必须保留版权声明 + NOTICE,且不能去掉头部**。蓝图未提 NOTICE 义务。`repomap.py` 文件头无 license 标记(依赖根 LICENSE),逐文件复制时务必附 attribution。 |
| **cline** | **Apache-2.0**(根 + `apps/vscode` 各一份) | `cline/LICENSE`, `cline/apps/vscode/LICENSE` | 借 BrowserSession 协议设计:Apache-2.0 友好,有专利授权条款(对你有利)。 |
| **codex** | **Apache-2.0** | `codex/LICENSE` | 但**内嵌 vendored bubblewrap = LGPL-2.0(GNU Library GPL v2)**,见下方 ⚠️。 |
| **codex/vendor/bubblewrap** | **⚠️ LGPL-2.0(GNU LIBRARY GPL v2)** | `codex/codex-rs/vendor/bubblewrap/COPYING` + 完整 C 源码 `bubblewrap.c`/`bind-mount.c` + 独立构建目标 `codex-rs/bwrap/` | **这是蓝图完全漏掉的真实 copyleft 风险**。codex 不是 shell 调系统 bwrap,而是 vendoring 并自建编译。你若「借 codex 三平台沙箱思路」并连带其 Linux 路径,会把 LGPL 源码拖进来。LGPL 在「动态链接/独立进程调用」下可控,但**静态编译进你的二进制需开放对应目标文件以允许替换**。修复:Linux 沙箱**只通过 exec 调用系统安装的 bwrap 二进制**(系统包,不 vendoring),彻底规避;或改用纯 MIT/无依赖路径。 |
| **gemini-cli** | **Apache-2.0** | `gemini-cli/LICENSE` | 借 BrowserAgent 防注入规则:友好。 |
| **qwen-code** | **Apache-2.0** | `qwen-code/LICENSE` | 友好。 |
| **OpenHands(核心)** | **MIT** | `OpenHands/LICENSE`(明示:enterprise/ 之外皆 MIT) | 借 web computer-use / sandbox ABC / skills:友好。 |
| **OpenHands/enterprise/** | **⚠️ PolyForm Free Trial License 1.0.0** | `OpenHands/enterprise/LICENSE`(`Copyright (c) 2026 All Hands AI`) | **非开源,仅试用**。`enterprise/` 含 analytics、integrations、Dockerfile、alembic 等大量目录。蓝图说「不碰即可」正确,但要**显式在构建中排除整个 enterprise/ 树**,且注意其中的 integrations/ 可能正是你想参考的部分——**那些恰恰碰不得**。 |
| **pi** | **MIT** | `pi/LICENSE`(`Mario Zechner`) | 借纯函数循环/ThinkingLevel:最友好,可直接借代码。 |
| **MetaGPT** | **MIT** | `MetaGPT/LICENSE`(`Chenglin Wu`) | 借 ActionNode/TeamLeader:友好。 |
| **opencode** | **MIT** | `opencode/LICENSE`;子包 `packages/http-recorder/LICENSE`、`packages/docs/LICENSE` 另有独立 LICENSE | 作为骨架蓝本:友好。**注意子包许可证未核验内容**,若借 http-recorder 需单独看其 LICENSE。 |
| **opensquilla** | **Apache-2.0** + 多个第三方 MIT 内嵌 | `opensquilla/LICENSE` | 见下方 ⚠️ tokenjuice/OpenClaw。 |
| **opensquilla/tokenjuice + bundled skills** | **⚠️ 内嵌上游 MIT(多个第三方)** | `opensquilla/THIRD_PARTY_NOTICES.md`、`opensquilla/src/opensquilla/plugins/tokenjuice/PROVENANCE.md` | tokenjuice 规则派生自 `github.com/vincentkoc/tokenjuice`(MIT, Vincent Koc);**bundled skills(sub-agent/cron/github/nano-pdf/skill-creator/summarize/tmux/weather)派生自 OpenClaw**(MIT, Peter Steinberger)。蓝图说「paper-* skill 直接移植为 SKILL.md」——**若你移植的 SKILL.md 命中 OpenClaw 派生的那批,你继承的是 OpenClaw 的 MIT 而非 opensquilla,attribution 链要追到 OpenClaw**。`SquillaRouter V4 模型 bundle` 另有单独条款,你蓝图阶段五已说要丢弃它(用轻启发式替),正确。 |
| **claudecode** | **⚠️ 无任何 LICENSE / 无 package.json,Anthropic 专有闭源** | 核验:`claudecode/` 下无 `LICENSE*`、无 `*.json`;`commands.ts`/`setup.ts` 实测含 `USER_TYPE === 'ant'` 内部门控 | **零代码可用**。蓝图「禁止复制 claudecode 任何代码,仅学架构」是对的,但要强调:**连「逐字照搬其 prompt 文本/工具描述/SKILL 文案」都属于复制**,不只是代码。架构思想可借,文本资产不可借。 |

**许可证总判**:无 AGPL,无 GPLv3,无 BSL/Elastic——总体可控。**两个真实雷点是蓝图遗漏的**:(1)codex vendored **bubblewrap LGPL-2.0**;(2)opensquilla 的 SKILL.md 实际 attribution 链指向 **OpenClaw**。蓝图原文只提了「tokenjuice + 媒体/渠道依赖」和「OpenHands enterprise」,**漏了 bubblewrap LGPL 和 OpenClaw 这两条**。Apache-2.0 源(aider/cline/codex/gemini-cli/qwen-code/opensquilla)逐一复制文件时的 **NOTICE/attribution 义务**在蓝图里也没有落地动作。

---

## 四、缺失环节(蓝图通篇未覆盖或一笔带过)

1. **认证 / 授权(用户身份)**:蓝图把 OAuth 2.1/PKCE 只用在 MCP 工具接入,**完全没有「用户登录到 arclightagent 本身」的认证体系**。一个「网页优先、多端、多租户」产品,谁是用户、如何登录、session 与 user 如何绑定——零设计。这是 P0 缺口。
2. **计费 / 用量计量**:LLM token、E2B 沙箱时长、Browserbase 会话、mem0/Langfuse 调用全是真金白银,蓝图无任何 metering/quota/cost-attribution-per-user 设计。多代理 deep research「~15× token」更放大此问题。
3. **多租户数据隔离**:蓝图提了「乐观锁 epoch 防并发覆盖」(那是并发控制,不是隔离),但**没有 tenant 边界**——SQLite→Postgres 迁移说「支持多租户」却无 row-level security / schema-per-tenant / 沙箱 per-tenant 的隔离模型。computer-use 凭证 + 会话历史跨租户泄漏是高危。
4. **可观测性的「最低限」**:Langfuse(trace)有了,但**无日志聚合、无指标(Prometheus)、无告警、无审计日志的统一去向**。蓝图把「审计日志」只挂在 computer-use 安全门上,而认证失败、权限提权、计费事件的审计全缺。
5. **评测(eval)**:11 仓里你要「移植最优模块」,但**没有任何回归/能力评测基线**。没有 eval,你无法证明移植后的写代码/调研能力没有退化,也无法做「模型分层路由」的成本-质量权衡。Deep research 的引用准确率、computer-use 的任务成功率都需要 eval harness。这是 MVP 就该有的(哪怕 10 条 golden case)。
6. **密钥管理**:provider API keys、MCP OAuth tokens、用户的 Google/Gmail 凭证——存哪、怎么加密、轮换策略,全无。`~/.config/arclightagent/` 明文配置对桌面单机尚可,对「网页多租户」是泄漏面。
7. **速率限制 / 滥用防护**:网页公开服务必备,蓝图无。
8. **数据导出 / 删除(GDPR-类)**:个人 AI Agent 持有大量私人数据(日历/邮件/写作),无删除与导出设计。

---

## 五、裁剪项(过度设计,MVP 应砍或后置)

1. **mem0 archival memory**:MVP 两大能力(写代码 + 调研)都是**会话内/任务内**上下文,不需要跨会话长期记忆。引入 mem0 = 多一个 Python 服务 + 一套未验证收益。**砍到阶段四之后**,日常规划真正需要长期记忆时再上。
2. **LangGraph 作编排底座**:见 M3/M7,先增后拆是净负。**直接砍掉**,MVP 写最小 async-generator。
3. **AG-UI + OpenAPI→TS SDK 自动生成 + 多端类型一致**:这是为「五端」服务的基建,但 MVP 只有 Web 一端。**自动 SDK 生成、AG-UI 适配全部后置到阶段五真有第二端时再做**。MVP 前后端同一 repo 直接共享 TS 类型即可,零 codegen。
4. **resumable-stream + durable 输入(steer/queue + advisory wake)+ 会话树 fork**:三个高复杂度持久化特性堆在阶段一。**fork 历史树、durable 输入后置**;resumable 只保留「刷新不丢」最朴素版。
5. **「provider 网关下沉为 @arclight/llm 独立包 + ThinkingLevel 6 档统一」**:阶段五的事,蓝图自己也说 MVP 用 LiteLLM+AI SDK——那就**别在架构图里把 @arclight/llm 画成核心组件**,容易误导团队提前投入。
6. **ToolExposure 四态 + Deferred/tool_search 延迟发现**:这是工具数量爆炸(几十上百)时才需要的 token 优化。MVP 工具数 <20,**直接全量暴露**,四态后置。
7. **三级压缩(snip→microcompact→autocompact)+ Context Epoch + cache-editing microcompact**:MVP 单级压缩(满了就摘要)足够,cache-editing microcompact 是 Anthropic 强绑定的高级优化,**后置到阶段二**(蓝图已部分后置,但阶段一仍写了「乐观锁 + 多 provider」太满)。
8. **「本地分层路由用轻启发式替 opensquilla 脆弱 ONNX」**:阶段五的省钱优化,在没有 eval(缺失项 5)前,任何自动模型降级路由都是盲调,**先建 eval 再谈路由**。

---

## 六、总评

**方向正确,自信过度,排期失真,合规有两处真漏。**

- **核心判断(不 fork、自研内核 + 借模块、网页优先)是站得住的**:11 仓确为编码专精,claudecode 实测闭源(无 LICENSE/无 package.json/含 `USER_TYPE==='ant'` 门控),codex 确为 Apache-2.0 但工程重且 vendoring LGPL bwrap,opencode 为 MIT。许可证大盘无 AGPL/GPLv3/BSL,可控。
- **但「网页优先 + 第一阶段 MVP」这条路线在当前范围定义下不成立**:M2 的工程量是 4-6 个月不是 6-8 周;M1 的网页端任意代码执行 + computer-use 安全模型有真实漏洞(SaaS 沙箱数据驻留、截图流带宽、凭证进了执行域、prompt-injection 缓解压在最弱的应用层)。**MVP 必须重新定界为:Web 单端 + 写代码单能力 + 单用户 + 本地沙箱**,把多端 SDK 生成、resumable/durable、多代理 deep research、computer-use 全部后置。
- **选型自洽性扣分**:「Bun 同构」卖点被 Python sidecar(browser-use/mem0/LiteLLM/Langfuse)和 LangGraph 当场打破(M3);computer-use 执行层 Stagehand 与「跑沙箱内」要求叠成双层远程冗余(M4)。
- **必须立刻补的两条许可证动作**:(1)Linux 沙箱**只 exec 系统 bwrap、绝不 vendoring codex 的 LGPL bubblewrap 源码**;(2)移植 opensquilla SKILL.md 时把 attribution 追到 **OpenClaw(MIT, Peter Steinberger)**,并对所有 Apache-2.0 源复制文件落实 NOTICE 义务。
- **必须立刻补的产品环节**:认证、计费/计量、多租户隔离、eval baseline、密钥管理——这五项是「个人 AI Agent 网页服务」的地基,蓝图几乎全缺。

**一句话**:把蓝图当「2.0 终态愿景」是优秀的;当「阶段一可执行计划」则范围超载、安全过乐观、合规漏两点。建议据此把阶段一砍掉约 70% 范围,补齐认证/计费/隔离/eval 四块地基,并在沙箱与 SKILL 移植上落实 LGPL 与 OpenClaw attribution 两条合规动作。

**证据文件路径(供复核)**:
- LGPL 雷:`/Users/fsm/project/arclightagent/codex/codex-rs/vendor/bubblewrap/COPYING`(+ `bubblewrap.c`、`codex-rs/bwrap/`)
- OpenClaw attribution 链:`/Users/fsm/project/arclightagent/opensquilla/THIRD_PARTY_NOTICES.md`、`/Users/fsm/project/arclightagent/opensquilla/src/opensquilla/plugins/tokenjuice/PROVENANCE.md`
- PolyForm 非开源:`/Users/fsm/project/arclightagent/OpenHands/enterprise/LICENSE`
- claudecode 闭源佐证:`/Users/fsm/project/arclightagent/claudecode/`(无 LICENSE/无 *.json),`commands.ts`、`setup.ts` 含 `USER_TYPE === 'ant'`
- 各仓根 LICENSE:`aider/LICENSE.txt`、`cline/LICENSE`、`codex/LICENSE`、`gemini-cli/LICENSE`、`qwen-code/LICENSE`、`OpenHands/LICENSE`、`pi/LICENSE`、`MetaGPT/LICENSE`、`opencode/LICENSE`、`opensquilla/LICENSE`