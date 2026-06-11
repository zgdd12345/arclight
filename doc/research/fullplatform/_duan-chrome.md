I now have all the grounding facts: the blueprint §7 Chrome MV3 row, the three foundations (协议契约/能力落点/横切), the MV3 caveats (SW 30s sleep, no eval/remote JS, side panel main UI, WS keep-alive), cline's HostProvider + browser.proto + Puppeteer/CDP pattern, OpenHands' decoupled runtime + named-ports, and gemini-cli's event-stream design. I'll now write the detailed design as the final Markdown response.

---

# arclightagent 全平台架构详设 ·【Chrome 扩展 MV3(P4)详细设计】

> 本文是 `/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md` 主蓝图 §7(Chrome 扩展 = MV3 / side panel + service worker / WS 连本地内核 / P4)的下沉详设，严格继承三块【地基】:地基1(内核↔各端协议契约,C1-C4 四通道、`ArcEvent` 统一事件、能力协商)、地基2(五能力×六端落点,Chrome = computer-use **天然主场**、写文章/调研裁剪、写代码/日常规划不适合)、地基3(横切,浏览器=不可信执行域、密钥经内核中转、`chrome.storage.session` 短效 token、OAuth via `chrome.identity`)。
> **铁律(不另起炉灶):** 内核(Bun+Hono)是唯一真相源与唯一推理/沙箱执行域;扩展是薄客户端,**零推理、零沙箱、零长效密钥**;MV3 禁 eval/远程 JS,SW 30s 休眠;凭证一律沙箱外签名放行,扩展即"不可信执行域"的浏览器投影;`[P4]` = 路线图阶段五,Web 主端先行。

---

## 1) 组件级架构(本端内部结构 + 按地基1 协议契约连内核)

### 1.1 MV3 四类执行上下文 → 映射到地基1 四通道

MV3 扩展只有四类受限执行上下文:**service worker(背景,非常驻)、side panel(主 UI)、content script(页面上下文)、offscreen document(可选,持 DOM/媒体能力)**。本端的核心架构纪律是:**service worker 是唯一持网络连接的中枢(holds the only WS to kernel)**,其余上下文一律经 `chrome.runtime` 消息与 SW 通信,绝不各自连内核。

```
┌──────────────────────────── Chrome 浏览器进程 ────────────────────────────┐
│                                                                           │
│  ┌─ side panel (主 UI, React) ─────────┐   ┌─ content script (注入页面) ─┐ │
│  │ · 会话/消息流渲染 (assistant-ui)     │   │ · DOM/AX 动作执行器          │ │
│  │ · @arclight/client-core reducer:    │   │   click/type/scroll/extract │ │
│  │   16ms coalescing·去重·重连退避      │   │ · AX 树快照采集 + 视觉兜底   │ │
│  │ · 权限/HITL 确认弹层 (permission.ask)│   │   截图(html2canvas/CDP)      │ │
│  │ · computer-use 截图流面板            │   │ · 高亮 agent 操作目标元素     │ │
│  └────────────┬───────────────────────┘   └──────────┬──────────────────┘ │
│               │ chrome.runtime.sendMessage            │ chrome.tabs        │
│               │  (port: 'ui')                         │  .sendMessage      │
│               ▼                                        ▼ (port:'cs')        │
│  ┌════════════════════ background service worker (中枢) ════════════════════┐│
│  │  【唯一持网络连接者】                                                     ││
│  │  · WS 客户端 → 内核 (C2 事件面 + C1 命令面 经同一 WS, 见 §1.3)            ││
│  │  · KeepAlive: 心跳帧 + chrome.alarms(≤30s) 防 SW 休眠 (地基3 caveat)     ││
│  │  · 消息路由: WS事件 → fan-out 到 side panel / content script             ││
│  │  · 命令汇聚: UI/CS 命令 → 封 C1 帧 → WS 发内核                            ││
│  │  · capability profile 声明 (见 §3.2) · 短效 access token (内存域)         ││
│  │  · 会话状态最小快照 (chrome.storage.session, SW 重启可恢复)              ││
│  └════════════════════════════════┬═══════════════════════════════════════┘│
│                                    │ (可选) offscreen document:             │
│                                    │  WebRTC/媒体解码、长任务音频、         │
│                                    │  Transformers.js 轻量前处理(非推理)    │
└────────────────────────────────────┼──────────────────────────────────────┘
                                      │  WS  ws://127.0.0.1:<port>  (本地内核, 默认)
                                      │      wss://<host>           (远程内核, 可选)
                                      ▼
        ┌──────────────────── arclightagent 内核 (Bun+Hono) ────────────────────┐
        │ 唯一推理域 + 唯一沙箱执行域 + 凭证代理(沙箱外签名放行)               │
        │ async-generator 主循环 → yield ArcEvent → WS 帧 (地基1 §2)            │
        │ provider 网关 / MCP / 工具系统 / 持久化(epoch) / 计费·审计·可观测归集 │
        │ computer-use: 决策/规划/感知融合在内核, 动作下发给 content script     │
        └───────────────────────────────────────────────────────────────────────┘
                                      ╎ (云浏览器路径, computer-use 非"本浏览器"会话时)
                                      ╎  C4 媒体面: Browserbase/Steel CDP-VNC ──→ side panel
```

### 1.2 为什么是这个拓扑(load-bearing 理由)

- **SW 独占 WS** = 地基1「Chrome MV3 用 WS 而非 SSE」+ 地基3「SW 持一条 WebSocket,WS 心跳延长 SW 存活,SW 再用 `chrome.runtime` 分发」的直接落地。side panel/content script **不直接持流**——SSE 在 SW 休眠后状态丢失,WS 心跳是唯一保活手段。
- **content script = computer-use 天然执行后端**(地基2:Chrome 是 computer-use 天然主场)。它运行在**用户已登录的真实页面上下文**,直接可达 DOM/AX 树,无需云浏览器。**但推理/决策/规划全在内核**(MV3 禁 eval,不在扩展跑模型)——这正是地基2「Chrome:content script DOM 动作,推理在内核」与地基1「感知/推理/安全闭环不变,仅执行后端可插拔」的合流。
- **offscreen document 可选**:仅当需要持久 DOM/`WebRTC`/媒体解码(C4 高保真截图流)或 Transformers.js 轻量前处理(分类/摘要,**非推理**)时启用;它能在 SW 休眠时维持媒体上下文。

### 1.3 按地基1 协议契约的连接方式(四通道在 MV3 的物理映射)

地基1 定义 C1 控制面/C2 事件面/C3 实时面/C4 媒体面。MV3 端的关键差异是 **C1+C2 复用同一条 WS**(而非 Web 端的 HTTP POST + SSE 分离),因为 SW 无法稳定持 SSE:

| 地基1 通道 | Web 端物理传输 | **MV3 端物理传输** | 帧格式 |
|---|---|---|---|
| **C1 控制面**(端→核:提交/中断/审批回传/能力声明) | HTTP POST | **经 SW 的同一条 WS 上行帧** `{op, ...}` | JSON |
| **C2 事件面**(核→端:`ArcEvent`) | SSE(`id:` 承载 seq) | **WS 下行帧** `{seq, ...ArcEvent}` | 单 JSON 帧/帧 |
| **C3 实时面**(双向:语音/computer-use 控制) | WS(按需叠加) | **同一条 WS(MV3 本就是 WS,无需另叠)** | JSON 控制消息 |
| **C4 媒体面**(核→端:截图/屏幕帧) | 独立二进制 WS/WebRTC | **本浏览器 computer-use: 截图由 content script 本地采集**(不过网);**云浏览器路径: 独立 WS/WebRTC(CDP-VNC) 接入 side panel/offscreen** | JPEG/WebP 帧差 / CDP-VNC |

- **断点续传**(地基1 §2.2):WS 重连后 SW 发 `{op:'resume', afterSeq:N}`,内核 replay > N 的帧;SW 在 `chrome.storage.session` 持 `lastSeq` + `sessionId` + `epoch`,**SW 被杀重启后据此续接**(这是 MV3 的核心韧性设计)。
- **`@arclight/client-core` reducer 三纪律**(地基1 §2.2,六端复用)在 side panel 内运行:16ms 帧 coalescing、250ms 重连退避、按 `seq` 单调去重。SW 只做"收 WS 帧→`chrome.runtime` 转发",reducer 状态机在 side panel。
- **forward-compat**(地基1 §2.4):side panel reducer 遇未知 `t` 静默忽略,未知 `risk` 降级按 `high`(fail-closed)。`Arc-Protocol-Version` 在 WS 握手 query/首帧声明。

---

## 2) 技术选型与关键依赖(与主蓝图栈一致)

| 层 | 选型 | 与主蓝图/地基一致性 |
|---|---|---|
| **Manifest** | **MV3**(`manifest_version: 3`) | 主蓝图 §7 明定 |
| **背景** | **service worker**(ES module, `"type":"module"`) | 主蓝图 §7 + 地基3 |
| **主 UI** | **side panel**(`chrome.sidePanel` API)+ **React + assistant-ui** | 主蓝图 §7「side panel 比 popup 更适合 agent」;assistant-ui 与 Web 端同栈(主蓝图 §7 Web 行) |
| **UI 状态/事件 reducer** | **`@arclight/client-core`**(地基1 共享包,端无关) | 地基1 §2.2 六端复用,**零重写** |
| **协议类型** | **`@arclight/protocol`**(`ArcEvent`/命令体,共享 TS 类型) | 地基1 §3.1 MVP 单 repo 共享类型零 codegen |
| **内核连接** | **WebSocket**(SW 内 `new WebSocket`)+ `chrome.alarms` 保活 | 主蓝图 §7「WS 连本地内核」+ 地基1/地基3 |
| **computer-use 执行** | **content script DOM/AX 动作**;视觉兜底截图 `html2canvas`/`chrome.tabs.captureVisibleTab`;高保真用云浏览器 CDP(Browserbase/Steel) | 主蓝图 §6.4「DOM/AX 优先+视觉兜底」「Browserbase/Steel 不叠 E2B」;借 cline `BrowserSession`(Puppeteer/CDP)与 OpenHands(playwright 截图)**思路**,但本浏览器路径用原生 content script 而非 Puppeteer |
| **OAuth** | **`chrome.identity.launchWebAuthFlow`**(PKCE)→ `https://<ext-id>.chromiumapp.org/` | 地基3 §1.2 |
| **token 存储** | **`chrome.storage.session`**(内存域,SW 重启即失)存短效 access;**不持 refresh**(内核保管) | 地基3 §1.3/§2.3 |
| **非密偏好** | **`chrome.storage.local`**(UI 偏好、内核地址、设备 ID;**禁存任何密钥**) | 地基3 §2.2/§3.2 |
| **打包** | **Vite + `@crxjs/vite-plugin`**(或 `wxt`),输出 zip;React webview 构建产物可与 Web 端共享组件 | 与 Web 端 Vite/Next 同生态;无新增异构 |
| **本地小模型(可选)** | **Transformers.js(WebGPU)/ offscreen** 仅做轻量前处理(摘要/分类),**Chrome Prompt API(Gemini Nano)不用于正式发布** | 主蓝图栈;地基3 caveat 明确 Prompt API 仍 Origin Trial、**无法在 Web Store 正式发布含该 API 的扩展** → 仅 Transformers.js 作可选前处理,不承担推理 |

**许可证纪律(继承主蓝图 §3.4-3.6)**:新增前端依赖(`@crxjs/vite-plugin` MIT、`html2canvas` MIT、assistant-ui Apache/MIT)逐一核为 MIT/Apache;无 GPL/LGPL 入树(CI 拦截);Apache-2.0 复制带 NOTICE。扩展内**不 vendoring 任何沙箱/bwrap**(本端零沙箱)。

---

## 3) 本端承载哪些能力(依据地基2)及裁剪/适配

### 3.1 能力落点(逐条锚定地基2 总矩阵 Chrome 列)

| 能力 | 地基2 档位 | 本端落地与裁剪 |
|---|---|---|
| **computer use** | **天然主场** | **本端唯一主场能力。** content script 就地操控**用户真实已登录会话**的 DOM/AX(click/type/scroll/extract),采集 AX 树快照 + 视觉兜底截图,经 SW 的 WS 回传内核;**推理/决策/规划全在内核**。**适配差异**:截图本地采集不过网(C4 在本浏览器路径退化为本地),凭证仍走沙箱外签名放行——即便操作已登录页面,高危动作(支付/删除/外发/跨域)**强制 HITL + 域名白名单 + 审计**(主蓝图 §6.4 硬边界,端无关)。 |
| **写文章** | **裁剪** | side panel 做大纲/草稿助手:**网页内划词取材**(content script 抓选区/正文)→ 喂内核 paper-* 写作流水线;在 Docs/Notion/Gmail 等**在线编辑器旁辅助**。**裁剪掉**:富文本所见即所得编辑、完整文档生成(docx/pptx 后端在内核,扩展只触发+下载)。 |
| **调研** | **裁剪** | side panel 对**当前页面/选中内容发起溯源式调研**(就地深挖)是天然取材入口。**裁剪掉**:长报告驻留呈现 + 断点续研驻留(SW 非常驻)→ 发起后**转 Web/桌面看长报告**(任务全在内核,SW 死了任务不停)。 |
| **写代码** | **不适合** | 仅**最小入口**:在 GitHub/GitLab 页面唤起内核对当前 repo/PR 做**只读分析**(走内核+远程),**不做编辑/编译/执行**(扩展无 FS/LSP/沙箱栖息地)。 |
| **日常规划** | **不适合** | 仅 side panel 看**只读今日待办**;**不作为规划载体**——SW 非常驻、无系统级常驻通知、无随身性(主动提醒主场在移动/桌面)。 |

### 3.2 能力协商:本端 capability profile(地基1 §5,内核据此裁剪)

SW 连接时声明 `CapabilityProfile`,内核 `materialize(profile)` 裁剪工具集:

```ts
const chromeMV3Profile: CapabilityProfile = {
  localSandbox: false,        // → 内核不暴露本地 exec/bash;代码执行强制远程 opt-in 或拒绝
  screenshot: 'binary-ws',    // 本浏览器: content script 本地采集; 云浏览器: 'cdp-vnc'
  background: 'limited',      // SW 30s 休眠 → 长任务绑定内核, 端关闭任务不停
  fileSystem: 'none',         // read/write/edit 落内核工作区(远程), 不碰端机 FS
  terminal: false,           // 不下发内嵌终端
  push: false,               // 无系统级常驻推送(规划主动提醒非本端)
  maxBinaryChannel: <档位>,    // 媒体面带宽档(本浏览器路径基本不占)
  realtimeControl: true,     // computer-use 控制面板 + (可选)语音, 走同条 WS
};
```

内核裁剪结果(地基1 §5.2):`localSandbox=false` → 本地 exec 类工具不暴露;`fileSystem='none'` → 文件操作落内核工作区;`background='limited'` → deep research/长 computer-use **绑定到内核 + 断点续研**,端关闭后任务在内核侧继续。**纪律:能力协商是内核侧裁剪**(端谎报只会拿到处理不了的事件,内核仍以 profile 为准做安全决策,如 `localSandbox=false` 绝不下发本地 exec)。最终工具集 = 端 capability profile ∩ agent profile(每能力独立工具子集)。

---

## 4) 鉴权/会话/密钥/离线同步在本端的落地(依据地基3)

### 4.1 鉴权(地基3 §1.2 Chrome 行)

- **OAuth 2.1 + PKCE via `chrome.identity.launchWebAuthFlow`**(redirect 到 `https://<ext-id>.chromiumapp.org/`)。授权码经内核交换;**扩展只拿短效 access token,refresh token 全程内核保管,绝不下发扩展**(地基3 §1.3)。
- **连本地内核(默认)**:SW 的 WS 连 `ws://127.0.0.1:<port>`,带 **pairing 校验**——内核首启写 `~/.config/arclightagent/server.json`(`{port,token,pid}`,地基1 §6.4 发现约定);但扩展沙箱**无法直接读该文件**,故采用「内核侧 pairing UI / 用户复制一次性 pairing code 到扩展」或「内核暴露 `chrome.identity` 友好的 loopback OAuth」二选一,**扩展侧只存短效 token**。
- **MV3 SW 休眠冲击鉴权流(地基3)**:OAuth 轮询/换码要做成**幂等可恢复**——若 SW 在轮询中被杀,用 `chrome.alarms` 唤醒续轮询;`launchWebAuthFlow` 本身由浏览器托管 redirect,不受 SW 生命周期影响。

### 4.2 会话与 token 存储(地基3 §1.3 / §2.3)

| 项 | 存哪 | 纪律 |
|---|---|---|
| **短效 access token** | `chrome.storage.session`(SW 内存域,浏览器关闭即清) | TTL 极短(15-60min);access 过期 → SW 经内核 `/token/refresh`(内核用其侧 refresh)→ 回发新短效 access |
| **refresh token** | **不持有,内核保管** | 旋转(rotating refresh)在内核侧;扩展永不接触 |
| **provider key / MCP OAuth token** | **绝不进浏览器,内核保管** | 地基3 §2.3:浏览器=不可信执行域,所有需密钥的调用(LLM 推理、Google API)在内核执行,扩展只发「动作请求 + app-session」 |
| **会话最小快照** | `chrome.storage.session`(`sessionId/epoch/lastSeq`) | 仅用于 SW 重启后续接 WS,非权威态;权威态在内核 |

### 4.3 密钥(地基3 §2.3 重点 — 浏览器无安全本地存储)

**`chrome.storage` 非加密、可被同机进程/恶意扩展读取,且受页面注入影响 → 视为不可信,禁存任何密钥**(地基3 §2.2 Chrome 行)。这是主蓝图 §5.5「凭证沙箱外签名放行 + 沙箱内零真实凭证」的**浏览器投影**:扩展即"不可信执行域",密钥换取的是**动作结果**,密钥本身不过线。

- **CSP 硬化**:`manifest.json` 的 `content_security_policy.extension_pages` 禁 `eval`/远程脚本(MV3 强制 `script-src 'self'`);`host_permissions` **收窄到必要域**(避免触发深审,见 §5)。
- computer-use 即便操作已登录页面,**高危动作仍走内核侧凭证签名放行 + HITL + 白名单 + 审计**,扩展不持任何站点凭证。

### 4.4 配置/状态/离线同步(地基3 §3 / §0 矩阵)

- **配置真相源 = 内核**(地基3 §3.1)。扩展 `chrome.storage.local` 仅存**非密 UI 偏好**(主题、内核地址、设备 ID)+ 内核同步缓存;用户级配置(agent profile、模型偏好、Skills 启用集)从内核拉取 + 本地缓存,改写经内核。
- **跨设备会话同步**:经内核单一真相源;`SessionUpdated{epoch}` 经 WS 推到 SW → 转 side panel,按 epoch 决定是否拉新(地基3 §3.3)。
- **离线 = 弱(地基3 §0 矩阵)**:SW 缓存最近 session **只读快照**,**离线只读**;写操作排队待联网(乐观 UI),提交时按 `epoch` 校验,陈旧则 `StaleEpochError`(地基1 §2.3 / 地基3 §3.5)。**MVP 期冲突合并 UX 后置(阶段二)**,本端只做「刷新/重连不丢」最朴素版。

---

## 5) 打包/分发/自动更新与平台合规

| 项 | 方案 | 合规纪律(地基3 §4 Chrome 行) |
|---|---|---|
| **打包** | Vite + `@crxjs/vite-plugin` → zip 扩展包(所有逻辑随包,**禁远程 JS**) | MV3 强制:所有可执行逻辑随包审核,**不可动态加载模型代码/远程脚本** |
| **分发** | **Chrome Web Store**(后续可发 Edge Add-ons) | — |
| **自动更新** | Web Store 托管自动更新(用户端静默) | 更新需重新过审 |
| **审核周期** | **MV3 审核数小时-数天;权限多/敏感 API(`<all_urls>`/`debugger`/computer-use 类)时触发深审、更久** | **最小化权限**:`host_permissions` 收窄、`activeTab` 优先于 `<all_urls>`、`tabs`/`scripting` 按需;敏感权限写清用途说明 |
| **关键架构红利** | **安全关键逻辑收敛在可即时更新的内核,扩展做薄壳** | 地基3 §4/§6:商店审核周期使扩展端**安全修复无法即时下发** → 把决策/推理/凭证/审计全放内核(可即时更新),扩展只保留无法移到内核的最小 DOM 执行/UI 逻辑。这是"薄客户端"架构的运维价值 |
| **版本协商** | SW 连内核时上报 client 版本,内核按兼容矩阵决定降级/提示升级 | 地基3 §4 防协议漂移 |

---

## 6) 本端特有硬约束与坑(诚实)及缓解

| # | 硬约束/坑(诚实) | 影响 | 缓解 |
|---|---|---|---|
| 1 | **SW 30s 无活动休眠**(地基3 caveat,topic-cross-platform 实测) | SSE 长流断、生成态丢、WS 被回收、鉴权轮询中断 | **改用 WS(非 SSE)+ 心跳帧 + `chrome.alarms`(≤30s)唤醒**;SW 重启后用 `chrome.storage.session` 的 `lastSeq/epoch` 发 `{op:'resume',afterSeq}` 续接;**长任务一律绑定内核**,端死任务不停(地基1 §5.2 `background='limited'`) |
| 2 | **MV3 禁 eval/远程 JS** | 不能在扩展内跑推理/动态加载模型代码 | **所有推理在内核**;扩展零模型代码;可选 Transformers.js 仅做**轻量前处理**(摘要/分类),非推理;**Chrome Prompt API(Gemini Nano)不用于正式发布**(Origin Trial,Web Store 不允许,地基3 caveat) |
| 3 | **`chrome.storage` 非加密、可被同机进程/恶意扩展读** | 无安全本地存储 | **禁存任何密钥**;短效 access 存内存域 `chrome.storage.session`;refresh/provider key/MCP token 全程内核(地基3 §2.3) |
| 4 | **computer-use 同源/凭证/prompt injection**(操作用户真实已登录会话,风险面最大) | 误操作/越权/被注入页面诱导高危动作 | **硬边界=沙箱内零真实凭证 + 凭证代理外置按动作签名放行**(端无关);**HITL 强确认 + 域名白名单 + 审计**为纵深;高危动作(支付/删除/外发/跨域 POST)强制二次确认;content script 与页面 JS 隔离世界(isolated world)降低注入面 |
| 5 | **content script 注入限制**:`file://`、Chrome Web Store 页、部分 CSP 严格站点无法注入;SPA 动态 DOM 时序 | 部分页面 computer-use 失效/动作打空 | 注入失败显式降级提示;动作前等待元素就绪(AX 树轮询)+ 失败重试;高保真/受限站点**回退云浏览器 CDP 路径**(Browserbase/Steel) |
| 6 | **本地内核发现**:扩展沙箱读不到 `~/.config/arclightagent/server.json` | 无法自动发现本地内核端口/token | 用户一次性 pairing(内核 UI 出 pairing code,扩展输入)或 loopback OAuth;之后短效 token 走 `chrome.storage.session` |
| 7 | **审核周期 → 安全修复延迟**(数小时-数天,深审更久) | 端侧紧急修复上不去 | **安全逻辑收敛内核**(可即时更新);扩展薄壳(§5 架构红利) |
| 8 | **截图带宽**(computer-use 多步会话) | 帧混入事件流打爆带宽 | 本浏览器路径**截图本地采集不过网**;云浏览器路径走**独立二进制 WS/WebRTC + JPEG/WebP 帧差 / CDP-VNC**(主蓝图 §6.4,绝不混 C2) |

---

## 7) 与其他端/内核的代码复用边界

| 复用层 | 内容 | 边界纪律 |
|---|---|---|
| **完全复用内核(零重写)** | Agent 主循环、工具系统、上下文/记忆压缩、provider 网关、会话持久化(epoch)、权限策略、Skills/MCP/Hooks、computer-use **感知融合/决策/规划**、凭证签名放行、计费·审计·可观测**归集** | 地基2 §7.1:扩展是纯薄壳;**computer-use 的推理/安全闭环在内核,扩展只换执行后端**(地基2 §7.2)。计费/审计/遥测**端侧零落地**(地基3 §5),trace-context 经 SW 透传,trace 由内核组装 |
| **跨端共享包(端无关 TS)** | `@arclight/protocol`(类型源)、`@arclight/client-core`(reducer/重连/去重) | 地基1 §2.2/§3.1:与 Web/桌面/CLI/VSCode **共用同一份**;Chrome 仅传输层(SSE→WS)适配不同,reducer 不变 |
| **与 Web 端共享 UI 组件** | assistant-ui 消息流/工具渲染/权限弹层(React 组件) | 借 cline「React webview 构建产物跨 VSCode/JetBrains 复用」思路;side panel 与 Web 端共享组件层,仅外壳(side panel vs 浏览器标签页)与传输适配不同 |
| **本端特有(端特定执行后端)** | **content script DOM/AX 动作执行器**(computer-use 天然后端)、SW 的 WS 中枢 + KeepAlive、`chrome.identity` OAuth、`chrome.storage` 适配、side panel/offscreen 生命周期 | 地基2 §7.2:**computer-use 执行后端按端可插拔**——Chrome=content script DOM 动作(就地操控真实会话),Web/桌面/移动=远程云浏览器 CDP;**感知/推理/安全闭环不变,仅后端可插拔**。借 cline `BrowserSession`/`browser.proto`、OpenHands playwright 截图的**动作协议思路**,但本浏览器路径用原生 content script 而非 Puppeteer |
| **不采纳** | cline 的 gRPC-over-postMessage/protobuf 作主协议;OpenHands Python SDK | 地基1 §3.3:协议不上 protobuf(重、易静默回退),用 JSON+TS 类型;内核 TS/Bun,不引 Python SDK |

**一句话收口**:本端 = `@arclight/protocol` + `@arclight/client-core`(跨端共享)+ Web 端 React 组件复用 + **唯一本端特有的 content script DOM/AX 执行后端 + SW WS 中枢**;内核侧零改动消费同一 `ArcEvent`/capability 协议。

---

## 8) 工作量量级、前置依赖与排期位置

- **排期位置**:**主蓝图 §9 阶段五(全平台壳 + 多租户服务化,~6-8 周,与 CLI/桌面/VSCode 并行)**,优先级 **P4(六端最低)**。Web 主端(阶段一)+ 协议/SDK 基建(阶段五「第二端起上 OpenAPI→TS SDK + 自建流式 codegen」)+ computer-use 内核能力(阶段四)**全部就绪后**才启动,**绝不前置**。

- **前置依赖(硬)**:
  1. **阶段四 computer-use 内核能力**(DOM/AX 感知融合 + 决策/规划 + Stagehand 执行层抽象 + 凭证签名放行 + HITL/白名单/审计)——本端是其「天然主场执行后端」,**无此内核能力,本端无主场可承载**。
  2. **地基1 协议契约 + `@arclight/protocol`/`@arclight/client-core`** 稳定(阶段五自建流式 codegen 预算已列)。
  3. **内核 WS 端点 + `resume/afterSeq` 续传 + capability `materialize`** 落地(WS 是本端唯一通道,SSE 不可用)。
  4. **OAuth/token-refresh 端点**(内核保管 refresh,回发短效 access)。

- **工作量量级(粗估,不含已就绪的内核/共享包)**:**约 3-4 人周**(单人),分布:
  - SW WS 中枢 + KeepAlive(`chrome.alarms`/心跳)+ `resume` 续接 + 消息路由:~1 人周(本端最核心、坑最多,SW 生命周期是主要风险)。
  - side panel 主 UI(复用 assistant-ui + `@arclight/client-core`,主要是壳与 `chrome.runtime` 桥接):~0.5 人周。
  - **content script DOM/AX 执行器 + 视觉兜底截图 + 动作协议对接内核**(本端特有、computer-use 主场核心):~1-1.5 人周。
  - OAuth(`launchWebAuthFlow`)+ `chrome.storage` 适配 + pairing 本地内核发现:~0.5 人周。
  - 打包(`@crxjs/vite`)+ Web Store 上架(权限收窄、隐私说明、过审)+ CSP/许可证合规:~0.5 人周。
  - **风险缓冲**:SW 休眠续接、content script 注入边界、Web Store 深审来回 → 实际可能上浮 30-50%,故规划区间 **3-5 人周**。

- **不在本端范围(后置/不做)**:OS 级 GUI 控制(桌面后端);移动本机执行;写代码编辑/执行;日常规划主动提醒(主场在移动/桌面);Chrome Prompt API 正式发布(Origin Trial 限制)。

---

**与主蓝图/三地基一致性自检(逐条,无矛盾、无另起炉灶)**:MV3 / side panel + SW / WS 连本地内核 / P4 → §7 ✔;C1+C2 复用 WS、`ArcEvent`、`resume/afterSeq`、capability 协商、forward-compat、`@arclight/protocol`+`@arclight/client-core` 复用 → 地基1 ✔;Chrome=computer-use 天然主场 + 写文章/调研裁剪 + 写代码/日常规划不适合、执行后端可插拔、推理在内核 → 地基2 ✔;`chrome.identity` OAuth/PKCE、短效 token 存 `chrome.storage.session`、refresh+provider key 内核保管、浏览器=不可信执行域密钥经内核中转、配置真相源在内核、离线弱只读、计费/审计/遥测内核归集端侧零落地 → 地基3 ✔;沙箱内零凭证 + 签名放行 + HITL/白名单/审计、截图独立二进制通道/不混 C2、SW 30s 休眠用 WS 保活 + `chrome.alarms`、禁 eval/远程 JS、Prompt API 不正式发布、许可证 MIT/Apache 无 GPL/LGPL → 主蓝图 §6.4/§7/§3.4-3.6 + topic-cross-platform caveat ✔;排期阶段五 P4、前置阶段四 computer-use → §9 ✔。

**涉及源文件**:`/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md`(§7 跨平台策略 / §6.4 computer-use / §8 决策表 / §9 路线图 / §10 风险表)、`/Users/fsm/project/arclightagent/research/data/topic-cross-platform.json`(MV3 SW 30s/Prompt API/Web Store caveat 与 Chrome 扩展推荐)、`/Users/fsm/project/arclightagent/research/data/repo-cline.json`(HostProvider / `BrowserSession`(Puppeteer/CDP)/ `browser.proto` 动作协议、React webview 跨端复用)、`/Users/fsm/project/arclightagent/research/data/repo-openhands.json`(运行时与表层解耦 + 命名端口 + playwright 截图 computer-use)、`/Users/fsm/project/arclightagent/research/data/repo-gemini-cli.json`(事件流 `AsyncGenerator` 设计佐证)。