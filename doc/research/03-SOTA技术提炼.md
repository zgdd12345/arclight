以下是完整的 Markdown 报告，已基于全部 11 份调研文件综合提炼。

---

# arclightagent 2025-2026 SOTA 技术提炼与选型建议

> **项目定位**：全平台个人 AI Agent（写代码 / 写文章 / deep research / computer use / 日常规划），五大能力，CLI + 桌面 + 网页 + 浏览器插件 + IDE 插件，**网页端先发、优先级最高**。
>
> **构建策略拍板**：采用「**自研内核 + 借用模块**」路线——以 Vercel AI SDK v6 + LangGraph 构建 headless agent 服务作为核心内核，通过 AG-UI 协议对外暴露标准化事件流，网页端用 Next.js + assistant-ui 消费，工具层全面接入 MCP，记忆层接 mem0，provider 层接 LiteLLM Proxy，后续各平台壳（Tauri 桌面、Bun CLI、Chrome 扩展、VSCode 插件）共享同一内核服务。**不 fork 现有 Claude Code / OpenHands / GPT-Researcher 等基座**，原因是它们的设计目标单一且更新频率快、fork 维护成本极高；借用其中的思路与模块（LangGraph、browser-use、open_deep_research 等），但核心循环与产品体验自己掌控。

---

## 一、Agentic Loop / Agent Harness

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **Gather → Act → Verify 基础 agent 循环** | 行业共识 | 所有生产 agent 的骨架，不可绕过 |
| **ReAct（推理+行动交替）** | 事实标准 | 工具调用场景默认推理范式 |
| **Long-Running Agent Harness（双/三代理支架）** | 前沿/2025-11 | initializer + coding agent + progress 文件跨会话保持状态 |
| **Reflexion（失败后自反思）** | 研究广泛验证 | 可重试、有明确成败信号的任务（代码生成、可验证输出）叠加使用 |

**关键来源**：[Anthropic Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) · [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [Reflexion arXiv:2303.11366](https://arxiv.org/abs/2303.11366)

### 对 arclightagent 的建议

- **从单代理 + 工具循环起步**，先把 gather→act→verify 跑通，绝不要一上来堆多代理框架（Cognition 的《Don't Build Multi-Agents》提供了大量反面案例）。
- 为五大能力分别实现独立的 verify 闭环：代码用测试/lint；写作用 LLM-as-judge；research 用引用核验；computer use 用截图视觉反馈；日历用 schema 校验。
- 长时任务（deep research / 复杂编码）采用 Anthropic harness 模式：`progress.json` 记录状态 + git 历史跨会话重建上下文 + 每次启动仪式（读 progress → 看历史 → 跑冒烟测试 → 挑一个任务）。
- **推理范式按任务选型**：交互式对话用 ReAct；可重试任务叠加 Reflexion；步骤多、依赖明确的任务用 Plan-and-Execute。

---

## 二、上下文工程与长期记忆

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **Context Compaction（上下文压缩）** | 生产级 | 逼近上限时高保真摘要，保留架构决策/未决问题，丢弃冗余工具结果 |
| **mem0（可扩展长期记忆层）** | 生产级开源 | LoCoMo 上比 OpenAI memory 高 26% 准确率、低 91% 延迟、省 90% token |
| **KV-cache 友好提示设计** | 生产级 | 稳定前缀 + append-only + mask 不删工具；KV-cache 命中率是最重要成本指标（10× 差距） |
| **Filesystem-as-Memory + Just-in-Time Retrieval** | 生产级最佳实践 | Agent 只持有轻量标识符（文件路径/查询），运行时按需加载，避免上下文膨胀 |

**备选（关系型记忆需求）**：[Zep/Graphiti](https://arxiv.org/abs/2501.13956)（时序知识图谱，LongMemEval +18.5% 准确率），适合需要强时序/实体关系的场景。

**关键来源**：[Anthropic Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Manus Context Engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) · [mem0 arXiv:2504.19413](https://arxiv.org/abs/2504.19413)

### 对 arclightagent 的建议

- **记忆分三层**：(1) working memory—当前会话上下文窗口（compaction 管理）；(2) archival memory—接 mem0 持久层（异步写入、按需检索，多模型支持开箱即用）；(3) raw history—落文件系统/Postgres，grep/向量混合检索。
- 把 **KV-cache 命中率作为头号性能指标**：系统 prompt + 工具定义放最前且逐 token 稳定，用户消息放最后，搭配 Anthropic prompt caching（最高 90% 成本节省）或 vLLM Automatic Prefix Caching。
- 不要迷信百万 token 窗口：100K 后有效利用率降至约 60%，中段信息 30%+ lost-in-the-middle，长上下文是「推理工作台」而非「存储」。
- 网页端将 memory blocks 可视化（让用户查看/编辑 agent 记住了什么）作为功能点，既提升信任也便于纠错。

---

## 三、网页优先应用架构（流式 / 会话持久化 / AG-UI / Vercel AI SDK 等）

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **Vercel AI SDK v6（streamText + Agent + useChat）** | 生产级，生态最大 | TS 全栈，v6 新增 Agents 类/MCP 全面支持/rerank，3M+ 周下载量 |
| **AG-UI Protocol（Agent-User Interaction Protocol）** | 新兴事实标准 | 约 16 种标准事件（message/tool-call/state-patch/lifecycle），14k stars，已被 LangGraph/CrewAI/Mastra/Google ADK 等接入 |
| **Resumable / Durable Streams（断线恢复流）** | 新兴但迅速成标配 | Redis + vercel/resumable-stream + useChat resume 选项，解决刷新/断网丢生成的核心痛点 |
| **assistant-ui（React AI chat UI 库）** | 生产级，社区最广 | Radix 风格可组合 primitives，50k+/月下载，支持 AI SDK/LangGraph 适配器 |

**备选内核框架**：[Mastra v1.0](https://mastra.ai/)（纯 TS、graph-based workflows + 记忆 + 94+ provider 路由，可作 Hono 独立服务）；[Cloudflare Agents](https://developers.cloudflare.com/agents/)（Durable Objects，原生 resumable streaming，边缘强一致）。

**关键来源**：[Vercel AI SDK](https://ai-sdk.dev/) · [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui) · [assistant-ui](https://www.assistant-ui.com/) · [vercel/resumable-stream](https://github.com/vercel/resumable-stream)

### 对 arclightagent 的建议

- **架构核心：headless agent 服务 + 标准化事件流**。Agent 内核（reasoning loop + tools + memory + 持久化）做成独立 HTTP 服务，前端只消费 AG-UI 事件流——这是日后网页/桌面/插件多端共享的关键解耦点。
- **技术栈首选**：后端 Vercel AI SDK v6 + LangGraph（状态持久化 + HITL）；前端 Next.js App Router + assistant-ui；传输 SSE + 心跳（每 15-30s 防代理超时）。
- **把断线恢复从第一天设计进去**：Redis + vercel/resumable-stream + useChat resume 选项，让刷新页面、切设备都不丢生成。
- 会话持久化用 LangGraph checkpointer（可接 Postgres/Redis），每会话独立状态对象，支持时间回溯调试。
- 传输默认用 SSE，只有确实需要双向控制（语音 Realtime、多人协作）时才叠加 WebSocket 控制通道。

---

## 四、MCP 与 Skills

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **MCP Streamable HTTP Transport（HTTP POST + SSE）** | GA，远程 server 推荐标准 | 取代旧版 HTTP+SSE，支持标准负载均衡、OAuth 2.1 认证，无状态化（2026-07 RC） |
| **MCP Authorization（OAuth 2.1 + PKCE + RFC 8707/9728）** | GA Draft，持续更新 | web-facing server 强制要求，委托外部 IdP（Auth0/Clerk），server 只做 token 验证 |
| **Agent Skills / SKILL.md 开放标准** | GA，跨平台互操作 | 一次编写跨 32 个工具运行（Claude Code/OpenAI Codex/Cursor/Gemini CLI），89,753+ skills |
| **A2A Protocol v1.0.0（Agent-to-Agent）** | v1.0.0 正式版，2026 | 与 MCP 互补分层：MCP 给 agent 工具，A2A 给 agent 同事；150+ 组织支持 |

**关键来源**：[MCP Specification Latest](https://modelcontextprotocol.io/specification/latest) · [Agent Skills agentskills.io](https://agentskills.io/specification) · [A2A Protocol](https://atlan.com/know/google-a2a-protocol/) · [MCP Apps ext-apps](https://github.com/modelcontextprotocol/ext-apps)

### 对 arclightagent 的建议

- **MCP 是工具层标准，不是 agent 框架**：所有外部接入（搜索、日历、邮件、GitHub、文件、数据库）通过 MCP server 封装，agent 动态发现和调用，换工具不改 agent 代码。
- 用 **Streamable HTTP transport** 构建远程 MCP server，第一天就实现 OAuth 2.1（RFC 9728 + RFC 8707 + PKCE），委托给 Auth0/Clerk，不自建授权服务器。
- 用 **SKILL.md** 封装可复用的领域能力（写作风格指南、研究方法论、代码规范），一次编写在 Claude Code/Cursor/Codex 均可运行。
- **防御 Tool Poisoning**：不无条件信任第三方 MCP server 的 tool description，实现白名单审计，监控 CVE-2025-54136 类攻击面。
- 多 agent 协作时：MCP 负责 agent-tool 连接，A2A 负责 agent-agent 委派，AG-UI 负责 agent-前端交互——三者角色严格不混用。

---

## 五、执行沙箱与安全

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **E2B Sandbox（Firecracker microVM）** | 生产可用，商用 SaaS | 硬件级隔离，~150ms 冷启动，SDK 与 Anthropic/OpenAI/Next.js 原生集成，1B+ 启动次数 |
| **Vercel Sandbox** | GA 2026-01 | 每个 sandbox 独立 Linux microVM，与 Next.js/Vercel CLI 原生集成，最适合 web 优先项目 |
| **Pyodide（WASM 浏览器端执行）** | 生产可用 | 浏览器端 Python 代码零服务器风险执行，server 侧无任何 eval() 风险，成本最低 |
| **nono（Linux Landlock + macOS Seatbelt）** | 早期稳定，开源 Apache-2.0 | 本地/CLI agent 的零 overhead 内核级隔离，无需 root，brew install nono 即用 |

**关键来源**：[E2B](https://e2b.dev/) · [Vercel Sandbox](https://vercel.com/docs/sandbox) · [nono](https://nono.sh/os-sandbox) · [Cursor 沙箱博客](https://cursor.com/blog/agent-sandboxing)

### 对 arclightagent 的建议

- **分层防御，不依赖单一隔离层**：网页端代码执行首选 **Vercel Sandbox**（与 Next.js 生态零配置），需更多模板/持久化则用 **E2B**；浏览器端轻量代码用 **Pyodide**；本地 CLI 用 **nono** 的 Landlock+Seatbelt。
- **Computer use / 浏览器自动化必须叠加语义层防护**：进程沙箱无法防御 prompt injection。高危动作（支付、删除、邮件外发、权限授予）强制 HITL 确认 + 出口网络白名单 + 动作白名单。
- 在 agent pipeline 中加入二次 LLM 审查，对从页面读取的文本做来源标注/隔离，默认不信任页面内容中的「指令」。
- 规模化后考虑 [Google Agent Sandbox（kubernetes-sigs/agent-sandbox）](https://github.com/kubernetes-sigs/agent-sandbox) 做 Kubernetes 原生多租户扩展。

---

## 六、多智能体编排

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **LangGraph 1.0（图结构编排 + Checkpointer）** | 生产就绪，成熟度最高 | DAG 状态图 + 内置检查点/时间回溯/HITL 中断/原生流式，模型无关，Klarna/LinkedIn/Uber 生产部署 |
| **Orchestrator-Worker 模式** | 2026 生产默认模式 | 主 agent 持有完整上下文，按需派生专用 worker（搜索/代码/文件），worker 只回传压缩摘要 |
| **OpenAI Agents SDK（sessions + handoffs）** | 生产就绪 | 快速上线选项，2026.04 大版本引入 subagent 原语/沙箱执行/长任务 harness，但模型锁定 OpenAI |

**关键来源**：[LangGraph](https://www.langchain.com/langgraph) · [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) · [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)

### 对 arclightagent 的建议

- **核心编排引擎选 LangGraph**：模型无关（Claude/GPT-4o/本地模型均可）、checkpointer 持久化（长时 research / 编码任务必须）、HITL 中断点（computer use 高危动作必须）、原生 SSE 流式（与网页端架构天然契合）。
- **从单代理起步**：判断标准——单 agent + 工具调用能完成就不需要多 agent；只有任务有自然并行性（如 deep research 的并行子查询）或不同专业能力时才拆分。
- 多代理时严格用 **Orchestrator-Worker** 拓扑，worker 之间不直接通信，通过主 agent 中转，避免 peer-to-peer mesh 的调试噩梦。
- **从第一天接可观测性**：LangSmith（LangGraph 配套）或 Langfuse（开源，框架无关），单次 research 任务可产生 40-200 个 span，不上 tracing 等同于盲飞。

---

## 七、编码技术

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **SEARCH/REPLACE Block 编辑格式** | 生产就绪（Aider 默认） | 精确字符串替换，避免重写整个文件；大文件 ≥6 处修改时降级为 Script Generation（省 3.5× token） |
| **tree-sitter AST + PageRank Repo Map** | 生产就绪 | 用极小 token（1024）传达大型代码库拓扑关系，被 Cursor 等多工具借鉴 |
| **ReAct 验证闭环（Edit→Test→Fix Loop）** | 生产就绪，行业标准 | GitHub Copilot Coding Agent/Devin 3.0 均以此为核心；Devin 3.0 PR merge 率 67% |
| **LSP 集成（goToDefinition / getDiagnostics）** | 生产就绪 | 编辑后立即报告类型错误，形成「编辑→诊断→修复」紧密循环；LSAP v0.2.0 更高层抽象 |

**关键来源**：[Aider Edit Formats](https://aider.chat/docs/more/edit-formats.html) · [Aider Repo Map](https://aider.chat/2023/10/22/repomap.html) · [OpenHands ICLR 2025](https://github.com/OpenHands/OpenHands) · [Live-SWE-agent arXiv:2511.13646](https://arxiv.org/abs/2511.13646)

### 对 arclightagent 的建议

- **编辑格式**：实现 SEARCH/REPLACE block 作为默认，加装 edit-guard（行数验证 + 连续编辑计数器 + lost-in-the-middle 检测）；对大文件 ≥6 处修改降级为 Script Generation。
- **代码库索引**：tree-sitter AST 感知分块（保持函数/类完整边界）+ PageRank 排名作为核心；向量语义检索仅作自然语言查询的降级回退。参考 [cocoindex 增量实时更新](https://github.com/cocoindex-io/realtime-codebase-indexing)。
- **沙箱执行**：代码执行用 E2B（安全优先）或 Vercel Sandbox，绝不在宿主进程中执行 agent 生成的代码。
- 引入 LSP 集成作为早期里程碑，goToDefinition/getDiagnostics 大幅提升编辑精度；多 agent 并行只在任务可明显并行时使用（约 3-4× token 成本）。
- 参考基准：SWE-bench Verified 当前 SOTA 79.2%（Claude Sonnet 4 + Live-SWE-agent scaffold），个人项目优先评估 [Agentless 三阶段流水线](https://arxiv.org/abs/2407.01489)（成本比 agent 循环低 10×）。

---

## 八、Provider 抽象与路由

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **LiteLLM Proxy（统一 gateway）** | 生产级成熟 | 140+ providers，多策略路由，P95 延迟 8ms，240M+ Docker pulls，MCP/A2A 集成 |
| **Vercel AI SDK v6（前端 provider 抽象）** | 生产级成熟 | TS 原生，100+ providers，两行代码切换 provider，3M+ 周下载 |
| **Prompt Caching（多 provider 原生）** | 生产级成熟 | Anthropic 节省 90%，OpenAI 节省 50%；system prompt + 工具定义放最前、稳定不变 |
| **Instructor / Zod（结构化输出）** | 生产级成熟 | Python 用 Instructor + Pydantic（3M+ 月下载），TS 用 Vercel AI SDK 的 generateObject + Zod |

**备选路由**：[OpenRouter](https://openrouter.ai/)（托管型，Auto Router 自动选模型，免费模型支持）适合个人项目早期降成本；[Portkey Gateway](https://portkey.ai/)（开源，40+ guardrails，SOC2/HIPAA）适合企业合规场景。

**本地模型**：[Ollama](https://github.com/ollama/ollama)（开发/隐私场景，OpenAI-compatible API）；[vLLM](https://docs.vllm.ai/)（GPU 服务器高吞吐，PagedAttention，OpenAI-compatible）。

**关键来源**：[LiteLLM](https://docs.litellm.ai/docs/) · [Vercel AI SDK](https://ai-sdk.dev/) · [Prompt Caching 对比](https://introl.com/blog/prompt-caching-infrastructure-llm-cost-latency-reduction-guide-2025)

### 对 arclightagent 的建议

- **永远不要把业务代码绑死到 provider 原生 SDK**，统一用 OpenAI-compatible 格式作为内部接口标准，换 provider 只改配置文件。
- **成本控制三板斧**：① 开启各 provider 原生 prompt caching（Anthropic 节省 90%）；② FAQ/分类等高重复任务启用 Redis 语义缓存；③ 配置三层 fallback 链（主模型 → 备用同级 → 降级模型），简单任务走 DeepSeek/Gemini Flash，复杂推理走 Claude Sonnet/Opus。
- **模型分层降本提质**（强制执行）：central 综合/架构决策 → Opus；执行类中等任务 → Sonnet；读文档/抽列表等机械工作 → Haiku/Flash。在 LangGraph 多 agent 编排里按 subagent 角色分配模型层级。
- **可观测性**：接 [Langfuse](https://langfuse.com/)（开源，框架无关）或 Helicone，追踪每步 token 用量与成本，LiteLLM 版本锁定小版本（API 变更频繁）。

---

## 九、跨平台交付

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **MCP server（Streamable HTTP + stdio 双模式）作为内核接口** | 生产可用 | 同一内核被 CLI/桌面/VSCode/Chrome 扩展/Web 共享，无需重写逻辑 |
| **Bun --compile（单二进制 CLI 分发）** | 生产可用，Bun v1.x | Claude Code 采用此方式，跨平台编译，启动比 Node.js 快 5-8x，无需用户安装运行时 |
| **Tauri 2.0（桌面壳）** | GA，v2.x 稳定 | Rust + 系统 WebView，~12MB 包体，覆盖 iOS/Android，需学习少量 Rust |
| **VSCode Chat Participants API + MCP（IDE 插件）** | GA（Language Model API GA） | @your-agent 接入 Copilot Chat，MCP server 注册进 VSCode 1.102+，复用用户 Copilot 订阅 |

**关键来源**：[Tauri 2.0](https://v2.tauri.app/) · [Bun executables](https://bun.sh/docs/bundler/executables) · [VSCode MCP Support](https://code.visualstudio.com/blogs/2025/06/12/full-mcp-spec-support) · [Chrome Extensions MV3](https://developer.chrome.com/docs/extensions/whats-new)

### 对 arclightagent 的建议

- **架构核心**：将 agent 内核设计为 MCP server（Streamable HTTP + stdio 双模式），内核本身无 UI 依赖，各端只换壳：
  - **Web 端**（先发）：Next.js + AG-UI + assistant-ui，调用 MCP HTTP server；用 PWA Manifest 让用户可「安装到桌面」，无需打包，验证完 UX 再做原生壳。
  - **CLI**：Bun --compile --bytecode 单二进制，仿 Claude Code 分发方式。
  - **桌面**：纯 TS 团队选 Tauri 2.0（生态更成熟）；若不想学 Rust 且需快速验证可先用 Electrobun（v1，风险：生态较新）。
  - **VSCode 插件**：Chat Participants API（@arclightagent 触发）+ MCP server 注册，复用 Copilot 订阅，不重造聊天 UI。
  - **Chrome 扩展（MV3）**：background service worker 做消息路由，side panel 承载主 UI，通过 WebSocket 连接本地 MCP server 保持存活；MV3 禁止 eval/远程 JS，所有推理通过外部 API 完成。
- 跨端共享用户配置：存储在 `~/.config/arclightagent/`（XDG 标准），CLI 和桌面直接读写，Chrome 扩展通过本地 MCP server 中转。

---

## 十、Deep Research / 写作

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **Orchestrator-Subagent 多智能体架构（Anthropic 模式）** | 生产级，Anthropic 内部验证 | LeadResearcher（Opus 4）+ 并行子代理（Sonnet），比单代理性能提升 90.2%；token 消耗约聊天 15× |
| **LangChain open_deep_research（Supervisor-Researcher）** | 成熟开源，MIT | 基于 LangGraph，三阶段（Scope→Research→Write），HITL 审批，支持 Tavily/Exa/Anthropic/OpenAI |
| **STORM（Stanford OVAL，多视角对话写作）** | 成熟开源，MIT | 模拟多专家视角对话驱动大纲生成，产出带 inline citations 的长文；直接影响了商业 deep research 产品 |
| **CitationAgent 独立引用核验阶段** | 生产级（Anthropic 内部） | statement hallucination 和 citation hallucination 是所有系统的共同痛点；必须为每条声明存储 source chunk 指针 |

**备选（快速集成）**：[GPT-Researcher](https://github.com/assafelovic/gpt-researcher)（27.5k+ stars，Planner+Execution，$0.005/任务，支持 MCP）；[Gemini Deep Research API](https://ai.google.dev/gemini-api/docs/interactions/deep-research)（直接 API 调用，省去工程复杂度，background=True 异步执行）。

**关键来源**：[Anthropic Multi-agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system) · [open_deep_research](https://github.com/langchain-ai/open_deep_research) · [STORM](https://github.com/stanford-oval/storm) · [DeepResearcher arXiv:2504.03160](https://arxiv.org/abs/2504.03160)

### 对 arclightagent 的建议

- **架构骨架**：直接基于 LangGraph open_deep_research（Scope→Research→Write 三阶段）构建，不从零设计；接入 Tavily/Exa 搜索 + Firecrawl 抓取作为 MCP server；LeadResearcher 用 Opus，并行子代理用 Sonnet，CitationAgent 用 Sonnet。
- **HITL 置于研究计划审批环节**（fan-out 执行前）：让用户审批 subtopics 列表，网页端流式展示规划过程降低等待焦虑。
- **异步执行 + SSE 流式反馈是网页端体验关键**：research 任务通常 3-60 分钟，必须实现任务持久化（状态存 DB）+ 断点续研（checkpoint）+ 前端重连恢复；参考 Gemini Interactions API 的 thought/text/image 增量事件设计。
- **Token 预算管理**：简单查询 1 个子代理，复杂研究 10+ 并行；开启 prompt caching（Gemini Deep Research 标准版 50-70% 缓存命中）；设置最大步数防失控。

---

## 十一、Computer Use

### 最值得采用的技术

| 技术 | 成熟度 | 说明 |
|------|--------|------|
| **Claude computer-use（claude-opus-4-5 / sonnet-4-6）** | 生产可用（beta） | OSWorld SOTA：Opus 4.5 66.3%，Sonnet 4.5 61.4%；支持 30+ 小时多步任务；需 anthropic-beta header |
| **browser-use（Python 开源编排框架）** | 成熟开源，SOC 2 Type 2 | WebVoyager ~89%，混合 DOM + accessibility tree，支持 Claude/Gemini/OpenAI/Ollama，97.8k stars |
| **Playwright MCP（microsoft/playwright-mcp）** | 生产可用，官方维护 | 基于 accessibility tree 返回结构化快照，比截图更省 token，适合「用户视角」操作 |
| **Stagehand v3（TS/Python，self-healing）** | 成熟开源 + 商业云 | act/extract/observe/agent 四原语，DOM/布局变化时自动重新适配，适合 TS 技术栈 |

**备选（成本优化）**：[Gemini 2.5 Computer Use](https://blog.google/technology/google-deepmind/gemini-computer-use-model/)（~$1.25/M token，Web/Android 强，内置每步安全服务，Online-Mind2Web 约 225s）；开源自托管 [UI-TARS-2（ByteDance，Apache-2.0）](https://github.com/bytedance/UI-TARS)（OSWorld 47.5%，可私有部署）。

**关键来源**：[Anthropic Computer Use Docs](https://docs.anthropic.com/en/docs/build-with-claude/computer-use) · [browser-use](https://github.com/browser-use/browser-use) · [Stagehand v3](https://www.browserbase.com/blog/stagehand-v3) · [Playwright MCP](https://github.com/microsoft/playwright-mcp)

### 对 arclightagent 的建议

- **架构**：采用「DOM/accessibility-tree 优先 + 视觉兜底」混合模式。Playwright MCP（accessibility tree）作为主路径，token 省、稳、确定；仅 canvas/自定义渲染等 DOM 不可靠场景回退到视觉 grounding。
- **模型分层**：Web 操作主力用 Claude Sonnet 4.6（最强，成本合理）；预算敏感用 Gemini 2.5 Computer Use；数据合规/自托管用 UI-TARS-2。
- **执行层不自己造轮子**：直接用 browser-use（Python 技术栈）或 Stagehand v3（TS 技术栈），二者均支持多模型后端。
- **安全作为一等公民**：高危动作（支付/删除/邮件外发/权限授予/改密码）强制 HITL 确认 + 动作白名单；在 E2B Firecracker microVM 或 Browserbase/Steel 云浏览器中隔离运行；记录完整动作审计日志便于回溯。
- **针对 prompt injection 建立纵深防御**：OpenAI 已承认「不太可能被彻底解决」，NCSC 称「可能永远无法完全缓解」。默认不信任页面内容中的「指令」，限制可访问域名白名单，跨域/跳转至敏感操作时二次确认。
- **全平台扩展路径**：先做好 Web 浏览器自动化（browser-use），再用同一「截图→推理→动作」循环扩展到桌面（OSWorld）与 Android（Gemini Computer Use / UI-TARS-2 的 AndroidWorld 能力）。

---

## 综合选型决策矩阵

| 维度 | 选型 | 理由 |
|------|------|------|
| Agent 核心循环 | LangGraph 1.0 | 模型无关，checkpointer，HITL，原生流式 |
| 前端框架 | Next.js App Router + assistant-ui | TS 全栈，AG-UI 适配，Radix 可组合 |
| AI SDK | Vercel AI SDK v6 | 3M+ 下载，Provider 抽象，useChat，AG-UI 适配 |
| 协议层 | AG-UI + MCP + A2A（三件套） | AG-UI 接前端，MCP 接工具，A2A 接 agent 间 |
| 记忆层 | mem0（archival）+ LangGraph state（working） | 生产验证，多模型，性价比最高 |
| Provider 路由 | LiteLLM Proxy + Vercel AI SDK | 后端统一 gateway，前端 TS 抽象 |
| 流式传输 | SSE + Resumable Streams（Redis + vercel/resumable-stream） | 断线恢复，第一天设计进去 |
| 代码沙箱 | Vercel Sandbox（web）+ E2B（通用） | microVM 隔离，Next.js 零配置集成 |
| 浏览器自动化 | browser-use 或 Stagehand v3 | 不自己造轮子，89%+ WebVoyager |
| Computer Use 模型 | Claude Sonnet 4.6（主）+ Gemini 2.5 CU（备） | 最强 OSWorld，分层降本 |
| Deep Research | open_deep_research（骨架）+ Opus（综合）+ Sonnet（子代理） | 成熟开源 MIT，已验证架构 |
| CLI 分发 | Bun --compile | Claude Code 采用，零依赖，5-8× 启动速度 |
| 桌面壳 | Tauri 2.0 | 12MB 包体，iOS/Android 覆盖，生态成熟 |
| IDE 插件 | VSCode Chat Participants API + MCP | 复用 Copilot 订阅，零 UI 开发 |
| 本地模型 | Ollama（开发调试）+ vLLM（GPU 服务器） | OpenAI-compatible，无缝接入 LiteLLM |