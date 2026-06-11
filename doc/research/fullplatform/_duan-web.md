Hi Alba，以下为 Web 网页端（先发/P0）详细设计。

---

# Web 网页端（先发/P0）详细设计

> 版本基准：`ARCHITECTURE_BLUEPRINT.md` 主蓝图 + 地基1/2/3 契约。  
> Web 是全平台**参照实现端**：内核契约先在此打通，其他端复用。

---

## 1. 组件级架构

### 1.1 总体分层

```
┌─────────────────────────────────────────────────────────────────────────┐
│  浏览器（Browser）                                                        │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  Next.js App Router (RSC + Client Components)                       │ │
│  │                                                                     │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │ │
│  │  │  Route层(RSC)│  │  Page层(RSC) │  │  Layout / Shell (RSC)    │  │ │
│  │  │  /app/...    │  │  SSR首屏骨架 │  │  Sidebar/Nav/Auth guard  │  │ │
│  │  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │ │
│  │         │                 │                        │                │ │
│  │  ┌──────▼─────────────────▼────────────────────────▼─────────────┐ │ │
│  │  │              Client Components（'use client'）                  │ │ │
│  │  │                                                                 │ │ │
│  │  │  ┌─────────────────┐  ┌──────────────────────────────────────┐ │ │ │
│  │  │  │  ChatShell       │  │  CapabilityPanel                     │ │ │ │
│  │  │  │  ┌────────────┐  │  │  ┌────────────┐ ┌────────────────┐  │ │ │ │
│  │  │  │  │ MessageList│  │  │  │ CodeEditor │ │ ResearchPanel  │  │ │ │ │
│  │  │  │  │ (虚拟滚动) │  │  │  │(Monaco diff│ │(进度+引用溯源) │  │ │ │ │
│  │  │  │  └────────────┘  │  │  └────────────┘ └────────────────┘  │ │ │ │
│  │  │  │  ┌────────────┐  │  │  ┌────────────┐ ┌────────────────┐  │ │ │ │
│  │  │  │  │ ToolCards  │  │  │  │ WritingFlow│ │ ComputerUse    │  │ │ │ │
│  │  │  │  │(工具进度卡) │  │  │  │(章节流式)  │ │(截图帧+HITL)   │  │ │ │ │
│  │  │  │  └────────────┘  │  │  └────────────┘ └────────────────┘  │ │ │ │
│  │  │  │  ┌────────────┐  │  └──────────────────────────────────────┘ │ │ │
│  │  │  │  │ InputBar   │  │                                           │ │ │
│  │  │  │  │(文本+文件) │  │  ┌──────────────────────────────────────┐ │ │ │
│  │  │  │  └────────────┘  │  │  PermissionModal (权限/HITL 弹层)     │ │ │ │
│  │  │  └─────────────────┘  └──────────────────────────────────────┘ │ │ │
│  │  │                                                                 │ │ │
│  │  │  ┌─────────────────────────────────────────────────────────┐   │ │ │
│  │  │  │  @arclight/client-core（纯 TS，端无关共享包）            │   │ │ │
│  │  │  │  ├── EventStreamManager（SSE 连接 + 重连 + 去重）        │   │ │ │
│  │  │  │  ├── SessionReducer（ArcEvent → UI state）               │   │ │ │
│  │  │  │  ├── CommandClient（C1 HTTP POST 封装）                   │   │ │ │
│  │  │  │  └── EpochTracker（乐观锁 epoch + StaleEpochError 处理）  │   │ │ │
│  │  │  └─────────────────────────────────────────────────────────┘   │ │ │
│  │  │                                                                 │ │ │
│  │  │  ┌─────────────────────────────────────────────────────────┐   │ │ │
│  │  │  │  assistant-ui（无头流式 UI 组件，Apache-2.0）             │   │ │ │
│  │  │  │  消费 SessionReducer 的 threadStore，纯渲染层             │   │ │ │
│  │  │  └─────────────────────────────────────────────────────────┘   │ │ │
│  │  └─────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                     │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │ │
│  │  │  PWA Service Worker（@serwist/next）                            │ │ │
│  │  │  ├── 静态资产缓存（precache）                                   │ │ │
│  │  │  ├── API 请求：仅 GET 只读端点 network-first 缓存              │ │ │
│  │  │  ├── 离线只读降级（POST 排队，联网后用 epoch 重放）             │ │ │
│  │  │  └── Web Push 接收（`push` event → 系统通知）                  │ │ │
│  │  └─────────────────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
         │ C1 HTTP POST (命令)        │ C4 独立 WS/WebRTC (截图帧)
         │ C2 SSE (事件流)            │ C3 WS (按需，实时面)
         ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  @arclight/core  (headless agent server, Bun + Hono)                    │
│                                                                           │
│  Hono Router  →  Auth Middleware  →  Session/Tool/Agent 主循环           │
│  async-generator event source  →  SSE endpoint  →  二进制媒体端点        │
│  SQLite(本地) / Postgres(远程)  ·  keychain/KMS 凭证代理                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Next.js App Router 目录结构

```
apps/web/
├── app/
│   ├── layout.tsx               # Shell：AuthGuard + ThemeProvider（RSC）
│   ├── page.tsx                 # 首页（RSC，SSR 骨架 + hydration）
│   ├── (auth)/
│   │   ├── login/page.tsx       # OAuth 重定向发起 / 设备码展示
│   │   └── callback/route.ts    # OAuth 回调处理（Route Handler）
│   ├── sessions/
│   │   ├── page.tsx             # 会话列表（RSC，初始数据服务端拉取）
│   │   └── [id]/
│   │       ├── page.tsx         # 会话详情骨架（RSC，注入 sessionId）
│   │       └── ChatShell.tsx    # 实时订阅（'use client'）
│   └── api/                     # Next.js Route Handlers（仅薄代理）
│       ├── auth/[...nextauth]/  # Auth.js 适配器（远程托管模式）
│       └── proxy/               # CSP-safe 代理（仅本地开发/可选）
│
├── components/
│   ├── chat/                    # ChatShell, MessageList, InputBar, ToolCards
│   ├── capability/              # CodeEditor, ResearchPanel, WritingFlow, ComputerUse
│   ├── permission/              # PermissionModal, HitlConfirm
│   └── common/                  # VirtualScroller, SpillViewer, EpochBadge
│
├── lib/
│   ├── arc-client.ts            # 封装 @arclight/client-core，注入 baseURL + token
│   └── pwa-push.ts              # Web Push 订阅注册工具
│
└── public/
    ├── manifest.webmanifest     # PWA 清单
    └── sw.js                    # 由 @serwist/next build 生成
```

### 1.3 C1/C2/C3/C4 连接细节

```
┌──────────────────────────────────────────────────────────────────────┐
│  EventStreamManager（@arclight/client-core）                          │
│                                                                      │
│  1. 创建 EventSource('/v1/sessions/:id/events')                      │
│     携带 Last-Event-ID: <lastSeq>（断点续传）                         │
│                                                                      │
│  2. onmessage → 解析 ArcEvent（按 seq 单调去重）                      │
│     → dispatch 到 SessionReducer                                     │
│                                                                      │
│  3. 重连策略：exponential backoff，250ms → 500ms → 2s → 30s cap      │
│     onerror 时带 Last-Event-ID 重连，服务端 replay > lastSeq 的帧     │
│                                                                      │
│  4. 心跳检测：内核每 20s 发 comment `: ping`                         │
│     前端计时器 40s 无帧 → 主动关闭重连                                │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  CommandClient（C1）                                                  │
│                                                                      │
│  POST /v1/sessions          → 建立会话                               │
│  POST /v1/sessions/:id/turns → 提交用户输入（携带 epoch）            │
│  POST /v1/sessions/:id/interrupt → 中断                              │
│  POST /v1/sessions/:id/permission → 权限审批回传                     │
│  POST /v1/sessions/:id/capabilities → 声明本端 CapabilityProfile    │
│  GET  /v1/outputs/:spillRef  → 拉取超限工具输出完整内容              │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  C4 媒体面（computer-use，按需建立）                                   │
│                                                                      │
│  独立 WebSocket：ws(s)://<core>/v1/sessions/:id/media                │
│  帧格式：binary（JPEG/WebP + 帧差增量）或 CDP/VNC 远程渲染协议        │
│  ComputerUse 组件订阅此 WS，渲染截图流，HITL 确认走 C1 回传          │
│  绝不复用 C2 SSE 连接（主蓝图 §5.2/M1 硬约束）                       │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.4 SessionReducer 状态机（client-core）

```
ArcEvent 流
    │
    ▼
┌────────────────────────────────────────────────────────────────────┐
│  SessionReducer                                                     │
│                                                                     │
│  state: {                                                           │
│    messages: Message[]         // turn 级消息列表                   │
│    activeTurn: Turn | null     // 当前 streaming turn               │
│    tools: Map<callId, ToolState>  // 工具进度 / 输出                │
│    epoch: number               // 乐观锁 epoch                      │
│    pendingPermission: PermissionAsk | null                          │
│    subagents: Map<agentId, SubagentState>  // 子代理状态（后置）    │
│    connectionStatus: 'connected'|'reconnecting'|'offline'           │
│  }                                                                  │
│                                                                     │
│  事件映射（16ms 帧 coalescing 批量 dispatch）：                      │
│  'message.delta'     → 追加 activeTurn.text（流式渲染）             │
│  'tool.requested'    → tools.set(callId, {status:'pending',...})   │
│  'tool.progress'     → tools.get(callId).pct / note 更新           │
│  'tool.output'       → tools.get(callId).output / spillRef         │
│  'context.compacted' → epoch = event.epoch（epoch 单调递增）        │
│  'permission.ask'    → pendingPermission = event（弹 Modal）        │
│  'turn.completed'    → activeTurn → messages push，清 activeTurn   │
│  'interrupted'       → activeTurn 标记中断                         │
│  'session.error'     → 展示 5-key envelope 错误（不泄 traceback）  │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. 技术选型与关键依赖

| 层 | 选型 | 版本锚 | 许可证 | 理由 |
|---|---|---|---|---|
| **框架** | Next.js App Router | 15.x（stable） | MIT | SSR 首屏 + RSC + Route Handlers；主蓝图指定 |
| **AI 流式** | Vercel AI SDK v6（`ai` 包） | 4.x → 5.x（按路线图） | Apache-2.0 | `useChat`/`experimental_useObject` 流式客户端；底层 DataStream 对齐 SSE；主蓝图 §4.1 指定 |
| **无头聊天 UI** | `assistant-ui` | latest | MIT | 纯渲染层，消费 threadStore；无头设计不绑架内核语义；主蓝图 §4.1 |
| **代码编辑器** | Monaco Editor（`@monaco-editor/react`） | latest | MIT | 写代码能力 diff 视图；WebWorker 模式不阻塞主线程 |
| **Markdown 渲染** | `marked` + `shiki` | latest | MIT | 写文章章节流式渲染；shiki WASM 轻量 |
| **样式** | Tailwind CSS v4 + `shadcn/ui` | latest | MIT | 主蓝图 §4.1；shadcn 无运行时，组件可控 |
| **状态管理** | Zustand（会话 store） + RSC server state | latest | MIT | 轻量，与 reducer 直连；避免引 Redux 全家桶 |
| **PWA** | `@serwist/next` | latest | MIT | 继承 Workbox，Next.js App Router 官方推荐路径 |
| **Web Push** | VAPID（服务端 `web-push` 库） | latest | MIT | 日常规划主动提醒 |
| **虚拟滚动** | `@tanstack/react-virtual` | latest | MIT | MessageList 超长会话不 OOM |
| **鉴权** | Auth.js（自托管远程模式） / localhost 信任（本地单用户） | Auth.js v5 | ISC | 主蓝图 §5.5；Auth.js v5 支持 App Router Route Handler |
| **HTTP 客户端** | 原生 `fetch`（C1 命令面） | 平台内置 | — | 无额外依赖；EventSource API 处理 C2 SSE |
| **共享类型包** | `@arclight/protocol`（monorepo 内） | MVP 锁 v1 | 同主项目 | MVP 零 codegen，内核与 Web 端共享同一 TS 类型 |
| **共享逻辑包** | `@arclight/client-core`（monorepo 内） | — | 同主项目 | EventStreamManager / SessionReducer / CommandClient / EpochTracker |

**刻意不引入的依赖（与主蓝图一致）：**
- `effect`（beta，生态风险，主蓝图 §3.2）
- LangChain / LangGraph（主蓝图 M7）
- protobuf / buf（协议不上 protobuf，JSON+TS 类型即可）
- AG-UI 适配器（MVP 后置，主蓝图 §1.4）

---

## 3. 本端承载能力及裁剪/适配

依据地基2"五能力×六端落点矩阵"，Web 端档位如下：

### 3.1 写代码（主场，MVP 必交付）

**完整 UI 链路：**
```
用户输入需求
    → C1 POST /v1/sessions/:id/turns
    → 内核 RepoMap + SEARCH/REPLACE + 反射验证闭环
    → C2 SSE: tool.requested（展示"正在读文件"）
            + message.delta（流式 assistant 消息）
            + tool.output（含 diff 内容 / spillRef）
    → Monaco diff 组件渲染 SEARCH/REPLACE 结果
    → shadow-git 检查点 → 可视化 timeline（/undo 入口）
    → 命名端口 iframe 内嵌沙箱终端（OpenHands AGENT_SERVER/VSCODE/WORKER 约定）
```

**本端特有适配：**
- Monaco diff 视图：接收 `tool.output` 的 diff 内容，按文件分组渲染 unified diff；超限内容（`spillRef`）懒加载 `GET /v1/outputs/:spillRef`。
- iframe 内嵌沙箱终端：命名端口由内核在 CapabilityProfile 协商后下发；iframe `sandbox` 属性按最小权限收窄（`allow-scripts allow-same-origin allow-forms`，禁 `allow-top-navigation`）。
- SSE 16ms 帧 coalescing：`message.delta` 高频，批量收集后统一 `requestAnimationFrame` 更新，防 re-render 风暴。

**裁剪点：** 无（写代码是 Web 主场，能力不裁剪）。

### 3.2 写文章（主场）

**完整 UI 链路：**
```
大纲审批 UI（subtopics → 用户点确认）
    → 章节流式 SSE（message.delta 按章节分段渲染）
    → 引用溯源脚注组件（CitationAgent 输出，可点击展开来源）
    → 文档生成（内核侧 docx/pptx/pdf/latex），前端 `<a download>` 下载
```

**本端特有适配：**
- 分阶段审批 UI（大纲→草稿→精修→引用）：每个阶段对应 `permission.ask` 或显式步骤回传，用户点击"继续"走 C1。
- 章节级流式：`message.delta` 携带章节标记，前端按 `###` 边界分拆渲染，不等全文完成才显示。

**裁剪点：** 无（写文章是 Web 主场）。

### 3.3 调研 Deep Research（主场）

**完整 UI 链路：**
```
规划阶段：subtopics 流式展示 → 用户审批 fan-out 计划
    → SSE: subagent.spawned / subagent.update（并行子代理状态）
    → SSE: tool.progress（检索进度，展示"已搜索 N 个源"）
    → SSE: message.delta（子报告流入）
    → 断点续研：页面重连时 Last-Event-ID 续接
    → 报告页：引用可点击溯源 + 下载 .md/.docx
```

**本端特有适配：**
- 任务持久化：会话 ID 持久到 URL（`/sessions/:id`），刷新即续研（内核保状态，前端重建 SSE 订阅）。
- 子代理可折叠面板（MVP 后置到阶段三，占位组件先行）。
- Web Push 注册：调研发起后提示用户订阅 Push，任务完成时收通知（防用户一直盯着页面）。

**裁剪点：** `subagent.*` 事件 MVP 只显示 loading 占位，完整子代理面板在阶段三。

### 3.4 Computer Use（主场，阶段四）

**Web 端是「云浏览器后端」路径：**
```
用户指令 → C1
    → 内核决策：Stagehand v3 + Browserbase/Steel CDP 后端
    → C4 独立 WS：JPEG/WebP 帧差截图流 → 前端 <canvas> 渲染
    → C2 SSE: tool.requested（高危动作） → PermissionModal 弹出 HITL 确认
    → 用户点"允许" → C1 POST /v1/sessions/:id/permission {decision:'allow'}
    → 内核放行 → 继续执行
```

**本端特有适配：**
- `ComputerUse` 组件：`<canvas>` 接收二进制 WS 帧，`requestAnimationFrame` 渲染，帧差解码在 Web Worker 中执行（不阻塞主线程）。
- `PermissionModal`：高危动作（`risk: 'high'`）强制用户点击，不可键盘误触；低风险动作可配置"本会话默认允许"（走 `scope: 'session'`）。
- 媒体面**严格独立**：C4 WS 与 C2 SSE 不共用 socket，内核侧也用不同 handler 路由，防截图帧打爆 token 流缓冲。

**裁剪点：** MVP 不交付（阶段四），但 `ComputerUse` 组件占位先建，`CapabilityProfile` 中 `screenshot` 字段预留 `'binary-ws'` 枚举值。

### 3.5 日常规划（可用，非主场）

**Web 端能力：**
- 日历视图 + 看板/checklist 完整 UI（RSC 初始数据 + Client 实时更新）。
- Web Push 提醒（VAPID）：用户授权后，内核心跳协调器触发推送，Web Push → Service Worker `push` 事件 → `showNotification`。
- durable session：离线排队的 checklist 操作，重连后按 epoch 重放。

**裁剪点（相对移动/桌面主场）：** 浏览器标签页关闭后无后台常驻，Web Push 依赖浏览器/OS 通知权限（iOS Safari 对 Web Push 支持有限制），通知稳定性弱于移动原生推送。MVP 阶段五才交付。

---

## 4. 鉴权/会话/密钥/离线同步在本端的落地

### 4.1 鉴权登录（两条路径）

**路径 A：自托管单用户（MVP 默认，本地内核）**

```
前端首次访问 /
    → Route Handler /app/layout.tsx 检测 session cookie（httpOnly）
    → cookie 不存在 → 读 NEXT_PUBLIC_CORE_URL（内核地址）
    → 发 GET /v1/auth/ping 带本机 pairing secret（从环境变量注入）
    → 内核验证 → 建立 server-side session → Set-Cookie: arc_session（httpOnly, SameSite=Lax）
    → 前端 JS 不接触任何 token
```

pairing secret 生成：内核首启随机生成 `~/.config/arclightagent/session.key`（0600），Web 部署通过环境变量 `ARC_PAIRING_SECRET` 注入（**不在 `.env` 明文提交**，用 Doppler/1Password Secrets Operator 或 Docker secret）。

**路径 B：自托管远程 / 多租户（P5，Auth.js v5）**

```
前端 → /auth/login → Auth.js 构建 OAuth2.1 + PKCE 授权 URL
    → 浏览器跳转至授权页 → 用户同意 → 回调 /auth/callback/route.ts
    → Route Handler 用 code + PKCE verifier 换 token（server-side，前端不可见）
    → 内核侧保管 refresh token（KMS 信封加密）
    → 回发短效 access token 放 httpOnly Cookie（SameSite=Lax, Secure, 15min TTL）
    → refresh token 旋转：内核静默刷新，前端 401 → 重试即可
```

### 4.2 密钥在本端的存储原则

| 密钥类型 | 存储位置 | 前端 JS 可见性 |
|---|---|---|
| arc session（app-session） | httpOnly Cookie | **不可见** |
| refresh token | 内核侧 KMS | **不可见** |
| provider key（Anthropic/OpenAI…） | 内核侧 keychain/KMS | **不可见** |
| MCP OAuth token（Google 等） | 内核侧凭证代理 | **不可见** |
| Web Push VAPID public key | `NEXT_PUBLIC_VAPID_KEY`（可公开） | 可见，非密 |
| UI 偏好（主题/语言） | `localStorage` | 可见，非密 |

**CSP 硬化（防 XSS 窃 Cookie）：**
```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{nonce}';
  connect-src 'self' wss://<core-host>;
  img-src 'self' blob: data:;
  frame-src 'self' <sandbox-iframe-origin>;
  object-src 'none';
  base-uri 'self';
```

Trusted Types 在支持的浏览器启用（`require-trusted-types-for 'script'`）。

### 4.3 会话连接与断点续传

```
页面加载（RSC）
    → 服务端拉取 session 列表 / 当前 session 骨架（初始数据，无瀑布）
    → hydrate → ChatShell mount
    → EventStreamManager 建立 EventSource（带 Last-Event-ID: 0 或最后 seq）
    → 内核 replay > lastSeq 的帧（短缓冲，主蓝图 §5.2）
    → SessionReducer 重建 UI state（增量合并，不全量替换）

网络断开 / 页面休眠
    → onerror → 250ms backoff 重连
    → 重连成功 → 带 Last-Event-ID 续接，内核 replay 漏帧
    → EpochTracker 对比 epoch：若内核 epoch > 本地 → 发 GET /v1/sessions/:id 拉全量快照（仅在 epoch 跳跃时）
```

### 4.4 离线模式（弱离线）

- **只读快照**：Service Worker precache 最近打开的 session 骨架页面（HTML shell + 静态资产）；离线时展示最后一次加载的消息列表（从 SessionReducer 持久化到 IndexedDB，仅缓存，非权威）。
- **写操作排队**：用户离线时提交的输入（InputBar）存入 IndexedDB 队列；重连后按序重放，每条带当前 epoch；若 `StaleEpochError` 则弹提示让用户确认是否放弃（MVP 不做自动合并，地基3 §3.5 已定）。
- **不提供离线推理**：浏览器内不跑模型，无 WASM LLM（与主蓝图零本端推理逻辑一致）。

---

## 5. 打包/分发/自动更新方案

### 5.1 打包产物

```
next build
    → .next/（RSC server bundle + client bundle）
    → public/sw.js（@serwist/next 生成，含 precache manifest）
    → public/manifest.webmanifest（PWA 清单）
```

**bundle 体积纪律：**
- Monaco Editor 懒加载（`next/dynamic`，写代码能力页面才加载，~2MB gz 后 ~500KB）。
- `shiki` WASM 懒加载。
- `@arclight/client-core` / `@arclight/protocol` 共享包 tree-shaken 后极小（纯 TS，无 runtime）。
- 首屏 Client JS 目标 < 100KB gzipped（Shell + EventStreamManager + Zustand store，不含 Monaco/shiki）。

### 5.2 部署（自托管 / Vercel）

| 部署方式 | 命令 | 适用场景 |
|---|---|---|
| **Vercel（推荐，SaaS 路径）** | `vercel deploy` | Next.js 原生；边缘函数做静态 Route Handler；内核单独部署在 VPS/Fly.io |
| **自托管 Docker** | `docker build` → `node server.js`（next start） | 本地/私有云部署；与内核 sidecar 同机或同 Docker Compose |
| **静态导出（不推荐）** | `next export` | 无 RSC/Route Handler，功能严重受限，不走此路 |

**Vercel 注意事项：** SSE endpoint 在 Vercel Edge Runtime 不支持长连接（Vercel Serverless Function 有 30s / Edge Function 有 25s 超时）。**结论：SSE 端点不能经 Vercel 代理**，必须由前端直连内核（或 Vercel 做纯 WebSocket 代理，走 Pro 计划的 WS 支持）。SaaS 路径下内核独立部署（Fly.io/Railway/自托管 VPS），前端直连内核 `ARC_CORE_URL`。

### 5.3 PWA 安装与更新

**`manifest.webmanifest`（核心字段）：**
```json
{
  "name": "arclightagent",
  "short_name": "Arc Agent",
  "display": "standalone",
  "start_url": "/",
  "theme_color": "#0f0f0f",
  "background_color": "#0f0f0f",
  "icons": [
    {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
    {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"}
  ]
}
```

**Service Worker 更新策略：**
```
新版本部署 → SW precache manifest hash 变更
    → 浏览器检测到新 SW → waitingState
    → 前端 UI 弹 toast："已有新版本，点击更新"
    → 用户点击 → postMessage('SKIP_WAITING') → SW.skipWaiting()
    → clients.claim() → 页面刷新加载新版本
```
不用"静默 `skipWaiting`"（防用户在长任务中被强制刷新丢失状态）。

### 5.4 无商店审核（Web 端最大优势）

Web 端部署**即时生效，零审核周期**，安全关键修复可在分钟级上线。这是将安全逻辑尽量收在内核（可即时更新）而非端壳的核心理由——即便如此，Web 端本身也天然具备快速响应能力，是六端中运维灵活性最高的端。

---

## 6. 本端特有硬约束与坑（诚实披露）

### 6.1 Vercel SSE 超时（最高优先级坑）

**问题：** Vercel Serverless Functions 30s 超时、Edge Functions 25s 超时，与 LLM 长时推理（deep research 3-30min）完全不兼容。`EventSource` 连接到经 Vercel 路由的内核 SSE 端点会在 30s 被强制切断。

**缓解：**
- 前端直连内核（内核独立部署在无超时限制的 VPS/Fly.io），完全绕过 Vercel 函数。
- `ARC_CORE_URL` 配置为内核直连地址，SSE 不经 Next.js Route Handler 代理。
- CORS：内核配置 `Access-Control-Allow-Origin: <web-origin>`（精确匹配，不用 `*`）。

### 6.2 EventSource 无法发送自定义 Header

**问题：** 浏览器原生 `EventSource` 不支持设置 `Authorization` header，只能靠 Cookie 或 URL query param 鉴权。

**缓解：**
- 默认用 httpOnly Cookie（session 鉴权最简路径，同源请求自动携带 `SameSite=Lax`）。
- 跨域场景（前端域 ≠ 内核域）：SSE URL 附 short-lived token query param（`?t=<short-lived-sse-token>`，TTL 60s，一次性，内核侧验证后失效）；不用长效 token 放 URL（防日志泄漏）。
- 备选：用 `fetch` + `ReadableStream` 手工解析 SSE（可设 header），`@arclight/client-core` 预留此路径，默认仍用 `EventSource`（兼容性更好）。

### 6.3 浏览器并发 HTTP/1.1 连接数限制（SSE + 多会话）

**问题：** 同一域名下浏览器 HTTP/1.1 最多 6 个并发连接，每个 SSE 长连占一个，多 session 场景会耗尽。

**缓解：**
- 内核强制使用 **HTTP/2**（单 TCP 多路复用），消除此限制。本地开发可用 `bun --tls`（HTTP/2 需 TLS）或 mkcert 本地证书。
- 前端同一时刻只订阅**一个活跃 session** 的 SSE；切换 session 时先 `EventSource.close()` 再重建。

### 6.4 Monaco Editor 在 iOS Safari 的输入法问题

**问题：** Monaco 在 iOS Safari 上输入法（IME）支持残缺，软键盘体验差，移动端写代码不可用。

**缓解：** Web 端写代码能力在移动浏览器降级为只读 diff 视图（CodeMirror 6 Mobile-friendly 版本），编辑操作提示"请使用桌面端或移动 App"。（地基2 已定移动端写代码为"裁剪"，此坑与结论一致。）

### 6.5 Web Push 在 iOS Safari 的限制

**问题：** iOS Safari 17+ 才支持 Web Push，且**只对已安装到主屏幕的 PWA 有效**（浏览器内打开的网页收不到 Web Push）；部分企业 MDM 会禁用 Web Push。

**缓解：** 日常规划能力的主动提醒在 Web 端标注为"可用非主场"（地基2 结论），Push 注册前提示用户"请将 arclightagent 安装到主屏幕以接收提醒"；未安装则降级为页面内 toast 提醒（需页面开着）。移动端原生推送（APNs/FCM，Tauri 移动端）才是主场。

### 6.6 SSE 重连时的"幻影重复"问题

**问题：** 内核侧短缓冲（主蓝图未定具体缓冲时长），若缓冲已过期，断连后重连收不到漏帧，但 `Last-Event-ID` 仍被发送；内核可能无法 replay，导致消息截断。

**缓解：**
- 内核短缓冲**至少 60s**（默认）；turn 完成时持久化到 DB，超出缓冲期后可从 DB 全量重建 session state（`GET /v1/sessions/:id` 返回完整 transcript）。
- 前端 `EpochTracker`：重连后比较 `epoch`，若 epoch 跳跃（压缩边界），**主动拉全量快照**而非依赖 replay。
- `seq` 单调去重过滤：重复帧静默丢弃（去重纪律，地基1 §2.2）。

### 6.7 worker 线程与 Content Security Policy 冲突

**问题：** Monaco Editor 和 shiki 依赖 Web Worker，Worker 的 `blob:` URL 或 `data:` URL 可能被严格 CSP 拦截。

**缓解：**
- CSP `worker-src 'self' blob:`（允许同源 Worker + blob URL Worker）。
- Monaco 使用 `MonacoEnvironment.getWorkerUrl` 指向 `/public/workers/editor.worker.js`（预先 bundle 好，避免 `blob:` URL）。
- shiki WASM 走 `fetch` 加载，不走 `data:` URL。

---

## 7. 与其他端/内核的代码复用边界

### 7.1 共享边界（各端必须复用，不得各自重写）

```
@arclight/protocol（单 repo 共享类型包）
├── ArcEvent union（§2.1 的完整类型定义）
├── 命令请求/响应类型（C1 命令体）
├── CapabilityProfile 类型
└── 内核↔端协议常量（端点路径、事件版本 v1）

@arclight/client-core（端无关逻辑包）
├── EventStreamManager（SSE 重连 + seq 去重 + 心跳检测）
├── SessionReducer（ArcEvent → UI state，纯函数）
├── CommandClient（C1 HTTP POST，带 epoch 注入）
└── EpochTracker（乐观锁 epoch 管理 + StaleEpochError 处理）
```

**这两个包是 Web 端建立的"参照实现"，CLI/桌面/移动/VSCode/Chrome 直接复用，不 fork。**

### 7.2 Web 端独有（不共享到其他端）

```
apps/web/
├── Next.js App Router + RSC（其他端无此运行时）
├── Monaco Editor 集成（VSCode 端用原生编辑器，不引 Monaco）
├── PWA Service Worker（@serwist/next，其他端用各自更新机制）
├── Auth.js Route Handler（Web 专属 OAuth 回调处理）
├── SSR 首屏数据拉取（RSC server-side fetch，其他端无 RSC）
└── Web Push 订阅注册（其他端用原生通知 API）
```

### 7.3 内核侧（Web 端不进入，只消费）

```
@arclight/core（headless agent server）
├── Agent 主循环（async-generator）
├── 工具系统 / RepoMap / paper-* 流水线
├── 上下文压缩 / 记忆 / provider 网关
├── SQLite/Postgres 持久化 / epoch 管理
├── 凭证代理（keychain/KMS）
└── SSE endpoint / 二进制媒体端点
```

Web 端**不 import** 任何 `@arclight/core` 内部模块（只通过 HTTP/SSE 消费），这是"薄客户端"边界的工程落地——monorepo 中通过 workspace 依赖图强制执行（`apps/web` 的 `package.json` 不 depend on `packages/core`，仅 depend on `@arclight/protocol`）。

### 7.4 复用路径与其他端的差异点汇总

| 端 | 复用 client-core | 不复用的部分 | 替代方案 |
|---|---|---|---|
| 桌面 Tauri | ✅ 全量 | Next.js/RSC/PWA/Auth.js Route Handler | Tauri WebView 跑同一 React 组件树，sidecar spawn 替 OAuth |
| 移动 Tauri | ✅ 全量 | PWA/Web Push/Monaco | 原生通知 API / CodeMirror Mobile |
| CLI | ✅ EventStreamManager + SessionReducer（无头） | 所有 React 组件 | OpenTUI 渲染同一 SessionReducer state |
| VSCode | ✅ CommandClient + EpochTracker | EventStreamManager（用 host→webview postMessage 桥接） | host 持 SSE，webview 用 postMessage 接收事件 |
| Chrome MV3 | ✅ CommandClient（SW 侧） | EventStreamManager（改用 WS 保活） | SW 持 WS，经 `chrome.runtime` 分发 |

---

## 8. 工作量量级与前置依赖、在全平台排期中的位置

### 8.1 在全平台排期中的位置

```
阶段一（MVP，T=0~T+8周）：Web 端先发/P0
│
├── [T+1] 内核基础（@arclight/core Hono 服务 + ArcEvent 事件模型 + SQLite 持久化）
│         前置依赖：@arclight/protocol 类型包确定，内核 SSE endpoint 可用
│
├── [T+2~3] @arclight/client-core（EventStreamManager + SessionReducer + CommandClient）
│           产物供 Web 端和其他后续端复用
│
├── [T+3~5] Web 基础壳（Next.js App Router + Auth + ChatShell + MessageList + InputBar）
│           写代码主场 UI（Monaco diff + iframe 沙箱终端 + shadow-git timeline）
│
├── [T+5~6] 写文章/调研 UI（分阶段审批 + 章节流式 + 引用溯源）
│           Web Push 注册（日常规划占位）
│
├── [T+6~7] PWA（@serwist/next，Service Worker 缓存 + 安装横幅 + 离线只读）
│
└── [T+7~8] Alpha 内测（自托管单用户，localhost 信任，写代码 MVP 闭环验证）

阶段二（T+8~T+16）：CLI（P2） + 错误/合并 UX / durable 输入
阶段三（P3）：桌面 Tauri + 移动 Tauri + VSCode 插件
阶段四（P4）：Chrome 扩展 MV3 + Computer Use 能力
阶段五（P5）：多租户/SaaS + AG-UI 适配器 + 自建流式 codegen
```

### 8.2 工作量量级估算

| 模块 | 量级 | 说明 |
|---|---|---|
| `@arclight/protocol` 类型包 | 0.5 周 | 协议契约已定，主要是 TS 类型定义 |
| `@arclight/client-core` | 1.5 周 | EventStreamManager + SessionReducer + CommandClient + EpochTracker；复杂度在重连/去重/coalescing 细节 |
| Next.js App Router 基础壳 + Auth | 1 周 | 标准 Next.js 15 App Router 配置 + Auth.js v5 适配；可参考 Auth.js 官方示例 |
| ChatShell + MessageList（虚拟滚动）+ InputBar | 1 周 | assistant-ui 无头组件集成 + Zustand store 接线 |
| 写代码 UI（Monaco diff + iframe 沙箱终端 + timeline） | 2 周 | Monaco 集成有坑（Worker/CSP/懒加载）；iframe 沙箱命名端口协商需内核配合 |
| 写文章 UI（分阶段审批 + 章节流式 + 引用溯源） | 1.5 周 | 章节流式渲染边界处理；溯源脚注组件 |
| 调研 UI（subtopics 审批 + 进度 SSE + 断点续研） | 1 周 | 复用章节流式组件；断点续研靠 client-core 已有能力 |
| PermissionModal（HITL）+ CapabilityProfile 上报 | 0.5 周 | — |
| PWA（Service Worker + 离线只读 + 更新提示） | 0.5 周 | @serwist/next 配置 + 更新 toast |
| Web Push 注册（日常规划用） | 0.5 周 | VAPID key 生成 + SW push handler |
| **合计（Web 端 MVP）** | **~10 周** | 其中 client-core 1.5 周是六端公共基建，摊薄后 Web 端净投入约 8.5 周 |

### 8.3 关键前置依赖（阻塞 Web 端开发的外部条件）

1. **内核 `@arclight/core` SSE endpoint 可用**：`/v1/sessions/:id/events` 能推 `ArcEvent` 帧，是 Web 端 E2E 联调的前置。可以 mock 内核（固定 NDJSON 流）先跑前端。
2. **`@arclight/protocol` ArcEvent 类型定稿**：一旦事件字段变更，client-core 和 Web 端都需同步修改——建议在 T+1 周内锁定 v1 事件模型，后续只做 backward-compatible 新增。
3. **内核 CapabilityProfile 协商端点**：Web 端 `CapabilityProfile` 声明（`localSandbox: false, screenshot: 'none', background: 'none'`等）需内核实现对应的裁剪逻辑，否则内核会向 Web 端下发无法处理的事件（如本地 exec 工具）。
4. **HTTP/2 内核配置**：解决 6 连接限制问题，需在内核 Bun HTTP server 开启 TLS + HTTP/2，本地开发需 mkcert 配套。

---

**源文件参考（本详设锚定）：**
- `/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md`（§2.1/§4.1/§5/§6/§7/§8/§9）
- 地基1 内核↔各端协议契约（C1/C2/C3/C4 四通道、ArcEvent 统一事件模型、SDK 策略）
- 地基2 五能力×六端落点矩阵（Web 端档位：写代码/写文章/调研=主场；computer-use=主场阶段四；日常规划=可用非主场）
- 地基3 跨端横切（Web 端鉴权/密钥/配置同步/分发策略）