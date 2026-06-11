---
title: "feat: 阶段一 Web + 写代码 MVP 开发计划"
type: feat
status: active
date: 2026-06-11
origin: doc/DEV_PLAN.md
---

# feat: 阶段一 Web + 写代码 MVP 开发计划

> **目标仓库**：本仓库（`arclight/`，即 Bun monorepo 根）。参考项目代码位于仓库外 `../references/{pi,aider,cline,opencode,claudecode,...}`。
> 本计划是 `doc/DEV_PLAN.md`（已对抗式评审的阶段一最终交付版）的**可执行落地计划**：7 个实施单元一一对应 slice0-6，每个单元自带验收口径与测试场景。设计细节以 DEV_PLAN 为权威，本计划不重复论证，只引用落点。

## Overview

交付阶段一两件用户可感知能力：**本地优先 Web 聊天界面** + **写代码 Agent**（读文件 / 改文件 / 跑命令 / 自校正闭环）。一条命令 `arclight serve --repo <path>` 在 localhost 拉起内核（Hono + queryLoop）+ Web UI（Next.js + assistant-ui）+ nono 沙箱 + SQLite。

自研实评 6000-9000+ 行，1-3 人节奏约 3-5 个月。三大自研件：`queryLoop()` 主循环（800-1500 行）、前端 ArcTransport + reducer + 富渲染 + 审批 UI（1500-3000+ 行）、编码能力链 RepoMap/Edit/Checkpoint/bash+反射（2000-2800 行）。

## Problem Frame

全平台个人 AI Agent（arclightagent）的第一阶段。架构蓝图与 P0 施工图已完成（见 `doc/`），代码库为空仓。需要把方案转为依赖有序、可独立演示、可硬验收的施工序列。其余平台能力（写作 / 调研 / 桌面 / 移动 / 远程拓扑 / MCP / 多 provider）全部推迟到阶段二及以后（见 origin §0 降级声明）。

## Requirements Trace

（来自 origin §5.2 Definition of Done）

- R1. **功能**：`arclight serve --repo <path>` 一条命令拉起全栈；Web 聊天可读文件 / 改文件 / 跑命令 / 自校正闭环
- R2. **正确性**：golden eval ≥8/10（发布 10/10），全部走真实 HTTP/SSE/tool/nono 链路；queryLoop 10 条不变量全有断言测试
- R3. **续接**：断线 / 刷新 / epoch-jump 三路径续接无缝、无重复、不丢历史
- R4. **安全**：写 / 高危命令必经审批（fail-closed）；黑名单直接拒绝；bash 一律经沙箱不裸跑；API key 不入 `server.json`；envelope 5 键不泄 traceback
- R5. **可回滚**：shadow-git 检查点 + `/undo` + `/redo`，零干扰用户 `.git`
- R6. **工程质量**：`biome check` + `tsc --noEmit` 零错；coverage 70%/70%/60%；CI 三 workflow 全绿；license-gate 零 copyleft
- R7. **可观测**：pino 结构化日志 + auditLog + usage 成本展示（不做 quota 强制，不接 OTel）

## Scope Boundaries

阶段一明确**不做**（origin §0 + 决策记录 D3/D4/D7/D8）：

- MCP 完整接入——仅 interface stub 返回 `MCP_NOT_AVAILABLE`（D3）
- 多 provider / LiteLLM——单 provider（Anthropic）（D4）
- LSP（AgentLspClient）、向量检索（sqlite-vec/RRF）、resumable-stream/Redis
- 写作 / 调研 / computer-use / planning 等其余子系统
- CLI（`@arclight/cli` 仅 commander 骨架占位）、桌面 / 移动 / VSCode / Chrome 端
- Next API proxy 中间层（D7，前端直连 localhost 内核）、OTel/traceparent（D8，仅 pino）
- quota 强制 / 账单（usage 只做展示）

## Context & Research

### 权威文档（本仓库内，路径已修正为仓库相对）

| 主题 | 文档 |
|---|---|
| 开发方案权威（本计划 origin） | `doc/DEV_PLAN.md` |
| 架构总览 / 平台分层 | `doc/ARCHITECTURE_BLUEPRINT.md` |
| 协议契约 / Web 端 / 横切 | `doc/FULL_PLATFORM_DESIGN.md` |
| 数据模型 12 表 / 工具契约 / 审批状态机 / 续接语义 | `doc/research/P0-基础三件套-拓扑-数据模型-工具契约.md` |
| nono 沙箱 / 三级回退 | `doc/research/P0-沙箱方案-拿来即用.md` |
| 全栈选型 / 许可证 / smoke 清单 | `doc/research/拿来即用-全栈选型清单.md` |
| 测试分层 / eval / CI | `doc/research/工程实践与测试eval策略.md` |

### 可借代码（仓库外 `../references/`，MIT/Apache 借结构，归因落 NOTICE）

- `../references/pi/packages/agent/src/agent-loop.ts`——双层循环 + 钩子面结构（MIT；**callback→generator 是控制反转重写，非借代码**）
- `../references/aider/aider/repomap.py` + `editblock_coder.py`——RepoMap pagerank 权重 / SEARCH-REPLACE 阶梯算法（Apache-2.0，TS 重写）
- `../references/cline/`——`CheckpointTracker` shadow-git（Apache-2.0，剥 VSCode）
- `../references/opencode/`——compaction 摘要模板、apply-patch 第二解析器（MIT）
- `../references/claudecode/`——generator 范式仅学不抄（闭源）

### 设计源真相

- `DESIGN.md`（仓库根）——CARBON ARC 设计系统（2026-06-11 定稿）。**Unit 3/5/7 所有前端施工前必读**：色彩 token、双声道字体、工程日志流布局、信任面纪律（hazard 红仅审批面等硬规则）

### 技术栈（origin §0 栈表，全拿现成）

Bun 1.2 + Hono ^4 + drizzle-orm/bun:sqlite + Vercel AI SDK `ai`~6（仅 `@ai-sdk/anthropic`）+ Next.js 15（Node runtime）+ @assistant-ui/react（ExternalStoreRuntime）+ nono 沙箱（docker-fallback 兜底）+ vitest + biome。

## Key Technical Decisions

（均已在 origin §7.2 决策记录定案，此处只列对施工排序有影响的）

- **D1/D2 前端 ExternalStoreRuntime（废 AISDKRuntime + useChat resume）**：前端零 `ai` 运行时，手写 fetch+ReadableStream SSE。→ Unit 1 须同步修订三份源文档留痕
- **D5 docker-fallback 阶段一实装且落 slice0**：CI 沙箱直接用它，是 CI 前置硬依赖
- **D9 compaction 上提 slice5**：epoch-jump 真实端到端验收随之绑定 Unit 6
- **D10 queryLoop 取上沿 + slice2 单独留缓冲**：先写 10 条不变量测试再动手（test-first 硬要求）
- **provider 边界**：`provider-adapter.ts` 是唯一 import `"ai"` 的文件，`stopWhen: stepCountIs(1)`，dependency-cruiser 架构测试守护
- **事件流不变式**：queryLoop 是唯一 seq 生产者，单 SQLite 事务内 `appendEvent` 与 yield 同处，"yield 顺序 = 持久顺序 = SSE replay 顺序"

## Open Questions

### Resolved During Planning

- 三份源文档与 DEV_PLAN 的全部矛盾（前端 Runtime、MCP 时序、provider 数量、epoch-jump 测试悬空、/redo 缺失）：已由对抗式评审在 origin §7.2 D1-D10 定案，本计划直接继承
- monorepo 根放哪：本仓库根（`arclight/`）即 workspace 根，`packages/*` 五包
- 计划文档落点：`doc/plans/`（项目文档根为 `doc/`，沿用单数命名）

### Deferred to Implementation

- **smoke test 结果决定降级路径**（Unit 1 第一周强制）：node-pty 失败→`Bun.spawn` pipe 丢 TTY；web-tree-sitter 失败→正则粗提取；nono 失败→docker-fallback。计划按主路编排，降级分支已在 origin §3.3 表格定义
- queryLoop 实际行数（800-1500 取上沿）与 slice2 是否需要砍审批进 Unit 4：按 Unit 3 ★ 备注弹性处理
- Edit fuzzy 阶梯 4（diff-match-patch）作 S2 opt-in，是否在 Unit 5 内启用：实现时按进度决定，默认关
- RepoMap / 多轮反射为弹性范围（可砍可延，不阻断 M1）：执行期按进度裁决

## High-Level Technical Design

> *方向性示意，供评审校验整体形状，非实现规范。*

```
┌─ @arclight/web (Next.js 15, Node runtime) ──────────────┐
│  assistant-ui ExternalStoreRuntime ← ArcRuntimeProvider │
│  PermissionModal / DiffView / TerminalView / StatusBar  │
└──────────────┬───────────────────────────────────────────┘
               │ HTTP (C1 commands) + SSE (C2 events, 手写 fetch+ReadableStream)
┌─ @arclight/client-core (纯 TS, 端无关) ─────────────────┐
│  EventStreamManager(重连/去重/coalesce) → SessionReducer │
│  CommandClient / EpochTracker / SpillFetcher             │
└──────────────┬───────────────────────────────────────────┘
               │ ArcEvent / ArcCommand (@arclight/protocol, 唯一类型源)
┌─ @arclight/core (Bun) ───────────────────────────────────┐
│  Hono routes ─ AgentRunner ─ queryLoop() async-generator │
│    ├─ provider-adapter (唯一 import "ai", stepCountIs(1))│
│    ├─ ToolRegistry → builtin 4 工具 / mcp stub           │
│    ├─ approval 状态机 (fail-closed)                      │
│    ├─ SandboxService: local-nono → docker-fallback → 拒绝│
│    ├─ coding: repomap / edit / checkpoint / exec+反射    │
│    └─ db: 12 表, appendEvent 事务内 seq, SSE replay      │
└───────────────────────────────────────────────────────────┘
```

turn 状态机：`queued → running → [awaiting_approval ⇄ running] → completed / failed / interrupted`

## Implementation Units

> 依赖严格线性：Unit N 依赖 Unit N-1。每单元独立可演示，前序 demo 是后序回归基线。★ = 评审点名易拖期单点，排期留缓冲。

### Phase M0 — 骨架可跑

- [x] **Unit 1: 工程骨架贯通 + docker-fallback + smoke（slice0）** ✅ 2026-06-11（smoke：5 PASS + nono DEGRADED→docker-fallback；"12 张表"口径=11 域表+drizzle 记账表）

**Goal:** 五包 monorepo 立起，`/health` 可 curl，12 张表迁移幂等，6 项 blocking smoke 全绿（含 docker-fallback），源文档同步修订完成。

**Requirements:** R6（部分 R4：server.json 0600）

**Dependencies:** 无

**Files:**
- Create: 根 `package.json`（workspaces）、`tsconfig.base.json`、`biome.json`、`vitest.workspace.ts`、`.env.example`、`NOTICE`
- Create: `packages/protocol/src/{events,commands,ack,tool,capability,schema}.ts` + `packages/protocol/src/__tests__/schema.test.ts`
- Create: `packages/core/src/server/{app.ts,serverJson.ts}`、`packages/core/src/server/routes/health.ts`、`packages/core/src/serve.ts`
- Create: `packages/core/src/db/{schema.ts,client.ts,migrate.ts}` + `packages/core/src/db/migrations/`
- Create: `packages/core/src/sandbox/{service.ts,backends/dockerFallback.ts,backends/localNono.ts}`（localNono 本单元仅 probe）+ `packages/core/src/sandbox/profiles/p0-local.json`
- Create: `scripts/smoke-test-native.ts`
- Modify: `doc/ARCHITECTURE_BLUEPRINT.md`、`doc/FULL_PLATFORM_DESIGN.md`、`doc/research/拿来即用-全栈选型清单.md`——执行 D1/D2 留痕（删 useChat resume 卖点与 `@assistant-ui/react-ai-sdk` 依赖行）；`doc/DEV_PLAN.md` §7.1——把 `/Users/fsm/...` 绝对路径改为仓库相对路径
- Test: `packages/core/src/db/__tests__/migrate.test.ts`、`packages/protocol/src/__tests__/schema.test.ts`

**Approach:**
- 12 张表 schema 照搬 `doc/research/P0-基础三件套` 施工图；`migrate.ts` 带启动锁（`.arclight/migrate.lock`）单点串行（吸收 MISSING-3）
- `serverJson.ts`：chmod 0600 + `owner === process.uid` 启动校验；**绝不写入 API key**
- dockerFallback 实装（`--network none --read-only`），CI 直接依赖它
- 配置优先级：`process.env` > `.arclight/config.json` > `~/.config/arclightagent/config.json` > 默认；zod parse，缺 `anthropicApiKey` 启动即失败

**Patterns to follow:** origin §1.2 目录树（可直接 mkdir+touch）、§1.3 配置约定、§3.3 smoke 表

**Test scenarios:**
- Happy path: `bun run dev:core` 启动 → `curl /health` 返回 ok
- Happy path: `db:migrate` 建 12 表成功；重复执行幂等（不报错、不重复建表）
- Happy path: smoke 6 项 blocking 全 PASS（bun:sqlite / drizzle / node-pty / web-tree-sitter / nono / docker-fallback），任一 FAIL → `exit(1)` 并输出降级方案
- Edge case: `server.json` 权限非 0600 或 owner 不符 → 启动拒绝
- Error path: 缺 `anthropicApiKey` → 启动失败并打印缺失字段
- Happy path: protocol zod schema 对合法/非法 ArcEvent/ArcCommand 样本 parse 通过/拒绝

**Verification:** slice0 验收原文——6 blocking smoke 通过；`biome check` + `tsc --noEmit` 零错；`server.json` 0600 + owner 校验；迁移幂等测试通过；grep 三份源文档无残留 `react-ai-sdk` / `useChat resume` 表述。

---

- [x] **Unit 2: SSE 续接闭环——事件流脊柱（slice1）** ✅ 2026-06-11（续接①②真实端到端通过；③epoch-jump mock 触发通过，真实回归绑 Unit 6；集成测位于 tests/ 维持包依赖纪律）

**Goal:** seq/epoch 事件流打通：C1 提交、C2 SSE replay、断线重连无缝续上；client-core 三纪律 reducer 就位。

**Requirements:** R3（路径①②真实可测；③ epoch-jump 接口+409 分支 mock 触发，端到端验收绑 Unit 6）

**Dependencies:** Unit 1

**Files:**
- Create: `packages/core/src/db/{appendEvent.ts,sseReplay.ts}`
- Create: `packages/core/src/server/routes/{commands,events,sessions,snapshot}.ts`、`packages/core/src/server/middleware/{auth,requestContext}.ts`
- Create: `packages/client-core/src/transport/{stream,sseTransport,httpClient}.ts`、`packages/client-core/src/store/{reducer,sessionStore}.ts`、`packages/client-core/src/{epoch,command}.ts`、`packages/client-core/src/hooks/useArcSession.ts`
- Test: `packages/core/src/db/__tests__/appendEvent.test.ts`、`packages/client-core/src/store/__tests__/reducer.test.ts`、集成测 `packages/core/src/__tests__/sse-resume.integration.test.ts`

**Approach:**
- `appendEvent`：单 SQLite 事务内读 `sessions.nextSeq+epoch` → insert `events` → 写回，`StaleEpochError` 兜底；`(session_id, seq)` 表唯一约束
- EventStreamManager：fetch+ReadableStream 手写 SSE 解析（~120 行，不用 EventSource）；16ms rAF coalesce；250ms 指数退避封顶 8s 加 jitter；`dispatch` 入口 `seq <= maxSeq` 去重
- 续接：①缓冲内增量 replay（200）；②buffer-expired → 409 `{reason,snapshotUrl}` → 拉 snapshot 全量重建；③epoch-jump 409 分支落接口，mock epoch 触发（吸收 OD-3）

**Test scenarios:**
- Happy path: POST submit → mock `message.delta` 流 → `curl -N /events?afterSeq=0` 收到有序帧
- Happy path: 中途 kill 连接，`?afterSeq=N` 重连 → 无缝续上、无重复（events 表唯一约束兜底）
- Edge case: `afterSeq` 早于缓冲窗 → 409 → snapshot 全量重建后状态一致
- Edge case: reducer 收到 `seq <= maxSeq` 的重放帧 → 静默丢弃；未知事件 `t` → 静默忽略（forward-compat）
- Edge case: 409 epoch-jump 分支 mock 触发 → 走全量 snapshot 路径
- Error path: SSE 断连 → 250ms 起指数退避重连，成功后退避复位
- Integration: "刷新不丢"——snapshot 作 bootstrap、`bootstrap.lastSeq` 作 afterSeq 起点续增量

**Verification:** slice1 验收原文——seq 单调唯一；reducer 三纪律单测通过；①②路径真实通过；409 分支 mock 正确。

---

### Phase M1 — 写代码闭环

- [x] **Unit 3: 写代码最小核 ★（slice2）** ✅ 2026-06-11（test-first：12 不变量先行全过；case-01 mock 模式与**真实模式均 PASS**——真实后端为智谱 GLM glm-4.6 经 Anthropic 兼容端点（D4 补充记账，成本考量），4.1s 完成；跨 turn 会话历史物化随 U5/U6；审批 slice2 为 allow-all 接缝，U4 换 fail-closed 状态机）

**Goal:** queryLoop 主循环 + 4 内置工具 + nono 执行真实跑通："加一个函数"端到端，golden case-01 过线。

**Requirements:** R1、R2（部分）、R4（bash 经沙箱）

**Dependencies:** Unit 2

**Files:**
- Create: `packages/core/src/loop/{query-loop.ts,provider-adapter.ts,runner.ts,epoch-guard.ts}`
- Create: `packages/core/src/tools/registry.ts`、`packages/core/src/tools/builtin/{readFile,writeFile,applyPatch,bash}.ts`、`packages/core/src/coding/edit/{parser,apply}.ts`（SEARCH/REPLACE 阶梯 1-3，无 fuzzy）
- Create: `packages/core/src/sandbox/backends/localNono.ts`（run 实装）、`packages/core/src/artifacts/store.ts`
- Create: `packages/web/src/app/{layout,page}.tsx`、`packages/web/src/app/chat/[sessionId]/page.tsx`、`packages/web/src/components/chat/{ArcRuntimeProvider,ArcThread,MessageParts}.tsx`、`packages/web/src/lib/{arcClient,assistantRuntime}.ts`（ExternalStoreRuntime 最小接线 + ToolCallCard 朴素版）
- Test: `packages/core/src/loop/__tests__/query-loop.test.ts`（10 不变量）、`packages/core/src/loop/__tests__/provider-adapter.test.ts`、架构测试（dependency-cruiser 断言唯一 import `"ai"`）、`evals/cases/case-01-add-function/`

**Approach:**
- **控制反转重写**：借 pi 双层循环结构（外层 follow-up 队列 / 内层 tool-call + steering），把 emit 回调翻为 `yield ArcEvent`；审批挂起不占 provider 调用、`.return()` 触发 `finally` 清理、事务内 seq+yield 原子，三件必须重写
- `callProvider`：`stopWhen: stepCountIs(1)` 禁 AI SDK 自跑工具循环；失败不 throw，编码进 `finishReason`；retryable ≤MAX 指数退避
- `executeToolBatch`：zod 校验失败走 5 键 envelope 回灌（不 throw）；只读并发 ≤8，写工具串行；>32KB 落 artifacts + spillRef
- 中断双路径汇于同一 AbortController：interrupt 命令 / SSE 断连 `.return()`，中断后无悬挂 sandbox run

**Execution note:** test-first 硬要求——先写 10 条不变量测试再动 queryLoop（origin §2.1 关键坑⑤）。本单元是最易拖期单点，进度紧则只交付 happy-path + 中断 + 错误恢复，审批往返天然在 Unit 4。

**Patterns to follow:** `../references/pi/packages/agent/src/agent-loop.ts`（结构）；origin §2.1 loop 骨架伪码

**Test scenarios:**
- Happy path: 事件序列快照——`turn.started → message.delta* → tool.requested → tool.output → turn.completed` 顺序 + seq 连续
- Happy path: "在 X 文件加函数 foo" → read_file → apply_patch → bash 跑 `tsc --noEmit` → 返回结果（golden case-01 真链路）
- Edge case: 只读工具 ≤8 并发分批；bash/apply_patch/write_file 串行
- Edge case: 消费者提前 break → generator `finally` → `ac.abort()` → 无悬挂 sandbox run
- Error path: provider retryable 错误 ≤MAX 次重试后 yield `session.error` envelope
- Error path: apply_patch SEARCH 不匹配 → 5 键 envelope（VALIDATION, retry_allowed:true）回灌，不静默乱改
- Integration: 中断命令 → callProvider abortSignal 透传 + nono kill process tree → turn 转 `interrupted`
- 架构: dependency-cruiser 断言 `provider-adapter.ts` 是唯一 import `"ai"` 的文件

**Verification:** slice2 验收原文——case-01 真链路通过；并发纪律；bash 不裸跑；envelope 回灌；中断无悬挂；10 不变量断言全绿。

---

- [x] **Unit 4: 权限审批往返——fail-closed（slice3）** ✅ 2026-06-11（presets 22 测 + service 7 测 + 审批集成 5 测全过；case-09 mock 与真实 GLM 均 PASS；黑名单确定性拦截以集成测为权威，真实模式断言安全不变量；tool_calls 行由 policy upsert，富生命周期落库随 U5/U6）

**Goal:** 审批状态机 + 黑名单 + PermissionModal 往返闭环，golden case-09 过线。

**Requirements:** R4

**Dependencies:** Unit 3

**Files:**
- Create: `packages/core/src/approval/{service,presets,policy}.ts`
- Modify: `packages/core/src/loop/query-loop.ts`（缝审批挂起/解阻）、`packages/client-core/src/command.ts`（approve）
- Create: `packages/web/src/components/approval/{PermissionModal,RiskBadge}.tsx`
- Test: `packages/core/src/approval/__tests__/service.test.ts`、`evals/cases/case-09-approval-write/`

**Approach:**
- 状态机 pending→allowed/denied/expired/cancelled，60s TTL 内核权威（前端倒计时仅 UX）；`awaiting_approval` 挂起不占 provider 调用
- 风险分类：`ToolMeta.riskTier` + shell-quote 分词 + presets + 黑名单（`rm -rf ~` / `~/.ssh` / `docker.sock` / `sudo`）
- fail-closed UI：默认焦点"拒绝"；未知 risk→high、未知 cls→irreversible

**Test scenarios:**
- Happy path: `rm -rf build/` → `permission.ask` → 批准 → 执行回流
- Happy path: 拒绝 → envelope 回灌 Agent 改方案
- Edge case: 审批四终态唯一；挂起期间断言 callProvider 零调用
- Edge case: `ssh` / `~/.ssh` 命中黑名单 → 直接拒绝不弹审批
- Error path: 60s 过期 → `APPROVAL_EXPIRED` envelope
- Integration: 挂起中 interrupt → 审批转 `cancelled` 终态（golden case-09 全链路）

**Verification:** slice3 验收原文全项。

---

### Phase M2 — 安全网就位

- [x] **Unit 5: 检查点 + `/undo` `/redo` + 编辑健壮性（slice4）** ✅ 2026-06-11（checkpoint 10 测 + edit/guard 29 测 + 检查点集成 4 测全过；shadow-git 借 cline 剥 VSCode、用户 .git 零干扰；undo/redo 自持 ref 栈正确截断 redo（修了 navigable-from-DB 无法建模分支的设计 bug）；EditGuard 省略号/截断守卫；Monaco DiffView 真懒加载；DiffView Monaco 默认走 CDN 待自托管，记账于下）

**Goal:** shadow-git 检查点可一键回滚/恢复，EditGuard + fuzzy 阶梯健壮化，golden case-10 过线。

**Requirements:** R5

**Dependencies:** Unit 4

**Files:**
- Create: `packages/core/src/coding/checkpoint/{git-operations,tracker}.ts`、`packages/core/src/coding/edit/guard.ts`
- Modify: `packages/core/src/coding/edit/apply.ts`（fuzzy 阶梯 4 opt-in）、`packages/core/src/loop/query-loop.ts`（写操作前后 commit）
- Create: `packages/web/src/components/tools/{DiffView,ToolCallCard,JsonView}.tsx`（Monaco `dynamic(ssr:false)` 懒加载）
- Test: `packages/core/src/coding/checkpoint/__tests__/tracker.test.ts`、`packages/core/src/coding/edit/__tests__/{guard,apply}.test.ts`、`evals/cases/case-10-checkpoint-restore/`

**Approach:**
- shadow 仓 `.arclight/checkpoints/<cwdHash>.git`，`core.worktree` 指真实工作区；借 cline CheckpointTracker 剥 VSCode（删 multi-root/folder-lock/gRPC）
- `/undo` 二分定位 sha + `reset --hard`；`/redo` undo 栈游标，新写操作清空 redo 栈（D6）
- 嵌套 `.git` 临时禁用（`finally` + 3 次重试复原）；`--allow-empty --no-verify`；`commit.gpgSign=false`

**Patterns to follow:** `../references/cline/`（CheckpointTracker）、`../references/aider/aider/coders/editblock_coder.py`（guard/fuzzy 逐行语义）

**Test scenarios:**
- Happy path: Agent 改 3 文件 → `/undo` 回滚到改前 → `/redo` 恢复
- Edge case: 连续 undo/undo/redo 在 sha 序列上正确游走；`/undo` 后新写操作 → redo 栈清空
- Edge case: 用户 `.git` 状态在检查点操作前后零变化（worktree 隔离）
- Edge case: 嵌套 `.git` 子目录存在 → 临时禁用并在异常时复原
- Error path: EditGuard 检出未配对省略号 → VALIDATION envelope 含 "Did you mean"（find_similar_lines 0.6）
- Edge case: fuzzy 阶梯 4 仅 opt-in 且 `patch_apply` 全 true 才接受；默认关
- Integration: golden case-10——interrupt + shadow-git 恢复 + undo/redo 往返

**Verification:** slice4 验收原文全项。

---

- [ ] **Unit 6: RepoMap 上下文 + 单级压缩 ★（slice5）**

**Goal:** RepoMap（tree-sitter → pagerank → 二分裁剪 → mtime 缓存）注入上下文；compaction 落地，epoch-jump 真实端到端回归（补 Unit 2 悬空验收）。

**Requirements:** R3（epoch-jump 闭环）、R1（上下文增强）

**Dependencies:** Unit 5

**Files:**
- Create: `packages/core/src/coding/repomap/{tag-extractor,cache,builder,types}.ts`、`packages/core/src/loop/{compaction.ts,memory.ts}`
- Modify: `packages/core/src/loop/query-loop.ts`（进 turn 前注入 RepoMap；压缩边界 epoch++）
- Test: `packages/core/src/coding/repomap/__tests__/builder.test.ts`、`packages/core/src/loop/__tests__/compaction.test.ts`、集成测 epoch-jump 端到端

**Approach:**
- pagerank 权重**逐字对齐 aider 不可改**：chat-referencer ×50、mentioned/长标识符 ×10、私有名/过度定义 ×0.1、`num_refs→sqrt`、无 ref def 自环 0.1、personalize `100/num_files`；长标识符 = `is_snake or is_kebab or is_camel` 且 `len>=8` 三风格精确移植
- 二分裁剪 `mid = floor(maxTokens/25)` 容差 0.15；`tree.delete()` 必调（WASM 无 GC）；`Parser.init()` 全局一次
- compaction：`@anthropic-ai/tokenizer` 计 token > effectiveWindow → 两次 provider 调用之间 LLM 摘要 → `epoch++` → yield `context.compacted`；绝不在 tool_use/tool_result 未配对时压缩

**Execution note:** RepoMap 是弹性范围（可降级正则粗提取，不阻断 M1）；**compaction 不可砍**。

**Patterns to follow:** `../references/aider/aider/repomap.py`（权重/裁剪算法）、`../references/opencode/`（compaction 摘要模板）

**Test scenarios:**
- Happy path: 中型 TS 仓提问"哪里定义了 X" → RepoMap 命中相关符号，token 用量低于无 RepoMap 基线
- Edge case: 单测断言 ×50/×10/×0.1 权重 + 长标识符三风格判定逐项对齐 aider
- Edge case: 二分裁剪结果落在 token 预算 ±15% 内
- Edge case: mtime 未变 → 缓存命中跳过解析；重复 build 无 WASM 内存增长
- Edge case: 压缩只发生在两次 provider 调用之间，流式中途断言不触发
- Integration: 长会话触发真实压缩 → `epoch++` → 前端 epoch-jump 409 → snapshot 重建 → 续接无缝（Unit 2 悬空验收在此回归）

**Verification:** slice5 验收原文全项，含 epoch-jump 真实端到端通过。

---

### Phase M3 — 阶段一发布

- [ ] **Unit 7: 反射闭环 + 10 条 golden eval + 可观测收口（slice6）**

**Goal:** edit→lint→test→自校正反射闭环；10 条 golden case 全建齐 + CI 三 workflow；usage 成本展示。达成发布 DoD。

**Requirements:** R1、R2、R6、R7

**Dependencies:** Unit 6

**Files:**
- Create: `packages/core/src/coding/exec/{pty-manager,bash-tool,reflection}.ts`、`packages/core/src/usage/tracker.ts`
- Create: `packages/web/src/components/session/{SessionList,SessionStatusBar}.tsx`、`packages/web/src/components/tools/TerminalView.tsx`（先 `<pre>`+ansi-to-html）
- Create: `evals/`（fixtures submodule + cases/case-01..10 + runner）、`.github/workflows/{ci,eval,license-gate}.yml`
- Modify: pino + auditLog 接线（serializers 脱敏 token/apiKey/secret；14 种 AuditEventKind）
- Test: `packages/core/src/coding/exec/__tests__/reflection.test.ts` + 10 golden case

**Approach:**
- 反射闭环借 aider `run_one`：edit → checkpoint post-edit → lint（tsc/eslint）→ test（vitest，lint 通过才跑）→ 读失败 preview 喂回 → `max_reflections=3` → 达上限如实上报
- 二级 judge：确定性 judge 作 CI hard gate；LLM judge 只写报告
- CI 沙箱用 docker-fallback；eval.yml 结果自动 comment PR

**Execution note:** 进度紧可先交付 reflection=1 保 M1 闭环，多轮自校正作增量。

**Test scenarios:**
- Happy path: "修复这个 bug" → 改代码 → test 失败 → 读输出自校正 → 再跑通过（≤3 反射）
- Edge case: 反射达上限 → 如实上报失败，不假装成功
- Edge case: lint 失败 → 不跑 test（省 token）；lint/test 输出 >32KB 落 artifacts
- Error path: interrupt → node-pty `kill()` + nono kill process tree
- Integration: 10 条 golden case 真链路 ≥8/10（发布 10/10），平均 ≤25k tokens/case，p95 ≤60s
- Integration: 发布验收剧本 origin §5.3 全流程手动走查（含刷新恢复、usage 可见）

**Verification:** slice6 验收 + §5.2 DoD 全部 7 项硬指标逐项核对。

## System-Wide Impact

- **Interaction graph:** queryLoop 是所有子系统的汇合点（审批/沙箱/压缩/检查点/反射全部缝进钩子位），Unit 4-7 每个都要改它——10 条不变量测试是防回归的总闸
- **Error propagation:** 全链统一 5 键 ToolErrorEnvelope，工具失败回灌模型喂反射，provider 失败编码进 `finishReason` 不 throw
- **State lifecycle risks:** 中断后三不变式（无悬挂 sandbox run / 审批转 cancelled / turn 转 interrupted）；压缩与 tool 配对的时序约束；redo 栈"新写清空"语义
- **API surface parity:** `@arclight/protocol` 是唯一类型源，事件新增只能 append（前端未知 `t` 静默忽略保 forward-compat）
- **Integration coverage:** golden eval 全部走真实 `arclight serve` HTTP/SSE/tool/nono 链路，明确非 mock
- **Unchanged invariants:** 用户仓库 `.git` 零干扰（shadow-git worktree 隔离）；`.arclight/` 为唯一运行时落点

## Risks & Dependencies

（完整登记见 origin §6 R1-R12，此处仅列排期影响最大的）

| 风险 | 缓解 |
|------|------|
| R4 queryLoop 控制反转重写被低估（最高危） | 先写 10 不变量测试；Unit 3 单独留缓冲；进度紧砍到 happy-path+中断+错误恢复 |
| R1/R2 Bun + node-pty / web-tree-sitter 原生兼容 | Unit 1 第一周 smoke 强制；降级路径已定义（Bun.spawn pipe / 正则粗提取） |
| R3 nono 成熟度（Landlock 需内核 ≥5.13） | docker-fallback Unit 1 实装，CI 直接用它 |
| R10 自研量超预算（1-3 人） | RepoMap / 多轮反射为弹性范围；MCP/LSP/多 provider 已推迟 |
| R11 选型修订未同步源文档 | Unit 1 内完成 D1/D2 留痕修订 |

## Documentation / Operational Notes

- `NOTICE` 文件：Apache-2.0 归因（ai/drizzle/aider/cline 摘录）+ 前端 Runtime 选型修订决策记录（Unit 1 建立，后续单元追加）
- 每完成一个 Unit 勾选本计划 checkbox，并以 slice demo 作里程碑演示
- 发布验收以 origin §5.3 Demo 剧本为准

## Sources & References

- **Origin document:** [doc/DEV_PLAN.md](../DEV_PLAN.md)（阶段一最终交付版，已对抗式评审）
- 架构：[doc/ARCHITECTURE_BLUEPRINT.md](../ARCHITECTURE_BLUEPRINT.md)、[doc/FULL_PLATFORM_DESIGN.md](../FULL_PLATFORM_DESIGN.md)
- P0 施工图：[doc/research/P0-基础三件套-拓扑-数据模型-工具契约.md](../research/P0-基础三件套-拓扑-数据模型-工具契约.md)、[doc/research/P0-沙箱方案-拿来即用.md](../research/P0-沙箱方案-拿来即用.md)
- 选型与工程实践：[doc/research/拿来即用-全栈选型清单.md](../research/拿来即用-全栈选型清单.md)、[doc/research/工程实践与测试eval策略.md](../research/工程实践与测试eval策略.md)
- 可借代码：`../references/pi`、`../references/aider`、`../references/cline`、`../references/opencode`（许可证与借用边界见 origin §7.1）
