蓝图已对本子系统给出明确的边界与决策。我现在掌握了所有必要信息,直接产出拿来即用选型清单。

---

# arclightagent · 内核运行时(agent 主循环 + 工具系统 + MCP + 扩展)拿来即用选型清单

> 总原则贯彻:**现成件 = npm 可直接安装的成熟库优先;11 个参考仓只在「许可证允许且可搬」时复用代码,否则仅借设计、TS 重写。自研只留薄接缝。** 本清单与 `ARCHITECTURE_BLUEPRINT.md` §3/§7 的拍板一致:不 fork 基座、自研最小循环、MVP 不引 LangGraph。

## 0. 一句话结论

本子系统**几乎没有"现成的 agent-loop 库"可整体拿来用**——`@modelcontextprotocol/sdk`、`ai`(Vercel AI SDK)、`zod`、`jiti` 这四个 npm 库是真正"拿来即用"的现成件,覆盖了 **provider 流式、工具 schema、MCP 客户端/服务端、运行时 TS 扩展加载**;而 **agent 主循环本身只能自研一条薄的 async-generator 接缝**(Vercel AI SDK 的 agent 循环不够、其余仓的循环或闭源或绑 Effect/Rust,均不可搬)。Skills/Hooks 是**规范+约定,不是库**,自己写一个加载器即可。

---

## 1. async-generator 主循环

### 1) 直接采用的现成方案
| 候选 | 来源 | 许可证 | 提供什么 | 裁决 |
|---|---|---|---|---|
| **Vercel AI SDK `ai`** 的 `streamText` / `generateText` + `stopWhen` 多步工具循环 | npm `ai`(v5/v6) | **Apache-2.0** | 一个**内置的、可用的"调模型→执行 tool→回灌→再调"多步循环**(`maxSteps`/`stopWhen`)、统一流式事件、工具调用解析 | **部分采用**:把它当**单 turn 的 provider 调用 + 工具执行原语**用,**不**把它当你的顶层 agent 循环 |
| `@anthropic-ai/sdk` 的 beta messages + 手写 while | npm | MIT | 最贴近 claudecode 的原生流式/cache 语义 | 仅在需要极致 KV-cache 时,作 AI SDK 之下的直连后端(蓝图 §2.4) |
| Mastra / VoltAgent / LangGraph 等"agent 框架" | npm | 各自 | 完整 agent 运行时 | **不采用**(蓝图 M7:避免「先增后拆」,框架会绑架内核语义) |

**关键诚实判断:Vercel AI SDK 的 agent 循环"看似拿来即用、实则不够"。** 它的 `streamText({ stopWhen })` 能跑通"基础 ReAct 多步",但你的内核需要的**可中断(AbortController/`.return()`)、压缩边界 yield、steering/follow-up 队列注入、per-turn 重建**这些(claudecode `query()→queryLoop()`、pi `agent-loop.ts` 双队列、opencode durable 输入)它都**不原生提供**。强行套它做顶层循环 = 后期撕掉重写。

### 2) 集成成本量级
- AI SDK 作 turn 原语:**拿来即用**(npm i,5 行调通流式)。
- 顶层 async-generator 主循环:**轻度封装~需较多缝合**(自研,约 300-400 行,见接缝)。

### 3) 成熟度与风险
- `ai`:**生产可用**,Vercel 主推、生态最大、与 `useChat`/assistant-ui 原生适配(蓝图 §2.1 已选 Web 前端 AI 层)。风险:v5→v6 有 breaking change,工具/流式事件 schema 仍在演进,锁版本。
- **坑**:网上把 AI SDK 宣传成"agent 框架",实际它是 **provider 抽象 + 流式 + 基础多步**;真正的 agent 编排(中断/压缩/队列)是你自己的。别被 marketing 误导。

### 4) 仅保留的最小自研接缝(**这是接缝,不是轮子**)
```
queryLoop(): AsyncGenerator<AgentEvent>   // 约 300-400 行
  while(true):
    取消息 → (MVP:单级压缩满则摘要) → AI SDK streamText 调 provider(单 turn)
    yield token / tool-progress / compact-boundary
    解析 tool_use → 工具系统执行 → tool_result 回灌
    检查 AbortController.signal / steering 队列 / stop 条件
```
- 设计**直接照搬** claudecode `query.ts`(闭源,**仅学架构,文本/代码一字不抄**)+ **pi `agent-loop.ts`(MIT,可借代码)** 的纯函数双层循环 + steering/followUp 双队列。
- 每能力 = 独立 agent profile(独立 prompt 前缀 + 工具子集 + 独立 cache 前缀)。

### 5) 现在不要自研、推迟到产品成熟后
- **orchestrator-subagent / fork 共享父 cache / coordinator 独立验证**(蓝图阶段四/六)。
- **durable 输入(steer/queue + advisory wake)、resumable-stream、Context Epoch、三级压缩 + cache-editing microcompact**(阶段二+,MVP 只做单级压缩 + 「刷新不丢」最朴素流恢复)。
- **TurnTransitionError 式 per-turn 重建**(opencode 的 Effect defect 机制,绑 Effect 不可搬,后置)。

---

## 2. 工具调用与 schema

### 1) 直接采用的现成方案
| 组件 | 来源 | 许可证 | 提供什么 |
|---|---|---|---|
| **`zod`**(v4) | npm | **MIT** | 工具 `inputSchema` 定义 + 运行时校验,**生态事实标准** |
| **`zod-to-json-schema`** 或 zod v4 内置 `.toJSONSchema()` / AI SDK `tool()` | npm | MIT / Apache-2.0 | zod → JSON Schema(喂模型 / 喂 MCP) |
| **AI SDK `tool({ inputSchema, execute })`** | npm `ai` | Apache-2.0 | 把 zod 工具直接接入 streamText 的工具调用,**自动 schema 序列化 + 调用分发** |

### 2) 集成成本
**拿来即用**:`zod` + AI SDK `tool()` 直接定义工具,零自研 schema 层。

### 3) 成熟度与风险
- 全部**生产可用**。zod 是 TS 生态默认,AI SDK `tool()` 稳定。
- **坑**:**工具的元数据驱动调度(`isReadOnly`/`isConcurrencySafe`/`isDestructive`/`maxResultSizeChars`)、只读并发/写串行分批、超限落盘投影、5 键错误 envelope —— 这些 AI SDK 全不管**。这是 claudecode `Tool.ts` / `toolOrchestration.ts` 和 codex `ToolExecutor` 的设计,**只能借设计、TS 自研**(claudecode 闭源代码不可抄;codex 是 Rust,Apache-2.0 但语言不同需重写)。

### 4) 最小自研接缝
- `Tool<In,Out>` 接口包一层(在 AI SDK `tool` 之上加元数据字段)。
- `partitionToolCalls()`:按 `isConcurrencySafe` 分批,只读批 `Promise.all` 并发(上限 ~10)、写串行——**约 50 行 reduce**(借 claudecode 设计)。
- 超限结果落盘 + 预览回灌(借 opensquilla `ToolOutputStore.bound` 设计,Apache-2.0,可参考实现)。
- 内置工具 MVP <20 个(read/write/edit/bash/glob/grep/webfetch/...),**全量暴露**。

### 5) 推迟到成熟后
- **ToolExposure 四态 / Deferred + ToolSearch 延迟加载**(蓝图明确:工具数 >30 才启用)。
- **code-mode(V8 isolate 内 JS 编排工具)**(codex 亮点,后置)。

---

## 3. MCP 客户端与服务端

### 1) 直接采用的现成方案 ✅ 本子系统最干净的"拿来即用"
| 组件 | 来源 | 许可证 | 提供什么 |
|---|---|---|---|
| **`@modelcontextprotocol/sdk`** | npm(官方 TS SDK) | **MIT** | **MCP 客户端 + 服务端双向**:`Client`/`Server` 类、Streamable HTTP & stdio transport、Tools/Resources/Prompts primitives、JSON-RPC 层 |

### 2) 集成成本
- **MCP 客户端**(内核接外部 server):**拿来即用~轻度封装**(把 MCP 工具 adapt 进你的 `Tool<In,Out>` 接口)。
- **内核暴露为 MCP server**(蓝图 §6:内核做成 MCP server 给各端壳):**轻度封装**。
- AI SDK 亦有 `experimental_createMCPClient`,可作更省事的客户端胶水(二选一)。

### 3) 成熟度与风险
- **生产可用 / 行业标准**(2025-12 已捐 Linux Foundation AAIF,97M 月下载)。
- **坑一**:**规范迭代快**(2025-03 / 2025-06 / 2025-11 / 2026-07-28 RC 无状态化移除 session 握手)。SDK 版本与 spec 版本要对齐,做 capability negotiation。
- **坑二(安全,必须自建)**:**Tool Poisoning / Prompt Injection(CVE-2025-54136)**。SDK **不**替你审计第三方 server 的 tool description——白名单审计、内容净化是你的活(蓝图 §4)。
- **坑三(架构强约束)**:MCP 拿到的**外部凭证(日历/邮件 OAuth token)必须存沙箱外凭证代理,不进执行域**(蓝图 M1)。

### 4) 最小自研接缝
- MCP 工具 → `Tool<In,Out>` 适配器(让 MCP 工具与内置工具同走 dispatch/policy/沙箱/审批管线)。
- tool description 白名单审计 + 凭证沙箱外代理(薄,但**安全关键,不可省**)。
- OAuth 2.1/PKCE 链路:**委托外部 IdP**(Auth0/Clerk/WorkOS),内核只验 token,不自建授权服务器。

### 5) 推迟到成熟后
- **MCP Apps(ui:// 富 UI)、MCP Tasks(durable 长任务)、A2A 协议、官方 Registry 自动发布**——全部后置(MVP 单 agent 不需要 A2A;富 UI 用你自己的 Next.js 前端)。

---

## 4. Skills(SKILL.md)与 Hooks

### 1) 直接采用的现成方案
**没有"Skills 运行时库"可装——SKILL.md 是开放规范(agentskills.io),不是 npm 包。** 现成可拿的是:
| 组件 | 来源 | 许可证 | 提供什么 |
|---|---|---|---|
| **SKILL.md 规范** | agentskills.io(开放标准) | 开放规范 | YAML frontmatter(name/description)+ Markdown 正文 + 渐进式加载约定 |
| **`gray-matter`** | npm | MIT | 解析 SKILL.md 的 YAML frontmatter(现成,别手写 parser) |
| **`jiti`** | npm | MIT | **运行时加载 TS 扩展/skill 脚本,无需预编译**(pi 用它做扩展系统的核心,设计已验证) |
| **可移植的 Skill 内容资产** | **opensquilla paper-\* skill** | **Apache-2.0(opensquilla-original)** | **写作流水线 SKILL.md 内容可直接搬**(按 NOTICE/attribution 义务) |

### 2) 集成成本
- frontmatter 解析:**拿来即用**(gray-matter)。
- Skill 发现注入(1% 预算列出 name/description,调用时才加载全文):**轻度封装**(自研加载器,借 pi `skills.ts` / claudecode `SkillTool` 设计,**pi 是 MIT 可借代码,claudecode 仅借设计**)。
- Hooks 生命周期:**轻度封装**(自研事件分发)。

### 3) 成熟度与风险
- SKILL.md:**已 GA、跨 32 工具互操作**,但**各平台 bundled script 执行权限差异大**——你自己定义执行边界即可。
- **坑**:**Skill / Hook 跑用户脚本 = 任意代码执行面**。Hook 的 shell/HTTP 钩子必须带 ssrfGuard(借 claudecode 设计),且过沙箱/审批。
- **合规坑(蓝图 §3.5)**:**禁复制 claudecode 任何 SKILL 文案/工具描述**;OpenClaw 派生的 8 个 SKILL(sub-agent/cron/github/...)若移植 attribution 追 **OpenClaw(MIT)**;**paper-\* 经核验为 opensquilla-original(Apache-2.0),不涉 OpenClaw**。

### 4) 最小自研接缝
- Skill 加载器:扫描目录 → gray-matter 解析 frontmatter → 渲染 `<available_skills>` 注入 system prompt → read 时加载全文。
- Hooks 分发器:`PreToolUse`/`PostToolUse`/`SessionStart`/`Stop` 等事件挂点(MVP 只需 2-3 个事件,借 claudecode `hookEvents.ts` 设计)。

### 5) 推迟到成熟后
- **jiti 运行时 TS 扩展 + Plugins marketplace + 完整 Hooks 全集**(蓝图阶段六)。MVP 的 Skills 只需"读 Markdown + 按需注入",**不需要可执行扩展系统**。

---

## 5. 本子系统 MVP 最小依赖集(阶段一:Web + 写代码)

> 真正需要安装的最少现成件 ——只有 4 个核心 npm 包 + 2 个胶水包:

```jsonc
{
  // —— 核心 4 件(拿来即用)——
  "ai":                          "^6",   // Apache-2.0 — provider 流式 + 单 turn 工具循环原语 + tool()
  "@ai-sdk/anthropic":           "^*",   //               + @ai-sdk/openai / @ai-sdk/google(至少三家)
  "zod":                         "^4",   // MIT          — 工具 inputSchema + 校验(JSON Schema 用 v4 内置)
  "@modelcontextprotocol/sdk":   "^*",   // MIT          — MCP 客户端 + 把内核暴露为 MCP server(双向)

  // —— 胶水 2 件 —— 
  "gray-matter":                 "^4",   // MIT          — SKILL.md frontmatter 解析
  "hono":                        "^4"    // MIT          — 内核 HTTP/SSE server(蓝图 §7 已定 Bun+Hono)
}
```
*(运行时为 Bun,SQLite 用 Bun 内置 `bun:sqlite`,无需额外驱动;jiti 留到阶段六再装)*

### MVP 自研接缝(全部是薄接缝,合计约 600-800 行,无一是"造轮子"):
1. **async-generator 主循环** `queryLoop()`(借 pi MIT 代码 + claudecode 设计):AI SDK 调 turn → yield 事件 → 工具回灌 → AbortController 中断。
2. **`Tool<In,Out>` 元数据包装 + 只读并发/写串行分批 + 超限落盘投影**(借 claudecode/codex/opensquilla 设计)。
3. **MCP 工具 → 内核工具适配器 + 白名单审计 + 凭证沙箱外代理**(安全关键)。
4. **Skill 加载器(gray-matter + 1% 预算注入)+ 最小 Hooks 分发(2-3 事件)**。
5. **单级压缩(满即摘要)+ 5 键失败 envelope**。

### MVP 明确不做(推迟到产品成熟后):
LangGraph / 任何 agent 框架 · orchestrator-subagent / fork / coordinator · ToolExposure 四态 + ToolSearch · code-mode · 三级压缩 + microcompact + Context Epoch · durable 输入 + resumable-stream · MCP Apps / Tasks / A2A / 官方 Registry · jiti 运行时扩展 + Plugins marketplace · 独立 `@arclight/llm` 网关 + ThinkingLevel 6 档。

---

### 附:11 仓"可复用代码 vs 仅借设计"速查(本子系统范围)
| 仓 | 许可证 | 本子系统可否搬代码 |
|---|---|---|
| **pi** | **MIT** | ✅ **可搬代码**:agent-loop 双队列、skills 加载、tool 工厂(最值得借的可复用源) |
| **opencode** | MIT | ⚠️ 许可证允许,但**深绑 Effect 4.x beta**,搬等于引入 Effect 全家桶——**仅借设计**(durable 输入/System Context/工具 registry 理念) |
| **codex** | Apache-2.0 | ⚠️ 许可证允许但**Rust**,需 TS 重写——**仅借设计**(ToolExposure/approval/code-mode);Apache-2.0 复制落 NOTICE |
| **opensquilla** | Apache-2.0(original) | ✅ **paper-\* SKILL 内容可搬**(按 NOTICE);工具落盘投影设计可参考 |
| **claudecode** | **无 LICENSE / 闭源** | ❌ **代码与文本资产一律不可搬,仅学架构**(query 循环、压缩、权限、ToolSearch、Hooks 设计) |