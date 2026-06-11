I have all source material. The blueprint confirms: Tauri 2.0 chosen for desktop+mobile, mobile无本地沙箱→远程 opt-in, Web Push/系统通知, P3 priority, MVP仅Web. openhands confirms编排器/执行器分离 + event-stream反向代理 pattern that maps cleanly to mobile远程内核. The three地基 (协议契约 C1-C4, 能力×端落点, 横切) give me the binding constraints. Now I produce the detailed design.

---

Hi Alba，以下为《移动端 iOS/Android（Tauri 2，纳入）详细设计》。严格锚定主蓝图 §7（Tauri 2.0 覆盖移动、P3、先 PWA 过渡）、§8 决策表、§5.2/§5.5/§5.6，以及三条地基（协议契约 C1-C4 / 能力×端落点 / 跨端横切），不另起炉灶。

---

# arclightagent 全平台架构详设 ·【移动端 iOS / Android（Tauri 2，纳入）详细设计】

> 端定位（主蓝图 §7）：**移动 = Tauri 2.0 iOS + Android，P3，先 PWA 过渡**。MVP 不交付移动端（MVP 仅 Web 单端，§9）。本文给出移动端**全量详设**供阶段五落地，凡标 `[P3-PWA]` 为过渡期可先交付，`[P3-Native]` 为 Tauri 原生壳阶段。
>
> **本端第一性约束（贯穿全文，诚实定性）**：
> 1. **移动端无本地代码沙箱、无本地浏览器自动化驱动（无 CDP/Playwright）、后台执行受 OS 严格限制**（地基2 总纪律4）。因此**凡涉及"执行"的能力一律走远程内核 server + opt-in 远程沙箱/云浏览器**，移动壳只做：输入采集 + 事件流渲染 + 审批 + 系统通知。
> 2. 移动端**几乎总是连远程内核**（地基1 §1.1：端侧不跑 Bun sidecar）。这是移动端与桌面/CLI 最根本的架构差异——它**没有拓扑 A（本地内核）路径**，只有地基1 §6.2 的**拓扑 B（自托管远程）为主路径**。
> 3. **凭证沙箱外签名放行、沙箱内零真实凭证**（主蓝图 §5.5/M1）——移动端把这条投影为"端只持 app-session 句柄，provider key / MCP token 永不下发到手机"。

---

## 1) 组件级架构（本端内部结构 + 按地基1 协议契约连接内核）

### 1.1 整体拓扑（移动壳 ↔ 远程内核，对应地基1 §6.2 拓扑 B）

```
┌──────────────────────── iOS / Android 设备 ────────────────────────┐
│                                                                      │
│  ┌────────────────── Tauri 2 原生壳 (Rust core) ──────────────────┐ │
│  │  · 应用生命周期 / 后台模式协调                                   │ │
│  │  · OS 安全存储桥 (iOS Keychain / Android Keystore)             │ │
│  │  · 系统通知接收 (APNs/FCM) + 深链路由 (Universal/App Link)      │ │
│  │  · ASWebAuthenticationSession / Custom Tabs (OAuth)            │ │
│  │  ┌── Tauri 插件 ──┐                                            │ │
│  │  │ keychain/keystore · push · deep-link · biometric · http   │ │
│  │  └────────────────┘                                            │ │
│  └───────────────▲────────────── IPC (invoke/event) ─────────────┘ │
│                  │                                                   │
│  ┌───────────────┴──────────── WKWebView / Android WebView ───────┐ │
│  │   复用 Web 前端代码 (Next.js export → 静态资产，触屏适配)         │ │
│  │  ┌──────────────────────────────────────────────────────────┐ │ │
│  │  │  @arclight/client-core  (端无关共享包,地基1 §2.2)          │ │ │
│  │  │   · 事件 reducer (16ms 帧 coalescing / 250ms 退避 / seq 去重)│ │ │
│  │  │   · 重连 + Last-Event-ID / afterSeq 续传                    │ │ │
│  │  │   · @arclight/protocol 类型 (ArcEvent 判别联合)             │ │ │
│  │  └──────────────────────────────────────────────────────────┘ │ │
│  │  UI 层: 触屏适配的会话流 / 日历视图 / checklist / 审批模态 /     │ │
│  │         调研报告阅读 / 富文本单段精修 / 语音输入                  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬───────────────────────────────────────┘
                               │  HTTPS / TLS (公网)
              ┌────────────────┼─────────────────────────────────┐
              │ C1 控制面: HTTP POST  /v1/...                      │
              │ C2 事件面: SSE        /v1/sessions/:id/events      │
              │ C3 实时面: WSS        (按需,语音/computer-use 面板) │
              │ C4 媒体面: WebRTC(优先)/独立 WSS (云浏览器截图流)    │
              └────────────────┼─────────────────────────────────┘
                               ▼
        ┌──────────── 远程内核 (Bun+Hono, 自托管 VPS / 云) ───────────┐
        │  OAuth2.1 网关 · 每请求 tenantId/userId · 会话隔离(RLS)     │
        │  凭证 KMS · 沙箱 per-tenant(opt-in E2B) · metering/quota    │
        │  ─ 长任务(调研/computer-use/长编码)在内核侧常驻续跑 ─        │
        │  ─ 任务里程碑 → 推送服务(APNs/FCM) 唤醒手机 ─                │
        └────────── 云浏览器 Browserbase/Steel (C4 截图 CDP/VNC) ─────┘
```

### 1.2 与地基1 四条逻辑通道的逐条映射（移动端落点）

| 通道 | 移动端物理传输 | 落地说明 |
|---|---|---|
| **C1 控制面** | HTTPS POST，经 Tauri `http` 插件或 WebView `fetch` | 提交输入 / 中断 / 审批回传 / capability 声明 / 会话管理。带 `Authorization: Bearer <短效 access>` + `Arc-Protocol-Version: 1` |
| **C2 事件面** | **SSE**（WebView `EventSource`） | token / 工具进度 / 压缩边界(epoch) / 权限请求 / 子代理通知。重连带 `Last-Event-ID`，内核 replay > seq 帧（地基1 §2.2） |
| **C3 实时面** | WSS（按需，仅语音 Realtime / computer-use 控制面板时叠加） | `realtimeControl` 能力为真时才开；否则不建立 |
| **C4 媒体面** | **WebRTC 优先**，回退独立 WSS | 云浏览器截图流（JPEG/WebP 帧差 或 CDP/VNC），**绝不混入 C2 的 SSE**（地基1 §1.2 硬约束）。WebRTC 在移动网络下抗丢包/带宽自适应优于裸 WS |

### 1.3 移动端特有的"前台 SSE + 后台 Push"双通道协同（核心设计）

移动端 OS 在 App 进入后台后会**冻结网络/挂起 WebView**（见 §6 坑1），SSE 长连无法跨越后台存活。因此移动端**不能像 Web 那样依赖单一 SSE 长连观测长任务**，必须做"前台流 + 后台推"切换：

```
App 前台:  WebView EventSource ──SSE──> 内核   (实时 token/进度流)
   │
   │ App 进入后台 (OS 冻结) → EventSource 断开
   ▼
App 后台:  任务仍在【内核侧】常驻续跑 (地基2: 长任务绑定远程内核,不依赖端常驻)
           内核到达里程碑(调研完成/审批点/computer-use 高危动作) 
              → 推送服务 APNs/FCM → 系统通知
   │
   │ 用户点通知 → 深链唤起 App → 回前台
   ▼
App 回前台: EventSource 重连,带 Last-Event-ID=<lastSeq>
           内核 replay 期间错过的事件 (地基1 §2.2 断点续传)
           reducer 按 seq 去重 → UI 状态无缝恢复
```

这条协同直接复用地基1 的 `seq`/`Last-Event-ID` 续传 + 地基2 "长任务绑定到远程内核 + 断点续研"（`background: 'limited'` 的内核裁剪动作）。**关键纪律：手机断网/后台/锁屏都不影响内核侧任务推进，手机只是"间歇性观测窗口 + 审批终端"。**

### 1.4 capability profile 声明（地基1 §5，移动端固定取值）

移动壳连接时 C1 发 `POST /v1/sessions/:id/capabilities`，固定声明：

```ts
const MOBILE_PROFILE: CapabilityProfile = {
  localSandbox: false,                 // 无本地沙箱 → 内核裁剪掉本地 exec
  screenshot: 'webrtc',                // 云浏览器截图走 WebRTC
  background: 'limited',               // 后台受限 → 长任务绑远程内核 + Push
  fileSystem: 'none',                  // 文件落内核工作区(远程),非手机本地 FS
  terminal: false,                     // 不下发内嵌终端 iframe
  push: true,                          // 收 APNs/FCM 推送
  maxBinaryChannel: <按网络档位>,       // 移动网络带宽档位
  realtimeControl: <语音功能开关>,       // 默认 false,语音功能开启时 true
};
```

内核据此 `materialize(profile)` 裁剪（地基1 §5.2 表）：本地 bash/exec 工具不暴露、代码执行强制走 opt-in 远程沙箱或拒绝、`read/write/edit` 落内核远程工作区、长任务绑远程内核。**这是移动端所有能力裁剪的协议级根因**——不是端侧隐藏，是内核侧据 profile 决定暴露什么。

---

## 2) 技术选型与关键依赖（与主蓝图栈一致）

| 层 | 选型 | 与主蓝图一致性 | 说明 |
|---|---|---|---|
| **原生壳** | **Tauri 2.0**（iOS + Android 目标） | §7/§8「Tauri 2.0 覆盖 iOS/Android，不用 Electron」 | Rust core + 系统 WebView（WKWebView/Android WebView），包体小 |
| **WebView 前端** | 复用 **Web 前端**（Next.js）静态导出资产 + 触屏适配层 | §7「同一内核服务,各端只换壳」 | 与 Web/桌面共享 UI 代码,移动加触屏/小屏适配组件 |
| **共享客户端逻辑** | `@arclight/client-core`（reducer/重连）+ `@arclight/protocol`（类型） | 地基1 §3.1「端无关共享包,六端复用」 | 零重写,直接 import |
| **过渡期** | **PWA「安装到主屏」**（`[P3-PWA]`） | §7/§8「先 PWA 过渡」 | Tauri 原生壳就绪前,先用 PWA 覆盖移动,验证触屏 UX |
| **OS 安全存储** | iOS **Keychain**（`WhenUnlockedThisDeviceOnly` + 可选 Secure Enclave 生物门控）/ Android **Keystore**（StrongBox + EncryptedSharedPreferences） | 地基3 §2.2 表 | 经 Tauri 移动插件桥 Swift Keychain / Kotlin Keystore |
| **推送** | iOS **APNs** / Android **FCM**（地基3 §4 / 地基2 §5）；PWA 期可用 **Web Push** | 地基2「主动提醒经系统通知/Web Push」 | 原生壳走 APNs/FCM,PWA 期 Web Push 兜底 |
| **OAuth** | iOS **ASWebAuthenticationSession** / Android **Custom Tabs**；兜底 **设备码流（device_code, RFC 8628）** | 地基3 §1.2 移动端条目 | 系统受信浏览器优先,回 App 经 Universal Link/App Link |
| **媒体** | **WebRTC**（云浏览器截图流，C4），回退独立 WSS | 地基1 §1.2「移动 C4 WebRTC 优先」 | 移动网络抗丢包/带宽自适应 |
| **关键 Tauri 插件** | `tauri-plugin-deep-link`、`tauri-plugin-notification`/原生推送桥、keychain/keystore 桥、`tauri-plugin-http`、生物识别桥 | — | 许可证核对：Tauri 插件 MIT/Apache-2.0，合规（继承主蓝图 §3.6 许可证纪律，新依赖一律核对） |

> **不引入**：移动端**不**打包 Bun/内核运行时（无法稳定跑 Bun sidecar，§6 坑2），**不**引 React Native/Capacitor（备选对比见 §6.5，结论：纳入 Tauri）。

---

## 3) 本端承载哪些能力（依据地基2 能力×端落点）及裁剪/适配

直接继承地基2 总矩阵的移动列。逐能力落地：

### 3.1 日常规划 —— **主场**（移动端最贴合能力）

- **理由**（地基2 §5.1）：随身 + 通知驱动 + 生活域，移动是最佳载体。**iOS/Android 原生推送（APNs/FCM）做主动提醒**是最佳触达。
- **适配**：心跳协调器的**活跃时段掩码 → 直接映射到系统勿扰/夜间不打扰**；日历视图 + checklist 触屏管理；碎片时间审批 agent 行动；durable 输入支持手机/Web 并发派活（durable 输入本身后置阶段二，地基3 §3.5）。
- **端特定后端**：**通知投递后端 = APNs/FCM**。心跳协调器在**内核**决定"何时提醒/是否夜间静默"，移动壳仅按本端通道投递（地基2 §7.2）。生活域执行（改日历/发邮件）走**内核 MCP**，手机不持 Google 凭证。

### 3.2 写文章 —— **裁剪**

- **裁剪点**（地基2 §2.1）：触屏 + 小屏不适合长文重度编辑/多栏审批；**裁剪掉**复杂多栏审批 UI、大纲拖拽重排。
- **保留**：**语音成稿（语音输入）+ 阅读审阅 + 单段精修 + 章节级审批**。写作流水线全在远程内核跑，移动订阅 SSE 看章节流出。
- **端特定后端**：无（写作是"跨端共享内核、仅 UI/输入差异"最纯粹的一项，地基2 §2.3）。差异仅在输入方式（语音 vs 键盘）与精修粒度。

### 3.3 调研 —— **可用**

- **理由**（地基2 §3.1）：调研是异步后台任务，与移动"碎片化 + 通知驱动"天然契合：发起→锁屏→**系统通知/Push 告知完成**→回来读报告 + 审批计划。
- **裁剪点**：超长报告小屏阅读体验受限、引用溯源交互简化；但**发起/审批/读结论闭环完整**，故评"可用"。
- **关键**：任务全在远程内核，**手机断网不影响后台调研**（直接吃地基1 §1.3 双通道协同 + 断点续研）。

### 3.4 写代码 —— **裁剪（远程 opt-in）**

- **裁剪点**（地基2 §1.1）：**移动无本地沙箱 → 代码执行只能走远程 internal server + opt-in 远程沙箱（E2B/Vercel）**。
- **定位**：**审阅/批准/轻量改动 + 触发远程任务**——看 diff、批 PR、跑远程测试、收结果通知。**不做本地编辑/本地执行**。
- **端特定后端**：执行后端**强制为远程 opt-in 沙箱**（无本地后端，地基2 §7.2）。

### 3.5 Computer Use —— **裁剪（远程观测 + 审批）**

- **裁剪点**（地基2 §4.1）：**移动无本地浏览器自动化驱动（无 CDP/Playwright）→ 必须走远程云浏览器（Browserbase/Steel）**。
- **定位**：**观测 + 审批面板**——看远程浏览器截图流（C4 WebRTC）、批高危动作；**无本机执行**。AndroidWorld（本机 OS 控制）是更后置的独立后端，**不在本范围**。
- **硬边界（端无关）**：即便观测，高危动作（支付/删除/外发）仍强制 **HITL + 域名白名单 + 审计**，凭证沙箱外签名放行（地基2 §4.2）。

### 3.6 移动端能力档位速查（取自地基2 §6 移动列）

| 能力 | 档位 | 一句话适配 |
|---|---|---|
| 日常规划 | **主场** | iOS/Android 原生推送主动提醒 + 随身日历/checklist |
| 写文章 | 裁剪 | 语音成稿 + 阅读审阅 + 单段精修 + 章节审批 |
| 调研 | 可用 | 发起 + 轻审批 + Push 完成通知 + 读报告（后台在内核） |
| 写代码 | 裁剪 | 无本地沙箱→执行走远程 opt-in；仅审阅/批 PR/触发远程测试 |
| computer use | 裁剪 | 无本地驱动→远程云浏览器观测 + 审批；无本机执行 |

---

## 4) 鉴权 / 会话 / 密钥 / 离线同步在本端的落地（依据地基3 横切）

### 4.1 鉴权登录（地基3 §1.2 移动端条目）

- **首选：系统受信浏览器会话**——iOS `ASWebAuthenticationSession` / Android `Custom Tabs`（经 Tauri 移动插件桥接），OAuth 2.1 + PKCE，回 App 经 **Universal Link（iOS）/ App Link（Android）**。体验最好，优先此路径。
- **兜底：设备码流（device_code, RFC 8628）**——移动端 loopback redirect 受限时改用设备码：App 显示 `user_code` + 验证 URL，用户在任意设备完成授权，App 轮询 token 端点。
- **不在 WebView 内嵌登录页**（防钓鱼/cookie 混淆，继承地基3 桌面同纪律）。

### 4.2 Token 存储与刷新（地基3 §1.3 表）

| 项 | 移动端落地 |
|---|---|
| **app-session access token** | iOS Keychain / Android Keystore，短 TTL（15-60min） |
| **app-session refresh token** | iOS Keychain / Android Keystore，**rotating refresh（一次性轮换）防重放** |
| **provider key / MCP OAuth token** | **永不下发到手机**，只在内核侧 KMS（地基3 §1.1 三类 token 分层 + §2.2 表） |
| **刷新触发** | 客户端检测过期 → 用 refresh 换新 → 写回 Keychain/Keystore；refresh 旋转 |
| **登出** | 内核吊销 + 手机清 Keychain/Keystore 句柄；跨端登出经内核会话广播（refresh 旋转 + 短 access TTL 使吊销最坏延迟 = access TTL） |

### 4.3 会话上下文传播（地基1 §4.2 三元组）

每条 C1/C2 连接，内核从 `Bearer` 解出 `RequestContext = {tenantId, userId, sessionId, capabilityProfile, authScope}`；移动端 MVP 单用户 = default tenant，但从第一天按 `tenant_id` 建模（主蓝图 §5.6）。校验 `session.user_id == ctx.userId && session.tenant_id == ctx.tenantId`，否则 403。

### 4.4 配置 / 状态 / 离线同步（地基3 §3）

- **真相源 = 远程内核**（地基3 §3.1）。移动壳**不维护权威状态**，本地只持缓存 + 非密偏好。
- **本地配置**：存 **App 沙箱容器目录**（iOS/Android 应用专属目录，非 `~/.config`）——仅 UI 偏好、设备 ID、session 句柄（**非密**）。密钥本体走 Keychain/Keystore。
- **离线模式：中**（地基3 §0/§3.4）——本地内核**不可选**（移动跑不了 Bun），故为 **PWA-style 只读缓存 + 联网恢复**：Service Worker（PWA 期）/ 本地缓存最近 session 只读快照；写操作排队待联网，提交时按 **epoch 乐观锁**校验（`StaleEpochError`，地基1 §2.3 / 地基3 §3.5）。
- **重连合并**：MVP 只做"刷新不丢"最朴素版（服务端短缓冲 + 重连续推），epoch 冲突合并 UX / durable 输入**后置阶段二**（地基3 §3.5，继承主蓝图后置定界）。

### 4.5 密钥纪律（地基3 §2，移动端投影）

- 手机=有 OS 安全存储的端 → **可持 app-session token 类凭据**（存 Keychain/Keystore）。
- 但 **provider key / MCP OAuth token 类永远只在内核侧**——需要这些密钥的调用（LLM 推理、Google API 工具）全在内核执行，手机只发"动作请求 + app-session"（地基3 §2.1 三类密钥纪律）。这与"凭证沙箱外签名放行"是同一条纪律的移动投影。
- **禁明文**：App 沙箱目录只存非密配置；任何密钥本体走 Keychain/Keystore（继承"禁明文 `~/.config`"，地基3 §2.4）。

---

## 5) 打包 / 分发 / 自动更新与平台合规（地基3 §4）

### 5.1 打包与更新通道（地基3 §4 表移动行）

| 项 | iOS | Android |
|---|---|---|
| 打包 | Xcode → IPA | Gradle → AAB |
| 更新通道 | **App Store** | **Google Play** |
| 审核周期 | **1-3 天（可能更久）** | **数小时-数天** |
| 灰度 | TestFlight | staged rollout（分阶段灰度） |
| 原生壳更新 | 必走商店，**不可热更原生代码** | 同上 |
| WebView JS 资产 | 可经远程配置在**不违反商店政策范围内**微调 | 同上 |

### 5.2 平台合规：商店审核对"AI 执行任意操作"的应对（本端关键合规风险）

商店对"AI 可执行任意操作 / computer-use / 代理用户账号操作"高度敏感，是移动端**独有且最高**的合规风险。应对（与架构红利一致）：

1. **安全关键逻辑收敛内核**（地基3 §4 纪律②/红利）——移动壳是**薄壳**，computer-use/代码执行/凭证全在可即时更新的内核侧；商店审核周期（1-3 天）导致移动端**安全修复无法即时下发**，故端侧只保留无法移到内核的最小逻辑。这反过来**论证了薄客户端架构的合规价值**。
2. **强 HITL 默认**：移动端对所有高危 agent 动作（支付/删除/外发/账号操作）强制系统级确认模态 + 域名白名单 + 审计（地基2 §4.2），向审核方证明"AI 不会无人值守执行破坏性操作"。
3. **能力声明诚实**：移动端 `localSandbox: false`，本身不在设备上执行任意代码/不本机控制 OS（无 AndroidWorld 路径），降低审核敏感度——执行均在用户**显式 opt-in 的远程沙箱/云浏览器**，可文档化数据流（继承主蓝图 §5.7「SaaS opt-in 文档化数据流」）。
4. **隐私合规**：数据导出/删除（GDPR 类）归内核统一执行并记审计（地基3 §5）；推送权限、麦克风（语音成稿）权限最小化声明并给清晰用途说明（App Store/Play 隐私清单）。
5. **PWA 过渡作为审核风险缓冲**（`[P3-PWA]`）：原生壳进商店审核前，先用 PWA「安装到主屏」交付，绕过商店审核周期验证 UX 与合规边界，再决定原生壳上架策略。

### 5.3 触屏 UX（移动端独有适配）

- 会话流、日历视图、checklist、审批模态、调研报告阅读、富文本单段精修均需触屏重构（大点击区、手势、底部操作栏），**不是** Web 桌面布局直接缩放。
- **语音输入**为移动写作主路径（替代键盘长文录入）；审批走全屏/底部抽屉模态而非 Web 的居中弹窗。
- 系统勿扰/夜间掩码与 OS Focus 模式对齐（地基2 §5.2）。

---

## 6) 本端特有的硬约束与坑（诚实，不回避）及缓解

### 6.1 Tauri 2 移动支持成熟度的诚实评估

**事实定性**：Tauri 2.0 的 iOS/Android 支持是**真实存在但相对年轻**的能力——它是 Tauri 2.0（2024 稳定）才正式纳入的方向，**桌面成熟度远高于移动**。诚实风险点：

- 移动插件生态（推送/深链/Keychain/Keystore/生物识别）**不如桌面完整**，部分能力需**自写 Swift/Kotlin 原生插件桥**（增加 Rust+Swift+Kotlin 三语种维护面）。
- iOS/Android 构建链路（Xcode 签名、Gradle、商店产物）需各自原生 runner，CI 复杂度高于桌面。
- WebView 行为差异（WKWebView vs Android WebView）需端到端测试覆盖。

**缓解**：① **先 PWA 过渡**（主蓝图 §7 既定），用 PWA 覆盖移动验证 UX，把 Tauri 原生壳风险后移；② 原生壳阶段优先复用已有成熟 Tauri 移动插件，缺口能力（如原生 APNs/FCM 桥）单独评估自写成本；③ **移动端是 P3**（主蓝图 §7），不阻塞 MVP，给 Tauri 移动生态成熟留时间窗。

### 6.2 无本地代码沙箱 / 无本地浏览器驱动（第一性约束）

- **坑**：iOS/Android 无法跑本地 nono/bwrap 沙箱、无 CDP/Playwright → 代码执行、computer-use 在手机上**无本地执行后端**。
- **缓解**：一律走**远程内核 + opt-in 远程沙箱（E2B）/ 云浏览器（Browserbase/Steel）**（地基2 总纪律4）；移动壳只做观测/审批。这是设计前提而非缺陷——已被 capability profile（`localSandbox:false`）协议化裁剪。

### 6.3 后台执行限制 + SSE 长连无法跨后台存活

- **坑**：App 进后台被 OS 冻结网络/挂起 WebView，`EventSource` 断开；长任务（调研 3-30min、长 computer-use）无法靠手机前台持流观测。
- **缓解**：**§1.3 前台 SSE + 后台 Push 双通道协同**——长任务绑**内核侧常驻续跑**（`background:'limited'` 裁剪动作），里程碑经 **APNs/FCM** 唤醒，回前台用 `Last-Event-ID` 续传。**手机后台不影响任务推进**。

### 6.4 推送通道复杂度（APNs/FCM 双平台 + 凭证）

- **坑**：APNs（证书/Token-based）与 FCM 配置、移动壳与内核推送服务对接、Web Push（PWA 期）三套并存。
- **缓解**：推送**投递决策在内核**（心跳协调器决定何时/是否静默），移动壳只**注册 device token + 接收 + 深链路由**；内核统一对接 APNs/FCM/Web Push 三通道（地基2 §5.3 通知是"端能力"非"执行后端"）。

### 6.5 React Native / Capacitor 备选对比与结论（诚实评估）

| 维度 | **Tauri 2（纳入，主蓝图既定）** | React Native | Capacitor |
|---|---|---|---|
| **与既有栈一致** | ✅ **桌面已选 Tauri 2，同壳覆盖 iOS/Android**，复用 Rust core + 系统 WebView；与 Web 前端共享代码 | ❌ 另一套（RN 组件体系），**不复用 Web/桌面前端代码**，UI 需重写 | ⚠️ WebView 容器，可复用 Web 代码，但**与桌面壳分裂**（桌面是 Tauri） |
| **代码复用（六端薄壳目标）** | ✅ 复用 `@arclight/client-core` + Web 前端 + 桌面壳同源 | ❌ UI 层几乎重写，破坏"各端只换壳"原则 | ⚠️ 复用 Web 前端，但引入**第二套原生壳技术**（运维双轨） |
| **包体 / 性能** | ✅ 系统 WebView，包体小 | ⚠️ JS 引擎 + 原生桥，包体中 | ⚠️ WebView，与 Tauri 近似但壳不统一 |
| **移动生态成熟度** | ⚠️ **较年轻**（本端最大短板，见 §6.1） | ✅ 成熟、插件丰富 | ✅ 较成熟（Ionic 生态） |
| **原生能力（推送/Keychain/深链）** | ⚠️ 部分需自写 Swift/Kotlin 桥 | ✅ 社区插件齐全 | ✅ Capacitor 插件齐全 |
| **维护语种面** | Rust + Swift + Kotlin（壳）+ TS（前端） | JS/TS + 原生 | TS + 原生 |

**结论（与主蓝图一致，不另起炉灶）**：**纳入 Tauri 2**。决定性理由是**架构一致性与代码复用**——主蓝图 §7/§8 已为桌面拍板 Tauri 2 且明示"Tauri 覆盖 iOS/Android"，移动用同壳可让桌面/移动共享 Rust core + 与 Web 共享前端，完全贴合"同一内核服务、各端只换壳"原则。RN 会**破坏代码复用**（UI 重写，违背薄壳原则），Capacitor 会**引入第二套原生壳技术与桌面分裂**（运维双轨）。Tauri 移动生态较年轻是真实代价，但用 **PWA 过渡 + P3 优先级**对冲——**用一点成熟度风险换取全平台壳的架构统一，是正净值**。若 Tauri 移动在 P3 落地期被验证为阻塞性不成熟，**Capacitor 是首选回退**（仍复用 Web 前端，仅壳层切换），RN 为最末选（复用代价最高）。

---

## 7) 与其他端 / 内核的代码复用边界

| 层 | 复用来源 | 移动端是否重写 |
|---|---|---|
| **内核全部业务逻辑**（agent 主循环、工具系统、上下文/记忆压缩、provider 网关、权限策略、持久化、沙箱抽象、五大能力流水线、心跳协调器、CitationAgent、MCP 接入） | 远程内核（Bun+Hono），六端共享一份 | **零重写**（地基2 §0 纪律1） |
| **协议类型** `@arclight/protocol`（ArcEvent 判别联合、命令/响应体） | 地基1 §3.1 单一类型源 | **零重写，直接 import** |
| **客户端事件 reducer / 重连 / 续传** `@arclight/client-core`（16ms coalescing / 250ms 退避 / seq 去重 / Last-Event-ID） | 地基1 §2.2 端无关共享包 | **零重写,直接复用** |
| **Web 前端 UI 代码**（会话流、日历、checklist、报告阅读、富文本编辑器、审批组件） | 与 Web/桌面共享（Next.js 资产） | **大部分复用 + 触屏适配层**（大点击区/手势/底部操作栏/语音输入） |
| **原生壳层**（OS 安全存储桥、推送接收、深链、OAuth 系统浏览器会话、生命周期/后台协调） | 移动端**特有**，部分与桌面 Tauri 共享 Rust core 模式 | **移动端特定实现**（Tauri 移动插件 + 必要时自写 Swift/Kotlin 桥） |
| **端特定执行/投递后端**（地基2 §7.2） | 移动端：① 代码/computer-use = 远程 opt-in 沙箱/云浏览器（与 Web 共享内核侧后端，无本机后端）；② 通知投递 = APNs/FCM（移动特有） | 通知投递后端移动特有；执行后端复用内核侧远程后端 |

**复用边界一句话**：移动端**只新增"原生壳层 + 触屏适配层 + APNs/FCM 通知投递后端"**，其余（内核全部逻辑、协议类型、client-core reducer、绝大部分 UI 代码）与 Web/桌面**同源复用**，完全贴合主蓝图 §7"各端只换壳"。

---

## 8) 工作量量级、前置依赖、在全平台排期中的位置

### 8.1 排期位置

- **优先级 P3**（主蓝图 §7），落于**阶段五：全平台壳 + 多租户服务化**（§9，~6-8 周整体）。**MVP（阶段一）不含移动端**。
- **前置依赖（硬阻塞）**：
  1. **远程内核服务化就绪**——移动端无本地内核路径，**强依赖拓扑 B（自托管远程内核 + OAuth2.1 网关 + 多租户 RLS + KMS + metering）**，即阶段五"多租户服务化"必须先于或同步于移动壳。
  2. **OAuth 2.1 + PKCE / 设备码流**远程鉴权（阶段五，地基3 §1）。
  3. **第二端基建**——OpenAPI→TS SDK 自动生成 + 自建流式 codegen + `@arclight/client-core` 抽出（主蓝图 §9 阶段五"第二端起"）。
  4. **Web 前端成熟**（MVP 已交付，作为移动 WebView 复用源）。
  5. **opt-in 远程沙箱（E2B）+ 云浏览器（Browserbase/Steel）** 接入（阶段四 computer-use/沙箱强化 + 阶段五 SaaS opt-in），供移动端代码执行/computer-use 远程后端。
  6. **推送基础设施**（APNs/FCM 内核侧对接）——可与日常规划能力（阶段五）同步建设。

### 8.2 工作量量级（相对量级，非绝对工时）

| 工作块 | 量级 | 说明 |
|---|---|---|
| PWA 过渡（`[P3-PWA]`） | **小** | Web 前端加 PWA Manifest + 触屏适配 + Web Push，复用度最高，先交付 |
| Tauri 移动壳骨架（iOS+Android 构建链路、WebView 嵌入、IPC） | **中** | Tauri 2 移动配置 + 双平台 CI runner |
| 原生壳层（Keychain/Keystore 桥、APNs/FCM 推送桥、深链、OAuth 系统浏览器会话、后台协调） | **中-大** | 移动端最大新增工作量；部分需自写 Swift/Kotlin 桥（§6.1 风险） |
| 触屏 UX 适配层（日历/checklist/审批模态/报告阅读/语音输入） | **中** | Web 组件触屏重构 |
| 前台 SSE + 后台 Push 双通道协同（§1.3） | **中** | 移动端特有的连接/续传/续跑逻辑,复用 client-core 续传桩 |
| 商店上架与合规（隐私清单、HITL 论证、审核应对） | **中** | iOS/Android 各一套审核周期（1-3 天）需排期缓冲 |

> 移动端**不**重写任何能力逻辑（全在内核），新增工作集中在"壳层 + 触屏 + 推送 + 连接协同 + 合规"。**最大不确定性来自 Tauri 移动生态成熟度（§6.1）与商店审核（§5.2）**，两者均已有缓解（PWA 过渡 + Capacitor 回退；薄壳收敛安全逻辑 + HITL 默认）。

---

## 附：与主蓝图 / 三地基一致性自检

- ✅ **栈一致**：Tauri 2.0 覆盖 iOS/Android、不用 Electron、先 PWA 过渡、P3（主蓝图 §7/§8）。
- ✅ **第一性约束**：移动无本地沙箱/无本地浏览器驱动 → 执行走远程 opt-in；后台受限 → 长任务绑远程内核 + Push（地基2 纪律4 / §1-3）。
- ✅ **协议契约**：C1 HTTP POST / C2 SSE / C3 WSS 按需 / C4 WebRTC 优先；capability profile（localSandbox:false 等）协议级裁剪；seq/Last-Event-ID 续传（地基1 §1/§2/§5）。
- ✅ **横切**：OAuth2.1/设备码流、Keychain/Keystore、provider key 不下发、远程内核单一真相源、离线只读缓存 + epoch 乐观锁、冲突合并/durable 后置阶段二（地基3 §1-3）。
- ✅ **能力落点**：日常规划主场 / 写文章·写代码·computer-use 裁剪 / 调研可用，逐条取自地基2 §6 移动列。
- ✅ **安全边界**：凭证沙箱外签名放行、computer-use 高危 HITL+白名单+审计、商店合规收敛安全逻辑到内核（主蓝图 §5.5/§5.7 / 地基2 §4.2 / 地基3 §4-5）。
- ✅ **备选诚实评估**：Tauri 移动成熟度短板不回避，给出 RN/Capacitor 对比，结论纳入 Tauri（架构一致+代码复用），Capacitor 为回退。
- ✅ **未另起炉灶**：移动端只新增壳层/触屏/推送/连接协同，能力逻辑零重写，全部决策落在主蓝图既定选型内。

**涉及文件**：主蓝图 `/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md`（§5.2/§5.5/§5.6/§7/§8/§9）；参考 `/Users/fsm/project/arclightagent/research/data/repo-openhands.json`（编排器/执行器分离 + event-stream 反向代理 + 命名端口沙箱，印证移动端"远程内核常驻续跑 + 端消费事件流"路径）。建议实现包：移动壳特有的 `@arclight/shell-mobile`（Tauri 移动壳 + 原生桥），复用 `@arclight/protocol` + `@arclight/client-core` + Web 前端资产。