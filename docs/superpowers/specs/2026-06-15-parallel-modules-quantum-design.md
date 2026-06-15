# 并行建设 skills / MCP / agent core 三模块 + 量子算法能力 — 设计

日期：2026-06-15
状态：待评审
作者：Alba（brainstorm with Claude）

## 1. 背景与目标

arclight 是一个 TS/Bun monorepo 的 AI 编码 agent。当前已按包拆分：
`@arclight/protocol`（唯一类型源 / 契约层）、`@arclight/core`（后端引擎：loop / tools / sandbox / db / server）、
`@arclight/client-core`、`@arclight/cli`、`@arclight/web`。

本设计要解决两件事：

1. **如何让 skills、MCP、agent core 三个能力模块并行建设**，互不阻塞、合并不撞车。
2. **如何把"量子算法能力"加进来**——作为上述抽象的**第一个真实业务实例**，而不是一个新的子系统。

非目标（明确排除，YAGNI）：

- 不拆多仓（polyrepo）。理由见 §8。
- 不自研量子算法库、不自训量子模型。量子模型**复用现有通用模型（GLM）**，不新增 provider。
- v1 不做多框架，只做 Qiskit 一个适配器（但架构必须支持后续扩展）。

## 2. 核心洞察：三模块都是"能力来源"

现有 `loop` 从不关心工具来自哪里——它只消费 `ToolRegistry` 给出的归一化 schema，执行全部收口在
`makeExecuteTool`（zod 校验 / 超时 / 取消 / >32KB spill，一处搞定）。

因此 skills 与 MCP 本质上都是"**往 registry 里塞 `Tool` 的来源**"，agent core 是消费这些来源的**宿主**。
量子算法能力则是 skills 模块的一个**具体 skill 实例**。

```
agent core (拥有契约)          MCP 模块                     skills 模块
core/src/loop/                core/src/mcp/               core/src/skills/
core/src/tools/source.ts ◀── 实现 ToolSource ──▶          实现 ToolSource
core/src/tools/registry.ts                                 │
   组合所有 source                                          └─ 首个 skill: 量子算法 workflow
```

## 3. 唯一阻塞项：`ToolSource` 接口（agent core 拥有，先合并、冻结）

当前 `ToolRegistry` 只有静态的 `register(tool)`。抽象为"能力来源"：

```ts
// core/src/tools/source.ts —— agent core 拥有；先实现并合并，然后冻结
export interface ToolSource {
  readonly id: string;                                       // "builtin" | "mcp:<server>" | "skills"
  list(ctx: SessionCtx): Promise<Tool<unknown, unknown>[]>;  // 异步：MCP 需连服务器
  contribute?(ctx: SessionCtx): PromptFragment | undefined;  // skills 需注入提示词（可用清单）
  dispose?(): Promise<void>;                                 // MCP 需断连
}
```

落地步骤（agent core owner，体量小但是闸门）：

1. 定义 `ToolSource` / `SessionCtx` / `PromptFragment`。
2. 把现有 builtin 工具改造成第一个 `ToolSource`（样板）。
3. loop 在会话开始时把 N 个 source **组合**进一个 registry；`contribute()` 汇入系统提示。
4. 提供 `FakeSource` 测试桩，供 MCP / skills 在真实现成前对接。

**纪律：此接口合并并冻结后，MCP 与 skills 才能真正并行。** 这是"契约优先"原则在 core 内部的应用
（与 protocol 作为客户端/服务端防火墙是同一招）。

## 4. 并行模块边界与所有权

| 模块 | 目录 | 职责 | 各自要啃的硬骨头 |
|---|---|---|---|
| agent core | `core/src/loop/`、`core/src/tools/source.ts`、`registry.ts` | 定义并冻结 `ToolSource`；组合来源；消费能力 | 接口设计、source 组合与生命周期编排 |
| MCP | `core/src/mcp/` | 连接 MCP server，把 MCP 工具映射成 `Tool` | ①风险分级默认值 ②连接生命周期 |
| skills | `core/src/skills/` | 发现 skill、产出 `Skill` 工具 + 提示词片段 | skill = 工具 + 渐进披露提示词 |

各模块**只对 `ToolSource` 接口编程**，CI 各自独立绿。

### 各模块内部的关键决策（天然隔离，不会互相影响）

- **MCP 风险分级**：外部 MCP server 不会声明 arclight 的 `riskTier` / `riskClass` / `mutatesWorkspace`。
  MCP 适配器必须给**保守默认**（`mutatesWorkspace=true`、`riskTier=confirm`），否则外部工具会静默绕过
  审批 / 影子检查点——遵守 protocol 既定的 fail-safe 纪律。
- **MCP 生命周期**：连接异步、会失败、工具表会变；`list()` 返回动态结果，断连走 `dispose()`。
- **skills 双重产出**：skill 不只是工具——还要通过 `contribute()` 往系统提示注入"可用 skills 清单"
  （Claude Code 式渐进披露）。这是接口里 `contribute?` 的由来。

### 协作机制

- **CODEOWNERS（新增）** 按目录分工：`core/src/loop` + `tools/source.ts` → agent core owner；
  `core/src/mcp` → MCP owner；`core/src/skills` → skills owner；`packages/protocol` → 全员会签。
- **契约即测试**：`ToolSource` 配黄金 fixture，谁破坏接口 CI 立刻红。

## 5. 量子算法能力 = skills 模块的首个真实 skill

量子需求**只落在两个已有抽象**上，不引入新模块类型：

| 需要的东西 | 落在哪 | 谁建 |
|---|---|---|
| 量子算法 workflow（见 §6） | `skills` 模块的一个 skill | skills owner |
| Qiskit 的 Python sandbox profile | `core/src/sandbox/profiles` | agent core / sandbox |
| 量子模型 | **复用 GLM，无需新建 provider** | —— |

约束：arclight 是 TS/Bun，主流量子库是 Python，故量子库**不能作为 workspace 依赖**，
只能通过 **sandbox 进程执行**（已有 bash 工具 + sandbox）触达。

## 6. 量子算法 workflow（框架无关骨架 + 适配器）

工序对所有框架通用，分阶段、带**关卡（gate）**：

```
① 建模 Formulate    框架无关。分类问题→选算法族
                    (QAOA/VQE 优化 · Grover 搜索 · Shor 分解 · 哈密顿模拟 · HHL 线代 · QML)
                    产出：选型 + 理由 + 量子比特/深度预算
   │  gate: 选型不合理不得往下
   │  ↓ 决策：选目标框架/语言（v1 固定 Qiskit）
② 设计电路 Circuit  适配器特定。构造电路/ansatz/oracle，参数化
   │
③ 模拟 Simulate     适配器特定。sandbox 跑 statevector/shot 模拟器
   │  gate: 小规模实例必须先对上经典暴力解，才允许放大
④ 分析 Analyze      框架无关。测量/期望值/成功概率，解读结果
   │
⑤ 转译优化 Transpile 适配器特定。降深度/门数，按目标基组与耦合图转译，噪声感知
   │  gate: 未过模拟验证，禁止上真机
⑥ (可选) 真机 QPU   适配器特定。提交真实硬件 + 误差缓解，与模拟对比
```

**关卡纪律是这个 skill 的核心价值**：小实例没对上经典解不准放大；没过模拟不准上真机。
正是 skill"渐进披露 + 流程约束"的用武之地。

### 6.1 框架适配器（为扩展而设计，v1 只实现 Qiskit）

阶段 ②③⑤⑥ 委托给"适配器"——每个框架一份小抄，说明该框架里每步具体怎么写/怎么跑。

- **加新框架 = 加一个适配器，workflow 主体不动。**
- v1 只实现 **Qiskit 适配器**；后续 Cirq / PennyLane（同 Python profile）、Q#（需 .NET profile）按需加。

### 6.2 OpenQASM 3 作为规范 IR

电路以 **OpenQASM 3** 为规范交换格式：

- 支持电路在框架/模拟器间搬运与交叉验证。
- "小实例对经典解"的关卡可跨框架复用同一份 QASM。
- 避免 N 个框架两两互转的组合爆炸。
- v1 即采纳：Qiskit 适配器负责 circuit ↔ QASM3 互转，为后续适配器铺好接缝。

### 6.3 sandbox profile

按**宿主运行时**分 profile，不按框架：

- v1：一个 Python 量子 profile（装 Qiskit；预留 Cirq/PennyLane 同 profile 扩展位）。
- 后续：Q# 需单独 .NET profile，Yao.jl 需 Julia profile。

## 7. 实施顺序

1. **阶段 0（阻塞，短）**：agent core 实现并冻结 `ToolSource`，builtin 改造为样板，提供 `FakeSource`。同时加 CODEOWNERS。
2. **阶段 1（并行）**：MCP 模块 ∥ skills 模块，各自实现一个 `ToolSource`，对接 `FakeSource` 起步。
3. **阶段 2（量子实例）**：
   - sandbox owner 加 Python 量子 profile（Qiskit）。
   - skills owner 写量子算法 workflow skill（§6 骨架 + Qiskit 适配器 + QASM3 互转）。
   - 用现有 GLM 模型跑通端到端闭环，验证整套抽象。

## 8. 关键决策记录

- **monorepo 不拆仓**：包之间强耦合、同步演进（protocol 一改，core 与客户端必须同改），
  commit 历史本就横跨多包。多仓会带来版本漂移与原子改动被切碎的代价，对单人/小团队纯负担。
  行业类似项目（VS Code、Cline、Continue）均为 monorepo + workspaces。
- **量子走"集成"而非"自建"**：用 agent 集成现成库/模型先跑通闭环、验证需求，再谈自研。
- **量子模型复用 GLM**：v1 不接专用量子模型。
- **为扩展而设计、只实现一个**：适配器架构 + OpenQASM3 IR 从一开始就在，但 v1 只交付 Qiskit。

## 9. 测试策略

- `ToolSource`：契约/黄金 fixture 测试；`FakeSource` 驱动 loop 组合逻辑单测。
- MCP：mock MCP server，验证工具映射与保守风险默认；断连/失败路径。
- skills：发现逻辑、`contribute()` 提示词注入、`Skill` 工具加载。
- 量子 skill：小实例对经典解的关卡（如 Grover/Bell 态可判定结果）；circuit ↔ QASM3 round-trip。
