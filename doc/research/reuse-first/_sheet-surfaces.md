现在我有了足够的信息来产出完整的选型清单。

---

# arclightagent 各端表层壳与 SDK 拿来即用选型清单

> 范围：Web / CLI / 桌面 / VSCode / Chrome 五端表层壳及其直接依赖。沙箱子系统（nono/E2B/Pyodide/Docker）已定案，本文不重复。内核（@arclight/core：Bun + Hono headless agent server）已定案，本文只讲"壳"。

---

## 一、Web 端（P0 MVP）

### 1.1 前端框架：Next.js (App Router)

| 项 | 内容 |
|---|---|
| **直接采用** | `next` (npm, MIT) — App Router + SSR/SSG + PWA 支持；自带 API Routes 可与 Hono 内核 proxy 协作 |
| **集成成本** | 拿来即用 |
| **成熟度** | 生产可用（极成熟，v14/15）|
| **来源复用** | opencode 用 SolidStart，但主蓝图明确选 Next.js（生态/招聘/assistant-ui 原生适配）；仅借**设计**，不搬 SolidStart 代码 |
| **自研接缝** | 仅需写 `app/` 路由层 + C1/C2 通道 proxy 配置；业务逻辑零进前端框架 |

### 1.2 AI 聊天 UI：assistant-ui

| 项 | 内容 |
|---|---|
| **直接采用** | `@assistant-ui/react` (npm, MIT) — Radix 风格可组合 primitives；自带流式滚动/重试/附件/markdown/代码高亮/语音/无障碍；`LocalRuntime` + `ExternalStoreRuntime` 两种运行时；AI SDK 适配器、LangGraph 适配器、`AssistantTransport` 可流式全量 agent 状态快照 |
| **集成成本** | 轻度封装（接内核 SSE 事件流，写一个 `ArcTransport` 适配器，约 100-200 行） |
| **成熟度** | 生产可用（Thoughtworks 雷达收录，50k+/月下载）|
| **坑** | `ExternalStoreRuntime` 需自建 store 接 `ArcEvent` reducer，非开箱即用；但这是"接缝"而非重造 |
| **来源** | topic-web-first-arch.json；`https://www.assistant-ui.com/` |
| **自研接缝** | 写 `ArcTransport`（适配 `ArcEvent` 到 assistant-ui 的 message 格式）；约 1-2 天 |

### 1.3 AI 流式层：Vercel AI SDK v5

| 项 | 内容 |
|---|---|
| **直接采用** | `ai`（npm，Apache-2.0）— `useChat` / `useUIMessageStream`；前端 hook 直接消费内核 SSE；`resume` 选项支持断线重连 |
| **集成成本** | 拿来即用（useChat 直连内核 `/api/chat` SSE 端点）|
| **成熟度** | 生产可用（生态最大，与 assistant-ui 联用是标准组合）|
| **坑** | AI SDK v5 于 2025-07 发布，v4→v5 有 breaking changes；主蓝图写"v6"，以实际最新稳定版为准，留意 breaking changes 跟进节奏 |
| **自研接缝** | 内核 Hono 侧实现标准 AI SDK Data Stream Protocol（`data:` 前缀格式）即可无缝对接 `useChat`；约半天 |

### 1.4 PWA / 移动安装：@serwist/next

| 项 | 内容 |
|---|---|
| **直接采用** | `@serwist/next` (npm, MIT) — Next.js PWA 集成；Service Worker 离线缓存 + Web Push + Manifest 桌面安装 |
| **集成成本** | 拿来即用（`withSerwist()` 包裹 next.config）|
| **成熟度** | 生产可用（next-pwa 精神续作）|
| **自研接缝** | Web Push VAPID 密钥生成一次存 keychain；通知投递逻辑约半天 |

### 1.5 断线流恢复（阶段二，非 MVP）

| 项 | 内容 |
|---|---|
| **直接采用（后置）** | `vercel/resumable-stream` (npm, MIT) + Redis；`@durable-streams/aisdk-transport`（可选）|
| **集成成本** | 需较多缝合（引入 Redis、GET /api/chat/[id]/stream 端点、epoch 书签机制）|
| **成熟度** | 新兴，2025 下半年成形，API 仍在演进 |
| **现在不要做** | MVP 只做「刷新不丢」最朴素版（服务端 in-memory buffer + 重连续推），durable 后置阶段二 |

---

## 二、CLI 端（P2）

### 2.1 TUI 框架：OpenTUI

| 项 | 内容 |
|---|---|
| **直接采用** | `opentui` (npm, MIT) — SolidJS reconciler 驱动的终端 UI 框架；支持 React-like 组件、diff 渲染、彩色/布局 |
| **集成成本** | 轻度封装（从 opencode/cline 均已验证生产可用）|
| **成熟度** | 生产可用（opencode TUI 端 + cline CLI TUI 都在用；开源仓 https://github.com/nicholasgasior/opentui）|
| **坑** | 生态较小，若遇到 OpenTUI 不支持的终端特性需自行 patch；文档不如 ink 完整 |
| **备选** | `ink`（npm, MIT，React for terminals）— gemini-cli 在用，更广泛，但 React 组件模型与 Web 端有更好的心智共享；若团队更熟 React 生态可换 ink |
| **来源** | opencode repo-json + cline repo-json；两仓均在生产用 OpenTUI |
| **可直接复用代码** | opencode `packages/tui/` 中 SolidJS 组件（MIT 许可），可搬 session/home/sidebar 等 UI 组件逻辑；**需替换 Effect/SolidStart 依赖为自研内核 client** |
| **自研接缝** | CLI 入口 + `ArcCommand`/`ArcEvent` stdio JSONL 编解码器；约 2-3 天 |

### 2.2 CLI 参数解析 + 交互提示

| 项 | 内容 |
|---|---|
| **直接采用** | `commander` (npm, MIT) — 命令行参数解析；成熟无风险 |
| **直接采用** | `@clack/prompts` (npm, MIT) — 交互式 CLI 提示（spinner/select/confirm）；现代感强，轻量 |
| **集成成本** | 拿来即用 |
| **成熟度** | 生产可用（均是行业标准库）|
| **自研接缝** | 无 |

### 2.3 单二进制分发：Bun --compile

| 项 | 内容 |
|---|---|
| **直接采用** | Bun v1.x `--compile --bytecode --target bun-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64}` — 内置运行时 + 所有依赖打包为单文件；Anthropic 用此分发 Claude Code |
| **集成成本** | 拿来即用（一条命令，CI matrix 五平台）|
| **成熟度** | 生产可用（Bun v1.x 稳定）|
| **坑** | Windows 图标/元数据标志需在 Windows runner 上运行；macOS 公证（notarize）需 Apple Developer 账户 + Gatekeeper 流程；跨平台 CI matrix 要准备三种 runner |
| **来源** | topic-cross-platform.json |
| **自研接缝** | `install.sh` 一键脚本（约 30 行 bash）；GitHub Releases 矩阵 workflow |

### 2.4 arg0 multicall（借 codex 思路，仅设计）

| 项 | 内容 |
|---|---|
| **来源** | `google-gemini/gemini-cli` (Apache-2.0) / codex 架构思路 |
| **复用性质** | **仅借设计**，不搬代码（gemini-cli 用 esbuild + Node SEA，我们用 Bun --compile）；实现极简（读 `process.argv[0]` 判断二进制名称，约 20 行）|
| **自研接缝** | 实现一个 `detectPersonality()` 函数（20 行），一个二进制通过 symlink 多名称 = 多形态（serve/agent/shell）|

---

## 三、桌面端（P3，先 PWA 过渡）

### 3.1 桌面壳：Tauri 2.0

| 项 | 内容 |
|---|---|
| **直接采用** | `@tauri-apps/cli` + `@tauri-apps/api` (npm, MIT/Apache-2.0) — Rust 核心 + 系统原生 WebView；包体 ~12MB；覆盖 macOS/Windows/Linux |
| **集成成本** | 需较多缝合（需安装 Rust 工具链；WebView 渲染复用 Next.js 同一 build 产物；sidecar 启动 + `server.json` 握手；iOS/Android 插件生态不全需额外 Swift/Kotlin 桥）|
| **成熟度** | 生产可用（v2.x GA，2024.10 发布，GitHub 87k+ stars）|
| **坑** | macOS WKWebView / Windows WebView2 / Linux WebKit2GTK CSS 兼容性差异，需三平台 CI 截图对比；Linux GTK 版本偏旧可能 flex/grid 行为不一致；Tauri 2.0 官方明确移动端非"first-class citizen"，iOS/Android 插件生态仍不全 |
| **直接采用的插件** | `tauri-plugin-store`（持久化）、`tauri-plugin-shell`（spawn 内核 sidecar）、`tauri-plugin-notification`（桌面通知）、`tauri-plugin-updater`（自动更新）— 全部官方 MIT/Apache-2.0 |
| **前端复用** | 直接加载同一套 Next.js/React 前端构建产物，零 UI 重写 |
| **来源** | topic-cross-platform.json；`https://v2.tauri.app/` |
| **自研接缝** | `src-tauri/src/sidecar.rs`（spawn 内核 + 读 `server.json`）；Tauri → Web 通道只传 `{port, token}`，业务走 loopback HTTP；约 3-5 天 Rust 接缝 |

### 3.2 移动端（探索性附录，非主交付）

| 项 | 内容 |
|---|---|
| **PWA 首选** | `@serwist/next`（已含，§1.4）+ Web Push — 覆盖约 80% 移动需求；零额外打包 |
| **Capacitor 次选（若 iOS 推送不达标）** | `@capacitor/core` + `@capacitor/push-notifications` (npm, MIT) — 最薄 WebView 壳，直接复用 Next.js 前端，原生推送插件成熟 |
| **Tauri 2 移动：排最后或不做** | 移动插件生态不全、部分需自写 Swift/Kotlin 桥；FULL_PLATFORM_DESIGN.md 已明确降格 |
| **现在不要做** | 移动端不计入五端主交付，不进 MVP |

---

## 四、VSCode 插件端（P3）

### 4.1 扩展框架：VSCode Extension API

| 项 | 内容 |
|---|---|
| **直接采用** | VS Code Extension API（无 npm，直接使用 `vscode` 模块）— 免费、官方、生产可用 |
| **集成成本** | 轻度封装（主逻辑在内核，扩展只做 C1/C2 通道接驳 + Webview 渲染）|
| **成熟度** | 生产可用（极成熟）|
| **来源** | topic-cross-platform.json；`https://code.visualstudio.com/api/` |

### 4.2 Chat Participants API + Language Model API

| 项 | 内容 |
|---|---|
| **直接采用** | `vscode.lm` 命名空间（Language Model API，GA）+ Chat Participants API — 允许扩展接入 Copilot Chat、复用用户 Copilot 订阅的模型调用额度 |
| **集成成本** | 轻度封装（注册 `@arclight` participant，实现 `handler(request, context, stream, token)` 约 50 行）|
| **成熟度** | Language Model API GA；Chat Participants 生产可用 |
| **坑（硬依赖，主蓝图已标注）** | 使用 Chat Participants = 模型路由权交给用户 Copilot 订阅，内核的 provider 中立/ThinkingLevel/provider 缓存优化全部失控；这是"主场"能力与架构控制权的二选一。需在插件说明中明确告知用户 |
| **自研接缝** | Chat Participant handler 桥接到内核 C1 POST；约 1 天 |

### 4.3 MCP in VSCode（VSCode 1.102+）

| 项 | 内容 |
|---|---|
| **直接采用** | VSCode 1.102 内置完整 MCP spec 支持（tools/prompts/resources/sampling/authorization）— 扩展可将内核注册为 MCP server，或直接由 VSCode 消费外部 MCP server |
| **集成成本** | 拿来即用（在 `package.json` 的 `contributes.mcpServers` 声明内核地址）|
| **成熟度** | 生产可用（GA，2025.07）|
| **自研接缝** | 内核需实现 `--stdio` MCP server 暴露模式；约半天（MCP SDK 已有标准实现）|

### 4.4 Webview UI 复用

| 项 | 内容 |
|---|---|
| **方案** | 扩展 Webview 直接加载同一套 Next.js/React 前端构建产物（Static Export）；`postMessage` 做 C1/C2 通道桥接 |
| **可直接复用代码（仅借设计）** | cline `WebviewProvider` 的 `postMessage` 类型 envelope 模式（Apache-2.0，**可搬**）；但 cline 的 gRPC-over-postMessage 对 MVP 偏重，直接用简化版 typed `postMessage` 即可 |
| **集成成本** | 轻度封装 |
| **成熟度** | 成熟（cline/opencode 均已验证）|
| **自研接缝** | `ArcHostBridge`（约 80 行）：把 `postMessage` C1/C2 帧转成内核 HTTP/SSE 调用 |

---

## 五、Chrome 扩展端（P4，MV3）

### 5.1 扩展开发框架：wxt

| 项 | 内容 |
|---|---|
| **直接采用** | `wxt` (npm, MIT) — MV3 优先的 Chrome/Firefox/Edge 扩展开发框架；Vite 驱动、HMR、自动 manifest 生成、TypeScript 原生；比 Plasmo 更轻量且更 MV3 友好 |
| **集成成本** | 拿来即用（`wxt init` 生成骨架，配置 `entrypoints/`）|
| **成熟度** | 生产可用（`https://wxt.dev/`，活跃维护）|
| **备选** | `plasmo` (npm, MIT) — 另一个 MV3 框架，功能更多但更重；wxt 更适合本项目轻量原则 |
| **来源** | topic-cross-platform.json |

### 5.2 Side Panel UI

| 项 | 内容 |
|---|---|
| **直接采用** | Chrome Side Panel API（`chrome.sidePanel`，MV3 内置）— 比 popup 更适合 Agent 交互（常驻、可调大小）；复用同一套 React/assistant-ui 前端组件 |
| **集成成本** | 拿来即用（在 manifest 声明 `side_panel`）|
| **成熟度** | 生产可用（Chrome 114+）|

### 5.3 Service Worker 通信层

| 项 | 内容 |
|---|---|
| **直接采用** | Chrome Extension Messaging API（`chrome.runtime.sendMessage` / `chrome.runtime.connect`）+ WebSocket 持 C1+C2 通道（SW 无状态可重启，WS 比 SSE 在 SW 下更稳）|
| **集成成本** | 需较多缝合（SW 30s 休眠/重启机制、WS 重连逻辑、`ArcCommand`/`ArcAck` 关联协议、pairing code 连本地内核）|
| **成熟度** | 生产可用，但 MV3 SW 的 30s 限制是已知坑 |
| **坑** | MV3 service worker 30s 无活动即休眠，不可维持传统持久连接；规避：用 `chrome.alarms` 定期唤醒 + WS keepalive ping；长任务需设计好状态持久化恢复机制 |
| **自研接缝** | `background/sw.ts`（约 150 行）：WS 连接管理 + 重连 + pairing code 握手 + `ArcCommand`/`ArcAck` 协议 |

### 5.4 Content Script

| 项 | 内容 |
|---|---|
| **直接采用** | Chrome Content Script（MV3 内置）— DOM/AX 操作、页面上下文注入、computer-use 就地操控 |
| **集成成本** | 拿来即用（wxt `entrypoints/content.ts`）|
| **成熟度** | 生产可用 |
| **安全警告（主蓝图 §4.6/§5.7）** | Chrome 扩展 content script 操控用户真实已登录会话，使"沙箱内零凭证"硬边界失效；computer-use 时凭证隔离需额外设计（操作发生在用户浏览器上下文而非沙箱内），这是 Chrome 扩展端的根本性安全约束 |

---

## 六、MCP 协议层（各端共享）

### 6.1 MCP SDK

| 项 | 内容 |
|---|---|
| **直接采用** | `@modelcontextprotocol/sdk` (npm, MIT) — 官方 TS SDK；tools/prompts/resources/sampling/authorization 全实现；stdio + Streamable HTTP 双传输；周下载量超 2000 万 |
| **集成成本** | 拿来即用（内核同时作 MCP server + MCP client）|
| **成熟度** | 生产可用（快速演进中）|
| **坑** | prompt injection / tool poisoning 安全问题已有学术记录（MCPSecBench, arXiv 2025）；对外暴露 MCP server 时务必实现 OAuth 鉴权 + tool 调用权限范围隔离 |
| **自研接缝** | 内核 `--stdio` MCP server 暴露逻辑；`MCP Hub` 连接外部 MCP servers；约 1-2 天（SDK 已有样板代码）|

---

## 七、各端借鉴开源仓说明（复用性质明确区分）

| 仓库 | 许可证 | 可直接复用代码 | 仅借设计 |
|---|---|---|---|
| `anomalyco/opencode` (opencode) | **MIT** | `packages/tui/` SolidJS TUI 组件（需替换 Effect/SolidStart 依赖）；`packages/server/src/api.ts` HttpApi 结构思路可搬 TS 类型（MIT 无限制） | server/client 分离骨架（设计蓝本）；Context Epoch；durable 输入模型 |
| `cline/cline` | **Apache-2.0** | `WebviewProvider` postMessage envelope 模式（Apache-2.0 可搬，需保留 NOTICE）；`StateManager` 文件持久化模式 | gRPC-over-postMessage 设计；HostProvider DI 模式；shadow git 检查点设计 |
| `google-gemini/gemini-cli` | **Apache-2.0** | `packages/core/src/hooks/hookSystem.ts` HookSystem AOP 模式（Apache-2.0 可搬，需 NOTICE）；`ThemeManager` 语义 token 体系 | arg0 multicall 思路；AsyncGenerator 事件总线设计；JSONL 会话持久化模式 |

**Apache-2.0 合规要求：** 搬 cline/gemini-cli 代码时必须保留原始 copyright header、在项目 NOTICE 文件中 attribution；不可将其声明为自研原创。

---

## 八、现在不要自研、推迟到产品成熟后

| 推迟项 | 理由 | 时机 |
|---|---|---|
| `@arclight/llm` 独立 LLM 路由包（opencode 路线） | MVP 有 AI SDK + LiteLLM Proxy 已够；独立包是"第五端 + 多 provider 缓存策略"才需要的基建 | 阶段五，多端 + provider 策略需求成形后 |
| AG-UI 协议适配器 | 新兴协议，部分框架适配仍 in-progress；MVP 单 Web 端共享 TS 类型足够；AG-UI 增加协议层复杂度 | 阶段五，确有多框架对接需求时 |
| OpenAPI → TS SDK 自动生成 | MVP 只有 Web 一端，零 codegen 收益；有第二端时再上，且注意 OpenAPI 对 SSE 表达力弱需自定义 codegen | 阶段二 CLI spike 完成后 |
| Resumable/Durable Streams（Redis + vercel/resumable-stream） | MVP 朴素版「刷新不丢」（in-memory buffer + 重连续推）可接受；durable 是高 bug 密度特性，后置 UX 验证之后 | 阶段二 UX 验证后 |
| Tauri 2 iOS/Android 移动端 | 主蓝图已明确降格；PWA + Capacitor 覆盖绝大部分移动需求，Tauri 移动插件生态不全 | 探索性附录，另行决策 |
| Chrome Prompt API（Gemini Nano on-device） | 仍在 Origin Trial（Chrome 131-136），不可正式上架 Chrome Web Store | Prompt API 正式 GA 后 |
| CopilotKit / CoAgents | 引入第三方 Copilot Runtime 中间层，与自研 headless 内核架构相冲；AG-UI 制定方但不代表强依赖 | 非计划 |
| 自研桌面 TUI 主题引擎 | gemini-cli ThemeManager（Apache-2.0）可直接搬；即便不搬，`@clack/prompts` 的风格已足够 MVP | 产品成熟后如有品牌定制需求 |
| VSCode gRPC-over-postMessage（cline 路线） | cline 的 protobuf + buf 生成流程重，且有"静默回退到 Anthropic"的高熵错误风险；MVP 用简化版 typed postMessage 足够 | 扩展通信量级真正成为瓶颈时 |

---

## 九、MVP 最小依赖集（阶段一：Web 单端 + 写代码单能力）

以下是阶段一真正需要安装的最少现成件，其余全部后置：

```
# 前端（Next.js App Router）
next                          # MIT — 前端框架
react react-dom               # MIT — UI 运行时
@assistant-ui/react           # MIT — 聊天 UI primitives（接 ArcTransport）
ai                            # Apache-2.0 — Vercel AI SDK，useChat + 流式
@serwist/next                 # MIT — PWA（可在 MVP 末期加，零成本）
tailwindcss                   # MIT — 样式（可选，但强烈推荐）

# 内核（Bun + Hono headless server）
hono                          # MIT — 内核 HTTP 框架
@modelcontextprotocol/sdk     # MIT — MCP client（消费外部工具）+ server（暴露内核）
drizzle-orm better-sqlite3    # MIT — 本地 SQLite ORM
zod                           # MIT — 运行时 schema 校验

# 分发
bun --compile（内置，无需 npm 包）

# 总计：约 7-8 个直接依赖，无运行时 Rust/Python 进程侵入内核
```

**不在 MVP 依赖集中（明确排除）：**
- `langchain` / `langgraph` / `mastra` — 引入过重框架；MVP 自研最小 async-generator 主循环（约 200-400 行，参考 opencode `llm.ts` 设计）
- `opentui` / `ink` / `commander` — CLI 端是阶段二
- `@tauri-apps/*` — 桌面端是阶段三
- `wxt` / `plasmo` — Chrome 扩展是阶段四
- `vercel/resumable-stream` / `redis` — durable 流后置
- `mem0` / `zep` — archival 记忆后置