I now have full context on all five blueprint decisions. I have everything needed to produce the cross-cutting concerns design document, fully consistent with the blueprint's kernel/选型/security/license decisions. I'll output the Markdown directly.

---

# arclightagent 全平台架构详设 ·【跨端横切关注点】

> 本文是 `/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md` 主蓝图的下沉详设,六端 = Web / 桌面(Tauri 2)/ 移动(Tauri 2 iOS+Android)/ CLI / VSCode 插件 / Chrome 扩展(MV3)。
> **铁律(与主蓝图一致,不另起炉灶):**
> 1. 内核是**唯一真相源**:headless agent server(Bun + Hono),`server/client` 彻底分离,各端皆为薄客户端。任何"业务/状态/密钥落地"决策只能在内核做一次。
> 2. **凭证一律在沙箱外、按动作签名放行,沙箱内零真实凭证**(主蓝图 §5.5 / M1)。本文把这条纪律从"执行域"扩展到"浏览器无安全本地存储域"。
> 3. **禁明文 `~/.config`**(主蓝图 §5.5/§7/§8)。各端密钥走各自 OS 安全存储;**无安全本地存储的端(Chrome 扩展、Web)必须经内核中转,本端零长效密钥**。
> 4. **MVP 仅 Web 单端**;CLI/桌面/移动/VSCode/Chrome 为 P2-P4 后续阶段(主蓝图 §7 / §9)。本文给出六端**全量详设**供分阶段落地,但凡标注 `[MVP]` 即阶段一必交付,其余标注所属阶段。
> 5. 许可证纪律全程继承:Apache-2.0 复制带 NOTICE;Linux 沙箱只 `exec` 系统 bwrap;CI 拦截 GPL/LGPL 入树。本文新增的依赖一律核对许可证。

---

## 0) 横切关注点 × 六端 总览矩阵

| 关注点 \ 端 | Web `[MVP/P0]` | 桌面 Tauri2 `[P3]` | 移动 Tauri2 iOS/Android `[P3]` | CLI `[P2]` | VSCode 插件 `[P3]` | Chrome 扩展 MV3 `[P4]` |
|---|---|---|---|---|---|---|
| **鉴权登录方式** | OAuth2.1/PKCE(浏览器跳转)/ localhost 信任(自托管) | localhost 信任(本地内核)/ OAuth2.1 系统浏览器回环 | 设备码流(device_code) + ASWebAuthenticationSession/Custom Tabs | **设备码流**(无浏览器环境) | 复用 VSCode `authentication` provider / 设备码流 | OAuth2.1/PKCE(`chrome.identity.launchWebAuthFlow`) |
| **token 存储** | httpOnly Cookie(同源) / 内核 session,前端**不持 refresh token** | OS keychain(via Tauri stronghold/Stronghold 插件 或 keyring) | iOS Keychain / Android Keystore(via Tauri 插件) | OS keychain(Keychain/DPAPI/libsecret) | VSCode `SecretStorage`(底层即 keychain/DPAPI/libsecret) | **不持长效 token**;短效 access token 存 `chrome.storage.session`(内存),refresh 由内核保管 |
| **密钥(provider key 等)** | **不存本端**,内核保管 | OS keychain | iOS Keychain / Android Keystore | OS keychain | VSCode `SecretStorage` | **不存本端**,内核中转 |
| **配置真相源** | 内核 server(SQLite→PG) | `~/.config/arclightagent`(XDG) + 内核同步 | App 沙箱容器目录 + 内核同步 | `~/.config/arclightagent`(XDG) + 内核同步 | VSCode `globalState`/settings + 内核同步 | `chrome.storage.local`(仅 UI 偏好)+ 内核同步 |
| **离线模式** | 弱(PWA 缓存只读) | 强(本地内核可离线跑) | 中(本地内核可选;否则只读缓存) | 强(本地内核) | 中(依 VSCode 网络) | 弱(service worker 缓存只读) |
| **分发/更新通道** | 即时部署 / PWA SW 更新 | Tauri updater(签名增量) | App Store / Play 商店审核 | 自更新(GitHub Releases + install.sh) | VSCode Marketplace | Chrome Web Store(MV3 审核) |
| **可观测/计费/审计归集** | 内核 Langfuse + 统一审计日志(本端零落地) | 同左,经内核 RPC | 同左,经内核 RPC | 同左,经内核 RPC | 同左,经内核 RPC | 同左,经内核 RPC |

> **读法:横切关注点的"真相"全在最左不可见的一列——内核**。表格里各端列描述的只是"该端如何安全地把请求/凭证句柄/遥测托管给内核",而非各自实现一套。

---

## 1) 鉴权与会话(Authentication & Session)

### 1.1 统一身份模型(内核侧,所有端共享)

继承主蓝图 §5.5:**"用户登录 arclightagent 本身"是一等体系**,不止用于 MCP 工具。内核维护:

- `User`(身份)→ `Tenant`(租户,主蓝图 §5.6,MVP 单租户但从第一天按 `tenant_id` 建模)→ `Session`(会话)→ `Device`(设备,跨端区分)。
- **三类 OAuth token 严格分层,不可混用**(这是各端安全差异的根因):
  1. **app-session token**:用户登录 arclightagent 本身 → 各端持有(或持有其句柄)。
  2. **MCP/工具 OAuth token**(Google Calendar / Gmail / GitHub 等)→ **永不下发到任何端**,只存内核侧凭证代理(KMS/keychain 信封加密)。
  3. **provider API key**(Anthropic/OpenAI/…)→ 同 2,内核侧,端不可见。

### 1.2 各端登录方式(逐端)

#### Web `[MVP/P0]`
- **自托管单用户(MVP 默认)**:`localhost 信任`——内核绑定 `127.0.0.1`,同源前端默认信任本机请求,首启生成一次性 pairing secret 写入 `~/.config/arclightagent/session.key`(0600),前端通过同源 httpOnly Cookie 拿 session,**前端 JS 永不接触 refresh token**(防 XSS 窃取)。
- **多端/公网起(P5 多租户)**:**OAuth 2.1 + PKCE**(Auth.js/Clerk),授权码经后端交换,refresh token 只在内核侧 KMS 加密存储,前端只持短效 access(放 httpOnly Cookie,`SameSite=Lax`,`Secure`)。
- 速率限制 / 滥用防护(主蓝图 §5.5):每 user / 每 IP 配额、突发限流,公网必备。

#### 桌面 Tauri 2 `[P3]`
- **连本地内核(默认)**:Tauri 进程 `spawn` 本地内核 sidecar,走 `localhost 信任` + 单次 pairing(同 Web 自托管)。
- **连远程内核**:**OAuth 2.1 系统浏览器回环流**——`tauri-plugin-shell` 打开系统默认浏览器到授权页,内核回调 `http://127.0.0.1:<random>/callback`(loopback redirect,PKCE),取得 code 换 token。**不在 WebView 内嵌登录页**(防钓鱼、防 cookie 混淆)。

#### 移动 Tauri 2 iOS/Android `[P3]`
- **设备码流(device_code,RFC 8628)为主**——移动端 loopback redirect 受限,改用设备码:App 显示 `user_code` + 验证 URL,用户在任意设备完成授权,App 轮询 `token` 端点。
- **或** 系统受信浏览器会话:iOS `ASWebAuthenticationSession` / Android Custom Tabs(经 Tauri 移动插件桥接),回 App Universal Link / App Link。优先此路径(体验更好),设备码作为兜底。

#### CLI `[P2]`
- **设备码流(device_code)是唯一正解**——CLI 常跑在无浏览器/SSH 远程环境。`arclight login` → 打印 `user_code` + URL(本机有浏览器时顺手 `open`),轮询取 token。借 Claude Code / gh CLI 同款体验。
- 自托管本机时退化为 `localhost 信任`(读 `~/.config/arclightagent/session.key`)。

#### VSCode 插件 `[P3]`
- **首选复用 VSCode `authentication` API**:注册 `AuthenticationProvider`,token 落 VSCode `SecretStorage`(底层即 OS keychain),用户在 VSCode 原生账户面板管理。
- 远程/Web 版 VSCode(vscode.dev)无法 loopback → 回落**设备码流**。
- 与 Chat Participants 集成时,`@arclightagent` 首次触发若未登录,弹 VSCode 原生授权提示。

#### Chrome 扩展 MV3 `[P4]`
- **OAuth 2.1 + PKCE via `chrome.identity.launchWebAuthFlow`**——MV3 标准路径,redirect 到 `https://<ext-id>.chromiumapp.org/`。
- **MV3 service worker 30s 休眠**(主蓝图 caveat / topic-cross-platform):授权流要做成幂等可恢复——若 SW 在轮询中被杀,用 `chrome.alarms` 唤醒续轮询;长连用 WebSocket 保活(连本地内核时)。

### 1.3 Token 存储与刷新(逐端差异)

| 端 | access token 存哪 | refresh token 存哪 | 刷新触发 |
|---|---|---|---|
| Web | httpOnly Cookie | **内核侧 KMS,前端不可见** | 内核侧静默刷新(token 旋转),前端 401→重试 |
| 桌面/移动/CLI | OS 安全存储(见 §2) | OS 安全存储 | 客户端检测过期 → 用 refresh 换新 → 写回安全存储;**refresh 旋转**(一次性)防重放 |
| VSCode | `SecretStorage` | `SecretStorage` | 同上,经 `AuthenticationProvider.getSessions` |
| Chrome | `chrome.storage.session`(内存,SW 重启即失) | **不持有;内核保管**,扩展只拿短效 access | access 过期 → 经内核 `/token/refresh`(内核用其侧 refresh)→ 回发新短效 access |

**统一纪律**:① 所有 refresh token **旋转(rotating refresh)**,检测重用即吊销整条会话链。② access token 短 TTL(15-60min)。③ **登出 = 内核吊销 + 各端清本地句柄**;跨端登出经内核会话广播(见 §3 同步通道)。

---

## 2) 密钥管理(Secrets Management)

### 2.1 核心原则(继承主蓝图 §5.5 + §8,本文细化到六端)

> **三类密钥(§1.1)中,只有 app-session token 类凭据可下发到"有 OS 安全存储的端";provider key / MCP OAuth token 永远只在内核侧,任何端都拿不到明文。** 无安全本地存储的端(Chrome 扩展、Web 前端)连 app-session 的 refresh 都不持有,必须经内核中转。

### 2.2 各端安全存储后端(逐端)

| 端 / OS | 安全存储后端 | 接入方式 | 备注 |
|---|---|---|---|
| **桌面 macOS** | **Keychain** | `tauri-plugin-keychain` 或 `keyring` crate(Rust) | Touch ID 可选门控 |
| **桌面 Windows** | **DPAPI**(`CredMan`/Credential Locker) | `keyring` crate(走 Windows Credential Manager) | per-user 加密 |
| **桌面 Linux** | **libsecret**(Secret Service / gnome-keyring / KWallet) | `keyring` crate / `tauri-plugin-stronghold` 兜底 | 无 keyring 守护进程时回落 Stronghold(本地加密文件 + 用户口令派生 KDF) |
| **移动 iOS** | **iOS Keychain**(kSecClassGenericPassword,`WhenUnlockedThisDeviceOnly`) | Tauri 移动插件桥 Swift Keychain | Secure Enclave 可绑生物识别 |
| **移动 Android** | **Android Keystore**(硬件支持时 StrongBox)+ EncryptedSharedPreferences | Tauri 移动插件桥 Kotlin Keystore | 密钥不出 TEE |
| **CLI** | 同桌面三 OS(Keychain/DPAPI/libsecret) | `keyring` crate(Bun 可经 napi/FFI 或独立 Rust helper) | headless Linux 无 keyring → 提示用户用 `pass`/环境变量注入(不落明文文件) |
| **VSCode 插件** | **`vscode.SecretStorage`** | VSCode API(底层即上述 OS keychain) | 跨 VSCode 实例同步由 VSCode 管 |
| **Web 前端** | **无安全本地存储 → 一律内核中转** | — | localStorage/IndexedDB 视为不可信,**禁存任何密钥** |
| **Chrome 扩展(MV3)** | **无安全本地存储 → 一律内核中转** | — | `chrome.storage` 非加密、可被同机进程读;**禁存长效密钥**;仅存 UI 偏好与短效内存 token |

### 2.3 Web / 浏览器"无安全本地存储 → 内核中转"详设(本任务重点)

浏览器扩展和 Web 前端**没有等价于 OS keychain 的安全本地存储**(`chrome.storage`/IndexedDB/localStorage 皆明文、可被恶意扩展或同机进程读取,且受 XSS 影响)。因此:

1. **provider key / MCP OAuth token 绝不进浏览器**——所有需要这些密钥的调用(LLM 推理、Google API 工具)都在内核侧执行,浏览器只发"动作请求 + app-session"。这与主蓝图 §5.5"沙箱内零真实凭证 + 凭证代理在沙箱外按动作签名放行"是**同一条纪律的浏览器投影**:浏览器即"不可信执行域"。
2. **Chrome 扩展的内核连接**:background service worker 作为 MCP client,**WebSocket 连本地内核**(`ws://127.0.0.1:<port>`,带 pairing 校验)或 HTTPS 连远程内核(带短效 access)。密钥换取动作结果,密钥本身不过线。
3. **短效 access token** 在扩展侧只存 `chrome.storage.session`(SW 内存域,浏览器关闭即清),且 TTL 极短;refresh 全程内核侧。
4. **CSP 硬化**:扩展 `manifest.json` CSP 禁 `eval`/远程脚本(MV3 强制);Web 前端设严格 CSP + Trusted Types,压低 XSS 窃 Cookie 面。

### 2.4 密钥管理统一纪律

- **禁明文 `~/.config`**(主蓝图反复强调):`~/.config/arclightagent/` 只存**非密配置**(模型偏好、UI、agent profile 选择)+ session **句柄/引用**(非 token 本体);任何密钥本体走 §2.2 安全后端。
- **多租户(P5)**:内核侧 **KMS/Vault + 信封加密(envelope encryption)+ 轮换**(主蓝图 §5.5)。per-tenant 数据密钥,主密钥在 KMS。
- **CI 合规**:沿用主蓝图——禁 GPL/LGPL 入树;新增 `keyring`/Stronghold 等依赖核许可证(`keyring` crate MIT/Apache-2.0,合规)。

---

## 3) 配置 / 状态同步(Config & State Sync)

### 3.1 单一真相源 = 内核 server(继承主蓝图 §5.1/§5.4)

**铁律:内核 server 是会话与跨设备状态的唯一真相源**(主蓝图"内核必须做成独立服务,绝不桥接终端进程")。各端**不得**各自维护权威状态;本地只持缓存 + 本地非密偏好。

### 3.2 配置分层(三层)

| 层 | 存哪 | 内容 | 同步策略 |
|---|---|---|---|
| **机器级本地配置** | `~/.config/arclightagent/`(XDG;移动端为 App 沙箱容器目录;VSCode 为 `globalState`;Chrome 为 `chrome.storage.local`) | 端 UI 偏好、本地内核地址、设备 ID、session 句柄(**非密**) | 不上行同步(纯本地) |
| **用户级配置** | **内核(权威)** + 各端缓存 | agent profile、模型/路由偏好、Skills 启用集、quota 视图 | 内核为真相源,端拉取 + 本地缓存;改写经内核 |
| **密钥** | 各端 OS 安全存储 / 内核 KMS(见 §2) | 见 §1.1 三类 | 不跨端明文同步;仅同步"引用" |

### 3.3 跨设备会话同步(经内核为单一真相源)

- **会话历史、transcript、cost rollup**:全在内核(主蓝图 §5.3:SQLite→Postgres + 乐观锁 epoch + migrations)。任一端打开同一 session 都从内核拉权威状态。
- **实时推送**:端订阅内核 **SSE 事件流**(token / 工具进度 / 压缩边界,主蓝图 §5.2);双向控制(steer/审批回传)走 WebSocket(主蓝图 §5.2,P2 起)。
- **跨端会话广播**:用户在设备 A 改了 session,内核经各端订阅的事件流推 `SessionUpdated{epoch}`,设备 B 收到后用 epoch 决定是否拉新(见 §3.5)。

### 3.4 离线模式(逐端能力,见 §0 矩阵)

- **桌面/CLI(强离线)**:本地 `spawn` 内核 sidecar,**本地即真相源**,完全离线可用;联网时与远程内核做合并(若用户同时用远程)。MVP 单用户本地模式天然离线。
- **移动(中)**:本地内核可选(电量/性能权衡);否则 PWA-style 只读缓存 + 联网恢复。
- **Web / Chrome(弱)**:Service Worker 缓存最近 session 只读快照,**离线只读**,写操作排队待联网(乐观 UI,提交时按 epoch 校验)。

### 3.5 重连合并与乐观锁(epoch,继承主蓝图 §5.3)

> **复用主蓝图既定机制,不另造:乐观锁 epoch(`StaleEpochError`,借 opensquilla `session/storage.py`)。注意 epoch 是并发控制,不是租户隔离(隔离见主蓝图 §5.6)。**

- **写路径**:端提交变更带其读到的 `epoch`;内核比对——相等则接受并 `epoch++`,不等抛 `StaleEpochError`。
- **离线写队列重连合并**:端离线期攒的乐观变更,重连后逐条按 epoch 重放;冲突项(epoch 落后)走**合并 UX**(主蓝图明确把"epoch 冲突合并 UX"列为高 bug 密度特性,**后置到阶段二**,MVP 只做"刷新不丢"最朴素版:服务端短缓冲 + 重连续推)。
- **多端并发输入**:durable 输入(steer/queue + advisory wake)同样**后置到阶段二**(主蓝图 §5.3/路线图)。MVP 期多端并发以"最后写赢 + epoch 拒绝陈旧覆盖"兜底。

---

## 4) 分发与自动更新(Distribution & Auto-update)

> 逐端打包与更新通道,继承主蓝图 §7 跨平台策略 + topic-cross-platform 调研。**审核周期差异是各端发布节奏的根本约束**,需在路线图排期时显式对齐。

| 端 | 打包 | 更新通道 | 审核/上线周期 | 关键纪律 |
|---|---|---|---|---|
| **Web `[MVP]`** | Next.js 部署(Vercel/自托管) | **即时部署** + PWA Service Worker 版本化缓存 | **秒级/分钟级**(无审核) | SW 更新用 skipWaiting + clients.claim,提示用户刷新;PWA Manifest 让"安装到桌面" |
| **桌面 Tauri2 `[P3]`** | Tauri bundler(.dmg/.msi/.AppImage/.deb) | **Tauri updater**(签名增量更新,`tauri-plugin-updater`) | 即时(自托管 update server / GitHub Releases) | **更新包必须签名**(minisign/updater key),公钥内置;macOS 需 notarize 过 Gatekeeper;Windows 需代码签名证书 |
| **移动 Tauri2 iOS `[P3]`** | Xcode → IPA | **App Store** | **审核 1-3 天**(可能更久),不可热更原生代码 | WebView 内 JS 资产可经远程配置微调(不违反商店政策的范围内);原生壳更新走商店 |
| **移动 Tauri2 Android `[P3]`** | Gradle → AAB | **Google Play** | **审核数小时-数天** | 同上;分阶段灰度发布(staged rollout) |
| **CLI `[P2]`** | **Bun `--compile --bytecode`** 单二进制 + arg0 multicall(主蓝图 §7) | **自更新**:GitHub Releases 多平台产物 + `install.sh` 一键;`arclight upgrade` 检查版本下载替换 | 即时 | 跨平台编译 8 target;Windows 元数据需 Windows runner;macOS 二进制需签名+公证;校验 checksum/签名再替换 |
| **VSCode 插件 `[P3]`** | `vsce package` → .vsix | **VSCode Marketplace**(`vsce publish`) | **数分钟-数小时**(基本自动,偶人工) | 复用 Chat Participants + MCP 注册;遵守 Marketplace 政策;Open VSX 同步发布(覆盖 VSCodium/Cursor) |
| **Chrome 扩展 MV3 `[P4]`** | zip 扩展包 | **Chrome Web Store** | **MV3 审核数小时-数天**(权限多/敏感 API 时更久) | MV3 禁远程 JS,所有逻辑随包审核;最小化权限声明(`host_permissions` 收窄);敏感权限触发深审 |

**统一纪律**:① **签名/校验贯穿所有自更新通道**(Tauri updater 签名、CLI checksum+签名、商店天然签名)。② **商店审核周期(移动 1-3 天、Chrome/VSCode 数小时-数天)必须前置进路线图排期**——这些端的紧急修复无法即时上线,故安全关键逻辑应尽量收敛在**可即时更新的内核**侧,端只做薄壳(再次印证"薄客户端"架构的运维价值)。③ 内核与端**版本协商**:端连内核时上报 client 版本,内核按兼容矩阵决定降级/提示升级,避免协议漂移。

---

## 5) 可观测 / 计费 / 审计的多端统一归集(Telemetry / Billing / Audit)

> **核心结论:三者全部归集到内核,端侧零落地。** 这是"薄客户端 + 内核单一真相源"架构的直接红利,也消除了"各端各记一套、口径不一"的反模式。继承主蓝图 §2.1 可观测性 + 计费/计量 + 统一审计日志去向。

### 5.1 为什么必须在内核归集(而非各端)

- **计费真金白银发生在内核**:LLM token、E2B 沙箱时长、Browserbase/Steel 云浏览器会话、外部 API 调用——**全部由内核代理发起**(端拿不到 provider key)。因此计量点天然在内核,端无法也不应自计。
- **多代理 ~15× token 放大**(主蓝图 §6.3 / 风险表):成本归因必须 per-user + per-session + per-subagent,只有内核有完整 span 树。
- **审计完整性**:认证失败、权限提权、计费事件、computer-use 动作放行——跨端统一落一处才可审计(主蓝图 §2.1 纠正"审计只挂 computer-use"的不全)。

### 5.2 统一归集架构(内核侧)

```
[六端薄客户端] --(请求携带: user/tenant/device/client-version/trace-context)--> [内核]
        │  端侧只上报: ① 客户端错误/崩溃(可选,脱敏) ② 交互埋点(可选)
        ▼
  ┌──────────────── 内核归集层(单一去向)────────────────┐
  │ 可观测: Langfuse(trace, 单次 research 40-200 span)    │
  │          + 结构化日志聚合 + 指标(Prometheus/OTel)     │
  │ 计费:   per-user metering(token/沙箱时长/云浏览器/外部调用)│
  │          + quota 强制 + cost-attribution(到 user/session/subagent)│
  │ 审计:   统一审计日志(认证失败/权限提权/计费/computer-use 动作放行/数据导出删除)│
  └────────────────────────────────────────────────────┘
```

### 5.3 各端如何接入(逐端,薄)

| 端 | 上行遥测(端→内核) | 计费触发点 | 审计事件来源 |
|---|---|---|---|
| Web/桌面/移动/CLI/VSCode/Chrome | 统一在请求头带 **trace-context(W3C traceparent)+ device-id + client-version**;内核据此把该端动作挂进同一 trace | **端不计费**;内核在代理 LLM/沙箱/云浏览器调用处计量 | 端的"登录/审批确认/高危动作请求"由内核记审计;**端不写审计** |
| Chrome(MV3 特例) | SW 短命,遥测改为**内核侧重建**:扩展只发动作请求,trace 由内核组装 | 同上 | computer-use 浏览器侧动作经内核放行 → 内核记审计 |

**统一纪律**:① **trace-context 跨端透传**——一个用户从 Web 发起、CLI 续跑的同一 session,在 Langfuse 里是一条连续 trace。② **端侧崩溃/错误上报可选且脱敏**(不含密钥/PII),且与计费/审计**物理隔离**(不同管道),防端侧噪声污染计费口径。③ **quota 在内核强制**(端只展示余量视图),防绕过。④ 数据导出/删除(主蓝图 §5.5,GDPR-类)也归内核统一执行并记审计——端只发起请求。

---

## 6) 与主蓝图一致性自检 & 关键风险

**一致性自检(逐条对齐,无矛盾、无另起炉灶):**
- 内核单一真相源 / server-client 分离 / 绝不桥接进程 → §1.1 §3.1 §5.1 ✔(主蓝图 §5.1/§5.4/反面教材 1)
- 凭证沙箱外签名放行、沙箱内零凭证 → 扩展为"浏览器=不可信执行域,密钥经内核中转" §2.3 ✔(主蓝图 §5.5/M1)
- 禁明文 `~/.config`,各端 OS 安全存储 → §2.2 ✔(主蓝图 §5.5/§8)
- 乐观锁 epoch 是并发控制非隔离;durable 输入/冲突合并 UX 后置阶段二 → §3.5 ✔(主蓝图 §5.3/路线图)
- 桌面 Tauri 2 不用 Electron;CLI Bun --compile + multicall;VSCode Chat Participants + MCP;Chrome MV3 side panel + SW → §1/§4 ✔(主蓝图 §7)
- 计费/审计/可观测归内核统一,认证/计费/提权/computer-use 全审计 → §5 ✔(主蓝图 §2.1)
- 许可证纪律(Apache NOTICE / 禁 GPL-LGPL / CI 拦截)延续,新依赖(`keyring` 等)核为 MIT/Apache → §2.4 ✔(主蓝图 §3.4-3.6)
- MVP 仅 Web 单端,其余端标注阶段 → 全文 `[MVP]/[P2-P4]` 标注 ✔(主蓝图 §9)

**本详设引入的关键风险(供下一轮评审):**
1. **Chrome MV3 service worker 30s 休眠**冲击长任务鉴权/SSE 长连——缓解:WebSocket 保活 + `chrome.alarms` 唤醒 + 状态持久化(主蓝图 caveat 已记)。
2. **设备码流的钓鱼面**(用户被诱导授权)——缓解:`user_code` 短 TTL + 设备绑定提示 + 内核侧异常地理/设备告警入审计。
3. **跨端登出/吊销的传播延迟**——缓解:refresh 旋转 + 短 access TTL,使吊销最坏延迟 = access TTL;关键吊销经事件流即时广播。
4. **商店审核周期**导致移动/Chrome 端安全修复无法即时下发——缓解(且是架构红利):安全关键逻辑收敛内核(可即时更新),端做薄壳;端侧只保留无法移到内核的最小逻辑。
5. **Linux 无 keyring 守护进程**时 CLI/桌面密钥落地——缓解:回落 Stronghold(口令派生 KDF 的本地加密文件,**非明文**)或提示用 `pass`/环境注入,绝不写明文 `~/.config`。

---

*(全文六端 × 五大横切关注点逐一落地,均锚定主蓝图既有内核/选型/安全/许可证决策,凡高风险/高复杂度特性均沿用主蓝图的"后置到阶段二及以后"定界,未引入与主蓝图矛盾的新选型。)*