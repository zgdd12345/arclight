我已获取足够信息。现在整合所有调研数据，输出选型清单。

---

# arclightagent 上下文与记忆子系统 — 拿来即用选型清单

> 范围：上下文压缩(context compaction)、长期记忆系统、检索层。  
> 原则：MVP = Web 单端 + 写代码单能力 + 单用户。能拿现成拿现成，接缝最薄。

---

## 一、上下文压缩(Context Compaction)

### 1.1 MVP 单级压缩：LLM 摘要 + 结构化模板（自研薄接缝）

| 项目 | 说明 |
|---|---|
| **直接采用的现成方案** | **无可直接安装的 npm 库**。但有两份可复用的现成「模板+触发逻辑」设计：① **opencode `packages/core/src/session/compaction.ts`（MIT）** — 结构化 Markdown 摘要模板（Goal / Constraints / Progress / Done / InProgress / Blocked / Next Steps / Critical Context / Relevant Files）+ KEEP_TOKENS=8000 预算 + 溢出自动重试逻辑，代码可直接复用（MIT 许可，复制需保留版权头）。② **opensquilla `session/compaction.py`（Apache-2.0）** — 结构化 summary 保留用户目标/状态/改动文件/失败/下一步，思路一致但为 Python，移植为 TS 即可（Apache-2.0，复制需 NOTICE/attribution）。触发时机：effectiveContextWindow = contextWindow − reservedTokensForSummary，超阈值即调 LLM 生成摘要并打 compactBoundary。这是 **claudecode `services/compact/autoCompact.ts`（闭源，仅学设计不复用代码）** 的思路。 |
| **集成成本** | 轻度封装（约 100–200 行 TS：计算窗口使用率 → 调 LLM → 返回摘要文本 → 打 boundary 标记）。可复用 opencode 的模板 + 触发条件，约 0.5 天完成。 |
| **成熟度与风险** | 生产可用。结构化模板比自由摘要稳定、可解析；opencode 在生产使用中；风险：LLM 摘要有损且不可逆，需保留 compactBoundary 前的 JSONL 以供回溯。 |
| **最小自研接缝** | 计算 `effectiveWindow` 的 token 计数函数（可用 `@anthropic-ai/tokenizer` npm 包或 Anthropic API 的 `count_tokens` 端点，无需自研）；选择「何时触发摘要」的阈值策略（一行配置）；将摘要结果 append 到 messages 数组的 3 行胶水代码。 |
| **推迟到产品成熟后** | 三级渐进压缩（snip → microcompact → autocompact）；microcompact 的 cache-editing API 原地清空旧 tool_result；ACON/Cat 论文中的压缩指南优化器。 |

### 1.2 Token 计数

| 项目 | 说明 |
|---|---|
| **直接采用** | **`@anthropic-ai/tokenizer`** npm 包（Anthropic 官方，Apache-2.0），或直接调用 Anthropic Messages API 的 token counting 端点。对 OpenAI 类 provider 用 **`tiktoken`** wasm 移植（`@dqbd/tiktoken`，MIT）。**不需自研。** |
| **集成成本** | 拿来即用（一行 import）。 |
| **成熟度** | 生产可用。 |

---

## 二、长期记忆系统

### 2.1 MVP 阶段：不引外部记忆库

**明确结论：MVP（Web 单端 + 写代码）根本不需要 archival 长期记忆。**

- 写代码是会话内任务，上下文完全够用；
- 单用户本地场景，会话结束即任务结束，跨会话关联没有用户价值；
- ARCHITECTURE_BLUEPRINT §2.1 已明确：「MVP 不引 mem0；阶段四日常规划真需跨会话长期记忆时再评估」；
- 引 mem0/Zep/Letta 在 MVP 是过度设计：每个库都携带额外的 Python/Node 服务，运维成本不对称。

**MVP 的「伪记忆」用最朴素实现**：把 MEMORY.md 文件（上限 200 行，参考 claudecode memdir 思路）存于项目目录；每次 session 开始时异步读取并注入系统消息尾部。实现约 30 行 TS，0 依赖。

---

### 2.2 阶段四（日常规划 / 多会话）：三选一评估方案

以下三个选项均为评估对象，到时按真实数据 A/B 再拍板，**现在不引入任何一个**。

#### 选项 A：mem0（首选候选）

| 项目 | 说明 |
|---|---|
| **来源** | `mem0ai/mem0`，npm 包 `mem0ai`（MIT），Python 主仓 `PyPI mem0ai`（MIT）。JS/TS SDK：`npm install mem0ai`（官方维护）。 |
| **许可证** | MIT（核心库）。云端 SaaS 有商业附加条款，自托管开源版 MIT。 |
| **它提供什么** | 结构化 add/search/update/delete 记忆操作 + 异步写入 + 元数据过滤 + 时间戳保真。LoCoMo 上较 OpenAI memory 高 26% 准确率、低 91% 延迟、省 90% token。支持 Claude/OpenAI/Gemini 多 LLM。有官方 TS SDK，API 风格简洁。 |
| **集成成本** | 拿来即用（3–5 行初始化）+ 轻度封装（统一 add/retrieve 接口，与内核 session 生命周期绑定）。 |
| **成熟度与风险** | 生产级开源（ECAI 2025 发表，多家企业使用）。**坑**：benchmark 数字为厂商自报（LoCoMo 子集与自选 LLM），需在自有数据上复测；自托管需额外部署 vector store（Qdrant/Chroma）；TS SDK 功能落后 Python 主仓，部分高级配置需读 Python 源码理解行为。 |

#### 选项 B：Zep / Graphiti（时序知识图谱，适合需要实体关系场景）

| 项目 | 说明 |
|---|---|
| **来源** | `getzep/graphiti`（Apache-2.0），`npm install @getzep/graphiti-core`（JS SDK 早期）或直接调 Zep Cloud API（商业）。 |
| **许可证** | Graphiti 开源核心 Apache-2.0；Zep Cloud 商业 SaaS。 |
| **它提供什么** | 时序感知知识图谱：episodic / semantic / community 三层子图，融合非结构化对话与结构化业务数据，保留历史关系演化。LongMemEval +18.5% 准确率、延迟 −90%。 |
| **集成成本** | 需较多缝合（需运行 Neo4j 或 Memgraph 图数据库；JS SDK 功能不完整，部分需直接调 REST；实体抽取流水线有延迟/token 开销）。 |
| **成熟度与风险** | 生产级开源/商业。**坑**：图数据库运维成本高；JS SDK 尚早期；实体抽取错误会污染图，需额外清洗；2026 年趋势已从外部图库转向「内置 entity linking 的混合多信号检索」（mem0 观察），纯图路线长期价值在下降。 |

#### 选项 C：Letta（完全 Agent 自管理记忆，适合需要 memory blocks 的高级场景）

| 项目 | 说明 |
|---|---|
| **来源** | `letta-ai/letta`，`pip install letta`（Python），有官方 REST API，TS 侧通过 HTTP 调用（无官方 TS SDK）。 |
| **许可证** | Apache-2.0（开源核心）；Letta Cloud 商业。 |
| **它提供什么** | MemGPT 演进版：memory blocks（可自编辑的功能单元）+ sleep-time agents（空闲时异步重组记忆）+ 分层 core / archival / external files。 |
| **集成成本** | 需较多缝合（Python 服务 sidecar；TS 侧仅 HTTP 调用；与 arclightagent TS 内核语言边界最大）。 |
| **成熟度与风险** | 生产级开源。**坑**：语言边界是最大风险（又一个 Python sidecar）；Letta 基准显示 GPT-4o-mini + 基础文件工具在 LoCoMo 达 74.0%，超 mem0 图变体 68.5%，提示「简单文件工具往往被用得更好」——用 MEMORY.md + grep 的朴素方案在写代码场景可能已够用，Letta 对 MVP 过重。 |

---

## 三、检索层（Retrieval）

### 3.1 向量检索：sqlite-vec

| 项目 | 说明 |
|---|---|
| **直接采用** | **`sqlite-vec`**，npm 包 `sqlite-vec`（Apache-2.0，MIT，由 Alex Garcia 维护），与已选 SQLite + Drizzle 数据栈完全契合。`import { sqliteVec } from 'sqlite-vec'` 即用，无需独立向量数据库服务。 |
| **许可证** | Apache-2.0 / MIT（双许可，商业可用）。 |
| **它提供什么** | SQLite extension，在同一 SQLite 文件内存向量，支持 cosine / L2 / dot-product 近邻查询；单文件部署，零额外服务；Bun/Node 均有官方 binding；opensquilla `memory/store.py` 的 Python 侧已验证此路线（其 JS 等价品即 `sqlite-vec` npm）。 |
| **集成成本** | 拿来即用（sqlite-vec 作为 Drizzle migration 中的 extension 加载，创建 vector 列，调 `vec_search`）。 |
| **成熟度与风险** | 生产可用（Alex Garcia 同时维护 `sqlite-json1`/`sqlite-http`，社区信任度高；sqlite-vec 已有多个生产案例）。**坑**：ANN 性能在百万级向量后不如 Qdrant/pgvector，但单用户个人 Agent 向量数不会超万级，完全够用；若后续多租户服务化需替换。 |

### 3.2 全文/BM25 检索

| 项目 | 说明 |
|---|---|
| **直接采用** | **SQLite FTS5**（内置，无需额外 npm 包），通过 Drizzle 或原始 SQL `CREATE VIRTUAL TABLE ... USING fts5(...)` 使用。BM25 排序是 FTS5 内置支持（`rank` 隐式列）。 |
| **许可证** | SQLite 公共领域（Public Domain）。 |
| **它提供什么** | BM25 全文检索 + 高亮 + snippet；与向量检索在同一 SQLite 事务内做混合排序（Reciprocal Rank Fusion 胶水代码约 20 行）。opensquilla 的 `memory/store.py` + `retrieval/fusion.py` 已验证「sqlite-vec 向量 + FTS/BM25 混合检索」路线，移植为 TS 是直接的。 |
| **集成成本** | 拿来即用（FTS5 是 SQLite 内置；Drizzle 可直接写 raw SQL；RRF 融合 20 行 TS）。 |
| **成熟度** | 生产可用。SQLite FTS5 是工业级组件。 |

### 3.3 Embedding 生成

| 项目 | 说明 |
|---|---|
| **直接采用** | **Vercel AI SDK v6 的 `embed()` / `embedMany()`**（已是选定技术栈，Apache-2.0）+ Anthropic / OpenAI Embeddings API。本地替代：**`@xenova/transformers`**（Apache-2.0，Hugging Face Transformers.js），可在 Bun 内跑 `all-MiniLM-L6-v2`，无需出站 API 调用，适合本地优先场景。 |
| **集成成本** | 拿来即用（Vercel AI SDK 已在技术栈中；`@xenova/transformers` 需下载模型文件，约 30MB）。 |
| **成熟度** | 生产可用。 |

### 3.4 中文分词（可选，提升中文 BM25 召回）

| 项目 | 说明 |
|---|---|
| **直接采用** | **`nodejieba`**（LGPL-2.1，Node addon）或 **`tiny-segmenter`**（BSD，纯 JS，无 addon 依赖）。**注意**：`nodejieba` 为 LGPL-2.1，动态链接可用但需声明；若许可证敏感选 `tiny-segmenter`（精度低但零依赖）。opensquilla 用 Python `jieba`，TS 侧 `nodejieba` 是其等价品。 |
| **集成成本** | 拿来即用（分词结果作为 FTS5 tokenizer 的输入，或直接 tokenize 后存入 FTS 索引）。 |
| **成熟度** | 生产可用（jieba 系是中文 NLP 事实标准）。**MVP 写代码场景英文居多，中文分词可后置**。 |

---

## 四、KV-Cache 友好的上下文管理（零 npm 依赖，设计原则）

这不是一个库，而是**必须在内核实现里强制执行的工程纪律**，参考来源为 claudecode/Manus/opencode（均为设计借鉴，不复用代码）：

1. **系统 prompt 分段**：可缓存段（工具 schema、persona、项目上下文）永远置于消息数组最前且逐 token 稳定；动态段（当前日期、会话 id）使用 opencode 的 **Context Epoch 增量系统消息**机制（仅学设计，约 50 行 TS 接缝），在安全边界懒采样，作为 `role: "user"` 的 `mid-conversation system message` 追加，而不是重发整段 system prompt。
2. **append-only 消息数组**：工具结果超大时落盘（见工具系统落盘投影），不删，只用 compaction boundary 标记裁剪起点。
3. **工具集稳定**：用 mask/schema filter（`materializeTools(permissions)`）而非动态增删工具。

**接缝**：`buildSystemPromptParts(epoch)` 函数 + `shouldTriggerCompaction(tokenCount, windowSize)` 函数，各约 30 行 TS，无外部依赖。

---

## 五、许可证与代码复用边界汇总

| 来源 | 许可证 | 可直接复用代码 | 备注 |
|---|---|---|---|
| opencode `compaction.ts` | MIT | **是**（保留版权头） | 压缩模板 + 触发逻辑 |
| opensquilla `session/compaction.py` | Apache-2.0 | **移植为 TS 可用**（需 NOTICE/attribution） | 结构化 summary 字段设计 |
| opensquilla `memory/store.py` + `retrieval/fusion.py` | Apache-2.0 | **移植为 TS 可用**（需 NOTICE） | sqlite-vec + BM25 混合检索 |
| claudecode `compact/autoCompact.ts` | **闭源，禁复用** | **否** | 仅学触发时机设计 |
| claudecode `memdir/memdir.ts` | **闭源，禁复用** | **否** | 仅学 MEMORY.md 文件格式思路 |
| mem0 npm SDK | MIT | 可直接 npm install | 阶段四才引入 |
| sqlite-vec npm | Apache-2.0 / MIT | 可直接 npm install | MVP 向量检索 |
| SQLite FTS5 | Public Domain | 内置 | MVP BM25 |
| @xenova/transformers | Apache-2.0 | 可直接 npm install | 本地 embedding |

---

## 六、MVP 最小依赖集（阶段一 Web + 写代码真正需要的）

```
# npm 包（阶段一实际需要）
sqlite-vec                    # 向量检索（Apache-2.0/MIT）
@xenova/transformers          # 本地 embedding（Apache-2.0）
                              # 或直接用 Vercel AI SDK embed()，不额外安装

# SQLite FTS5                 # 内置，无需安装
# Drizzle ORM                 # 已在技术栈，无需额外安装
```

**自研接缝（各约 30–200 行 TS，不是轮子）：**
- `compaction.ts`：opencode 模板移植 + 触发阈值（复用 MIT 代码，200 行）
- `memoryStore.ts`：sqlite-vec + FTS5 + RRF 融合（移植自 opensquilla Apache-2.0 设计，约 150 行）
- `memoryFile.ts`：MEMORY.md 读写 + session 开始时注入（约 30 行，0 依赖）
- `systemContext.ts`：Context Epoch 增量消息（学 opencode 设计，约 50 行）

**阶段一明确不引入（推迟）：**
- `mem0` / `mem0ai` — 阶段四日常规划再评估
- `@getzep/graphiti-core` — 阶段四再评估
- `letta` — 阶段四再评估，且是 Python sidecar
- 三级压缩（snip → microcompact → autocompact）— 阶段二/三
- cache-editing API 的 microcompact — 阶段二
- 中文分词 (`nodejieba`) — 阶段一写代码场景英文为主，后置
- 外部向量数据库（Qdrant / pgvector / Weaviate）— 多租户时再迁移

---

## 七、推迟到产品成熟后自研的部分（点名）

1. **自研 archival 记忆引擎**（现在用 mem0 / sqlite-vec 混合检索够用，成熟后可自研更贴合场景的检索策略）
2. **自研 LLM 摘要压缩质量优化器**（ACON 风格的压缩指南自动优化，现在用结构化模板足够）
3. **自研知识图谱记忆层**（Zep/Graphiti 路线，等用户量与实体密度真的需要时再做）
4. **自研 sleep-time / offline consolidation**（Letta Dream 风格的离线记忆整理，等日常规划上线后再评估）
5. **本地轻量路由分类器**（opensquilla SquillaRouter 思路，用自有数据训练；现在 MVP 单模型不需要）