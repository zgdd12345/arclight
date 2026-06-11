I have all the source material needed. The three foundations (协议契约 / 能力×端落点 / 横切) are fully specified in the task, and I've confirmed §7/§2.1/§8/§9 and the cline reference. Now I'll produce the desktop端详设 directly as Markdown, fully consistent with all decisions.

---

# 桌面端 Tauri 2.0(P3)详细设计

> 本文是 `/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md` 的下沉详设,锚定其 §7(跨平台策略,桌面=Tauri 2.0,先 PWA 过渡)、§2.1(栈)、§8(决策表,桌面壳=Tauri 2.0)、§9(路线图,桌面属阶段五全平台壳),并严格继承三条已定地基:
> - **地基1 协议契约**:四条逻辑通道(C1 控制面 HTTP POST / C2 事件面 SSE / C3 实时面 WS 按需 / C4 媒体面独立二进制),桌面端 = **sidecar stdio 握手拿端口+token,业务流量走 localhost HTTP/SSE**,或连远程。
> - **地基2 能力×端落点**:桌面端档位 = **写代码「可用」/ 写文章「主场」/ 调研「主场」/ computer-use「可用→裁剪」/ 日常规划「主场」**。
> - **地基3 横切**:桌面端鉴权=localhost 信任 / OAuth2.1 系统浏览器回环;密钥=OS keychain(via `keyring` crate / `tauri-plugin-stronghold` 兜底);离线=**强**(本地内核 sidecar 可离线);更新=Tauri updater 签名增量。
>
> **铁律(不另起炉灶)**:桌面壳是**薄客户端**,零业务/能力逻辑落地;Tauri WebView **直接复用 Web 前端全部代码**(Next.js + AI SDK v6 + assistant-ui);凭证一律沙箱外签名放行,沙箱内零真实凭证;禁明文 `~/.config`;桌面端在主蓝图属 **P3(且明确「先 PWA 过渡」)**,本文给全量详设供阶段五落地。

---

## 1) 组件级架构

### 1.1 本端内部结构 + 按地基1连接内核(ASCII)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                         桌面 App (Tauri 2.0, 单进程双层)                                  │
│                                                                                          │
│  ┌─────────────────────── WebView 层 (系统 WebView, 复用 Web 前端) ────────────────────┐ │
│  │  Next.js (静态导出/SSG) + AI SDK v6 + assistant-ui  ← 与 Web 端 100% 同源代码         │ │
│  │  @arclight/client-core: 事件 reducer(16ms coalescing/250ms 退避/seq 去重)            │ │
│  │  HostProvider(desktop 实现) ── 抽象「平台能力」, 同一前端在 Web/桌面切实现 ──┐         │ │
│  │     · 文件选择/保存对话框  · 系统通知  · 托盘/快捷键回调  · deep-link 回调   │         │ │
│  └──────────────┬───────────────────────────────────────────────┬──────────────┘       │ │
│                 │ ① HTTP POST(C1) + SSE(C2) + WS(C3/C4)          │ ② Tauri IPC          │ │
│                 │    指向 http://127.0.0.1:<port>(本地)           │   invoke/event       │ │
│                 │    或 https://remote(远程)                      │   (仅平台能力, 非业务)│ │
│  ┌──────────────▼────────────────────────────────────────────────▼──────────────────┐ │ │
│  │                      Rust 壳层 (tauri-core, ~Rust, 薄)                              │ │ │
│  │  ┌────────────────┐ ┌──────────────────┐ ┌────────────────┐ ┌──────────────────┐ │ │ │
│  │  │ Sidecar 管理器  │ │ 连接发现/编排     │ │ 原生集成 cmds   │ │ 安全存储桥        │ │ │ │
│  │  │ spawn 内核子进程│ │ ARC_SERVER_URL→  │ │ 托盘/全局快捷键 │ │ keyring crate    │ │ │ │
│  │  │ stdio 握手读    │ │ server.json→     │ │ 通知/自动启动   │ │ →Keychain/DPAPI/ │ │ │ │
│  │  │ {port,token,pid}│ │ 自启 sidecar     │ │ 文件系统/deep-  │ │  libsecret;无则  │ │ │ │
│  │  │ 健康/关停信令   │ │ →远程兜底        │ │ link/单实例锁   │ │  Stronghold 兜底 │ │ │ │
│  │  └───────┬────────┘ └──────────────────┘ └────────────────┘ └──────────────────┘ │ │ │
│  └──────────┼──────────────────────────────────────────────────────────────────────┘ │ │
└─────────────┼──────────────────────────────────────────────────────────────────────────┘
              │ spawn (Tauri sidecar, 仅本地模式)
              │ stdout 第一行: {"port":N,"token":"...","pid":N}  ← stdio 仅做握手/健康/关停
              ▼
   ┌───────────────────────────────────────────────────────────────┐
   │   内核服务 sidecar (@arclight/core, Bun+Hono, 绑 127.0.0.1)    │
   │   Agent Runtime / 工具系统 / 上下文压缩 / provider 网关 /       │
   │   本地沙箱(nono/系统 bwrap exec) / 持久化(SQLite) / 凭证代理    │
   │   —— 与 Web 端消费的是同一份内核, 桌面零业务逻辑重写 ——        │
   └───────────────────────────────────────────────────────────────┘
        │(本地模式: 业务流量全走 loopback HTTP/SSE, 不走 stdio 大流量)
        └─── 或 远程模式: WebView 直连 https://remote-kernel (OAuth2.1, 不 spawn sidecar)
```

### 1.2 两条数据路径的纪律(地基1 落地)

**关键分工**:Tauri WebView↔内核的**业务流量绝不走 Tauri IPC,也不走 sidecar stdio**——而是 WebView 直接发 HTTP/SSE 到 `127.0.0.1:<port>`(loopback)。

- **路径①(主路径,业务流量)**:WebView 内的 `@arclight/client-core` 直接对内核发 C1 HTTP POST / 订阅 C2 SSE / 按需开 C3·C4 WS。**与 Web 端走的是同一套传输代码**,只是 baseURL 从同源换成 loopback。理由(地基1 §1.2):stdio 在大流量(token 流/截图帧)下背压差,loopback HTTP 已足够快,且复用 Web 全部 reducer/重连逻辑。
- **路径②(IPC,仅平台能力)**:WebView 经 Tauri `invoke`/`event` 调 Rust 壳的原生命令——**只承载「平台能力」**(开文件对话框、弹系统通知、读 keychain、注册快捷键、收 deep-link 回调),**不承载任何 agent 业务**。这正是 cline `HostProvider` 模式(地基1 §3.3 采纳):前端通过 `HostProvider` 接口抽象平台依赖,Web 实现走浏览器 API、桌面实现走 Tauri IPC,**同一前端代码两端通吃**。

**sidecar stdio 只做三件事**(地基1 §1.2 硬纪律):① 启动握手(内核 stdout 打一行 `{"port","token","pid"}` JSON,Rust 壳读到后把 baseURL+token 注入 WebView);② 健康探针;③ 优雅关停信令。**绝不把 token 流/截图帧塞进 stdio。**

### 1.3 连接发现与编排(地基1 §6.4 统一约定)

Rust 壳层「连接发现/编排」按固定顺序(失败回退),与全端统一:

1. 环境变量 `ARC_SERVER_URL` 显式指向远程 → WebView 直连远程,走 OAuth2.1,**不 spawn sidecar**。
2. 读 `~/.config/arclightagent/server.json`(已存在的本地 sidecar 写入的 `{port, token, pid}`,**仅端口+短期 token,无密钥本体**)→ loopback 直连,复用同机已运行内核(与 CLI/Chrome 扩展**共享同一进程**)。
3. 无可复用 sidecar → 自启本地内核 sidecar → 内核 stdout 握手 → 写 `server.json` → 连。
4. 用户显式选「连远程」→ 走路径①远程分支。

> **单内核多端共享(地基1 §6.1)**:桌面 spawn 的 sidecar 内核,可被同机 CLI / 本地 Web / Chrome 扩展经 `server.json` 端口发现复用同一进程,避免每端各起一个内核。

---

## 2) 技术选型与关键依赖(与主蓝图栈一致)

| 层 | 选择 | 与主蓝图/地基一致性 |
|---|---|---|
| **桌面壳框架** | **Tauri 2.0**(系统 WebView,~12MB) | §2.1/§8「桌面壳=Tauri 2.0,不用 Electron」;§7「Tauri 覆盖 iOS/Android」 |
| **壳层语言** | **Rust**(Tauri core)+ 最薄命令层 | 仅承载平台能力,非业务;与「沙箱 helper 可 Rust」(§2.1)同语言基线 |
| **前端(WebView 内)** | **Next.js(App Router,静态导出)+ Vercel AI SDK v6 + assistant-ui** | §2.1 前端栈;**与 Web 端同源,直接复用**(§7「复用 Web 前端代码」) |
| **客户端事件层** | `@arclight/client-core`(reducer/重连,端无关共享包) | 地基1 §2.2:16ms coalescing / 250ms 退避 / seq 去重,六端复用 |
| **类型源** | `@arclight/protocol`(共享 TS 类型) | §2.1/§8「MVP 单 repo 共享 TS 类型,零 codegen」;桌面属「第二端」消费 OpenAPI→TS SDK + 自建流式 codegen(后置阶段五) |
| **平台能力抽象** | `HostProvider`(desktop 实现) | 地基1 §3.3 采纳 cline HostProvider 模式;**不采纳其 protobuf/gRPC-over-postMessage** |
| **Sidecar 内核** | `@arclight/core`(Bun+Hono),Tauri externalBin 嵌入 | §2.1 内核栈;Bun `--compile` 单二进制作 sidecar 产物 |
| **密钥存储** | **`keyring` crate**(MIT/Apache-2.0)→ Keychain/DPAPI/libsecret;**`tauri-plugin-stronghold` 兜底** | 地基3 §2.2;`keyring` 许可证合规(地基3 §2.4) |
| **更新** | **`tauri-plugin-updater`**(minisign 签名增量) | §7/地基3 §4「Tauri updater 签名更新」 |
| **原生集成插件** | `tauri-plugin-notification` / `-global-shortcut` / `-shell`(开系统浏览器)/ `-deep-link` / `-autostart` / `-single-instance` / `-dialog` / `-fs`(受 capability 收窄) | §7 原生集成(托盘/快捷键/文件系统/通知/自动启动) |
| **关键插件许可证** | Tauri 官方插件 **MIT/Apache-2.0**;`keyring` **MIT/Apache-2.0** | §3.6 许可证总判,CI 拦截 GPL/LGPL,新增依赖逐一核对 |

> **不引入项(与主蓝图反面教材一致)**:不用 Electron(§8 痛点);不在桌面壳重写任何能力逻辑;桌面壳不嵌入 LLM 调用/文件 IO 重活(cline `weaknesses_avoid` 教训:heavy lifting 嵌宿主进程导致卡顿 → arclightagent 把 Agent 运行时放独立 sidecar 进程,**桌面正是此结论的体现**)。

---

## 3) 本端承载的能力(依据地基2)及裁剪/适配

桌面端复用 Web 前端全部代码,因此**凡 Web 是主场的能力,桌面同为主场或可用**,并额外获得本地内核 sidecar(离线/本地真实文件)与原生集成(系统通知/托盘/本地文件库)三项增益。

| 能力 | 桌面档位(地基2) | 桌面适配/裁剪要点 |
|---|---|---|
| **写文章** | **主场** | 复用 Web 富文本编辑器全部代码 + **本地文档库直读** + **离线草稿** + **系统级文件保存对话框**(Tauri `-dialog`/`-fs`)。完整 paper-* 四阶段(大纲→草稿→精修→引用)可视化审批 + 章节级 SSE 流式 + 可点击溯源脚注。文档生成(docx/pptx/pdf/latex)后端在内核,桌面经系统保存对话框落本地。**「跨端共享内核、仅 UI 差异」最纯粹一项,桌面零能力重写。** |
| **调研** | **主场** | 复用 Web 调研面板 + **系统通知**(任务完成不必盯浏览器,Tauri `-notification`)+ **本地报告归档**。规划阶段流式 subtopics 审批、thought/进度 SSE、可点击溯源、**断点续研 + 重连状态恢复**(地基1 seq/Last-Event-ID)。长时(3-30min)异步任务 + 系统级通知是桌面优势载体。 |
| **日常规划** | **主场**(与移动并列) | **Tauri 系统通知 + 托盘 + 后台常驻心跳 poll**;每日简报弹窗;看板/checklist 大屏管理。心跳协调器(事件合并/优先级带/活跃时段掩码)在内核统一产出「何时提醒/是否夜间静默」,**桌面只按本端通道(系统通知/托盘)投递**(地基2 §7.2)。生活域工具(Calendar/Gmail)经内核 MCP,**桌面不持 Google 凭证**。 |
| **写代码** | **可用** | WebView 复用 Web 写代码前端(Monaco diff + 反射闭环 + shadow-git 检查点)+ **本地内核 sidecar + 本地文件系统直读** → 沙箱走**本地真实文件**(nono/系统 bwrap exec,与内核同机,无 iframe 跨端开销),而非 Web 的云 iframe 沙箱。**裁剪点**:缺 VSCode 成熟编辑器生态(LSP/SCM/原生 diff),编码主场让位 Web/VSCode,桌面定位为「接近 Web 主场的本地化写代码」。 |
| **computer-use** | **可用→裁剪** | **浏览器 computer-use 可用**:复用 Web 方案(云浏览器 Browserbase/Steel + 截图独立二进制 WS/WebRTC + JPEG/WebP 帧差,C4 媒体面)+ 系统通知。**OS 级 GUI 控制裁剪**(蓝图 OSWorld 路径定性「需自建 + 必须跑沙箱内」,高风险、阶段更靠后)→ 远程沙箱内 + 强 HITL,**非默认,后置**。共性硬边界端无关:沙箱内零凭证 + 凭证代理外置签名放行 + HITL/白名单/审计。 |

> **裁剪总纪律**:桌面凡涉「执行」均守端无关硬边界——默认本地沙箱(桌面有本地后端,优于移动)、凭证沙箱外签名放行。OS 级 computer-use 是桌面唯一明显裁剪项,后置到阶段四及以后。

---

## 4) 鉴权/会话/密钥/离线同步在本端的落地(依据地基3)

### 4.1 鉴权登录(地基3 §1.2 桌面行)

**两种部署模式**:

- **连本地内核(默认)**:Tauri 壳 `spawn` sidecar → sidecar stdio 握手时拿内核随机生成的 `token` → 后续 HTTP/SSE 带 `Authorization: Bearer <sidecar-token>`,内核仅 `127.0.0.1` 接受(**loopback 信任 + 一次性 sidecar token**,地基1 §4.1/地基3 §1.2)。单用户本机无需 OAuth。
- **连远程内核**:**OAuth 2.1 系统浏览器回环流**——`tauri-plugin-shell` 打开**系统默认浏览器**到授权页(**不在 WebView 内嵌登录页**,防钓鱼/cookie 混淆),内核回调 `http://127.0.0.1:<random>/callback`(loopback redirect + PKCE),取 code 换 token。或经 `tauri-plugin-deep-link` 用自定义 scheme(`arclight://`)回 App。

**三类 token 分层(地基3 §1.1,严格不混用)**:app-session token(桌面可持有,落 keychain)/ MCP 工具 OAuth token(永不下发桌面,内核侧)/ provider API key(永不下发桌面,内核侧)。

### 4.2 会话与跨设备(地基3 §3,内核单一真相源)

- 会话历史/transcript/cost rollup 全在内核(SQLite→PG + 乐观锁 epoch),桌面打开同一 session 从内核拉权威态。
- 实时:订阅 C2 SSE(token/工具进度/压缩边界);双向控制(steer/审批回传)走 C3 WS(按需)。
- 跨端会话广播:内核推 `SessionUpdated{epoch}`,桌面据 epoch 决定是否拉新。
- **乐观锁 epoch 复用主蓝图机制**(地基3 §3.5):写带 epoch,不等抛 `StaleEpochError`;**冲突合并 UX / durable 输入后置阶段二**,桌面 MVP 期「最后写赢 + epoch 拒陈旧覆盖 + 刷新不丢」。

### 4.3 密钥(地基3 §2.2 桌面三 OS)

| OS | 安全存储后端 | 接入 | 备注 |
|---|---|---|---|
| macOS | **Keychain** | `keyring` crate | Touch ID 可选门控 |
| Windows | **DPAPI / Credential Manager** | `keyring` crate | per-user 加密 |
| Linux | **libsecret**(Secret Service/gnome-keyring/KWallet) | `keyring` crate | **无 keyring 守护进程时回落 `tauri-plugin-stronghold`**(口令派生 KDF 的本地加密文件,**非明文**),绝不写明文 `~/.config` |

**纪律**:`~/.config/arclightagent/` 只存**非密配置**(模型偏好/UI/agent profile/设备 ID)+ session **句柄/server.json**(端口+短期 token,**非密钥本体**);任何密钥本体走上述安全后端(地基3 §2.4「禁明文 `~/.config`」)。

### 4.4 离线模式(地基3 §3.4,桌面=强)

桌面 `spawn` 本地内核 sidecar → **本地即真相源,完全离线可用**(本地沙箱、本地文件、本地 SQLite)。MVP 单用户本地模式天然离线。联网时若用户同时用远程内核,按 epoch 做合并(冲突合并 UX 后置阶段二)。这是桌面相对 Web/Chrome(弱离线)的核心增益。

### 4.5 配置同步(地基3 §3.2 三层)

机器级本地配置存 `~/.config/arclightagent/`(XDG,非密,不上行);用户级配置(agent profile/模型偏好/Skills 启用集/quota 视图)以内核为权威,桌面拉取+本地缓存,改写经内核;密钥不跨端明文同步,仅同步「引用」。

---

## 5) 打包/分发/自动更新与平台合规

### 5.1 打包(Tauri bundler)

| 平台 | 产物 | 签名/公证要求 |
|---|---|---|
| macOS | `.dmg` / `.app` | **代码签名(Developer ID)+ notarize 过 Gatekeeper**(否则用户首启被拦) |
| Windows | `.msi` / `.exe`(NSIS) | **代码签名证书**(EV 证书可免 SmartScreen 预热) |
| Linux | `.AppImage` / `.deb` / `.rpm` | minisign 自签(无强制商店签名) |

**sidecar 嵌入**:内核以 Bun `--compile --bytecode` 单二进制作 Tauri `externalBin`(per-target 命名 `core-<triple>`),随壳一起签名打包。**Linux 沙箱纪律(§3.4)**:内核 sidecar 在 Linux 只 `exec` 系统安装的 bwrap,**不 vendoring/链接 LGPL bwrap 源码**,桌面打包产物零 bubblewrap 源码,CI 拦截 GPL/LGPL 入树。

### 5.2 分发与自动更新(地基3 §4)

- **更新通道**:`tauri-plugin-updater`,**minisign 签名增量更新**,公钥内置 App。update server 走自托管 / GitHub Releases。
- **更新流程**:启动/定时检查 → 拉签名 manifest → 验签 → 下载增量 → 验签 → 替换 → 重启。**更新包必须签名,验签失败拒绝安装**(地基3 §4 统一纪律)。
- **sidecar 与壳协同更新**:壳更新时连带替换内嵌内核 sidecar 二进制;运行中检测到 sidecar/壳版本不匹配 → 走「端连内核时上报 client 版本,内核按兼容矩阵决定降级/提示升级」(地基3 §4 版本协商),避免协议漂移。

### 5.3 平台合规(商店审核等)

- **macOS/Windows 直分发(非商店)**:无商店审核周期,但 **notarize(macOS)/ 代码签名(Windows)是硬门槛**,无签名用户无法顺畅安装。这是桌面相对 Web(秒级部署)的合规成本,但**远低于移动 App Store(1-3 天)/ Chrome Store(数小时-数天)审核**(地基3 §4)。
- **可即时更新性**:桌面经 Tauri updater **可近即时下发更新**(无商店审核),因此安全关键逻辑虽收敛内核,桌面壳本身的紧急修复也能快速触达——优于移动/Chrome 端。
- **若上 Mac App Store(可选,后置)**:需走 App Sandbox 严格沙箱,**会限制 spawn sidecar / 本地文件直读 / 全局快捷键**——与桌面核心增益冲突。**结论:桌面主分发走直分发(签名+公证),Mac App Store 仅作可选受限版本,非主路径。**
- **许可证合规**:打包产物零 GPL/LGPL 源码;Apache-2.0 复制文件带 NOTICE;新增 Tauri 插件/`keyring` 均 MIT/Apache-2.0(§3.6 强制清单)。

---

## 6) 本端特有的硬约束与坑(诚实)及缓解

| # | 硬约束/坑 | 诚实定性 | 缓解 |
|---|---|---|---|
| 1 | **系统 WebView 碎片化** | Tauri 用各 OS 系统 WebView(macOS WKWebView / Windows WebView2 / Linux WebKitGTK),**渲染行为/Web API 支持不一致**,Linux WebKitGTK 尤其落后(SSE/WS/某些 CSS 表现差异)。这是 Tauri 相对 Electron(自带 Chromium)的固有代价。 | 前端按系统 WebView 最低公倍数能力开发;CI 加三平台 WebView E2E;SSE 长连在 WebKitGTK 上做额外重连兜底;Windows 确保 WebView2 Runtime 随包分发或引导安装。 |
| 2 | **Linux WebView2/WebKitGTK 依赖与发行版差异** | Linux 用户需 `webkit2gtk` 运行库,不同发行版包名/版本不一,易「装上跑不起来」。 | `.deb`/`.rpm` 声明依赖;`.AppImage` 尽量自带;文档列依赖;提供 PWA「安装到桌面」作 Linux 兜底(主蓝图「先 PWA 过渡」正是此用)。 |
| 3 | **sidecar 生命周期/孤儿进程** | spawn 的 Bun 内核子进程若壳崩溃/强杀,可能成孤儿进程占端口;多端复用同一 sidecar 时「谁负责关停」不清。 | stdio 健康探针 + 关停信令(地基1);内核绑 `127.0.0.1` 随机端口 + pid 写 `server.json`,启动时检测 stale pid 清理;`tauri-plugin-single-instance` 防多壳争抢;sidecar 设空闲超时自退(无端连接 N 分钟后)。 |
| 4 | **loopback 端口冲突/被占** | 固定端口易冲突,随机端口需可靠发现。 | 随机端口 + `server.json` 发现(地基1 §6.4);端口写文件原子操作;失败重试换端口。 |
| 5 | **stdio 大流量误用** | 若图省事把 token 流/截图帧塞 stdio,背压/缓冲行为差(地基1 §1.2 已警告)。 | **架构强制**:stdio 仅握手/健康/关停,业务全走 loopback HTTP/SSE,C4 截图走独立二进制 WS/WebRTC,**绝不混入 stdio 或 SSE**。 |
| 6 | **macOS notarize / Windows 代码签名成本与流程** | 无签名/公证 → 用户被 Gatekeeper/SmartScreen 拦,体验崩。证书/公证有成本和 CI 集成复杂度。 | CI 集成签名+公证流水线(需 macOS runner + Windows runner);证书纳入发布前置;首发前预留证书申请周期。 |
| 7 | **多端并发状态(cline 实证教训)** | cline `weaknesses_avoid` 坦承「StateManager 无跨实例同步」。桌面+Web+CLI 同连一内核或多内核时状态需中央协调。 | **内核单一真相源 + epoch 乐观锁 + SessionUpdated 广播**(地基3 §3),从根上避免 cline 的多实例缓存不同步问题;冲突合并 UX 后置阶段二。 |
| 8 | **Tauri 移动/桌面插件成熟度参差** | 部分 Tauri 2 插件(stronghold/keychain 桥)在某些平台仍不够稳。 | 密钥优先 `keyring` crate(成熟),Stronghold 仅 Linux 无 keyring 时兜底;插件逐一在三平台验证;不稳插件不进 MVP。 |
| 9 | **Linux keyring 缺失** | headless/精简 Linux 桌面无 Secret Service 守护进程。 | 回落 `tauri-plugin-stronghold`(口令派生 KDF 本地加密文件,**非明文**)或提示用 `pass`,**绝不写明文 `~/.config`**(地基3 §2.2)。 |
| 10 | **「先 PWA 过渡」的双轨维护** | 主蓝图明确桌面「先 PWA 过渡」,意味着一段时间 PWA 与原生 Tauri 壳并存。 | 因前端 100% 复用,PWA 与 Tauri 壳共享同一前端代码;`HostProvider` 抽象使「平台能力缺失」在 PWA 下优雅降级(无托盘/无本地 sidecar),迁移到 Tauri 壳零前端改动。 |

---

## 7) 与其他端/内核的代码复用边界

```
┌─────────────────────────────────────────────────────────────────────────┐
│  内核(零复用边界内):@arclight/core —— Agent Runtime/工具/压缩/沙箱/      │
│  provider 网关/持久化/凭证代理。桌面 100% 消费,零重写。                    │
├─────────────────────────────────────────────────────────────────────────┤
│  全端共享包(桌面直接 import):                                            │
│   · @arclight/protocol   —— 类型源(ArcEvent/命令/响应), 零 codegen        │
│   · @arclight/client-core —— 事件 reducer/重连/coalescing/去重(端无关)    │
│   · Web 前端(Next.js+AI SDK+assistant-ui)—— 桌面 WebView 整体复用         │
├─────────────────────────────────────────────────────────────────────────┤
│  桌面端特有(不复用,~占本端代码量小头):                                  │
│   · Rust 壳层 tauri-core(sidecar 管理/连接发现/原生集成命令/安全存储桥)   │
│   · HostProvider 的 desktop 实现(平台能力 → Tauri IPC 映射)              │
│   · 打包/签名/updater 配置(tauri.conf.json + CI 签名流水线)              │
└─────────────────────────────────────────────────────────────────────────┘
```

**复用边界纪律**:

- **与 Web 端**:**前端代码近 100% 复用**(同 Next.js + AI SDK + assistant-ui)。差异**只在 `HostProvider` 实现**——Web 实现走浏览器 API(`fetch`/`EventSource`/Web Notifications/File System Access),桌面实现走 Tauri IPC(loopback HTTP/系统通知/本地 FS/对话框)。这是 cline `HostProvider` 模式的直接采用(地基1 §3.3)。
- **与 CLI 端**:**共用 sidecar 内核二进制**(同 `@arclight/core` Bun `--compile` 产物)+ 共用 `@arclight/protocol`/`@arclight/client-core`;**共用 `server.json` 连接发现协议**(同机可复用同一内核进程)。CLI 的 OpenTUI 前端与桌面 WebView 前端不复用(载体不同)。
- **与 VSCode/Chrome 端**:共用 `@arclight/protocol`/`@arclight/client-core`/内核;UI/host 实现各异(VSCode webview+postMessage,Chrome side panel+SW WS)。
- **绝不复用/绝不重写**:桌面**不重写任何能力逻辑**(全在内核);Rust 壳层**不实现业务**(仅平台能力)。

---

## 8) 工作量量级、前置依赖与排期位置

### 8.1 排期位置

主蓝图 §7 桌面 = **P3(且明确「先 PWA 过渡」)**;§9 路线图把「全平台壳」整体放 **阶段五(全平台壳 + 多租户服务化 + 高级编排 + 省钱,~6-8 周)**。因此:

- **阶段一-四**:桌面以 **PWA「安装到桌面」过渡**(主蓝图反复强调),零原生壳工作量——因前端 100% 复用,PWA 自动可用。
- **阶段五**:正式产出 Tauri 2.0 原生壳。**本详设供阶段五落地。**

### 8.2 前置依赖(硬)

1. **Web 前端已稳定**(阶段一交付):桌面 WebView 直接复用,前端不稳则桌面无从复用。
2. **内核可作 sidecar 独立分发**(`@arclight/core` Bun `--compile` 单二进制 + stdio 握手协议):地基1 §1.2 的握手契约需先在 CLI(P2)落地验证,桌面复用。
3. **`@arclight/protocol` + `@arclight/client-core` 已抽出为端无关共享包**:即地基1 的「第二端起」基建(OpenAPI→TS SDK + 自建流式 codegen,主蓝图 §9 阶段五),桌面是其消费者。
4. **CLI(P2)先行验证 sidecar 模式 + `server.json` 连接发现 + keychain 接入**:桌面与 CLI 共用这套本地内核基建,CLI 先趟平。
5. **签名/公证证书就绪**(macOS Developer ID + Windows 代码签名证书):发布前置,需提前申请。

### 8.3 工作量量级(粗估,相对量)

> 因前端 100% 复用、能力零重写,桌面端净增工作量**集中在 Rust 壳层 + 打包签名**,量级**小于**一个从零的新端。

| 工作块 | 量级 | 说明 |
|---|---|---|
| Rust 壳层(sidecar 管理 + 连接发现 + 单实例锁) | 中 | 与 CLI 共用握手/发现协议,主要是 Tauri 集成 |
| 原生集成(托盘/全局快捷键/通知/自动启动/deep-link/文件对话框) | 中 | 逐插件三平台验证,平台差异是主要消耗 |
| `HostProvider` desktop 实现 | 小 | 接口已由 Web 端定义,桌面只填 Tauri IPC 映射 |
| 安全存储桥(`keyring` + Stronghold 兜底) | 小-中 | Linux keyring 缺失分支是难点 |
| 打包/签名/公证/updater(三平台 CI) | 中-大 | macOS notarize + Windows 签名 + 三平台 WebView E2E 是主要复杂度 |
| **合计** | **占阶段五全平台壳的一部分** | 桌面是阶段五~6-8 周内的一块,非独立大阶段 |

**一句话定位**:桌面端 = **「Web 前端 + 本地内核 sidecar + Rust 薄壳 + 原生集成」的组合装配**,核心价值是「本地优先/离线/原生体验」三项增益,工作量集中在壳层与签名分发,**与主蓝图 §7「同一内核服务、各端只换壳」「先 PWA 过渡」决策完全一致,无新增矛盾选型**。

---

## 与主蓝图/地基一致性自检

- ✅ **桌面壳=Tauri 2.0 不用 Electron**(§2.1/§8);**先 PWA 过渡**(§7);**~12MB 系统 WebView**(§7)。
- ✅ **薄客户端零能力重写**,前端复用 Web,业务全在内核(§7/§5.4);Rust 壳仅平台能力。
- ✅ **地基1**:sidecar stdio 仅握手/健康/关停,业务走 loopback HTTP/SSE(C1/C2),C3 WS 按需,**C4 截图独立二进制通道绝不混入**;`server.json` 连接发现 + 单内核多端共享。
- ✅ **地基2**:写文章/调研/日常规划=主场,写代码=可用,computer-use=可用→裁剪(OS 级后置);裁剪根因诚实。
- ✅ **地基3**:鉴权=localhost 信任/OAuth2.1 系统浏览器回环(不内嵌登录页);密钥=`keyring`→Keychain/DPAPI/libsecret + Stronghold 兜底,**禁明文 `~/.config`**;离线=强(本地 sidecar);epoch 乐观锁复用,冲突合并/durable 后置阶段二;更新=Tauri updater 签名增量。
- ✅ **采纳 cline HostProvider 模式,不采纳 protobuf/gRPC-over-postMessage**(地基1 §3.3);吸收 cline「heavy lifting 勿嵌宿主进程」「StateManager 无跨实例同步」教训(weaknesses_avoid)。
- ✅ **许可证**:Linux 沙箱只 exec 系统 bwrap 不连带 LGPL(§3.4);新增依赖(`keyring`/Tauri 插件)MIT/Apache-2.0;CI 拦截 GPL/LGPL;Apache-2.0 复制带 NOTICE(§3.5/§3.6)。
- ✅ **排期**:P3 / 阶段五全平台壳;前置=Web 前端稳定 + 内核 sidecar 化 + 共享包抽出 + CLI 先验 + 签名证书。

源文件:`/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md`(§2.1 栈 / §7 跨平台 / §8 决策表 / §9 路线图);`/Users/fsm/project/arclightagent/research/data/repo-cline.json`(HostProvider 模式 / weaknesses_avoid 教训);三条地基(协议契约 / 能力×端落点 / 横切)为本详设直接上位约束。