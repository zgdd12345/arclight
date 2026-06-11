Now I have sufficient information to write the comprehensive selection report. Let me compile the findings.

---

# arclightagent · Provider 抽象与路由子系统【拿来即用选型清单】

> 总原则：最大化复用现成成熟实现，自研只留"薄接缝"，把轮子制造推迟到产品成熟后。
> 适用范围：MVP = Web 单端 + 写代码单能力 + 单用户 + 本地沙箱；技术栈 = TypeScript + Bun + Next.js。

---

## 一、统一 Provider 调用层

### 1.1 前端 / 内核编排层：Vercel AI SDK

| 项 | 内容 |
|---|---|
| **名称** | `ai`（Vercel AI SDK v5/v6） |
| **来源** | npm 包 `ai`；`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/google` 等 provider 子包；GitHub: github.com/vercel/ai |
| **许可证** | Apache-2.0 |
| **它提供什么** | TypeScript 原生统一调用层：`streamText`/`generateText`/`generateObject`；`useChat`/`useCompletion` React Hook（流式 UI 开箱即用）；内置 Zod schema 结构化输出（`generateObject`）；工具调用统一 interface；多步骤 tool-loop（v5+）；provider 切换只改两行代码；3M+ 周下载量 |
| **集成成本量级** | **拿来即用** — `npm install ai @ai-sdk/anthropic`，10 行代码即可跑通流式对话 |
| **成熟度与风险** | **生产级成熟**。v5 2025 已稳，v6 新增 Agents 类与 MCP 全面支持。**坑：AI SDK UI（useChat 等）深度绑定 React/Next.js**，若未来迁其他框架成本较高；但 MVP 前端即 Next.js，此绑定是优势不是包袱；AI SDK Core（`generateText`/`streamText`）完全 framework-agnostic，可单独用于后端 Hono 服务 |
| **自研接缝（最小）** | 仅需在 Hono 服务端封装 `streamText` 的 SSE 推送路由；前端用官方 `useChat` 即可，零自研 |

### 1.2 后端统一 Gateway：LiteLLM Proxy

| 项 | 内容 |
|---|---|
| **名称** | LiteLLM（Python SDK + 自托管 Proxy） |
| **来源** | `pip install litellm`；Docker 镜像 `ghcr.io/berriai/litellm`；GitHub: github.com/BerriAI/litellm（49.7k stars） |
| **许可证** | MIT |
| **它提供什么** | 140+ provider、2500+ 模型的 OpenAI-compatible 统一 HTTP 网关；成本路由/负载均衡/failover/retry；虚拟 API key；prompt caching 头部透传；预算追踪；P95 延迟 8ms（1k RPS）；生产环境 10 亿+请求验证 |
| **集成成本量级** | **轻度封装** — 用 Docker Compose 一键起 Proxy；Vercel AI SDK 配置 `baseURL` 指向它，provider 从 Anthropic/OpenAI 切换只改配置文件，业务代码零修改 |
| **成熟度与风险** | **生产级成熟**，但有一个真实坑：**版本迭代极快（截至 2026-06-06 已发 v1.88.0，一年 1349+ 个版本）**，API 配置格式偶有变化。生产环境务必锁定小版本 `~1.88.0`；升级前阅读 release notes，路由配置失败是静默的（fallback 而非 crash）。另：LiteLLM 是 Python 进程，是本架构承认的唯一 sidecar，通过 HTTP 隔离不渗入 TS 内核 |
| **自研接缝（最小）** | 维护 `litellm-config.yaml`（provider 列表 + fallback 链 + 路由规则）；无需改任何 TS 业务代码 |

**aider 的实证验证**：aider 以 `LazyLiteLLM` 代理包装 `litellm.completion()`，所有 50+ provider 调用统一走此单点，同时用 `model-settings.yml` 声明每个模型的差异，是本架构"声明式模型配置"的直接参考（Apache-2.0，设计可借鉴；其 `llm.py` 的延迟加载模式可复用到 TS 侧的 lazy provider import）。

---

## 二、模型目录与元数据

### 2.1 models.dev 目录

| 项 | 内容 |
|---|---|
| **名称** | models.dev（LLM 模型元数据目录） |
| **来源** | opencode 仓库使用；`@opencode-ai/llm` 包依赖；网站 models.dev |
| **许可证** | 公开 API/数据，opencode 作为 provider 元数据查询后端 |
| **它提供什么** | context window / pricing / 能力标志（支持 vision、tool call、thinking 等）的统一查询；opencode 的 `@opencode-ai/llm` 包以此驱动模型选择 UI |
| **集成成本量级** | **拿来即用** — LiteLLM 内置了 `litellm.get_model_info()` 并从在线 JSON + 本地缓存获取同等元数据（与 models.dev 数据源部分重叠）；MVP 可直接用 LiteLLM 的内置模型元数据，不单独集成 models.dev |
| **成熟度与风险** | **生产可用**，作为查询后端足够稳定。**MVP 建议：直接用 LiteLLM 的 `get_model_info()` + 本地 `model-settings.yaml`，不额外依赖 models.dev HTTP 调用** |
| **自研接缝（最小）** | 维护一份 `model-config.ts`，从 LiteLLM metadata 填充 context window / pricing，用于前端模型选择器和 token 预算估算 |

---

## 三、ThinkingLevel 统一抽象

### 3.1 现成方案：pi 的 ThinkingLevel 抽象（MIT，可直接复用代码）

| 项 | 内容 |
|---|---|
| **名称** | pi 的 `ThinkingLevel` 类型 + `thinkingLevelMap` 映射机制 |
| **来源** | GitHub: github.com/earendil-works/pi，**MIT 许可证**；核心文件 `packages/ai/src/types.ts`（`ThinkingLevel` 类型定义）+ `packages/agent/src/types.ts`（`Model.thinkingLevelMap`）|
| **许可证** | **MIT** — 代码可直接复用，需保留 copyright 声明 |
| **它提供什么** | 6 档统一推理抽象：`'off' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh'`；每个 Model 的 `thinkingLevelMap` 将档位映射到 provider 具体参数（Anthropic 的 `budget_tokens`、OpenAI 的 `reasoning_effort` 字符串、Google 的 `thinking_config`、`null` = 不支持）；`getSupportedThinkingLevels()` 从模型元数据动态计算可用档位；`ThinkingBudgets` 允许覆盖每档 token 预算 |
| **集成成本量级** | **轻度封装** — 直接复制 `ThinkingLevel` 类型定义（约 30 行），在 `model-config.ts` 中为每个支持推理的模型填写 `thinkingLevelMap`；Vercel AI SDK 侧在调用 `streamText` 时根据档位注入 `providerOptions` |
| **成熟度与风险** | **生产可用**（pi MIT，已在 pi agent 中大量使用）。**注意：Vercel AI SDK 各 provider 子包对 extended thinking 的支持参数名不同**，需在封装层手动适配（Anthropic 用 `anthropic.thinking`，OpenAI o 系列用 `openai.reasoningEffort`）；但适配逻辑本身就是几行 switch-case，不属于"大量缝合" |
| **自研接缝（最小）** | 一个 `applyThinkingLevel(level: ThinkingLevel, provider: string): ProviderOptions` 函数（约 20 行），将统一档位翻译成各 provider 的 Vercel AI SDK `providerOptions`；后置到 `@arclight/llm` 包时可将此函数内化 |

**重要区分**：pi 的 `ThinkingLevel` 类型（纯 TS 接口 + 映射 object，MIT）**可直接搬代码**；opencode 的 `@opencode-ai/llm` 包虽也有类似抽象，但其整个 llm 包深绑 Effect 4.x beta，**仅借设计，不搬代码**。

---

## 四、结构化输出 / 工具调用兼容层

### 4.1 TypeScript 端：Vercel AI SDK `generateObject` + Zod

| 项 | 内容 |
|---|---|
| **名称** | `ai` 的 `generateObject`；`zod`（npm 包） |
| **来源** | `npm install ai zod`；Zod: GitHub: github.com/colinhacks/zod（MIT） |
| **许可证** | AI SDK: Apache-2.0；Zod: MIT |
| **它提供什么** | `generateObject({ schema: z.object({...}) })` — 内置 Zod schema 验证、JSON 解析、自动 fallback 到 JSON mode（provider 不支持原生 structured output 时）；支持 15+ provider；流式部分输出（`streamObject`）可实时渲染 |
| **集成成本量级** | **拿来即用** — MVP 写代码场景（解析文件路径列表、解析 diff patch 元数据等）直接用 `generateObject` + Zod schema，零额外依赖 |
| **成熟度与风险** | **生产级成熟**。**坑：部分开源模型（Ollama 后端）的 structured output 支持依赖模型 chat template 质量**，建议对本地模型调用加 Zod `.safeParse()` 保护 + 手动 retry（最多 2 次） |
| **自研接缝（最小）** | 无需自研；在工具系统的 `executeToolCall` 输出验证处统一用 `z.safeParse()` |

### 4.2 工具调用格式兼容

Vercel AI SDK v5+ 提供统一的 `tool()` 定义 interface，自动将 Zod schema 转换成各 provider 的 function-calling/tool-use 格式。**直接使用，无需自研兼容层。**

**坑（来自 topic-provider-routing.json caveats）**：本地模型（Ollama/vLLM）的 tool calling 输出格式依赖各模型的 chat template，部分开源模型（如某些 Mistral 变体）有自定义输出格式，OpenAI-compatible 适配层不一定能正确翻译。**MVP 阶段只接云端主力 provider（Anthropic），此坑不触发；接入 Ollama 时必须实测验证 tool call 解析，Vercel AI SDK 的 `tool()` 内置 parse-error 是第一道防线。**

---

## 五、OpenRouter（托管路由服务）

| 项 | 内容 |
|---|---|
| **名称** | OpenRouter |
| **来源** | openrouter.ai；Vercel AI SDK 有官方 provider 包 `@openrouter/ai-sdk-provider` |
| **许可证** | 托管服务，无源码许可证；`@openrouter/ai-sdk-provider` npm 包 MIT |
| **它提供什么** | 300+ 模型统一 OpenAI-compatible API；Auto Router（自动按 prompt 特征选模型）；按价格/延迟过滤；免费模型（DeepSeek R1、Llama 3.3 70B 等）；Prompt caching 折扣（标准 input 价格 10-20%）；自动 failover |
| **集成成本量级** | **拿来即用** — 通过 LiteLLM 配置 `openrouter/` 前缀或直接用 `@openrouter/ai-sdk-provider`，两行代码接通 |
| **成熟度与风险** | **生产级成熟，但有一个真实隐患**：**OpenRouter 默认允许 provider 收集数据**，部分 provider 要求 Zero Data Retention 需额外配置（`providers.require_parameters: {data_collection: "deny"}`）。**个人 AI Agent 处理用户代码/文件/私人数据时，此风险必须评估**；MVP 若主力 provider 是 Anthropic 直连，OpenRouter 只作"免费模型探索"用途，数据隐私风险可接受 |
| **定位建议** | MVP 期作为**可选的免费模型访问通道**（DeepSeek 等），不作主力路由。自托管 LiteLLM + 直连 Anthropic/OpenAI 才是主路 |
| **自研接缝** | 无需自研 |

---

## 六、Prompt Caching 策略

**不需要自研，直接按各 provider 规范配置即可。**

| Provider | 机制 | 如何启用（via AI SDK / LiteLLM） |
|---|---|---|
| Anthropic | 显式 `cache_control: {type:"ephemeral"}` 断点；cache read 约 $0.30/M（节省 90%）；最短 1024 tokens | AI SDK `@ai-sdk/anthropic` 的 `messages` 参数支持 `cacheControl: "ephemeral"`；LiteLLM 透传头部 |
| OpenAI | 自动前缀缓存，25-50% 折扣，无需显式标记 | 自动生效，确保 system prompt 稳定即可 |
| Google Gemini | 按分钟/小时计费缓存存储 | AI SDK `@ai-sdk/google` 配置 `cachedContent` |

**aider 实证（Apache-2.0 设计可借鉴）**：`chat_chunks.py` 的 `add_cache_control_headers()` 在 examples / repo / chat_files 三个稳定段末尾注入 `cache_control:ephemeral`，动态内容（当前用户消息）不标记；还有 **cache warming 后台线程**（每 5 分钟发 max_tokens=1 心跳维持缓存）。这套策略的 **设计思路直接移植**到 arclightagent 的 system context 组装逻辑中（`[system_prompt + tool_definitions]` 加 cache 断点，用户消息不加）。

**关键约束（来自 ARCHITECTURE_BLUEPRINT.md §2.4）**：caching 优化只对主力 provider（Anthropic）做满；网关层对所有 provider 只保证一件事：**不破坏前缀稳定性**（append-only、不重排系统消息、mask 不删工具）。

**自研接缝（最小）**：在 Hono 服务端组装 system context 时，将稳定的 `[system_prompt + tool_definitions]` 块放最前并标记 cache 断点，动态用户消息放后；这是约 10 行的消息排序逻辑，不是轮子。

---

## 七、本地模型接入

### 7.1 Ollama（开发调试 / 隐私场景）

| 项 | 内容 |
|---|---|
| **名称** | Ollama |
| **来源** | github.com/ollama/ollama；`ollama` CLI；底层封装 llama.cpp |
| **许可证** | MIT |
| **它提供什么** | 本地 LLM 运行时 + OpenAI-compatible HTTP API（localhost:11434/v1）+ 模型 registry；支持 Llama/Mistral/Qwen/DeepSeek/Gemma 等 |
| **集成成本量级** | **拿来即用** — LiteLLM 配置 `model: "ollama/llama3"` 一行接入；Vercel AI SDK 用 `createOpenAI({ baseURL: "http://localhost:11434/v1" })` |
| **成熟度与风险** | **生产级成熟**（本地开发场景）。**坑：tool calling 依赖模型 chat template，部分模型不稳定（见§四）**；MVP 写代码场景建议只用 Ollama 做本地调试，主力走云端 Anthropic |
| **MVP 定位** | 可选，开发者本地调试用；不是 MVP 必须件 |

---

## 八、参考仓库代码复用判断汇总

| 仓库 | 许可证 | provider 相关可直接复用的代码 | 仅借设计 |
|---|---|---|---|
| **pi** (`earendil-works/pi`) | **MIT** | `ThinkingLevel` 类型定义（`packages/ai/src/types.ts`）；懒加载 provider 注册模式（`register-builtins.ts`）；`streamSimple` 统一调用入口模式 | — |
| **aider** (`Aider-AI/aider`) | **Apache-2.0** | `model-settings.yml` 声明式模型差异配置格式（需保留 copyright + NOTICE）；`LazyLiteLLM` 延迟加载代理模式；ChatChunks 分段 cache header 注入策略 | — |
| **opencode** (`anomalyco/opencode`) | **MIT** | — | `@opencode-ai/llm` 的 protocol+route+transport 三层抽象（深绑 Effect 4.x beta，只借设计，不搬代码；等阶段五自研 `@arclight/llm` 时作蓝本） |
| **claudecode** | **闭源，无 LICENSE** | **禁止复用任何代码或文本资产** | provider 缓存前缀稳定性策略（仅架构思路） |

---

## 九、现在不要自研、推迟到产品成熟后的部分

以下内容**明确点名后置**，MVP 期不碰：

1. **`@arclight/llm` 独立 provider 包**（opencode protocol+route+transport 三层抽象）：MVP 用 AI SDK + LiteLLM 已足够，独立包是阶段五的工作。过早自研 = 在 LiteLLM 之上再造一个 LiteLLM。
2. **智能语义路由**（Auto Router / embedding-based 模型选择）：MVP 硬编码主力模型（Anthropic claude-sonnet-4-x），按任务类型硬路由；语义路由等有了足够的 eval 数据后再上。
3. **语义缓存**（Redis vector similarity）：高重复 FAQ/分类场景有收益，但 MVP 写代码场景重复率低，不值得引入额外 Redis + embedding 计算。等产品有大量用户重复 query 时再评估。
4. **多级 fallback 链精细配置**（超时/5xx/context overflow 分别路由不同策略）：MVP 只配 Anthropic 主模型 + 一个备用，fallback 策略复杂化是过度工程。
5. **完整可观测性 pipeline**（Langfuse trace + Prometheus metrics + 统一审计日志）：MVP 用 LiteLLM 自带的 usage log 即可；完整 observability 是阶段三基建。
6. **vLLM 高性能推理引擎**：GPU 服务器部署才需要，个人 Agent MVP 不适用。
7. **BAML DSL 跨语言 schema 共享**：TypeScript 端 Zod 已经足够，BAML 适合大团队多语言场景。

---

## 十、MVP 最小依赖集（阶段一 Web + 写代码真正需要的最少现成件）

```
# npm / Bun 依赖（TypeScript 内核 + Next.js 前端）
ai                            # Vercel AI SDK Core + UI（Apache-2.0）
@ai-sdk/anthropic             # Anthropic provider（Apache-2.0）
zod                           # 结构化输出 schema 验证（MIT）

# 可选：多 provider 探索（已有 Anthropic 则不急）
@ai-sdk/openai                # OpenAI provider（Apache-2.0）
@openrouter/ai-sdk-provider   # OpenRouter（MIT，免费模型用）

# 外部服务（Docker / 独立进程，非 npm）
litellm proxy                 # Docker，MIT，后端统一 gateway（可选，MVP 也可 AI SDK 直连 Anthropic）
ollama                        # 本地开发调试，MIT（可选）
```

**逻辑：**
- **最小核心**：`ai` + `@ai-sdk/anthropic` + `zod`。三包合计，Anthropic 直连，流式输出 + 结构化输出全覆盖，provider 切换只改 `@ai-sdk/xxx` 包名。
- **LiteLLM Proxy 可选**：MVP 只接一个主力 provider 时，直接用 AI SDK 直连 Anthropic，LiteLLM 可以先不起。当需要同时接 2+ provider 或需要统一 key 管理时再起 Proxy。
- **ThinkingLevel 接缝**：从 pi（MIT）复制约 30 行 `ThinkingLevel` 类型定义 + 手写 20 行 `applyThinkingLevel()` 函数，不引入额外 npm 包。
- **Prompt caching**：AI SDK `@ai-sdk/anthropic` 原生支持 `cacheControl` 参数，无需额外包，只需在消息组装时把 `[system + tool_defs]` 放前并标记断点。

**单一 provider 成本最优选择**：**Anthropic（claude-sonnet-4-x 系列）**。理由：① AI SDK 原生深度支持；② 显式 prompt caching（90% token 成本节省，对 agent 场景收益最大）；③ 工具调用格式最稳定，MVP 写代码场景无需额外兼容工作；④ 是 ARCHITECTURE_BLUEPRINT.md §2.4 明确的主力 provider 选择。