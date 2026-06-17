# arclight core 迁移 Python — 绞杀重建 + opensquilla 借件 — 设计

日期：2026-06-17
状态：待评审
作者：Alba（brainstorm with Claude）

## 1. 背景与目标

arclight 当前是 TS/Bun monorepo：`@arclight/protocol`（契约层）、`@arclight/core`（后端引擎：loop/tools/sandbox/db/server/workflow）、`@arclight/client-core`、`@arclight/cli`、`@arclight/web`。`core` 约 8K LOC TS，含刚落地的 workflow 编排基建（QuickJS/wasm，549 测试）与刚冻结的 `ToolSource` 抽象。

**目标**：把 `@arclight/core` 的后端引擎从 TS/Bun **迁移到 Python**。

**驱动力（如实记录）**：开发者人体工学——团队/个人更熟 Python、TS/Bun 维护负担重，希望后端统一到 Python。**不是**某个技术强制约束（非量子生态对齐、非 AI/ML 库需求、非运行时性能痛点）。

**诚实的成本认知**：纯语言偏好驱动的重写，对已跑通、有测试的基础设施而言功能收益为零、成本与风险高。本设计因此采用**最低风险路径**（绞杀式渐进迁移）并**最大化复用**（参考 opensquilla 这一 Apache-2.0 Python agent 的成熟实现），把"重写税"压到最低；并把**唯一一处 JS 是更优工具的子系统（workflow 引擎）永久留在 JS**。

## 2. 非目标（YAGNI）

- **不迁 web/cli**：`@arclight/web`、`@arclight/cli`、`@arclight/client-core` 保持 TS 不动。它们经 `arcClient.ts`（`baseUrl + /api/*` + SSE）与后端解耦，不关心后端语言。
- **不迁 workflow 引擎**：QuickJS/wasm 的"JS 脚本=控制流 + 真隔离 + 确定性 + resume"无 Python 等价物；workflow **永久保留为 JS/Bun 内部服务**，Python core 经 RPC 调用（§7）。
- **不 fork opensquilla**：它是紧耦合单体（1270 py / ~193K LOC），且传输层不兼容（见 §3）。opensquilla 定位为**参考 + Apache-2.0 代码捐赠者**，不是 base。
- **不采纳 opensquilla 的 db 模式**：保留 arclight 自有 schema（drizzle 仍是迁移权威）。调研确认共享 opensquilla 的 schema 会撞表名/双迁移系统/锁竞争/epoch 互扰；过渡期"TS core 与 Python core 如何共用 arclight 自有库"的方案见 §4.1 与 §9.3（默认单库一表一写语言，失控则分库）。
- **不采纳 opensquilla 的传输层/channels/cli/scheduler/meta-skill 编排**：与 arclight 契约或前端冲突，或 arclight 已有/不需要。

## 3. 关键约束（调研得出的决定性事实）

1. **传输不兼容**：opensquilla 流式走 WebSocket JSON-RPC（`/ws`），**无 SSE**；arclight web/cli 走 HTTP REST + SSE。→ 整仓 fork 会令 web/cli 全断，被否。
2. **紧耦合单体**：`engine/runtime.py` 单文件 5747 行，engine↔session↔memory↔gateway↔tools 互相直接 import；选择性 vendor "engine+tools+skills+mcp" 实测会拽进 ~450–500 文件。→ 整体 vendor 不划算，被否。
3. **编排范式不同**：opensquilla meta-skill 是声明式 YAML DAG（拓扑序 + asyncio + Jinja `when`），非脚本控制流，**替代不了** arclight 的 JS workflow。

## 4. 采纳方式：参考 + 借件，绞杀重建瘦核（模式 B）

opensquilla 作参考与 **Apache-2.0 代码捐赠者**；arclight 在**自有 protocol/SSE 契约 + 自有 db 模式**上，用绞杀式渐进迁移把 `core` 重建为一个**更瘦、可掌控**的 Python 包，按需借入 opensquilla 的干净模块。

### 4.1 绞杀缝：HTTP/SSE 契约边界

- **契约优先（enabling step）**：把 `@arclight/protocol` 从手写 TS 类型升级为**语言中立契约**（OpenAPI/JSON Schema 作单一事实源）。TS 侧 zod、Python 侧 pydantic v2 两边对该契约**生成/校验**；两侧各跑**契约黄金 fixture 测试**，任一侧破坏接口即红。
- **反向代理**：前置一个 path 路由代理，按 `/api/*` 路由组把请求分发到 Python core 或老 TS core。每个端点完整落在单一语言里，可逐组切换、单组回滚。
- **迁移顺序（按风险，低→高）**：
  1. `health`（无状态）
  2. `config`（读为主）
  3. `projects / files / grants / commands`（db/fs CRUD，不跑 loop）
  4. `sessions`（turn/loop + SSE 事件流——agent 心脏，最难）
  5. `run_workflow`：始终经 JS workflow 服务（§7），不进绞杀目标
- **数据所有权规则**（过渡期）：保留 arclight **单一 SQLite + 自有 drizzle 模式**；**drizzle 仍是迁移的唯一权威**，Python core 不跑 schema 迁移、只按该模式裸 SQL 读写。两侧连接均开 `WAL` + `busy_timeout`。规则：**一张表在某一时刻只有一种语言写**；一个路由组迁到 Python 仅当它写的表的写权已独占归 Python。读可跨语言（WAL）。

### 4.2 端态拓扑

迁移完成后：**Python core（Starlette/uvicorn，服务 `/api/*` + SSE）** + **JS workflow 服务(Bun)** + **TS web/cli（不变）**。代理与老 TS core 移除。

## 5. TS/Bun → Python 技术映射

| TS/Bun 现状 | Python 目标 | 说明 |
|---|---|---|
| `ai`(Vercel AI SDK v6) + `@ai-sdk/anthropic` | **借 opensquilla `provider/`**（Python，in-process） | 30+ provider + ModelSelector 失败回退；GLM 一等公民。见 §6 与 §9 的 GLM 线决策 |
| `@anthropic-ai/tokenizer` | provider 侧 token 计数 / `tiktoken` 类 | 计数口径随 provider |
| `zod` v4 | `pydantic` v2 | schema + 校验；契约两侧对齐 |
| `drizzle-orm` + `bun:sqlite` | 裸 SQL + `aiosqlite`（含 sqlite3 回退，镜像 opensquilla compat 模式） | **保留 arclight 自有 schema**；drizzle 留作迁移权威 |
| `hono` | `Starlette` + `uvicorn`，SSE 经 `sse-starlette`/原生 `StreamingResponse` | 实现 arclight `/api/*` + SSE 契约 |
| `node-pty` | **见 §9 sandbox 决策**：借 opensquilla subprocess + bubblewrap/seatbelt 隔离 + kill 升级；交互 TTY 需求另定 | 隔离模型变更，需评估 |
| `pino` | `structlog` / stdlib `logging`（JSON） | |
| `shell-quote` | `shlex`（stdlib） | |
| `simple-git` | `GitPython` / subprocess git | |
| `tree-sitter-typescript` / `web-tree-sitter` | `py-tree-sitter` + 对应 grammar | RepoMap 用 |
| `quickjs-emscripten`(+asyncify) | **不迁,留 JS** | workflow 服务（§7） |

## 6. opensquilla 借件清单（Apache-2.0）

| 借件 | 来源 | 改造 → arclight |
|---|---|---|
| **MCP client**（stdio + sse 传输，仅 httpx/asyncio/json） | `mcp/client.py`、`mcp/stdio.py`、`mcp/sse.py`、`mcp/types.py`、`mcp/discovery.py` | 包成 `McpSource` 实现 `ToolSource`；`_active_clients` 由模块全局改为**实例态**（对应 `dispose()`）；`list()` 返回 arclight `Tool`;**补风险默认**（`riskTier=confirm`/`mutatesWorkspace=true`，opensquilla 此处无,arclight ToolMeta 更优）。**吸收阶段一 MCP** |
| **skills loader + injector**（渐进披露 full/compact 30k 预算、frontmatter、快照缓存） | `skills/loader.py`、`skills/injector.py`、`skills/types.py`（**不含** `skills/hub/` ClawHub，纠缠） | 包成 `SkillsSource`：`list()` 返回 `skill_view`/`skill_list` 桥工具;`contribute()` 注入 `<available_skills>`——**injector 几乎就是 arclight 刚冻结的 `ToolSource.contribute()` 现成实现体**。**吸收阶段一 skills** |
| **provider 抽象**（LLMProvider 协议、streaming、tool-call、自定义 base_url/key、ModelSelector） | `provider/`（19 文件，最干净的层） | 作 Python core 的模型网关;GLM 路由（§9） |
| **engine 子模块**（可挑借，低纠缠）：`AgentState` 枚举 + `StateChangeEvent`；4 模工具并发策略（mutex/concurrent/keyed）；`FallbackPolicy` + backoff；`_ProviderRetryPolicy` + 5 类 attempt 分类；turn 预算（max_turn_llm_calls/tokens/cost）；length-cap 续写 | `engine/agent.py`、`engine/runtime.py`、`engine/fallback.py` | 移植进 arclight Python loop。**纠缠不借**：reactive overflow 压缩、tokenjuice 投影 |
| **epoch 乐观锁模式**：DB 触发器 `prevent_epoch_rollback`、原子 `INSERT ... WHERE EXISTS(epoch=?)` 守卫、in-process epoch 缓存 | `session/storage.py` | 作 arclight schema 的一次迁移 + 读写守卫(比现状 app-层守卫更严) |
| **sandbox 隔离模式**：bubblewrap/seatbelt 命名空间隔离、kill 升级（SIGTERM→2s→SIGKILL via killpg）、`ResourceLimits` + 安全级枚举 | `sandbox/backend/*` | 见 §9 决策 |

**许可证机制**：opensquilla Apache-2.0。借入代码须：保留 Apache-2.0 LICENSE 文本与源文件版权头;保留/复制 `THIRD_PARTY_NOTICES.md` 相关条目(若带 OpenClaw skill 文本 MIT、tokenjuice MIT);在 arclight 新增 `NOTICE`/`ATTRIBUTION` 记录每个借件的出处与原始版权。

## 7. workflow 跨语言接缝（永久 JS 服务）

- 把 arclight `packages/core/src/workflow/` 抽成**独立 Bun 服务**（保留 QuickJS runtime + Scheduler + journal/resume + WorkflowStore）。
- 接口：`POST /internal/workflow/run`（入参：source/args + 父会话/turn/cwd 上下文），SSE 把 subagent 事件 + `permission.ask` **冒泡回** Python 父会话事件流;审批决议回灌该 run（对齐现有 `CoreToolContext.workflows.launch` 接缝语义，只是从进程内变网络调用）。
- Python loop 的 `run_workflow` 工具实现 = 调该服务 + 转发事件/审批。
- 端态：monorepo 为"Python core + 一个 JS workflow 服务",这是**唯一**用对工具的多语言例外。

## 8. 迁移里程碑

- **M0 — 契约优先 + 代理**：protocol→语言中立契约 + 两侧 codegen + 黄金 fixture;立反向代理(默认全转老 TS core)。
- **M1 — 叶子 CRUD 组**：`health → config → projects/files/grants/commands` 迁 Python 并逐组切流量。
- **M2 — 模型网关 + 工具/沙箱**：借入 provider/；Python 侧实现 tools 执行壳(zod→pydantic 校验/超时/取消/spill)与 sandbox(§9)。
- **M3 — sessions/loop + SSE(心脏)**：移植 queryLoop→Python async-generator + 借 engine 子模块;SSE 事件流与 epoch 守卫对齐;切 sessions 流量。
- **M4 — workflow JS 服务化**：抽出 Bun workflow 服务 + 跨语言接缝(§7);Python `run_workflow` 接通。
- **M5 — 切换收尾**：默认全转 Python core;移除老 TS core 与代理;`@arclight/core` 仅剩(或重定位)workflow 服务。
- **并行**：MCP/skills 借件(§6)可在 M2 起与主线并行(各自 `ToolSource`),**吸收原阶段一**。

## 9. 待定子决策（实现前需拍板，已给默认）

1. **GLM 线**：现状 arclight 走 **Anthropic 兼容**端点;opensquilla provider 走 **OpenAI 兼容**端点(bigmodel `/chat/completions`,工具调用保真度可能更高)。**默认**：随 opensquilla provider 采 OpenAI 兼容线(借件即用);若回归测试发现工具调用退化,保留切回 Anthropic 兼容的适配位。
2. **sandbox 模型**：arclight 现用 node-pty(交互 TTY);opensquilla 用 subprocess + 命名空间隔离(无 TTY,安全更强)。**默认**：非交互执行采 opensquilla subprocess+bwrap/seatbelt + kill 升级;若确有交互 TTY 需求,补 Python `pty`/`ptyprocess` 路径。
3. **db 过渡**：**默认**单一 arclight SQLite + drizzle 迁移权威 + Python 裸 SQL 读写 + WAL/`busy_timeout` + 一表一写语言;若切换期写竞争实测不可控,退化为分库 + 只读桥接。

## 10. 测试策略

- **契约**：protocol 黄金 fixture，TS(zod)与 Python(pydantic)双侧校验;任一侧破坏即红。
- **逐组平价测试**：每个迁移路由组,Python 响应与老 TS 响应同请求 → 同结构/同语义(含 SSE 事件序);切流量前必须通过。
- **保绿**：老 TS 测试在该组切换前保持绿;切换后补 Python 等价测试。
- **心脏(M3)**：loop 上下文隔离/压缩/中断/steering;SSE 重放(arclight 的 DB 持久重放优于 opensquilla 的内存 deque,保留 arclight 模型);epoch 并发(借触发器后回归)。
- **借件**：MCP mock server + 保守风险默认;skills 发现/`contribute()` 注入/渐进披露;sandbox 隔离/超时/kill 升级。
- **跨语言接缝(M4)**：workflow 服务的事件/审批冒泡回 Python 父会话并回灌。

## 11. 风险

- **借件适配量被低估**：opensquilla 模块虽干净,移植进 arclight 自有事件/契约模型仍是真工程(类比当年"借 pi 代码"实测 800–1500 行的教训)。
- **SQLite 跨语言并发**：WAL + busy_timeout + 一表一写语言为前提;失控则分库。
- **SSE 语义平价**：事件序/心跳/重放须与 TS 侧逐字节对齐,否则 web/cli 行为漂移。
- **sandbox 模型变更**：pty→subprocess 可能影响交互式工具行为。
- **GLM wire 格式**：Anthropic 兼容↔OpenAI 兼容切换的工具调用保真度。
- **长迁移窗维双 core**：过渡期同时维护 TS + Python 两套,需纪律(单 feature 分支连续推进,勿每里程碑新分支)。
- **许可证 attribution**：借件须完整保留 Apache-2.0/MIT 归属。

## 12. 关键决策记录

- **驱动力 = 人体工学(Python 偏好)**，非技术强制;如实接受"功能零收益、成本高",故选最低风险 + 最大复用路径。
- **绞杀重建瘦核(模式 B)**，非 fork、非整体 vendor、非共享库:传输不兼容 + 单体紧耦合两条事实排除了 fork/vendor。
- **opensquilla = 参考 + Apache-2.0 借件捐赠者**;干净件(MCP/skills/provider/engine 子模块/epoch 触发器/sandbox 隔离)单独借,不背单体。
- **MCP/skills 借件吸收原阶段一**;`ToolSource` 抽象被 opensquilla injector 反向印证为正确的缝。
- **workflow 永久留 JS**,抽成 Bun 内部服务经 RPC 调用,是唯一用对工具的多语言例外。
- **web/cli 留 TS 不动**;契约优先(语言中立)是 enabling step。
- **arclight 保留自有 protocol/SSE 契约 + 自有 db 模式**,而非采纳 opensquilla 的传输/schema。
