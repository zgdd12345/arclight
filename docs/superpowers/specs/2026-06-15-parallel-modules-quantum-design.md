# 并行建设 skills / MCP / agent core 三模块 + 量子计算动态 workflow 能力 — 设计

日期：2026-06-15（v2，量子部分按四框架调研重写）
状态：待评审
作者：Alba（brainstorm with Claude）

## 1. 背景与目标

arclight 是一个 TS/Bun monorepo 的 AI 编码 agent。当前已按包拆分：
`@arclight/protocol`（唯一类型源 / 契约层）、`@arclight/core`（后端引擎：loop / tools / sandbox / db / server）、
`@arclight/client-core`、`@arclight/cli`、`@arclight/web`。

本设计解决两件事：

1. **如何让 skills、MCP、agent core 三个能力模块并行建设**，互不阻塞、合并不撞车。
2. **如何加入"量子计算能力"**——作为 skills 模块的真实业务实例，采用 **Claude-Code 式动态 workflow** 架构，
   适配多种国产量子框架（isQ / PyQuafu / cqlib / Wuyue 系 / 玻色 Kaiwu）。

非目标（YAGNI）：

- 不拆多仓（polyrepo）。理由见 §9。
- 不自研量子算法库、不自训量子模型。量子模型**复用现有通用模型（GLM）**，不新增 provider。
- v1 量子只交付：基座 workflow + 门电路模板 + **isQ 一个适配器**。其余框架/范式后续按同一架构加。
- **不强制单一通用 IR**（撤销早期 OpenQASM3 决定，理由见 §6.3 与 §9）。

## 2. 核心洞察：三模块都是"能力来源"

现有 `loop` 从不关心工具来自哪里——它只消费 `ToolRegistry` 给出的归一化 schema，执行全部收口在
`makeExecuteTool`（zod 校验 / 超时 / 取消 / >32KB spill，一处搞定）。

因此 skills 与 MCP 本质上都是"**往 registry 里塞 `Tool` 的来源**"，agent core 是消费这些来源的**宿主**。
量子能力是 skills 模块的一个**具体 skill**（动态 workflow 形态）。

```
agent core (拥有契约)          MCP 模块                     skills 模块
core/src/loop/                core/src/mcp/               core/src/skills/
core/src/tools/source.ts ◀── 实现 ToolSource ──▶          实现 ToolSource
core/src/tools/registry.ts                                 │
   组合所有 source                                          └─ 首个 skill: 量子动态 workflow
```

## 3. 唯一阻塞项：`ToolSource` 接口（agent core 拥有，先合并、冻结）

当前 `ToolRegistry` 只有静态的 `register(tool)`。抽象为"能力来源"：

```ts
// core/src/tools/source.ts —— agent core 拥有；先实现并合并，然后冻结
export interface ToolSource {
  readonly id: string;                                       // "builtin" | "mcp:<server>" | "skills"
  list(ctx: SessionCtx): Promise<Tool<unknown, unknown>[]>;  // 异步：MCP 需连服务器
  contribute?(ctx: SessionCtx): PromptFragment | undefined;  // skills 需注入提示词（渐进披露）
  dispose?(): Promise<void>;                                 // MCP 需断连
}
```

落地步骤（agent core owner，体量小但是闸门）：

1. 定义 `ToolSource` / `SessionCtx` / `PromptFragment`。
2. 把现有 builtin 工具改造成第一个 `ToolSource`（样板）。
3. loop 在会话开始时把 N 个 source **组合**进一个 registry；`contribute()` 汇入系统提示。
4. 提供 `FakeSource` 测试桩，供 MCP / skills 在真实现成前对接。

**纪律：此接口合并并冻结后，MCP 与 skills 才能真正并行。** 这是"契约优先"在 core 内部的应用
（与 protocol 作为客户端/服务端防火墙是同一招）。

## 4. 并行模块边界与所有权

| 模块 | 目录 | 职责 | 各自要啃的硬骨头 |
|---|---|---|---|
| agent core | `core/src/loop/`、`core/src/tools/source.ts`、`registry.ts` | 定义并冻结 `ToolSource`；组合来源；消费能力 | 接口设计、source 组合与生命周期编排 |
| MCP | `core/src/mcp/` | 连接 MCP server，把 MCP 工具映射成 `Tool` | ①风险分级默认值 ②连接生命周期 |
| skills | `core/src/skills/` | 发现 skill、产出 `Skill` 工具 + 提示词片段；承载量子动态 workflow | skill = 工具 + 渐进披露；动态 workflow 合成 |

各模块**只对 `ToolSource` 接口编程**，CI 各自独立绿。

### 各模块内部的关键决策（天然隔离）

- **MCP 风险分级**：外部 MCP server 不会声明 arclight 的 `riskTier` / `riskClass` / `mutatesWorkspace`。
  MCP 适配器必须给**保守默认**（`mutatesWorkspace=true`、`riskTier=confirm`），遵守 protocol 既定 fail-safe 纪律。
- **MCP 生命周期**：连接异步、会失败、工具表会变；`list()` 返回动态结果，断连走 `dispose()`。
- **skills 双重产出**：skill 不只是工具——还要通过 `contribute()` 往系统提示注入"可用 skills/workflow 清单"。

### 协作机制

- **CODEOWNERS（新增）** 按目录分工：`core/src/loop` + `tools/source.ts` → agent core；
  `core/src/mcp` → MCP；`core/src/skills` → skills；`packages/protocol` → 全员会签。
- **契约即测试**：`ToolSource` 配黄金 fixture，谁破坏接口 CI 立刻红。

## 5. 量子能力 = skills 模块的动态 workflow skill

量子需求落在已有抽象上，不引入新模块类型：

| 需要的东西 | 落在哪 | 谁建 |
|---|---|---|
| 量子动态 workflow（§6） | `skills` 模块的一个 skill | skills owner |
| 各框架的 sandbox 运行环境（profile） | `core/src/sandbox/profiles` | agent core / sandbox |
| 量子模型 | **复用 GLM，无需新建 provider** | —— |

约束：arclight 是 TS/Bun，量子框架基本是 Python/DSL，故框架**不能作为 workspace 依赖**，
只能通过 **sandbox 进程执行**（已有 bash 工具 + sandbox）触达。

### 5.1 四框架调研结论（决定架构形态）

四个目标框架**不是同一范式的四种方言**，差异巨大（已逐一查证）：

| 框架 | 真实身份 | 范式 | 宿主 | 本地离线模拟器 | 原生表示 |
|---|---|---|---|---|---|
| **isQ** | 中科院软件所 / 弧光量子 的 C-like DSL | 门电路 | 独立 `.isq` + `isqc` 编译 | ✅ QIR 模拟器(CPU/CUDA) | QIR → QCIS/OpenQASM3 |
| **PyQuafu** | 北京量子院 BAQIS 夸父云 | 门电路 | 纯 Python | ✅ 免 token 本地模拟 | 自有 + OpenQASM2 双向 |
| **cqlib** | 中电信天衍 / 国盾 | 门电路 | 纯 Python | ❌ 模拟器在云端(需 login_key) | QCIS(双比特仅 CZ) + QASM↔QCIS |
| **Wuyue 系** | 移动"五岳纪元" WuYueSDK（开源,门电路, QASM2, 本地全幅模拟器）/ 玻色 Kaiwu（光量子 QUBO 退火, 非门电路） | **门电路 与 退火并存** | 纯 Python | WuYueSDK ✅ / Kaiwu 经典解可本地 | WuYueSDK: QASM2 / Kaiwu: QUBO-Ising 矩阵 |

两条决定性事实：

1. **范式分裂**：门电路（isQ/PyQuafu/cqlib/WuYueSDK）与 **QUBO/Ising 退火**（玻色 Kaiwu，相干光量子 CIM——无量子比特、无门、无电路）是**两种根本不同的计算模型**。任何"单一固定 workflow"都覆盖不全。
2. **能力按框架分裂**：离线模拟、原生 IR、安装方式各不相同。→ 不能把任何一个框架的特性写进通用流程。

→ 这正是采用**动态 workflow** 而非"枚举固定 workflow"的根本原因。

## 6. 量子动态 workflow 架构（Claude-Code 式）

三层结构，全部落在 skills 模块、走渐进披露（按需加载）：

```
┌─ Layer A · 基座 meta-workflow（永远先走，范式无关）──────────────┐
│  ① Intake & 分类   判定问题类型 + 计算范式(门电路/退火/其他)      │
│  ② 选择或合成      匹配到固定模板?→用；无匹配?→在基座上动态合成   │
│  ③ 实现            委托给所选【框架适配器】                       │
│  ④ 验证 (GATE)     已知答案/已知最优 + 经典交叉验证               │
│  ⑤ 执行 (GATE)     先模拟通过，才允许上真机                       │
│  ⑥ 分析/后处理     解码 → 经典答案 + 置信度                       │
└──────────────────────────────────────────────────────────────┘
        │ 选模板                          │ 委托
        ▼                                ▼
┌─ Layer B · 固定 workflow 模板 ─┐   ┌─ Layer C · 框架适配器 ────────┐
│ gate-circuit.md                │   │ isq.md   (v1)                 │
│   Map→设计→模拟→分析→转译→真机  │   │ pyquafu.md / cqlib.md (后续)  │
│ qubo-annealing.md              │   │ wuyue.md / kaiwu.md   (后续)  │
│   建模→QUBO→Ising→CIM求解→解码 │   │ 每个含: 钉死版本 / BANNED_     │
│ (新范式按需新增)               │   │ PATTERNS / 离线模拟能力 / 原生 │
└────────────────────────────────┘   │ IR / 已知答案校验钩子          │
                                      └───────────────────────────────┘
```

### 6.1 动态合成（用户提出的核心思想）

- **匹配到固定模板** → 直接用（门电路任务用 `gate-circuit.md`，优化退火任务用 `qubo-annealing.md`）。
- **不匹配**（新算法 / 不熟悉的框架 / 跨范式）→ agent 以 Layer A 基座为骨架、用框架适配器的原语**现场合成**一条 workflow。
- **复利**：合成出的好 workflow 可沉淀为新的固定模板（Layer B），下次直接命中。这与 Claude Code skills 的"渐进披露 + 经验沉淀"一致。

### 6.2 验证纪律（基座的核心价值，调研实证）

- **关卡用"输出格式义务"表达，不是"建议"**：要求 agent 在每关输出 `GATE_N: PASSED|FAILED`，harness 可 grep 校验。
- **门电路**已知答案校验：Bell / GHZ / Bernstein-Vazirani / Deutsch-Jozsa（确定性，必须 100%）、Grover / QFT（阈值判定）。
- **退火**已知最优校验：小规模 MaxCut / TSP 等有已知最优解的实例。
- **最关键洞察**（QuanBench+ / Qiskit Code Assistant 论文）：RAG 注入文档仅提升 ~4%，真正有效的是
  **"模拟器报错 trace → 分析 → 修复 → 再过关"的 debug 闭环**。skill 设计重心放在 debug 闭环工程，而非堆文档。
- 关卡硬纪律：小实例没对上经典解不准放大；**没过模拟不准上真机**（真机执行默认锁定，需用户显式放行关键字）。

### 6.3 IR 决策：撤销"通用 IR 强约束"，改为每适配器自带原生表示

调研双重否定了"单一通用 IR"：

- **OpenQASM3 不可靠**：即使在 Qiskit 内部 round-trip 都漏（参数化门被硬编码、`switch/int` 自家导出自家解析不了、物理比特映射丢失、`int/angle/duration/def` 直接不支持）；pytket 完全不支持；PennyLane 只入不出。
- **四框架无一以 QASM3 为中心**：isQ 能导出但社区冷、PyQuafu 只 QASM2、cqlib/国盾走 QCIS、WuYueSDK 用 QASM2、Kaiwu 压根没电路。
- **QCIS** 是中国超导事实标准（cqlib/国盾/中科院/祖冲之），但本源用 OriginIR，仍不统一。

**结论**：不设全局 IR。每个**框架适配器声明自己的原生表示**与可选互通格式；需要跨框架搬运时，用两个适配器的最大公约数（门电路超导生态常见为 **QCIS 或 QASM2**），且永远是 best-effort、不是硬约束。

### 6.4 sandbox 运行环境（按框架，不按统一 profile）

每个适配器声明运行环境与**离线模拟能力**（决定 §6.2 验证关卡能否本地执行）：

- **isQ（v1）**：独立 DSL，工具链重——官方推荐 Nix，亦有预编译 tarball / Docker 镜像。配一个装好 `isqc` 的 profile；
  其 QIR 本地模拟器 ✅ 可离线自验。注意两套不兼容方言（完整 isQ vs 硬件 isQ-Core，后者禁 measurement-feedback），适配器须讲清。
- PyQuafu / WuYueSDK：纯 pip + 本地模拟器 ✅，profile 最轻。
- cqlib：无本地模拟器 ❌ → 本地关卡需交叉模拟或联网（适配器须标注）。
- Kaiwu：经典退火解可本地，CIM 真机需 license/token。

## 7. v1 量子交付范围（首个适配器：isQ）

按用户决定，门电路三件套里 **v1 先落地 isQ**：

- 写 Layer A 基座 workflow + Layer B `gate-circuit.md` 模板 + Layer C `isq.md` 适配器。
- 配 isQ 的 sandbox profile（`isqc` + 本地 QIR 模拟器）。
- isQ 风险点写进适配器：版本管理混乱（GitHub 仅 v0.0.1 / 文档 0.2.8、2023 后低活跃）、两套方言不兼容、
  CNOT 写法非主流（`ctrl X(c,t)`）、社区极小 → 通用模型幻觉率高 → **钉死版本 + BANNED_PATTERNS + 可执行校验脚本是必需品**。
- 用现有 GLM 跑通端到端：写 Bell/GHZ/Grover → 本地 QIR 模拟 → 已知答案校验过关。

## 8. 实施顺序

1. **阶段 0（阻塞，短）**：agent core 实现并冻结 `ToolSource`，builtin 改造为样板，提供 `FakeSource`；加 CODEOWNERS。
2. **阶段 1（并行）**：MCP 模块 ∥ skills 模块，各自实现一个 `ToolSource`，对接 `FakeSource` 起步。
3. **阶段 2（量子实例，挂在 skills 上）**：
   - sandbox owner 加 isQ profile。
   - skills owner 写 Layer A 基座 + `gate-circuit.md` 模板 + `isq.md` 适配器 + 验证 oracle 脚本。
   - GLM 跑通闭环，验证动态 workflow + 适配器 + 关卡整套抽象。
4. **后续**：按同一架构加 PyQuafu / cqlib / WuYueSDK 适配器，及 `qubo-annealing.md` 模板 + Kaiwu 适配器。

## 9. 关键决策记录

- **monorepo 不拆仓**：包强耦合、同步演进（protocol 一改，core 与客户端必须同改），commit 历史本就横跨多包。
  多仓带来版本漂移与原子改动被切碎的代价，对单人/小团队纯负担。类似项目（VS Code、Cline、Continue）均 monorepo + workspaces。
- **量子走"集成"而非"自建"**：用 agent 集成现成框架/模型先跑通闭环、验证需求，再谈自研。
- **量子模型复用 GLM**：v1 不接专用量子模型。
- **动态 workflow 而非枚举固定 workflow**（用户提出）：四框架分属门电路与退火两种范式且能力分裂，固定流程覆盖不全；
  基座 + 模板 + 适配器 + 动态合成，既覆盖常用又能扩展，且可沉淀复利。
- **撤销 OpenQASM3 通用 IR**：调研实证其 round-trip 不可靠且四框架无一以其为中心；改为每适配器自带原生表示，跨框架 best-effort（QCIS/QASM2）。
- **v1 首个适配器 = isQ**（用户决定）。

## 10. 测试策略

- `ToolSource`：契约/黄金 fixture 测试；`FakeSource` 驱动 loop 组合逻辑单测。
- MCP：mock MCP server，验证工具映射与保守风险默认；断连/失败路径。
- skills：发现逻辑、`contribute()` 提示词注入、`Skill` 工具加载；动态合成的 happy/无匹配路径。
- 量子（v1 isQ）：基座关卡（`GATE_N` 输出义务）；isQ 本地 QIR 模拟跑 Bell/GHZ/BV/DJ 等已知答案校验；
  BANNED_PATTERNS 自检脚本；真机执行默认锁定且需显式放行的回归测试。
```
