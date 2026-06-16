# 并行三模块(skills/MCP/agent core) + 动态 workflow 编排基建 + 量子能力 — 设计

日期：2026-06-15（v3，新增 dynamic workflow 编排基建作为核心地基，量子降为首个消费者）
状态：待评审
作者：Alba（brainstorm with Claude）

## 1. 背景与目标

arclight 是一个 TS/Bun monorepo 的 AI 编码 agent。当前已按包拆分：
`@arclight/protocol`（唯一类型源 / 契约层）、`@arclight/core`（后端引擎：loop / tools / sandbox / db / server）、
`@arclight/client-core`、`@arclight/cli`、`@arclight/web`。

本设计解决三件事，从地基到上层：

1. **三模块并行**（§2–4）：skills、MCP、agent core 各自独立建设，靠 `ToolSource` 契约互不阻塞。
2. **动态 workflow 编排基建**（§5）：给 arclight 长出一个 **Claude-Code 式的工作流能力**——
   用 JS 脚本编排一组 subagent，**关卡 = 代码控制流**。这是核心地基，先建。
3. **量子能力**（§6）：作为编排基建的**第一个消费者**，量子 workflow = 跑在该基建上的脚本，
   适配多种国产量子框架（isQ / PyQuafu / cqlib / Wuyue 系 / 玻色 Kaiwu）。

非目标（YAGNI）：

- 不拆多仓（polyrepo）。理由见 §9。
- 不自研量子算法库、不自训量子模型。量子模型**复用现有通用模型（GLM）**，不新增 provider。
- 编排基建做**完整方案**（含真并行 `parallel/pipeline` + resume/journal），详见独立 spec `2026-06-16-workflow-infrastructure-design.md`。
- v1 量子只交付：门电路 workflow 脚本 + **isQ 一个适配器**。其余框架/范式后续按同一架构加。
- **不强制单一通用 IR**（撤销早期 OpenQASM3 决定，理由见 §6.5 与 §9）。

## 2. 核心洞察：三模块都是"能力来源"

现有 `loop` 从不关心工具来自哪里——它只消费 `ToolRegistry` 给出的归一化 schema，执行全部收口在
`makeExecuteTool`（zod 校验 / 超时 / 取消 / >32KB spill，一处搞定）。

因此 skills 与 MCP 本质上都是"**往 registry 里塞 `Tool` 的来源**"，agent core 是消费这些来源的**宿主**。

```
agent core (拥有契约 + 编排基建)   MCP 模块            skills 模块
core/src/loop/                    core/src/mcp/       core/src/skills/
core/src/tools/source.ts ◀── 实现 ToolSource ──▶      实现 ToolSource
core/src/workflow/  (新, §5)                          └─ 量子适配器 + 算法库 (§6)
   编排基建,消费 ToolSource 组好的 registry 起 subagent
```

## 3. 阻塞项一：`ToolSource` 接口（agent core 拥有，先合并、冻结）

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

**纪律：此接口合并并冻结后，MCP 与 skills 才能真正并行。** 这是"契约优先"在 core 内部的应用。

## 4. 并行模块边界与所有权

| 模块 | 目录 | 职责 | 各自要啃的硬骨头 |
|---|---|---|---|
| agent core | `core/src/loop/`、`core/src/tools/source.ts`、`registry.ts`、`core/src/workflow/` | 定义并冻结 `ToolSource`；组合来源；**实现 workflow 编排基建（§5）** | 接口设计、source 编排、subagent 生成与隔离、关卡/审批接通 |
| MCP | `core/src/mcp/` | 连接 MCP server，把 MCP 工具映射成 `Tool` | ①风险分级默认值 ②连接生命周期 |
| skills | `core/src/skills/` | 发现 skill、产出 `Skill` 工具 + 提示词片段；**承载量子适配器 + 算法库（§6）** | skill = 工具 + 渐进披露 |

各模块**只对 `ToolSource` 接口编程**，CI 各自独立绿。

### 各模块内部的关键决策（天然隔离）

- **MCP 风险分级**：外部 MCP server 不会声明 arclight 的 `riskTier` / `riskClass` / `mutatesWorkspace`。
  MCP 适配器必须给**保守默认**（`mutatesWorkspace=true`、`riskTier=confirm`），遵守 protocol 既定 fail-safe 纪律。
- **MCP 生命周期**：连接异步、会失败、工具表会变；`list()` 返回动态结果，断连走 `dispose()`。
- **skills 双重产出**：skill 不只是工具——还要通过 `contribute()` 往系统提示注入"可用 skills/workflow 清单"。

### 协作机制

- **CODEOWNERS（新增）**：`core/src/loop` + `tools/source.ts` + `core/src/workflow` → agent core；
  `core/src/mcp` → MCP；`core/src/skills` → skills；`packages/protocol` → 全员会签。
- **契约即测试**：`ToolSource` 配黄金 fixture，谁破坏接口 CI 立刻红。

## 5. 动态 workflow 编排基建（核心地基，先建）

> **完整设计已独立成文**：`2026-06-16-workflow-infrastructure-design.md`（含隔离引擎选型、真并行、resume、调度限流、审批路由、实施里程碑）。本节仅留要点，细节以独立 spec 为准。

### 5.1 模型来源（Claude Code 调研结论）

Claude Code 的 "dynamic workflow" 不是状态机引擎、也不是单 agent 读 markdown 自驱，而是：
**一段 JS 脚本，用 `agent(prompt,{schema})` 生成独立上下文的 subagent，用 `parallel()/pipeline()` 编排，
关卡是脚本里的 `if/throw`**——确定性、不可被 LLM 绕过；subagent 只把最终结果（可强制 schema 校验的 JSON）
回灌脚本变量，中间过程不进主上下文。脚本可临场生成，也可存为命名 workflow 复用。

arclight **当前没有这套**（只有一个扁平 query-loop）。本节定义要新建的最小能力。

### 5.2 最小原语集 + arclight 如何实现

| 原语 | arclight 实现 | 作用 |
|---|---|---|
| `agent(prompt, {schema?, tools?, model?})` | 起一个**嵌套 queryLoop**：独立 state、受限工具集、跑完返回最终消息；`schema` 复用现有 zod 校验强制结构化返回 | 一个 workflow 阶段 = 一次 subagent |
| JS 控制流 `if/for/throw/try` | 脚本在**受限 JS 执行环境**里跑，`agent()` 是唯一副作用通道（脚本无 fs/网络） | **硬关卡**：见 §5.3 |
| 脚本加载/存储 | `.arclight/workflows/*.workflow.js`（项目级，进 git） | 命名 workflow + 动态合成（§5.5） |

`agent()` 的 subagent 上下文隔离复用现有 runner——新 state、`turnId` 派生、工具集按需裁剪，
最终消息作为返回值（与现有 tool result 投影一致，>阈值走 artifacts spill）。

### 5.3 关卡 = 控制流（硬关卡，本设计的关键收益）

之前纠结的"关卡怎么强制"在这里一刀解决——关卡就是代码：

```js
const code = await agent(`用 ${args.lang} 实现 ${args.algorithm}，参考算法库样例`,
                         { schema: CODE_SCHEMA });
const verify = await agent(`sandbox 跑模拟 + 已知答案 oracle`, { schema: VERDICT });
if (!verify.passed) {                       // ← 硬关卡:LLM 无法绕过的代码分支
  // 有界 debug 闭环（重试上限 N）；仍失败 throw 中止，真机分支不可达
}
const hw = await agent(`提交真机`, { schema: HW_SCHEMA });   // 仅在 verify 通过后可达
```

两道关卡的强制来源不同、都不可绕：
- **校验关卡**：`verify.passed` 是 subagent 在 sandbox 跑 oracle 得的**真值**，agent 编不出来。
- **真机关卡**：`hw` subagent 内的真机工具调用 `riskTier=irreversible` → 命中现有 `presets.ts` → 发 `permission.ask`、turn 转 `awaiting_approval` → 用户审批，仍不可绕。

### 5.4 跨 subagent 审批路由（待接通的设计点）

现有审批（`approval/presets.ts`）在主 loop 的工具执行处触发。subagent 内的 `confirm`/`irreversible`
工具调用必须能**冒泡回到用户**：编排基建需把 subagent 的 `permission.ask` 事件透传到主会话的事件流，
用户决议再回灌该 subagent。这是 §5 必须实现的一环，否则真机硬关卡形同虚设。

### 5.5 脚本：命名复用 + 动态合成

- **固定 workflow** = 版本化存于 `.arclight/workflows/<name>.workflow.js`，可被反复调用、参数化（`args`）。
- **动态合成** = 任务不匹配任何固定脚本时，主 agent **现写一个脚本**（基座骨架 + 框架适配器原语）并执行。
- **复利** = 合成出的好脚本可存盘提升为固定 workflow，下次直接命中。

### 5.6 范围：完整方案（含真并行 + resume）

- **隔离引擎**：QuickJS(wasm, QuickJS-ng asyncify)——Bun(JSC) 上唯一兼具真隔离 + async 宿主注入 + 确定性的方案。
- **真并行**：`parallel/pipeline` 宿主侧 `Promise.all` 真并发；受 asyncify 单挂起所迫，二者收**可序列化 agent 规格**而非 guest 闭包。
- **resume/journal**：`workflow_runs/workflow_agents` 两表 + 缓存重放未变前缀。
- **配套**：provider 共享限流（真并行不撞 429 的前提）、token budget、跨 subagent 审批冒泡。
- 详见独立 spec `2026-06-16-workflow-infrastructure-design.md` §4–§12。

## 6. 量子能力 = 跑在编排基建上的第一个消费者

约束：arclight 是 TS/Bun，量子框架基本是 Python/DSL，故框架**不能作为 workspace 依赖**，
只能通过 **sandbox 进程执行**触达（在 subagent 的 sandbox 里跑）。量子模型**复用 GLM，不新增 provider**。

### 6.1 四框架调研结论（决定为何要"动态"）

四个目标框架**不是同一范式的四种方言**（已逐一查证）：

| 框架 | 真实身份 | 范式 | 宿主 | 本地离线模拟器 | 原生表示 |
|---|---|---|---|---|---|
| **isQ** | 中科院软件所 / 弧光量子 的 C-like DSL | 门电路 | 独立 `.isq` + `isqc` 编译 | ✅ QIR 模拟器(CPU/CUDA) | QIR → QCIS/OpenQASM3 |
| **PyQuafu** | 北京量子院 BAQIS 夸父云 | 门电路 | 纯 Python | ✅ 免 token 本地模拟 | 自有 + OpenQASM2 双向 |
| **cqlib** | 中电信天衍 / 国盾 | 门电路 | 纯 Python | ❌ 模拟器在云端(需 login_key) | QCIS(双比特仅 CZ) + QASM↔QCIS |
| **Wuyue 系** | 移动"五岳纪元" WuYueSDK（开源,门电路,QASM2,本地全幅模拟器）/ 玻色 Kaiwu（光量子 QUBO 退火,非门电路） | **门电路与退火并存** | 纯 Python | WuYueSDK ✅ / Kaiwu 经典解可本地 | WuYueSDK: QASM2 / Kaiwu: QUBO-Ising 矩阵 |

两条决定性事实：①**范式分裂**——门电路 vs QUBO/Ising 退火是两种根本不同的计算模型；
②**能力按框架分裂**——离线模拟、原生 IR、安装各不相同。→ 固定单一流程覆盖不全，**必须动态合成**，
这正是 §5 编排基建的用武之地。

### 6.2 量子 workflow 脚本（跑在 §5 上）

- **固定脚本**：`gate-circuit.workflow.js`（门电路：设计→模拟→校验→转译→真机）、
  `qubo-annealing.workflow.js`（退火：建模→QUBO→Ising→CIM 求解→解码）。
- **每个阶段 = 一次 `agent()`**，预加载对应**框架适配器** skill + 按需从**算法库**取样例。
- **关卡 = 控制流**（§5.3）：没过模拟 `throw`，真机走审批。
- **不匹配**（新算法/新框架/跨范式）→ 主 agent 动态合成脚本（§5.5）。

### 6.3 框架适配器（skills 模块产出，subagent 预加载）

每个适配器是一份 skill，声明：钉死版本、`BANNED_PATTERNS`（废弃 API）、离线模拟能力、原生 IR、
已知答案校验钩子。**v1 只做 `isq`**。

- **isQ**：独立 DSL，工具链重（官方 Nix / 预编译 tarball / Docker）；QIR 本地模拟器 ✅ 可离线自验；
  两套不兼容方言（完整 isQ vs 硬件 isQ-Core 禁 measurement-feedback）；CNOT 写法非主流（`ctrl X(c,t)`）；
  社区极小 → 通用模型幻觉率高 → 钉死版本 + BANNED_PATTERNS + 可执行校验是必需品。
- 后续：PyQuafu/WuYueSDK（纯 pip + 本地模拟器 ✅，最轻）；cqlib（无本地模拟器 ❌，校验需联网或交叉模拟）；Kaiwu（退火，经典解可本地，CIM 真机需 license/token）。

### 6.4 验证纪律（关卡的真值来源，调研实证）

- **门电路**已知答案：Bell/GHZ/Bernstein-Vazirani/Deutsch-Jozsa（确定性，必须 100%）、Grover/QFT（阈值）。
- **退火**已知最优：小规模 MaxCut/TSP 等。
- **最关键洞察**（QuanBench+/Qiskit Code Assistant 论文）：RAG 注入文档仅 +4%，真正有效的是
  **"模拟器报错 trace → 修复 → 再过关"的 debug 闭环**——在脚本里就是校验关卡的有界重试循环。

### 6.5 IR 决策：撤销"通用 IR 强约束"

调研双重否定单一通用 IR：OpenQASM3 即使在 Qiskit 内部 round-trip 都漏（参数化门硬编码、switch/int 自家解析不了、
物理比特丢失）、pytket 不支持、PennyLane 只入不出；且四框架无一以 QASM3 为中心。QCIS 是中国超导事实标准但本源用 OriginIR，仍不统一。
→ **不设全局 IR**，每个适配器自带原生表示；跨框架搬运 best-effort（门电路超导生态常见 QCIS/QASM2），非硬约束。

### 6.6 sandbox 运行环境（按框架，不按统一 profile）

每个适配器声明运行环境与离线模拟能力（决定 §6.4 校验关卡能否本地跑）。v1 配 isQ profile（`isqc` + 本地 QIR 模拟器）。

### 6.7 量子算法库（知识层，严格遵循渐进披露）

定位：按集成路线，算法库是 arclight 内部"算法资产库"（不是自研数值库），架在框架之上，
被量子 workflow 的 subagent 在"选型/实现"阶段按需消费。

**目录结构**——每算法 = 框架无关规范 + 校验 oracle + 按语言已验证样例：

```
algorithms/
├─ gate-circuit/                    # 门电路 (isQ/PyQuafu/cqlib/WuYueSDK/…)
│  ├─ INDEX.md                      # 范式内一行式索引(含语言覆盖标记)
│  ├─ grover/
│  │  ├─ spec.md                    # 框架无关:用途/选型条件/资源量级/nisq
│  │  ├─ oracle.md                  # 已知答案校验:2-qubit 搜 |11⟩ → 概率>阈值
│  │  └─ samples/                   # 按语言,逐步完善,文件名钉死版本
│  │     ├─ isq@0.2.8.isq ✓   ├─ pyquafu@0.4.5.py ✓   └─ (cqlib 暂缺)
│  ├─ vqe/  qaoa/  qft/  bell/  …
└─ annealing/  (maxcut/tsp/knapsack: spec.md + oracle.md + samples/kaiwu@1.3.1.py)
```

**渐进披露层映射**（选型只读极薄索引，绝不读遍全部 spec）：

| 披露层 | 加载时机 | 内容 |
|---|---|---|
| L1 Discovery | 量子 skill frontmatter | name/description，判断是否激活 |
| L2 Activation | skill 激活常驻（小、有界） | 顶层索引：范式 + 指针 |
| L3-a 范式索引 | 分类出范式后 | `gate-circuit/INDEX.md` 等：每算法一行 |
| L3-b 算法规范 | 选定算法后 | 该算法 `spec.md` 全文 |
| L3-c 样例 + 校验 | 在某语言实现/验证时 | `samples/<lang@ver>` **单一一份** + `oracle.md` |

- **索引分片**：先按范式收窄，再拉一行式索引，最后才读单算法 spec → 常驻上下文有界、与库规模无关。
- **索引声明语言覆盖**（`samples: isq,pyquafu (缺 cqlib)`）→ 避免读不存在的样例。
- **缺目标语言时 fallback**：读已有语言样例（如 Qiskit）+ 适配器 → 合成 → 跑 oracle 校验 → **通过后回写为新样例**（自动填缝，即"逐步完善"）。
- **入库纪律**：校验通过 + 版本钉死才入库（防旧 API 教偏模型）；手工策展样例与 agent 合成样例互补。
- 这些"按需读一份样例"发生在 subagent 上下文内，渐进披露依然成立。

## 7. v1 量子交付范围（首个适配器：isQ）

- 写 `gate-circuit.workflow.js`（跑在 §5 编排基建上）。
- skills 产出 `isq` 适配器 skill；sandbox owner 加 isQ profile（`isqc` + 本地 QIR 模拟器）。
- 算法库种子：Bell/GHZ/Grover 的 `spec.md` + `oracle.md` + `samples/isq@<ver>.isq`；`gate-circuit/INDEX.md` 登记覆盖（仅 isq）。
- 用 GLM 跑通端到端：脚本调度 → subagent 选型查索引 → 读 isQ 样例 → 写 isQ → sandbox QIR 模拟 → oracle 校验关卡通过 →（真机分支走审批）。

## 8. 实施顺序

1. **阶段 0a（阻塞，短）**：agent core 实现并冻结 `ToolSource`，builtin 改造为样板，`FakeSource`，加 CODEOWNERS。
2. **阶段 0b（地基，agent core）**：实现 §5 编排基建完整方案（QuickJS runtime + `agent()` + 真并行 + journal/resume + 审批路由），按独立 spec `2026-06-16-workflow-infrastructure-design.md` 的 M1–M5 里程碑推进。
3. **阶段 1（并行）**：MCP 模块 ∥ skills 模块，各自实现一个 `ToolSource`，对接 `FakeSource` 起步。
4. **阶段 2（量子，消费 0b + 1）**：isQ profile + `isq` 适配器 + `gate-circuit.workflow.js` + 算法库种子；GLM 跑通闭环。
5. **后续**：加 PyQuafu/cqlib/WuYueSDK 适配器、`qubo-annealing.workflow.js` + Kaiwu 适配器；按需补 §5 推后原语（parallel/pipeline/resume）。

依赖：0a → 0b（同属 agent core，顺序）；0a 冻结后 1 可与 0b 并行；2 需 0b + skills 的 isQ 适配器就绪。

## 9. 关键决策记录

- **monorepo 不拆仓**：包强耦合、同步演进；多仓带来版本漂移与原子改动被切碎的代价。类似项目（VS Code、Cline、Continue）均 monorepo + workspaces。
- **workflow = 编排 subagent 的 JS 脚本，关卡 = 控制流**（用户指认 Claude Code 模型，已调研证实）：硬关卡、上下文隔离、可复用版本化，优于"纯提示词自驱"与"编码状态机引擎"。
- **编排基建是地基，先于量子建**（用户决定）：量子是它的第一个消费者，不是它的子功能。
- **量子走"集成"而非"自建"**；**量子模型复用 GLM**。
- **动态合成而非枚举固定 workflow**：四框架分属门电路/退火两范式且能力分裂，固定流程覆盖不全。
- **撤销 OpenQASM3 通用 IR**：调研实证 round-trip 不可靠且四框架无一以其为中心；改每适配器自带原生表示。
- **编排基建做完整方案**（真并行 + resume，用户决定；隔离引擎 QuickJS/wasm，详见独立 spec），**v1 首个量子适配器 = isQ**（用户决定）。

## 10. 测试策略

- `ToolSource`：契约/黄金 fixture；`FakeSource` 驱动 loop 组合逻辑单测。
- **workflow 编排基建（§5）**：`agent()` 上下文隔离与最终消息返回；`{schema}` 校验失败 retry；
  控制流关卡（verify 失败必中止、真机分支不可达）；跨 subagent 审批冒泡到主会话事件流并回灌；脚本加载/存储；确定性约束（禁 Date.now/random）。
- MCP：mock MCP server，工具映射与保守风险默认；断连/失败路径。
- skills：发现逻辑、`contribute()` 注入、`Skill` 加载；适配器 BANNED_PATTERNS 自检。
- 量子（v1 isQ）：`gate-circuit.workflow.js` 端到端（含 verify 关卡有界重试、真机默认锁定需审批的回归）；
  isQ 本地 QIR 模拟跑 Bell/GHZ/BV/DJ 已知答案校验。
- 算法库（§6.7）：索引覆盖标记与 `samples/` 一致性；版本钉死回归；缺语言 fallback（合成→校验→回写）happy/失败路径；`contribute()` 只注入 L2 指针。
