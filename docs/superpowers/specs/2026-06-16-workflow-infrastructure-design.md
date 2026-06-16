# Workflow 编排基础设施 — 完整设计

日期：2026-06-16
状态：待评审
作者：Alba（brainstorm with Claude）
关联：本设计是 `2026-06-15-parallel-modules-quantum-design.md` §5（编排基建）的完整展开；
量子能力是本基建的第一个消费者。

## 1. 目标与范围

给 arclight 长出一套 **Claude-Code 式的动态 workflow 能力**：用一段 JS 脚本编排一组 subagent，
**关卡 = 代码控制流（`if/throw`）**，subagent 独立上下文、只回灌可 schema 校验的结构化结果。

本版是**完整方案**，明确包含：

- **真并行**（`parallel` / `pipeline`，宿主侧 `Promise.all` 真并发，非伪并行）。
- **resume / journal**（断点续跑，缓存重放未变前缀）。
- 脚本临场生成 + 命名复用；跨 subagent 审批冒泡；provider 共享限流；token budget。

非目标（YAGNI）：worktree 隔离仅在并发写文件冲突时启用（按需）；不做脚本可视化编辑器；
不引入二级嵌套 workflow 以上的深度（`workflow()` 仅一层）。

## 2. 地基决策：脚本隔离引擎 = QuickJS(wasm, QuickJS-ng asyncify)

arclight 服务端跑在 **Bun（JavaScriptCore）**。AI 临场生成的编排脚本是不可信代码，必须强隔离
（只能触达注入的 `agent()` 等原语，禁 fs/net/process）且可确定性化（禁 `Date.now/Math.random`）。
调研结论（含出处见附录）：

| 方案 | Bun(JSC) | 隔离 | async 宿主注入 | 确定性 | 取舍 |
|---|---|---|---|---|---|
| isolated-vm | ❌ V8 原生插件，加载不了 | — | — | — | 排除 |
| node:vm | 🟡 | 官方明示**非安全边界** | — | — | 排除 |
| SES | 🟡 | JSC 上有栈泄露 gap | — | — | 排除 |
| Bun Worker | ✅ | 仅线程隔离，**fs/net 不可禁** | postMessage 桥接 | 部分 | 落选（不安全） |
| **QuickJS-emscripten（QuickJS-ng, asyncify）** | ✅ 官方支持 Bun | **物理隔离（wasm，默认无宿主 API）** | ✅ `newAsyncifiedFunction` | ✅ 可彻底桩掉 | **选定** |

具体取 `quickjs-emscripten` + `@jitl/quickjs-ng-wasmfile-release-asyncify` 变体（ES2023+、上游活跃）。

### 2.1 asyncify 的硬约束（决定 API 形态）

QuickJS-ng asyncify 实例**同一时刻只能挂起一个 async 调用；挂起期间任何对 guest 的再入（含同步回调）都会崩溃**。

推论（本设计据此定型）：
1. **真并发只能发生在宿主侧。** guest 发起一次 async 原语调用 → 实例挂起一次 → 宿主侧 `Promise.all` 并发跑完 → 一次性回灌结果 → guest 恢复。
2. **扇出所需的全部数据必须在挂起前由 guest 备好**（纯同步构造），因此 `parallel/pipeline` 接收**可序列化的 agent 规格**，而非 guest 闭包。
3. 附带收益：规格可序列化 → 天然可 journal → 与 resume 契合。

## 3. 模块布局 `core/src/workflow/`（agent core 拥有）

```
runtime.ts     QuickJS 实例生命周期:注入原语、桩 Date/random、加载并执行脚本、错误归一
primitives.ts  agent / parallel / pipeline / workflow / phase / log + args / budget 绑定
subagent.ts    嵌套 queryLoop:派生 state、受限工具集、schema 强制结构化返回
scheduler.ts   并发信号量池 + provider 共享限流 + token budget 记账 + AbortSignal 扇出
journal.ts     workflow_runs / workflow_agents 持久化、resume 缓存重放
events.ts      workflow.* 生命周期事件(protocol 背书)的发射
store.ts       .arclight/workflows/*.workflow.js 加载 / 保存 / 命名解析
index.ts       对外仅暴露 runWorkflow(scriptOrName, args, ctx)
```

## 4. 原语 API（宿主实现，注入 guest）

```ts
type AgentSpec = {
  prompt: string;
  schema?: JsonSchema;          // 提供则强制结构化返回(zod 校验,不匹配 retry)
  tools?: string[];             // 该 subagent 可见工具白名单(默认继承受限集)
  model?: string;               // 模型覆盖(默认继承会话模型)
  label?: string; phase?: string;
  isolation?: "worktree";       // 仅并发写文件时按需
};

// 单 subagent;一次 async 挂起,asyncify 安全
agent(prompt: string, opts?: Omit<AgentSpec,"prompt">): Promise<string | object>;

// barrier:宿主 Promise.all 真并发;失败项 → null
parallel(specs: AgentSpec[]): Promise<(any | null)[]>;

// 无 barrier 流水线;stage 是声明式规格,${prev}/${item}/${index} 由宿主插值(无 guest 再入)
type StageSpec = { prompt: string; schema?: JsonSchema; tools?: string[]; model?: string };
pipeline(items: any[], ...stages: StageSpec[]): Promise<(any | null)[]>;

workflow(name: string, args?: any): Promise<any>;   // 内联子 workflow,仅一层
phase(title: string): void;  log(msg: string): void; // 同步,进度事件
// 全局: args(启动入参), budget({ total, spent(), remaining() })
```

**与 Claude Code 闭包式 API 的刻意分歧**：`parallel/pipeline` 收规格而非 `() => Promise` 闭包——
受 §2.1 所迫，且利于 journal。任意 guest 逻辑仍可用顺序 `agent()` + 普通 `if/for` 表达；
`parallel` 覆盖"扇出+收集""对抗式多投票校验"，`pipeline` 覆盖"逐项多阶段流式"。

## 5. subagent 执行模型（`agent()` 落地）

一次 `agent()` = 跑一个嵌套 `queryLoop`：

- **上下文隔离**：派生子 `sessionId`/`turnId`（`parentTurnId` 关联）；独立消息历史；系统提示 = 基建注入的角色提示 + 环境信息；**不见父会话历史/已读文件**。
- **受限工具集**：从 ToolSource 组好的 registry 按 `opts.tools` 裁剪（默认给一个安全子集）。
- **结构化返回**：`schema` → 强制末步调用内置 `StructuredOutput` 工具 → zod 校验 → 返回对象；无 schema 则返回最终文本。
- **结果投影**：最终消息复用现有投影（>32KB 落 artifacts，返回 preview + spillRef）。
- **持久化**：子 turn/message/event 入库，关联 `workflowRunId` + `parentTurnId`，便于审计与 resume。

## 6. 调度与资源治理（真并行的硬点）

- **并发池**：信号量，默认上限 `min(16, cores-2)`；`parallel/pipeline` 提交的每个 agent 入池排队；单 run 累计 agent 上限做防失控 backstop。
- **provider 共享限流**：并发 subagent 全打 GLM → 在 `provider-manager` 加**共享令牌桶/队列**，按端点 RPM/TPM 限流，撞限退避重试（区分可重试 429 与终态错误）。**这是真并行不撞墙的前提。**
- **sandbox 隔离**：并发跑代码的 subagent 各起独立 sandbox session/工作区；确有并发写同一工作区时启用 `isolation:"worktree"`。
- **token budget**：`budget` 跨整个 run 共享记账；到顶后 `agent()` 抛错（硬上限）。

## 7. 状态 / journal / resume（v1 内）

新增两表（drizzle，sqlite）：

```
workflow_runs   (id, sessionId, scriptHash, args, status, startedAt, finishedAt)
workflow_agents (id, runId, seq, callKind, specHash, resultJson, status)
                callKind ∈ {agent, parallel-item, pipeline-item}
```

- **journal**：每次 agent 调用按 `(seq, specHash)` 落 `workflow_agents`。
- **resume**：以相同 `scriptHash + args` 重跑 → 未变前缀的调用按 `specHash` 命中缓存秒回，首个变更/新增调用起 live 跑。
- **确定性前提**：脚本内禁 `Date.now()`/`Math.random()`/无参 `new Date()`（runtime 桩为抛错或固定值），时间戳/随机种子经 `args` 注入。

## 8. 事件 / protocol / 可观测

新增事件（zod schema 落 `packages/protocol`，**全员会签**）：
`workflow.started` / `workflow.phase` / `workflow.agent.started` / `workflow.agent.completed` / `workflow.completed` / `workflow.failed`。

- 走现有"进度帧旁路"（持久化 + bus 扇出，不混入主 turn 叙事流），与 `executeBatch` 的进度帧一致。
- web 端出一个进度树视图（phase → agent，可下钻单 agent 的子 turn）。

## 9. 跨 subagent 审批路由

subagent 内 `confirm`/`irreversible` 工具调用命中现有 `approval/presets.ts` → 发 `permission.ask`：

- 事件**冒泡到主会话事件流**呈现给用户；该 subagent 的 turn 转 `awaiting_approval`，不占 provider 调用。
- 用户决议按 `approvals.askId` 关联回灌到对应 subagent（并发下多问并存，靠 askId 区分）。
- 真机执行类工具据此天然受控——这是 §量子"没过校验/未审批不上真机"硬关卡的强制来源之一。

## 10. 失败 / 中断 / 安全模型

- **失败语义**：`agent()` 内部错 → 返回 `null`（`.filter(Boolean)` 可滤）；`parallel` 单项失败 → `null` 不拖垮整体；`pipeline` 某 stage 抛 → 该 item 落 `null` 跳过剩余 stage；脚本顶层 `throw` → run 置 `failed` 并发 `workflow.failed`。
- **中断**：`AbortSignal` 沿现有链路扇出到所有在飞 subagent；run 置 `interrupted`。
- **安全纵深**：①脚本在 wasm 物理隔离内，唯一副作用通道是注入原语；②subagent 的实际工具调用仍受 ToolSource 白名单 + 审批风险分级 + sandbox 三重既有约束；③脚本静态体检（禁用符号扫描）作为加固层，非唯一防线。

## 11. 与三模块 / 量子的关系

- 本基建归 **agent core**，是 `2026-06-15` spec 的**阶段 0b 地基**，位于 `ToolSource`(0a) 之后、消费其组好的 registry 起 subagent。
- **量子是第一个消费者**：`gate-circuit.workflow.js` 等脚本跑在本基建上，subagent 预加载 isQ 适配器、按需读算法库样例，校验/真机关卡用本基建的控制流 + 审批路由强制。

## 12. 实施顺序（基建内部里程碑）

1. **M1 runtime + agent()**：QuickJS 实例 + 注入 `agent()`（嵌套 queryLoop + schema 返回）+ Date/random 桩；顺序脚本能跑通。
2. **M2 真并行**：`scheduler`（并发池 + provider 共享限流 + sandbox 隔离）→ `parallel()` → `pipeline()`。
3. **M3 journal + resume**：两表 + 缓存重放。
4. **M4 事件 + 审批路由**：protocol 事件 + 进度旁路 + 跨 subagent `permission.ask` 冒泡/回灌 + 中断扇出。
5. **M5 store + 动态合成**：命名 workflow 加载/保存；主 agent 临场生成脚本入口。

依赖：M1 → M2 → M3/M4（可并行）→ M5。量子（外部阶段 2）需 M1+M2+M4 就绪。

## 13. 关键决策记录

- **隔离引擎 = QuickJS(wasm) asyncify**（用户定）：Bun(JSC) 上唯一兼具真隔离 + async 宿主注入 + 确定性的方案；isolated-vm/node:vm/SES/Worker 均不达标（§2）。
- **parallel/pipeline 收规格、非 guest 闭包**：asyncify 单挂起所迫（§2.1），且利于 journal。
- **resume/journal 进 v1**（用户定）：长量子任务（多轮改电路）崩溃/改脚本后可续跑。
- **真并行进 v1**（用户定）：支撑对抗式多投票校验、并行选型等；需 provider 共享限流配套。
- **provider 共享限流是真并行前提**：并发 subagent 共打 GLM，必须统一限流防 429。

## 14. 测试策略

- runtime：脚本只能触达注入原语（fs/net/process 访问被拒）；`Date.now/Math.random` 被桩；脚本语法/运行错误归一为结构化失败。
- agent()：上下文隔离（子不见父历史）；`schema` 校验失败 retry；最终消息/spill 返回。
- 并行：`parallel` 真并发（计时验证非串行）+ 失败项 → null；`pipeline` 无 barrier 流式 + 单 item 失败隔离；并发池上限与排队；provider 限流退避。
- journal/resume：相同 scriptHash+args 全缓存命中；改中段后前缀命中、其后 live；确定性约束回归。
- 事件/审批：`workflow.*` 事件序列；subagent `permission.ask` 冒泡到主流并按 askId 回灌；中断扇出到在飞 subagent。
- store：命名 workflow 加载/保存；动态合成脚本执行。

## 15. 未决 / 推后

- worktree 隔离的触发判定（何时自动启用）——M2 落地时定细则。
- `pipeline` 声明式插值的表达力边界（仅 `${prev/item/index}` 路径取值，不支持任意表达式）——若不够再评估。
- 二级以上嵌套 workflow——明确不做。

## 附录：隔离引擎调研出处

- Bun 原生插件不兼容（V8/JSC ABI）：bun.com/docs/runtime/nodejs-compat
- isolated-vm 为 V8 原生：github.com/laverdet/isolated-vm
- node:vm 非安全边界：bun.com/reference/node/vm/runInNewContext
- SES 在 JSC 栈泄露：github.com/endojs/endo（ses README）
- Bun 无权限模型（Worker 仍可访问 fs/net）：github.com/oven-sh/bun/issues/25928
- quickjs-emscripten 支持 Bun + asyncify async 宿主注入：github.com/justjake/quickjs-emscripten
- QuickJS-ng asyncify 变体：@jitl/quickjs-ng-wasmfile-release-asyncify
