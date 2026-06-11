现在我已经有了充分的资料，来生成这份选型清单。

---

# arclightagent 调研子系统【拿来即用选型清单】

> 范围：deep research 编排、web 搜索/抓取、CitationAgent。对照蓝图定位：此子系统为**阶段三**交付（独立阶段，非首个 MVP）。

---

## 一、组件总览

```
ResearchOrchestrator
├── 编排骨架（Plan→Fan-out→Read→Reflect→Verify→Synthesize）
├── Web 搜索 API（Tavily / Exa / Brave Search）
├── 网页抓取 + 正文提取（Firecrawl / @mozilla/readability）
└── CitationAgent（引用核验，独立阶段）
```

---

## 二、逐组件选型详述

---

### 2.1 编排骨架（Orchestrator-Subagent + 工作流）

#### 直接采用的现成方案

| 项目 | 来源 | 许可证 | 它提供什么 |
|---|---|---|---|
| **LangChain open_deep_research** | [github.com/langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research) | MIT | 完整的 Scope→Research→Write 三阶段骨架；Supervisor 将任务拆为独立 subtopic 并行派发多个 Researcher 子代理（每个子代理独立上下文窗口）；支持 Tavily/Exa/PubMed/Perplexity 多搜索工具替换；内置 human-in-the-loop 审批研究计划；Python，27k+ stars，持续活跃 |
| **GPT-Researcher** | [github.com/assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher) | MIT | Planner+Execution 双 agent；并发子查询检索 + 过滤聚合 + 带引用报告；支持 MCP 集成；平均 3 分钟/$0.005；Python，可作设计参考 |
| **Vercel AI SDK v6（`streamText` + `generateObject`）** | [npmjs.com/package/ai](https://www.npmjs.com/package/ai) | Apache-2.0 | TS/JS 原生；`maxSteps` 多步 agentic loop；`generateObject` + Zod schema 强类型结构化输出（替代 ActionNode 功能）；`streamText` 流式事件推前端；provider 中立；与栈直接同构，**是本项目在 TS 侧做轻量编排的最优直接依赖** |
| **Anthropic Orchestrator-Subagent 架构** | [anthropic.com/engineering/multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system) | 设计参考（无代码） | LeadResearcher（Opus 级）规划+综合；动态生成 Sonnet 子代理并行检索；子代理独立上下文防污染；较单 agent 性能提升 90.2%；token ~15× |

**关键决策**：本项目栈为 TS/Bun，open_deep_research / GPT-Researcher 均为 **Python**，**不可直接 npm install**。二者的价值是：

- open_deep_research：**仅借设计**（Scope→Research→Write 三阶段 + Supervisor 拆分逻辑），用 Vercel AI SDK + `@anthropic-ai/sdk` 在 TS 侧**薄自研编排接缝**复现同一 pipeline；
- 蓝图已明确：「多代理 deep research 骨架参考 LangChain open_deep_research + Anthropic Orchestrator-Subagent，用 async-generator 自研 orchestrator」，**非 fork Python 仓**。

**实际 TS 侧可直接安装的编排层**：

```
@anthropic-ai/sdk          # Anthropic Messages API，支持 tool_use，可直接实现 orchestrator-subagent
ai（Vercel AI SDK v6）     # streamText / generateObject / maxSteps，provider 中立
```

**集成成本量级**：轻度封装（用 Vercel AI SDK `streamText` + `maxSteps` 自写 ~300-500 行 TS orchestrator，参照 open_deep_research 的阶段划分）。

**成熟度**：Vercel AI SDK v6 ✅ 生产可用；`@anthropic-ai/sdk` ✅ 生产可用；open_deep_research ⚠️ 成熟开源但 Python，借设计不借代码。

**坑**：open_deep_research 看起来像「拿来即用」，实则是 Python LangGraph 生态，要在本项目 TS 运行时里用它，需要跑一个 Python sidecar，引入跨语言边界，蓝图明确反对为此增加 Python 边界。正确做法是**以 TS 代码复现其 pipeline 逻辑**，整个文件只需 ~500 行。

---

### 2.2 Web 搜索 API

#### 直接采用的现成方案

| 项目 | 来源 | 许可证 | 它提供什么 |
|---|---|---|---|
| **Tavily Search API（`@tavily/core`）** | [npmjs.com/package/@tavily/core](https://www.npmjs.com/package/@tavily/core) | MIT | 专为 AI agent 设计的搜索 API；`tavily.search()` / `tavily.searchContext()` / `tavily.searchQNA()`；返回结构化 JSON（含 url/title/content/score）；支持深度搜索（search_depth: "advanced"）；免费 tier 1000 次/月；**TS SDK 一等公民，直接 install** |
| **Exa Search（`exa-js`）** | [npmjs.com/package/exa-js](https://www.npmjs.com/package/exa-js) | MIT | 语义搜索（相似度而非关键词）+ 内容抓取合体；`exa.searchAndContents()` 单次返回 URL+正文；支持 `type: "neural"/"keyword"`；适合学术/深度语义检索；**TS SDK 直接 install** |
| **Brave Search MCP Server** | [github.com/modelcontextprotocol/servers/brave-search](https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search) | MIT | 官方 MCP server；`brave_web_search` / `brave_local_search` 工具；通过 MCP 接入不需要改 agent 代码；免费 tier 2000 次/月 |

**选型建议**：

- **主力选 Tavily**：专为 agent 设计，TS SDK 干净，open_deep_research 也将其列为首选；
- **Exa 作语义检索增强**：学术/技术调研场景补充；
- **Brave Search 作 MCP 接入备选**：通过 MCP 工具层接入，零代码改动切换。

**集成成本量级**：拿来即用（各 SDK install 后 5-10 行初始化，封装为 MCP tool 或 TS Tool）。

**成熟度**：Tavily ✅ 生产可用，有 anthropic/langchain 官方教程背书；Exa ✅ 生产可用；Brave Search MCP ✅ 官方维护。

---

### 2.3 网页抓取 + 正文提取

#### 直接采用的现成方案

| 项目 | 来源 | 许可证 | 它提供什么 |
|---|---|---|---|
| **`@mozilla/readability`** | [npmjs.com/package/@mozilla/readability](https://www.npmjs.com/package/@mozilla/readability) | Apache-2.0 | Mozilla 开源；从 HTML DOM 提取主要正文（去导航/广告/边栏）；需配合 `jsdom` 使用；**TS 可直接 install，完全离线，零 API 成本** |
| **`jsdom`** | [npmjs.com/package/jsdom](https://www.npmjs.com/package/jsdom) | MIT | 服务端 DOM 解析，配合 readability 使用 |
| **Firecrawl（`@mendable/firecrawl-js`）** | [npmjs.com/package/@mendable/firecrawl-js](https://www.npmjs.com/package/@mendable/firecrawl-js) | MIT（SDK）；服务端 SaaS | JS/TS SDK；托管抓取服务，自动处理 JS 渲染/反爬/PDF；`scrapeUrl()` 返回 markdown 正文；有自托管选项（Apache-2.0）；每月 500 次免费；**TS SDK 直接 install** |
| **Firecrawl MCP Server** | [github.com/mendableai/firecrawl-mcp-server](https://github.com/mendableai/firecrawl-mcp-server) | MIT | MCP 接入方式；`firecrawl_scrape` / `firecrawl_search` / `firecrawl_crawl` 工具；通过 MCP 层接入无需改 agent 代码 |

**分层使用策略**：

```
静态页面 → @mozilla/readability + jsdom（零成本，离线，首选）
JS 渲染页面 / 复杂反爬 → Firecrawl SaaS（opt-in，有成本）
批量深度抓取 → Firecrawl crawl（整站）
```

**集成成本量级**：`@mozilla/readability` 拿来即用（约 20 行封装为 `fetchAndExtract(url)`）；Firecrawl 轻度封装（SDK install + 封装为 MCP tool）。

**成熟度**：`@mozilla/readability` ✅ 生产可用（Firefox Reader Mode 同一代码）；Firecrawl ✅ 生产可用（open_deep_research 官方集成）。

**坑**：Firecrawl SaaS 有成本且数据经第三方，个人 agent 应作 opt-in。自托管 Firecrawl 需要 Docker，增加运维负担，MVP 阶段用 readability 即可。

---

### 2.4 CitationAgent（引用核验）

这是整个子系统中**唯一需要较多自研的接缝**，原因：现成方案要么是 Python（FACTUM 等学术实现），要么与本项目架构深度耦合，难以直接引入。

#### 直接采用的现成方案（有限）

| 项目 | 来源 | 许可证 | 它提供什么 |
|---|---|---|---|
| **`@anthropic-ai/sdk`（structured output + tool_use）** | npm | MIT | 用 `generateObject` / `tool_use` 做句级声明抽取与来源匹配打分；**是实现 CitationAgent 的基础设施，不是 CitationAgent 本身** |
| **`@mendable/firecrawl-js`（已列上文）** | npm | MIT | 验证引用 URL 有效性 + 重新抓取来源正文做比对 |
| **FACTUM 论文设计（arXiv 2601.05866）** | [arxiv.org/abs/2601.05866](https://arxiv.org/abs/2601.05866) | 学术参考（无可用 TS 代码） | sentence-level citation verification 机制参考；NLI（Natural Language Inference）判定声明是否被来源支持；**仅借设计，得自己写** |

**CitationAgent 的最小自研实现**（~200-300 行 TS）：

```typescript
// 借设计自研，无现成 TS 包可 install
interface Citation {
  statement: string;      // 报告中的一句声明
  sourceUrl: string;      // 来源 URL
  sourceChunk: string;    // 检索时存的原文 chunk 指针
}

// 三步流程（参照 FACTUM + Anthropic CitationAgent 设计）：
// 1. 综合阶段：每条声明存 source chunk 指针（不依赖 LLM 生成引用）
// 2. 验证阶段：对每个 (statement, sourceChunk) 调用 LLM 做 NLI 打分（支持/矛盾/无关）
// 3. 报告阶段：低置信度引用标红/降级；citation hallucination 率输出为 eval 指标
```

**集成成本量级**：需较多缝合（但非造轮子——基础设施全是现成的，自研的只是「把它们组合起来的 200-300 行逻辑」）。

**成熟度**：此设计模式已在 Anthropic 内部系统生产验证；TS 实现目前无现成 npm 包可用。

---

### 2.5 异步任务持久化 + 断点续研

#### 直接采用的现成方案

这部分完全复用蓝图已定案的共享基础设施，无需新引入依赖：

| 组件 | 已定案方案 | 说明 |
|---|---|---|
| 任务持久化 | SQLite（Drizzle ORM）+ 乐观锁 epoch | 蓝图 §5.3；deep research 任务作为一等 session 存储 |
| 流式推送 | SSE（Hono）+ 服务端短缓冲 | 蓝图 §5.2；thought/搜索进度/子报告增量推前端 |
| 后台异步任务 | Bun 原生 `Worker` + 任务状态机（QUEUED→RUNNING→DONE/FAILED） | 无需额外队列库（MVP 单机） |
| 断线重连 | 服务端事件 buffer + `Last-Event-ID` 续推 | MVP 最朴素版；完整 Redis resumable-stream 后置 |

---

## 三、仅保留的最小自研接缝

以下是**必须自研的薄接缝**，不是轮子，合计约 800-1200 行 TS：

| 接缝 | 代码量估算 | 说明 |
|---|---|---|
| **ResearchOrchestrator（TS 编排层）** | ~400-500 行 | 参照 open_deep_research 三阶段设计，用 Vercel AI SDK `streamText` + `@anthropic-ai/sdk` 实现；LeadResearcher 调度 N 个并行子代理，子代理独立上下文 |
| **CitationAgent（句级核验）** | ~200-300 行 | 参照 FACTUM 设计；每条声明存 chunk 指针 → LLM NLI 打分 → 置信度输出 |
| **SearchTool 统一封装** | ~100-150 行 | 把 Tavily/Exa/Brave 统一封装为同一 `SearchTool` 接口（可通过 MCP 或直接 TS 调用），provider 可配置切换 |
| **FetchAndExtract 工具** | ~50-80 行 | `@mozilla/readability` + `jsdom` 封装为 agent tool；失败降级 Firecrawl |

---

## 四、现在不要自研、推迟到产品成熟后的部分

| 延迟项 | 为什么推迟 |
|---|---|
| **RL 训练的 deep research agent**（DeepResearcher、O-Researcher 路线） | 需要大量 trajectory 数据 + 真实 Web 交互环境，个人开发者无法复现训练；等产品成熟、有真实用户数据后再评估蒸馏 |
| **STORM 多视角对话驱动大纲**（用于报告生成） | Python，且 STORM 更适合 Wikipedia 风格长文，MVP 调研报告先用 open_deep_research 的 Write 阶段设计替代 |
| **完整 resumable-stream（Redis + 断线 replay 去重）** | 蓝图明确后置到阶段二；MVP 用服务端短缓冲 + `Last-Event-ID` |
| **分层模型路由（SquillaRouter 风格的本地 ONNX 分类器）** | 先用启发式（query 复杂度 → Opus/Sonnet 静态分配），等有 eval 数据再做动态路由 |
| **评测基准自建（DREAM/ReportBench/DEER 风格）** | 先用 ≥10 条 golden research case 作为 MVP eval harness；完整评测基准等阶段三调研能力稳定后建 |
| **HITL 研究计划协作式精化 UI**（collaborative_planning Gemini 风格） | 先做最简「展示 subtopics 供审批」UI；丰富的协作规划 UI 后置 |
| **私有数据源 MCP 接入**（Google Drive、Notion、企业知识库） | 先跑公网搜索；私有 MCP server 等通用 MCP 集成稳定后逐步接入 |

---

## 五、MVP 最小依赖集（阶段三 deep research 真正需要的最少现成件）

> **注**：阶段一（写代码 MVP）不需要以下任何依赖，这是**阶段三**最小集。

```jsonc
// package.json dependencies（TS/Bun 侧）
{
  "@anthropic-ai/sdk": "latest",          // Orchestrator + subagent 调用，CitationAgent LLM 核验
  "ai": "^6.x",                           // Vercel AI SDK，streamText/generateObject/maxSteps
  "@tavily/core": "latest",               // 主力搜索 API
  "exa-js": "latest",                     // 语义搜索补充
  "@mozilla/readability": "latest",       // 正文提取（离线，零成本）
  "jsdom": "latest"                       // 配合 readability 的服务端 DOM 解析
}

// 外部服务（按需 opt-in，非硬依赖）
// @mendable/firecrawl-js     → 处理 JS 渲染页面，opt-in SaaS
// MCP server：brave-search   → Brave Search MCP，可选替换搜索后端
// MCP server：firecrawl      → Firecrawl MCP，可选替换抓取后端
```

**依赖计数**：核心 6 个 npm 包（其中 2 个 `@anthropic-ai/sdk`/`ai` 在写代码 MVP 已引入，实际**新增 4 个**）+ opt-in 外部服务。无需引入任何 Python sidecar，无需 LangGraph，无需 LangChain 任何包。

---

## 六、许可证合规摘要

| 项目 | 许可证 | 合规动作 |
|---|---|---|
| `@mozilla/readability` | Apache-2.0 | 保留 NOTICE；在本项目 NOTICE 文件中注明 Mozilla 出处 |
| `@tavily/core`、`exa-js`、`ai` | MIT | 无额外义务 |
| `@anthropic-ai/sdk` | MIT | 无额外义务 |
| `@mendable/firecrawl-js` | MIT（SDK）| 无额外义务；SaaS 数据条款另行审阅 |
| open_deep_research（仅借设计） | MIT | **不复制代码**，只借 pipeline 逻辑；如有逐字搬运须保留 MIT header |
| GPT-Researcher（仅借设计） | MIT | 同上 |
| FACTUM 论文（仅借设计） | 学术参考 | 无代码复制，不涉及许可证义务 |

---

## 七、风险提示（诚实标注）

1. **检索召回率瓶颈**：即使最优 agent 仅能检索到专家引用文献的 20.92%（TaxoBench 基准）。单靠 Tavily + readability 不能解决此问题——需要多轮迭代检索 + 子查询分解，这是 ResearchOrchestrator 自研接缝要解决的核心逻辑，不是换一个搜索 API 就能修复的。

2. **引用幻觉无法完全消除**：OpenAI Deep Research 引用准确率约 78%，Claude with Search 约 94%。CitationAgent 只能检测和标注，不能消除；务必在 UI 上给用户明确的置信度展示，不要给用户「引用 100% 准确」的错误预期。

3. **多 agent ~15× token 成本放大**：fan-out 10 个子代理的单次调研任务成本可能达到 $0.5-$5。必须在 ResearchOrchestrator 中实现 token 预算管理（`maxTokens` per subagent + 总预算熔断），并将成本归入 per-user metering（蓝图 §5.5 已要求）。

4. **Tavily/Exa/Firecrawl 均为 SaaS 外部服务**：数据经第三方，与蓝图「个人 Agent 数据默认不出本机」原则有张力。研究查询（非代码/凭证）外发风险相对低，但**须在 UI 上明确告知用户哪些数据经过第三方服务**，提供纯本地搜索降级选项（如本地 Brave Search Self-hosted / SearXNG）。