现在我有足够的信息来输出完整的选型清单。让我直接输出：

---

# computer-use 子系统拿来即用选型清单

> 范围：浏览器自动化 · 云浏览器 · 视觉 grounding · computer-use 模型  
> 基准：ARCHITECTURE_BLUEPRINT.md §1.1/§2.1/§5.7 定案结论 + 四份调研 JSON  
> 原则：网页优先 · TS/Bun 内核 · MVP = Web+写代码单能力；computer-use 为 **P3 阶段**，不在 MVP 关键路径

---

## 一、浏览器自动化

### 1.1 Stagehand v3 ✅ 主选

| 项目 | 详情 |
|---|---|
| **来源** | `npm install @browserbasehq/stagehand` · github.com/browserbase/stagehand · MIT |
| **提供什么** | `act / extract / observe / agent` 四个自然语言原语；v3 移除 Playwright 硬依赖，可插 Puppeteer 或任意 CDP driver；self-healing（DOM/布局变化自动 re-LLM 适配，不抛异常）；多模型后端（Claude/GPT/Gemini）；TypeScript 原生，与 arclightagent TS/Bun 栈同构，零语言边界 |
| **集成成本** | **拿来即用**：`new Stagehand({ ... })` 直接初始化，API 极薄 |
| **成熟度** | 成熟开源 + Browserbase 商业云背书，生产可用 |
| **风险/坑** | v3 是 2025 年发布，driver 模块化为新设计，少数边缘 driver 适配可能不稳；self-healing 增加每步 LLM 调用开销，高频任务注意 token 成本 |
| **许可证** | MIT，商用无限制 |

**为何选而非 browser-use**：browser-use（Python，~98k stars）虽更成熟，但 Python 进程引入语言边界（sidecar），ARCHITECTURE_BLUEPRINT §2.3 明确纪律「执行层优先选 TS 原生实现」；Stagehand 与内核同构，无跨语言 sidecar 维护负担。

### 1.2 @playwright/test + playwright（底层驱动）

| 项目 | 详情 |
|---|---|
| **来源** | `npm install playwright` · github.com/microsoft/playwright · Apache-2.0 |
| **提供什么** | Stagehand v3 默认内置的 CDP 驱动；也可直接用于非 AI 确定性自动化步骤（截图、导航、表单）；TypeScript 原生 |
| **集成成本** | **拿来即用**（Stagehand 已封装，透明使用）；直接用时 `chromium.launch()` 即可 |
| **成熟度** | 业界最成熟浏览器自动化库，生产标准 |
| **风险** | 无实质风险；注意 Playwright 安装会拉 Chromium 二进制（~150MB），CI/Docker 镜像需预装 |
| **许可证** | Apache-2.0，复制代码须附 NOTICE |

### 1.3 microsoft/playwright-mcp（备选路径：MCP 接入）

| 项目 | 详情 |
|---|---|
| **来源** | `npm install @playwright/mcp` · github.com/microsoft/playwright-mcp · Apache-2.0 |
| **提供什么** | 基于 accessibility tree 的 MCP 服务器；以结构化文本快照（角色+文本）替代截图，**每步 token 消耗远低于视觉**；与 arclightagent MCP 双向架构天然对齐；约 29 个工具（导航/输入/截图/网络）；微软官方维护 |
| **集成成本** | **拿来即用**：作为 MCP server 挂入已有 MCP dispatch 管线，零业务代码改动 |
| **成熟度** | 微软官方维护，生产可用 |
| **风险/坑** | accessibility tree 对 canvas / WebGL / 老旧 iframe 重站点覆盖不全，需视觉兜底补位 |
| **许可证** | Apache-2.0 |

> **两者定位**：Stagehand 是 AI 编排主路径（自然语言驱动+自愈），playwright-mcp 是 Agent 通过 MCP 工具调用的备选路径（token 更省），二者共享 Playwright 底层，互补不冲突。

---

## 二、云浏览器（隔离运行时）

### 2.1 Browserbase SDK ✅ 主选

| 项目 | 详情 |
|---|---|
| **来源** | `npm install @browserbasehq/sdk` · browserbase.com · 商业 SaaS，SDK 开源 MIT |
| **提供什么** | 云端隔离 Chrome（stealth，代理轮换，CAPTCHA 处理）；每会话独立沙箱，不同用户/任务之间零共享；内建 prompt injection containment 研究；与 Stagehand 深度集成（Stagehand 官方 harness 即 Browserbase）；CDP 远程连接，可直接 `playwright.connect(session.connectUrl)` |
| **集成成本** | **拿来即用**：`new Browserbase({ apiKey })` + `session.create()`，Stagehand 用 `env: "BROWSERBASE"` 一行切换 |
| **成熟度** | 生产可用，商业服务，SLA 保障 |
| **风险/坑** | 商业计费（会话按分钟/请求）；数据经第三方服务器——按 ARCHITECTURE_BLUEPRINT §2.1 定义为 **opt-in SaaS 模式**，本地开发默认走本地 Playwright；多租户敏感会话需评估数据驻留合规 |
| **许可证** | SDK MIT；服务条款另计 |

### 2.2 Steel Browser SDK（备选/开源自托管）

| 项目 | 详情 |
|---|---|
| **来源** | `npm install steel-sdk` · github.com/steel-dev/steel-browser · Apache-2.0（开源版） |
| **提供什么** | 开源浏览器 API，可自托管（Docker 镜像）；按会话隔离；同样提供 SaaS 版；leaderboard.steel.dev 聚合 AI agent 基准 |
| **集成成本** | **轻度封装**：自托管需维护 Docker 部署；云版接入同 Browserbase 量级 |
| **成熟度** | 成熟，开源社区活跃 |
| **风险** | 自托管运维成本高于直接用 Browserbase SaaS；自托管安全更新需自行跟踪 |
| **许可证** | Apache-2.0（开源 core）；SaaS 服务条款另计 |

> **选型决策**：生产优先 Browserbase（Stagehand 原生 harness）；需要数据自主可控时用 Steel 自托管或本地 Playwright。两者均满足 ARCHITECTURE_BLUEPRINT §5.7「浏览器 computer-use 用本身已隔离的 Browserbase/Steel，不再套 E2B」的定案。

---

## 三、视觉 Grounding

### 3.1 OmniParser v2 ✅ 主选（兜底路径）

| 项目 | 详情 |
|---|---|
| **来源** | github.com/microsoft/OmniParser · MIT · Python 模型（ONNX 可导出）；无官方 npm 包 |
| **提供什么** | 截图 → 可交互元素坐标/边界框；ScreenSpot-Pro 39.5%（当前开源 SOTA 级）；Set-of-Mark (SoM) 增强；OCR + 元素检测两阶段；微软维护，有持续更新 |
| **集成成本** | **需较多缝合**：Python 推理服务需包装为内部 HTTP sidecar；或使用 ONNX Runtime（npm `onnxruntime-node`）做 JS 端推理（但需手动转换模型权重）；是子系统中**唯一无现成 TS npm 包的组件** |
| **成熟度** | 研究成熟，部分生产可用；模型权重开源，微软官方维护 |
| **风险/坑** | - 无官方 TS/JS SDK，必须自建 sidecar 或 ONNX 导出 pipeline；<br>- 推理成本高（GPU 友好，CPU 下延迟可观）；<br>- 视觉 grounding 场景仅是 AX-tree 失效时的兜底，MVP 不应是主路径 |
| **许可证** | MIT，商用无限制 |

> **使用策略**：按 ARCHITECTURE_BLUEPRINT §5.7「DOM/accessibility-tree 优先 + 视觉 grounding 兜底」：90% 场景走 Stagehand/playwright-mcp 的 AX tree；仅在 canvas/自定义渲染/老旧站点 DOM 不可用时回退 OmniParser。**视觉 grounding 在 P3 computer-use 阶段才真正需要，MVP 不引入。**

---

## 四、computer-use 模型

### 4.1 Anthropic Claude computer-use ✅ 主选

| 项目 | 详情 |
|---|---|
| **来源** | Anthropic API（`@anthropic-ai/sdk` npm）· 商业 API · 无开源版；工具名 `computer_20250124` / `computer-use-2025-11-24 beta` |
| **提供什么** | 当前公开 SOTA：Claude Sonnet 4.5 OSWorld 61.4%，Claude Opus 4.5 OSWorld 66.3%（P@1 avg@5）；细粒度动作（鼠标/键盘/scroll/drag/hold_key/triple_click）；可维持 30+ 小时多步任务；与 arclightagent 主力 provider（Anthropic）统一，复用 KV-cache 机制 |
| **集成成本** | **拿来即用**（已在 Anthropic SDK 内）：调用时加 `anthropic-beta: computer-use-2025-11-24` header，工具定义走标准 tool_use 流程 |
| **成熟度** | 生产可用（beta 工具，API 全面开放） |
| **风险/坑** | - Beta header，工具版本（2025-11-24）会继续迭代，需做版本兼容封装；<br>- 纯视觉截图路线，每步截图 token 开销大；需配合独立 WS/WebRTC 截图通道（不混 SSE）；<br>- 任务难度超出 OSWorld 基准时能力急剧下降（66% 不等于通用可靠） |
| **许可证** | 商业 API，无源码 |

### 4.2 Gemini 2.5 Computer Use（备选/成本优化路径）

| 项目 | 详情 |
|---|---|
| **来源** | Google AI Studio / Vertex AI API · `@google/genai` npm · 商业 API · public preview |
| **提供什么** | 基于 Gemini 2.5 Pro 的专用 computer-use 模型；Web/Android UI 控制基准领先；内置每步安全服务（可对高危动作拒绝/确认）；Browserbase harness 约 70%+；计费约 $1.25/百万 input token（低于 Claude Opus） |
| **集成成本** | **拿来即用**：`computer_use` 工具走标准 Gemini API tool_use |
| **成熟度** | Public preview，API 开放，生产路径明确；Project Mariner 已关停并入此 API |
| **风险/坑** | - Preview 状态，接口稳定性不如 Anthropic；<br>- Google 产品形态变动快（Project Mariner 关停先例），不要绑产品名，绑底层 API；<br>- 与 arclightagent 主力 KV-cache（Anthropic）不统一，混用两套 provider 增加 token 成本归因复杂度 |
| **许可证** | 商业 API |

### 4.3 UI-TARS-2（可选/数据合规/自托管路径）

| 项目 | 详情 |
|---|---|
| **来源** | github.com/bytedance/UI-TARS · github.com/bytedance/UI-TARS-desktop · Apache-2.0 |
| **提供什么** | 开源 GUI 原生 Agent 模型，端到端截图输入→动作；UI-TARS-2 OSWorld 47.5%、AndroidWorld 73.3%、ScreenSpot-Pro 38.1；完整 stack（模型权重+框架+桌面/浏览器运行时+MCP+行为日志）；Apache-2.0，可完全私有部署 |
| **集成成本** | **需较多缝合**：需自托管模型推理服务（GPU 资源）+ 与 arclightagent agent loop 对接 |
| **成熟度** | 成熟开源，模型权重全开放 |
| **风险/坑** | - 推理需 GPU 资源（自托管成本）；<br>- OSWorld 47.5% 显著低于 Claude 66.3%，能力差距明显；<br>- 个人 Agent 初期用云 API 即可，自托管推到产品成熟再评估 |
| **许可证** | Apache-2.0，商用友好；可复制代码须附 NOTICE |

---

## 五、各组件：仅保留的最小自研接缝

| 接缝 | 内容 | 为何不能现成 |
|---|---|---|
| **截图传输通道** | 独立 WS/WebRTC 服务（JPEG/WebP + 帧差增量编码），不混入 token SSE | 所有库都不提供「与 arclightagent 内核 SSE 解耦的截图通道」；ARCHITECTURE_BLUEPRINT §5.2 明确要求独立二进制通道 |
| **computer-use Agent Loop 封装** | 将 `截图 → 模型推理 → 动作执行 → 再截图` 闭环适配为 arclightagent 的 async-generator 事件流（`yield` CUScreenshot / CUAction / CUThought 事件类型）| Loop 结构各厂 SDK 都不提供；需适配内核事件模型 |
| **高危动作 HITL 确认** | 前端模态对话框回传（借鉴 cline `bridgePermissionCallbacks` 设计思路，但代码自写）+ 沙箱外凭证代理的动作签名放行逻辑 | 凭证管理和确认回调深度绑定 arclightagent 认证体系；现成库无法直接复用 |
| **OmniParser sidecar 接口**（仅当需要视觉兜底时） | 将 Python 推理封装为本地 HTTP service，或做 ONNX 导出 + `onnxruntime-node` 调用 | OmniParser 无 TS SDK，是子系统中唯一需要额外封装的组件 |
| **Provider 版本兼容层** | 对 Claude `computer-use-2025-11-24` beta header 做版本封装（beta 工具仍在迭代） | 直接调 Anthropic SDK 无版本兼容封装 |

---

## 六、现在不要自研、推迟到产品成熟后的部分

| 推迟项 | 理由 |
|---|---|
| **自研浏览器自动化引擎**（替代 Stagehand/Playwright） | Stagehand+Playwright 已成熟，投入极大，无差异化收益 |
| **自研视觉 grounding 模型**（替代 OmniParser） | 需要大量训练数据和 GPU 资源，微软/字节 SOTA 短期不可超越 |
| **自研云浏览器/沙箱浏览器基础设施**（替代 Browserbase/Steel） | 基础设施投入巨大（stealth、IP 轮换、CAPTCHA、多租户隔离），现成商业方案性价比远高于自建 |
| **自研 computer-use 模型**（替代 Claude/Gemini/UI-TARS） | 训练门槛极高，短期不可企及 SOTA；产品成熟后视数据合规需求再评估 UI-TARS 私有部署 |
| **UI-TARS 自托管推理服务** | 当前 GPU 成本高、能力低于 Claude CU；先用云 API，后期规模起来再评估 |
| **全桌面 GUI 控制**（OS 级鼠标键盘注入、多窗口）| 超出 MVP 和 P3 范围，等浏览器 computer-use 跑稳后再做；OSWorld 桌面能力需要独立 VDI/VM 基础设施 |
| **Prompt Injection 根本性防御** | 业界承认"无法彻底解决"（OpenAI 公开声明），推迟自研专项防御机制；现阶段以 HITL + 沙箱隔离 + 域名白名单 + 凭证代理控制爆炸半径 |

---

## 七、MVP 最小依赖集（阶段一：Web + 写代码）

**computer-use 是 P3 阶段能力，不在阶段一 MVP 关键路径。** 阶段一只需预留接口，不引入任何 computer-use 库：

| 是否 MVP 必需 | 组件 | 原因 |
|---|---|---|
| **否（预留）** | Stagehand v3 | computer-use P3 阶段才引入 |
| **否（预留）** | Browserbase SDK | 同上 |
| **否（预留）** | playwright-mcp | 同上（但 `playwright` 本身写代码沙箱可能已用到） |
| **否（推迟）** | OmniParser v2 | 视觉兜底，P3 阶段视觉路径才需要 |
| **否（推迟）** | Claude computer-use beta | P3 阶段引入 |
| **否（推迟）** | Gemini 2.5 Computer Use | P3 阶段备选 |

**阶段一真正需要的 computer-use 相关最少件**：

```
1. playwright（dev dependency）
   - 仅用于写代码能力的沙箱内自动化测试运行（不是 computer-use 用途）
   - npm install playwright --save-dev
   - Apache-2.0，拿来即用

2. 架构层预留：SandboxService ABC 的命名端口约定
   - 参考 OpenHands 设计，预留 AGENT_SERVER / BROWSER / WORKER 端口槽位
   - 这是「自研接缝」设计决策，非第三方库
```

**P3 阶段（computer-use 能力上线时）才引入的最小件**：

```
@browserbasehq/stagehand   MIT    浏览器自动化主路径
@browserbasehq/sdk          MIT    云浏览器隔离 harness（opt-in SaaS）
@playwright/mcp             Apache-2.0  MCP 工具路径（token 优化备选）
@anthropic-ai/sdk           商业    已在内核 provider 层，加 computer-use-2025-11-24 beta header
```

> **OmniParser v2 不在 P3 最小集**：只有当 AX tree + DOM 路径覆盖不了的站点占比高到影响产品时，才引入视觉 grounding（需要 Python sidecar，成本最高）。

---

## 八、风险优先级汇总

| 风险 | 等级 | 缓解 |
|---|---|---|
| Prompt injection 无法根除 | 🔴 高 | 沙箱内零凭证 + 凭证代理签名放行 + HITL 高危确认 + 域名白名单（纵深防御，接受残余风险）|
| Claude computer-use beta 接口迭代 | 🟡 中 | 版本兼容封装层，关注 anthropic-beta release notes |
| Stagehand v3 driver 适配不稳 | 🟡 中 | 保留直接 Playwright fallback；定期 bump 版本 |
| Browserbase SaaS 数据驻留 | 🟡 中 | 定义为 opt-in，提供本地 Playwright 默认路径；文档化数据流 |
| OmniParser 无 TS SDK（Python sidecar） | 🟡 中 | 仅兜底路径，晚于 AX tree 引入；先评估 ONNX 导出可行性 |
| 截图流与 SSE 混合（原蓝图反面教材） | 🔴 高 | 强制纪律：截图走独立 WS/WebRTC 通道（ARCHITECTURE_BLUEPRINT §5.2 已定案） |