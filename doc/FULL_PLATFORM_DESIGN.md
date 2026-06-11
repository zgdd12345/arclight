> 本文为 arclightagent 全平台架构详设(与 ARCHITECTURE_BLUEPRINT.md 配套,已对抗式评审修订)

> 本文是主蓝图 `/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md` 的**配套姊妹文档【最终交付版】**,已逐条吸收对抗式评审意见(M1-M4 必须修复 + B1-B6 建议改进 + 缺失项 1-5 + 阶段五工时重定价)。

# arclightagent 全平台架构详设(五端主交付 + 移动端探索性附录)

> **主蓝图讲"内核与网页 MVP",本文讲"如何把同一内核延展到全平台壳"。** 不重复主蓝图的内核细节(async-generator 主循环、工具系统、上下文压缩、沙箱抽象、provider 网关、五大能力流水线均在主蓝图 §4/§6),聚焦**全平台维度**:协议契约、各端落点、逐端详设、跨端横切、分阶段排期、全平台风险。
>
> **【评审修订口径,先于全文声明,避免误导实现者】**
> 1. **主蓝图是"五端"项目,不是"六端"。** 主蓝图 §1/§9/§10(521 行第 5、25、487、489、520 行)一致表述为 **Web + CLI + 桌面 + 浏览器/IDE 插件 = 五端**;§9 阶段五"全平台壳"枚举的是 **"CLI/桌面/插件"**,**从未把"移动 App"列为一个独立交付端**——主蓝图仅在 §7 桌面行写 "Tauri 2.0 …… 覆盖 iOS/Android"(指 Tauri 的*跨平台能力*),其"先 PWA 过渡"亦指**桌面**。因此本文把**移动 App 明确降格为"主蓝图之外的探索性增量提案"(见 §8 附录 A)**,不写进"既定交付端";正文 §0-§7 的"各端"一律指**五端**。若未来要正式交付移动 App,须回主蓝图补一次正式决策。
> 2. **移动端主路径结论已倒置**(吸收评审 M1):移动端经诚实裁剪后是**几乎纯 WebView 壳**(只做输入/观测/审批/通知),最不需要 Tauri 的 Rust 原生能力、最需要成熟的推送/商店生态,故主路径为 **PWA 首选 → Capacitor 次选(iOS 推送不达标时)→ Tauri 2 移动最后或不做**,详见 §8 附录 A。
> 3. **一致性纪律(贯穿全文,不另起炉灶、不与主蓝图矛盾):** 内核(Bun+Hono headless agent server)是**唯一真相源 + 唯一推理域 + 唯一沙箱执行域**;各端皆为**薄客户端**,零业务/能力逻辑重写,只做"输入采集 + 事件流渲染 + 端特有执行/投递后端接驳"(主蓝图 §5.4/§7)。**MVP 仅 Web 单端 + 写代码单能力 + 单用户 + 本地优先沙箱**(主蓝图 §9 阶段一);其余端属阶段二(CLI 最小 spike)/阶段五(全平台壳)。**SSE 默认数据通道、WS 仅双向控制叠加、截图走独立二进制通道**(主蓝图 §5.2);**凭证一律沙箱外、按动作签名放行,沙箱内零真实凭证**(主蓝图 §5.5/§8);**禁明文 `~/.config`**;**从第一天按 `tenant_id` 建模**(主蓝图 §5.6)。许可证纪律全程继承(Apache-2.0 带 NOTICE、Linux 沙箱只 `exec` 系统 bwrap、CI 拦 GPL/LGPL,主蓝图 §3.4-3.6)。

---

## 决策修订记录（v2 · 2026-06-09，后续决策以本节为准）

> 与主蓝图 `ARCHITECTURE_BLUEPRINT.md` 的「决策修订记录(v2)」同步。权威细节见 `research/P0-沙箱方案-拿来即用.md`、`research/拿来即用-全栈选型清单.md`、`research/P0-基础三件套-拓扑-数据模型-工具契约.md`。

1. **沙箱定案**：本地**整体采用 nono**（Apache-2.0，Landlock/Seatbelt，零自研隔离原语）+ 远程 Vercel/E2B SDK + 浏览器 Pyodide + Docker 兜底。→ **§16 / §1.3 等处「Linux 沙箱只 exec 系统 bwrap」一句作废**（nono 走 Landlock 不碰 bwrap）；其余沙箱纪律（凭证沙箱外、本地优先、截图独立通道）不变。
2. **localSandbox 矛盾已解决**：P0=**本地优先** `arclight serve`，本地部署下 **Web 的 `localSandbox = true`**（经本地 Hono 内核 + nono）。本文 §2.6/§3 中 Web `localSandbox:false` **仅对远程部署 Web 成立**，P0 不走该拓扑。
3. **协议小修（Codex 审阅）**：`reasoning.delta` 应输出**摘要**而非真实思维链（→ `reasoning.summary.delta`，修正 §2.3）；**loopback token 是机密**（泄露=接管内核），原生端宜用 Unix domain socket、浏览器端用 pairing+origin allowlist+CSRF，不依赖 TCP-loopback 的 PID 绑定硬保证（修正 §1.2/§4.2/§5.3）。
4. **数据模型/工具契约落地**：P0 协议契约已细化为 12 张表 Drizzle schema（`events(session_id,seq)` 唯一 + `epoch` 乐观锁）+ 工具执行契约 + 审批状态机 + 完整生命周期时序，见 P0 施工图文档。
5. **选型/自研量/许可证**：MVP 最小依赖 17 内核+7 前端 npm（零 GPL/AGPL）；MVP 自研实评 6000-9000+ 行（主循环+前端是真工程，非薄接缝）；`web-push`=MPL-2.0、`node-cron`=ISC、opensquilla 按每文件 provenance——详见拿来即用清单。
6. **原则**：现阶段最大化复用现成、自研推迟到产品成熟后。
7. **阶段一开发方案**见 `DEV_PLAN.md`（最细，开工以它为准）。其评审修正（以 DEV_PLAN 为准）：**前端 runtime 用 `ExternalStoreRuntime`（非 AISDKRuntime）**，本文 §2.x / §4.1 涉 `useChat` resume、`@assistant-ui/react-ai-sdk` 的卖点作废，改自研 SSE EventStreamManager；阶段一 MCP 仅 stub、单 provider(Anthropic)。

---

## 0) 执行摘要(全平台战略一页讲清)

**一句话结论:写一次内核,五端只换壳。** arclightagent 全平台个人 AI Agent(写代码 / 写文章 / deep research / computer use / 日常规划)以一个 UI 无关的 headless 内核服务(TS/Bun + Hono)为唯一真相源,**Web / CLI / 桌面(Tauri2) / VSCode 插件 / Chrome 扩展(MV3)五端**都是它的薄客户端,**全部消费同一套协议契约与同一套 `ArcEvent` 事件流**。各端差异只在三处:**传输适配**(SSE/WS/stdio/postMessage)、**UI/输入呈现**、**端特有执行/投递后端**(编辑落地 / GUI 操控 / 通知投递)。**移动 App 作为探索性增量提案单列附录 A,不计入五端主交付。**

**五端定位(一句话):**

| 端 | 优先级 | 定位与主场能力 |
|---|---|---|
| **Web(Next.js)** | **P0(MVP 先发)** | 全平台**参照实现端**,协议先在此打通;写代码/写文章/调研=主场,computer-use=主场(云浏览器),日常规划=可用 |
| **CLI(Bun+OpenTUI)** | **P2** | **最早证明骨架解耦的端**;写代码/调研=可用,headless 管道模式服务 CI/脚本;computer-use/日常规划裁剪 |
| **桌面(Tauri2)** | **P3(先 PWA 过渡)** | 复用 Web 前端 + 本地内核 sidecar;写文章/调研/日常规划=主场,写代码=可用,computer-use=可用→裁剪 |
| **VSCode 插件** | **P3** | 写代码=主场;**但"主场"定级附带 Copilot 硬依赖与"模型路由权"二选一,见 §4.5 与 §3.1 脚注**;写文章=可用,调研/日常规划裁剪,computer-use 不适合 |
| **Chrome 扩展(MV3)** | **P4** | computer-use=**天然主场**(content script 就地操控真实会话);**但"操控用户真实已登录会话"使"沙箱内零凭证"硬边界失效,见 §4.6/§5.7**;写文章/调研裁剪,写代码/日常规划不适合 |

**移动端结论(单独点名,评审 M1 修订后):** 移动端**没有本地内核路径**——iOS/Android 无法稳定跑 Bun sidecar、无本地代码沙箱、无本地浏览器自动化驱动、后台执行受 OS 严格限制,经裁剪后是**几乎纯 WebView 壳**(只做输入+观测+审批+通知)。鉴于 ① 主蓝图未把移动 App 列为交付端,② Tauri 2 官方明确 "Tauri 2.0 will not be the 'mobile as a first class citizen' release"、移动插件生态不全且部分需自写 Swift/Kotlin 桥,**移动端主路径倒置为:PWA 首选(已有 §4.1 的 @serwist/next + Web Push 覆盖约 80%)→ 若 PWA 的 iOS 推送不达标则用 Capacitor(最薄、纯复用 Web 前端、原生推送插件成熟)→ Tauri 2 移动排最后或不做。** 详见 §8 附录 A。

**排期主线:** Web(阶段一 MVP)→ CLI 最小 spike(阶段一末,验证骨架解耦)→ 协议/SDK 基建抽出(阶段五前置)→ **阶段五按端拆分子阶段顺序/并行交付**(CLI 完整版 → 桌面/VSCode → Chrome;移动 App 作附录 A 提案另行决策)。**关键纠偏(评审重定价):阶段五"~6-8 周"是主蓝图既有标注,但它绝不是"五端壳 + 多租户 + Postgres/RLS/KMS + 多代理 + provider 下沉 + 分层路由全部塞进单一 6-8 周"——那正是主蓝图自己痛批过的范围失真。本文把阶段五重定价为"按端串行/多人并行的多月工程,每端壳的 6-8 周量级仅指单端壳本身",见 §6。** **安全关键逻辑收敛在可即时更新的内核**,端做薄壳——这既是架构原则,也是应对 Chrome/VSCode 商店审核周期的运维红利。

---

## 1) 全平台拓扑总图

### 1.1 一个内核服务 ↔ 五端 ↔ 沙箱/数据/MCP/provider

```
                              ┌────────────────────────── 五端薄客户端 ──────────────────────────┐
                              │                                                                   │
  ┌──────────────┐           │  ┌─────────────┐  C1:HTTP POST / C2:SSE / C3:WS按需 / C4:独立WS·WebRTC │
  │ Web(Next.js) │ ──────────┼─▶│  Web  [P0]  │  浏览器直连(同源/CORS),SSE 默认                   │
  │  参照实现端  │           │  └─────────────┘                                                   │
  ├──────────────┤           │  ┌─────────────┐  serve 本地 daemon→HTTP/SSE;headless(-p)=stdio JSONL │
  │ CLI(Bun+TUI) │ ──serve───┼─▶│  CLI  [P2]  │  (-p 与 --stdio 两套 stdio 协议互斥,见 §4.4)         │
  ├──────────────┤  sidecar  │  └─────────────┘                                                   │
  │ 桌面(Tauri2) │ ──spawn───┼─▶│ 桌面  [P3]  │  sidecar stdio 仅握手拿 {port,token,pid},业务走 loopback │
  ├──────────────┤           │  └─────────────┘                                                   │
  │ VSCode 插件  │ ──host────┼─▶│VSCode [P3]  │  host 持 SSE,webview↔host=postMessage 类型 envelope │
  ├──────────────┤           │  └─────────────┘                                                   │
  │ Chrome(MV3)  │ ──SW WS───┼─▶│Chrome [P4]  │  SW 无状态可重启,WS 持 C1+C2,resume 续接(非"保活")  │
  └──────────────┘           │  └─────────────┘                                                   │
                             └──────────────────────────────────────────────────────────────────┘
   〔附录A 探索性〕                │ 所有端共享:@arclight/protocol(类型) + @arclight/client-core(reducer/重连)
   移动 PWA/Capacitor ───HTTPS────┤  (移动几乎只连远程拓扑 B;非主交付端)
                                   ▼
        ┌══════════════════════════════════════════════════════════════════════════════════════════┐
        ║                @arclight/core — headless agent server (Bun + Hono)                          ║
        ║  Hono Router → Auth 中间件(tenantId/userId/sessionId 传播) → 能力协商 materialize(profile)  ║
        ║  自研最小 async-generator 主循环 → yield ArcEvent → SSE/WS/stdio/postMessage 各端帧(同构投影)║
        ║  工具系统 · 上下文压缩(epoch) · 记忆 · 五大能力流水线 · 权限策略 · 持久化 · 凭证代理         ║
        ║  ★ 对外亦作 MCP server(--stdio / Streamable HTTP)——此暴露方向独立鉴权,见 §5.7 缺失项①     ║
        ╚═════╤═══════════════════╤════════════════════╤═══════════════════════╤═════════════════════╝
              │                   │                    │                       │
        ┌─────▼─────┐      ┌──────▼──────┐      ┌──────▼───────┐        ┌───────▼────────┐
        │  沙箱      │      │  数据层      │      │   MCP Hub     │        │ provider 网关   │
        │ 默认本地   │      │ SQLite→PG    │      │ Streamable    │        │ AI SDK+LiteLLM  │
        │ nono/系统  │      │ 乐观锁 epoch │      │ HTTP + stdio  │        │ Anthropic/      │
        │ bwrap exec │      │ tenant_id    │      │ Google Cal/   │        │ OpenAI/Gemini   │
        │ opt-in E2B │      │ (RLS 远程)   │      │ Gmail/GitHub  │        │ KV-cache(主力)  │
        │ 云浏览器   │      │ 凭证: keychain│      │ (凭证沙箱外    │        │                 │
        │Browserbase │      │ /KMS 信封加密 │      │  签名放行)    │        │                 │
        │/Steel CDP  │      └─────────────┘      └──────────────┘        └────────────────┘
        └───────────┘
```

### 1.2 两种核心部署拓扑 + 一条脚注(评审 B6:边缘降级为脚注)

| 拓扑 | 内核位置 | 哪些端 | 鉴权 | 数据边界 |
|---|---|---|---|---|
| **A 本地内核(默认)** | `127.0.0.1:<port>`,sidecar | 桌面(spawn)/CLI(serve)/VSCode(host)/Web(localhost)/Chrome(SW WS)。**移动不适用** | loopback **bearer** token(**非"非密"!见 §4.2 与 §5.7 缺失项,泄露=完全接管内核**) | 数据不出本机;密钥 OS keychain。**单内核多端共享**(经 `~/.config/arclightagent/server.json` 端口+token 发现,复用同一进程) |
| **B 自托管远程(VPS)** | 远程 Bun+Hono | 全端;**移动 App(若交付)主路径** | OAuth 2.1 + PKCE + TLS | 多租户 RLS + KMS + 沙箱 per-tenant + per-user 计费(阶段五) |

> **脚注(原拓扑 C 降级,评审 B6):边缘(Cloudflare Workers via Hono `toWebHandler`)仅可选用于无状态认证端点。** 因长任务/流式/沙箱全部要回落拓扑 B 常驻内核、且 SSE 不经边缘函数(§4.1 硬约束①),边缘几无有意义落点,不作为一种部署拓扑列入,避免认知负担。

**连接发现统一约定(各端同序,失败回退):** ① 环境变量 `ARC_SERVER_URL`(显式远程)→ OAuth 直连;② `~/.config/arclightagent/server.json`(本地 sidecar 写入的 `{port,token,pid}`,**文件权限强制 `0600` + 校验 owner**)→ loopback 直连复用同机内核;③ 自启本地 sidecar(桌面/CLI)→ 写 `server.json` → 连;④ Chrome 扩展沙箱读不到 `server.json` → 用 pairing code;⑤ Web 无本地选项 → 必须配置远程 URL。

---

## 2) 内核 ↔ 各端协议契约

> 内核侧**只实现一套**,各端只做"传输适配 + 事件 reducer + UI 渲染"。这是所有端共享的骨干。

### 2.1 四条逻辑通道(心智模型)

内核对每端暴露**四条逻辑通道**,物理上按端能力映射到不同传输:

| 通道 | 方向 | 语义 | 默认物理传输 | 载荷 |
|---|---|---|---|---|
| **C1 控制面(Command)** | 端→核 | 提交输入/中断/审批回传/能力声明/会话管理 | HTTP POST(请求-响应) | JSON,单条命令(`ArcCommand`) |
| **C2 事件面(Event)** | 核→端 | token/工具进度/压缩边界/权限请求/子代理通知/生命周期 | SSE(单向流) | NDJSON 帧,统一事件模型(`ArcEvent`) |
| **C3 双向实时面(Realtime)** | 双向 | 仅需服务端→端实时打断、语音 Realtime、computer-use 控制面板时叠加 | WebSocket | JSON 控制消息 |
| **C4 二进制媒体面(Media)** | 核→端(主) | computer-use 截图/屏幕帧、音频 | 独立 WS/WebRTC | JPEG/WebP+帧差 或 CDP/VNC,**绝不混入 C2** |

**关键纪律:** C1 是"命令队列入"(Submission),C2 是"事件流出"(Event),二者**逻辑解耦**(借 codex SQ/EQ 语义,但用 HTTP POST + SSE 落地而非进程内队列,因网页优先需跨网络)。`responseId`/`epoch` 作书签支持续接。

**C1/C2 复用同一条 WS 时的命令-应答关联协议(评审 B1 补齐):** 当端被迫把 C1+C2 复用同一条 WS(仅 Chrome MV3,因 SW 持不稳 SSE),HTTP POST 的天然"请求-响应/幂等/重试"语义在多路复用帧里会丢失。故**补一个 `ArcCommand`/`ArcAck` 最小契约**,让 WS 复用端恢复命令关联:

```ts
// @arclight/protocol —— 命令面(C1)最小契约(WS 复用端必需,HTTP 端可选用)
type ArcCommand =
  | { k: 'submit';     v: 1; commandId: string; sessionId: string; input: object }
  | { k: 'interrupt';  v: 1; commandId: string; turnId: string; reason: 'user'|'abort' }
  | { k: 'approve';    v: 1; commandId: string; askId: string; decision: 'allow'|'deny' }
  | { k: 'declareCap'; v: 1; commandId: string; profile: CapabilityProfile }
  | { k: 'resume';     v: 1; commandId: string; sessionId: string; afterSeq: number; epoch: number };

type ArcAck =                                  // 仅 C1+C2 复用同一连接时由内核回送
  | { k: 'ack';  v: 1; commandId: string; ok: true }
  | { k: 'nack'; v: 1; commandId: string; ok: false; code: string; message: string }
  | { k: 'resync'; v: 1; commandId: string; reason: 'buffer-expired'|'epoch-jump'; snapshotUrl: string };
```

> HTTP POST 端(Web/桌面/CLI 交互/VSCode)用 HTTP 的 req-resp 自带关联,`commandId` 可选作幂等键;WS 复用端(Chrome)**必须**用 `commandId` ↔ `ArcAck` 关联,且 `resume` 失败回 `resync`(见 §2.3 缓冲过期语义)。

### 2.2 传输层矩阵:各端传输选择与理由

| 端 | C1 | C2 | C3 | C4 | 连核方式 | 核心约束/理由 |
|---|---|---|---|---|---|---|
| **Web** | HTTP POST | **SSE** | WS(按需) | 独立 WS/WebRTC | 直连 HTTP(同源/CORS) | 纯 HTTP 无 sticky session、易横扩、`EventSource` 自带 `Last-Event-ID` 重连 |
| **CLI** | HTTP POST | **SSE**(交互)/**stdio JSONL**(`-p` 管道) | — | — | `serve` 本地 daemon→HTTP;或 `-p`/`--stdio` 直连子进程 | `-p`(ArcEvent NDJSON)与 `--stdio`(MCP JSON-RPC)是**两套互斥协议**,见 §4.4 |
| **桌面** | HTTP POST | **SSE** | WS(按需) | 独立 WS/WebRTC | sidecar stdio 握手→loopback HTTP/SSE;或远程 | stdio 仅"握手+健康+关停",业务走 loopback(性能优于 stdio 大流量) |
| **VSCode** | HTTP POST | **SSE** | WS(按需) | iframe webview 内嵌 | host 进程连内核;webview↔host=**postMessage** | webview 与 host 间用 postMessage(VSCode 强制),host 再代理内核 HTTP |
| **Chrome MV3** | **WS(C1+C2 复用,带 ArcAck 关联)** | **WS**(经 SW,非 SSE) | WS | side panel 内 | SW 持 WS;**SW 无状态可重启 + resume 续接** | **MV3 关键限制**:SW 即使有 WS 活动也存在 ~5min 周期性回收(见下),SSE 在 SW 休眠后状态丢→改用 WS + resume |

**逐端 load-bearing 理由:**
- **Web — SSE 默认**:单向 token 流恰好匹配 LLM 输出;SSE 纯 HTTP 无 sticky session,浏览器 `EventSource` 自带 `Last-Event-ID` 重连。WS 仅语音/computer-use 面板叠加。
- **桌面/CLI sidecar — stdio 仅握手**:内核在 stdout 打一行 `{"port","token","pid"}` JSON,端读到后切到 `http://127.0.0.1:<port>` 走 HTTP/SSE。**不**把 token 流塞 stdio(大流量背压差);stdio 保留给"关停信令、健康探针、崩溃日志"。
- **Chrome MV3 — 必须 WS 而非 SSE,且"resume"而非"保活"(评审 M2 技术事实纠正)**:
  - 事实一(已确认):Chrome 116+ **活跃 WebSocket 收发消息会重置 SW 的 30s 空闲计时器**,故 WS 心跳能解决"30s 空闲休眠"。
  - **事实二(评审 M2 修正,最关键):Chrome 对 SW 还有一条独立上限——单个事件/任务运行超过约 5 分钟会被强制终止,这条不被 WebSocket 活动豁免。** 心跳只防 30s 空闲,**防不了 ~5min 周期性回收**。
  - **因此唯一可靠设计 = SW 无状态可被随时杀死并重启 + 状态全在内核 + 每次重启发 `{k:'resume', afterSeq:N, epoch}` 续接 + `lastSeq/epoch/sessionId` 持久化到 `chrome.storage.session`。** 好消息:§4.6 的 resume 机制本就具备此能力——**这里只是把措辞从"心跳保活"如实改为"无状态可重启 + 续接",并把风险等级如实标注"高:周期性回收不可避免,可靠性靠续接而非保活"**,设计不需重做。
- **computer-use 截图独立二进制通道(C4,全端共性)**:多分钟会话每步一帧数百 KB,混入 C2 的 token SSE 会打爆带宽。**硬约束**:截图走独立二进制 WS 或 WebRTC,编码 JPEG/WebP + 帧差;高保真长会话用云浏览器 CDP/VNC 远程渲染。媒体面与事件面**永不复用同一连接**。

### 2.3 统一事件模型:内核 async-generator → 各端帧

内核主循环是自研最小 async-generator(主蓝图 §4.2),`yield` 出**统一事件枚举**——这是**唯一事实源**,各端帧都是它的同构投影:

```ts
// @arclight/protocol —— 内核与各端共享的唯一类型源(MVP 单 repo,零 codegen)
type ArcEvent =
  | { t: 'session.started';   v: 1; sessionId: string; epoch: number }
  | { t: 'turn.started';      v: 1; turnId: string }
  | { t: 'message.delta';     v: 1; turnId: string; role: 'assistant'; text: string }   // token 增量
  | { t: 'reasoning.delta';   v: 1; turnId: string; text: string }                       // 思维链增量(可关)
  | { t: 'tool.requested';    v: 1; callId: string; name: string; argsPreview: string }
  | { t: 'tool.progress';     v: 1; callId: string; pct?: number; note?: string }
  | { t: 'tool.output';       v: 1; callId: string; ok: boolean; preview: string; spillRef?: string } // 超限落盘投影
  | { t: 'context.compacted'; v: 1; turnId: string; epoch: number; keptTokens: number }  // 压缩边界
  | { t: 'permission.ask';    v: 1; askId: string; risk: 'low'|'med'|'high'; action: string; cls: 'read'|'write'|'irreversible'|'funds'; detail: object } // cls 见 §5.7 缺失③
  | { t: 'subagent.spawned';  v: 1; agentId: string; parentTurnId: string; role: string }
  | { t: 'subagent.update';   v: 1; agentId: string; status: 'running'|'completed'|'failed'; summary?: string }
  | { t: 'turn.completed';    v: 1; turnId: string; responseId: string; usage: Usage }
  | { t: 'session.error';     v: 1; code: string; message: string }                      // 5键 envelope,不泄 traceback
  | { t: 'interrupted';       v: 1; turnId: string; reason: 'user'|'abort'|'overflow' };
```

**每帧三不变量**:`t`(类型标签)、`v`(事件版本)、单调递增 `seq`(由 SSE `id:` 承载,用于断点续传)。`epoch` 是压缩边界/乐观锁统一编号——`context.compacted` 递增 epoch,客户端据此知道 cache 前缀已变。

**`seq` 持久化语义边界(评审缺失项②补齐):** `seq` 是 **per-session 单调序**(非 per-connection),由内核按 `sessionId` 持久化;重连 replay "`> afterSeq`" 由服务端按 session 序回放。**服务端短缓冲窗口 ≥60s**;**超过缓冲窗口或 epoch 跳跃的断线重连 → 内核回 `resync{reason, snapshotUrl}`,端拉全量快照而非增量 replay。** 三种续接路径明确:① 缓冲内 → 增量 replay;② 缓冲过期 → 强制全量 resync;③ epoch 跳跃(压缩边界已变,cache 前缀失效) → 强制全量 resync。

**端帧映射(同一事件,各端不同物理帧):**

| 物理传输 | 帧格式 | seq 承载 | 断点续传 |
|---|---|---|---|
| **SSE**(Web/桌面/CLI交互/VSCode) | `event:<t>\nid:<seq>\ndata:<json>\n\n` | SSE `id:` | 重连带 `Last-Event-ID`,服务端 replay > seq;过期→全量 resync |
| **WS**(Chrome MV3/实时面) | `{seq, ...ArcEvent}` 单 JSON 帧 | 帧内 `seq` | 重连后发 `{k:'resume', afterSeq:N, epoch}`;过期→`resync` |
| **stdio JSONL**(CLI `-p` headless) | 每行一个 `{seq, ...ArcEvent}` | 行内 `seq` | 进程内无需续传;崩溃靠 rollout replay |
| **postMessage**(VSCode webview↔host) | `host.postMessage({channel:'event', frame})` | 帧内 `seq` | host 持 SSE,webview 刷新后 host 重推快照 |

**前端 reducer 三纪律**(`@arclight/client-core`,各端复用):(1) **16ms 帧 coalescing**(`message.delta` 高频,按动画帧合批防抖);(2) **250ms 重连退避**;(3) **按 `seq` 单调去重**(重连 replay 的重复帧丢弃)。

**版本化与向后兼容:** 字段级带 `v`,新增可选字段不升 `v`;枚举 non-exhaustive,客户端遇未知 `t` 静默忽略并继续(forward-compat),遇未知枚举值降级到安全默认(未知 `risk`→按 `high`,未知 `cls`→按 `irreversible`,fail-closed);连接时 `Arc-Protocol-Version` 协商取 `min(client,server)`,MVP 固定 v1。

### 2.4 类型化 SDK 策略(取舍结论,评审 B2 措辞纠正)

- **MVP(主蓝图 §5.4 硬约束)**:单 repo 共享 TS 类型,**零 codegen**。`@arclight/protocol` 导出全部类型,内核与 Web 端 `import` 同一份;reducer/重连封在 `@arclight/client-core`。
- **第二端起(阶段五)——明确切两段,不找"OpenAPI→SSE 银弹"(评审 B2):**
  - **C1 命令面走 OpenAPI**:Hono 产 doc → `openapi-typescript` 生成命令客户端类型。
  - **C2 事件面完全不走 OpenAPI**:OpenAPI 对 SSE 表达力弱(只能描述为不透明字符串),故**以 `ArcEvent` union 为唯一源自建流式 codegen**——生成(a)discriminated-union 解析器、(b)`Last-Event-ID`/`afterSeq` 续传桩、(c)类型化 reducer 骨架。
  - **措辞纠正(评审 B2):opencode 的 SSE 表达力恰恰是靠它"自建 codegen(非 OpenAPI)"解决的(主蓝图 §5.4 亦承认)。** 故本文**不再说"采用 opencode 的 OpenAPI 思路"**——opencode 没用 OpenAPI。准确表述为:"**C1 走 OpenAPI/openapi-typescript;C2 完全不走 OpenAPI,以 ArcEvent union 为唯一源自建流式 codegen**",避免实现者去找不存在的 OpenAPI→SSE 银弹。
- **五参考实现取舍(指名道姓)**:**opencode** 的 server/client 分离骨架 + **自建流式 codegen 思路**采用(但用更轻的 Hono+openapi-typescript 做 C1,不引 Effect 4.x beta、不照搬其 Effect HttpApi);**cline** HostProvider 模式采用(各端 host 适配)、**protobuf/buf 不采纳**(重、易静默回退,用 JSON+TS 类型);**codex** SQ/EQ 命令/事件解耦语义采用、落地为 HTTP+SSE,`response_id` 书签 + non_exhaustive forward-compat 采用;**qwen-code** ACP 作"可选外部适配器"(未来被第三方 IDE 当 agent 接入,不进核心);**gemini-cli** A2A 仅留作多代理远程编排可选传输,**不**用于各端 UI 连接(A2A 是 agent↔agent,不是 agent↔UI)。**AG-UI** 仅作外挂适配器 `@arclight/adapter-agui`,把 `ArcEvent` 单向有损投影给第三方前端,**绝不绑架内核语义**(内核独有的 epoch 压缩边界/签名放行无 AG-UI 原生对应),MVP 不做。

### 2.5 鉴权/会话/租户上下文传播

每条 C1 命令/C2 订阅/C3·C4 连接,内核解析出并强制贯穿三元组:

```
RequestContext = { tenantId, userId, sessionId, capabilityProfile, authScope }
```

**传播链:** ① 认证中间件从 `Bearer` token 解出 `userId`+`tenantId`(本地 sidecar token 映射 default tenant;远程从 OAuth claim);② `sessions(tenant_id, user_id, id, epoch, ...)`,每次访问校验 `session.user_id == ctx.userId && session.tenant_id == ctx.tenantId`,否则 403;③ `tenantId` 下沉数据层(MVP 带 `tenant_id`,远程升 Postgres RLS);④ **凭证不随请求体传输**——provider key/MCP token 绝不进 C1 载荷,内核按 `userId` 从 keychain(本地)/KMS(远程)取。

**信任分级:** 本地内核=loopback bearer token(**注意:loopback ≠ 可信,见 §4.2/§5.7**);自托管远程=OAuth 2.1 + PKCE;MCP/外部工具凭证=独立 OAuth,存沙箱外凭证代理,按动作签名放行。**内核作为 MCP server 被外部接入时的反向鉴权见 §5.7 缺失项①。**

### 2.6 能力协商:端声明 capability profile,内核裁剪

每端连接时声明:

```ts
type CapabilityProfile = {
  localSandbox: boolean;      // 桌面/CLI=true, Web/Chrome/移动=false
  screenshot: 'none' | 'binary-ws' | 'webrtc' | 'cdp-vnc';
  background: 'full' | 'limited' | 'none';   // 桌面/CLI=full, Chrome=limited, Web=none, 移动=limited
  fileSystem: 'native' | 'browser-fsa' | 'none';
  terminal: boolean;
  push: boolean;
  maxBinaryChannel: number;
  realtimeControl: boolean;
  liveSession: boolean;       // ★ Chrome content-script 操控用户真实已登录会话=true,见 §5.7 缺失③
};
```

内核 `materialize(profile)` 裁剪:`localSandbox=false`→本地 exec 类工具不暴露,代码执行强制走 opt-in 远程沙箱或拒绝;`screenshot='none'`→computer-use 视觉工具裁剪;`background='none'/'limited'`→长任务绑定远程内核 + 断点续研;`fileSystem='none'`→读写落内核工作区;**`liveSession=true`→对真实登录会话的写/不可逆/资金类动作强制 HITL + 域名白名单(此时这不是纵深防御补充而是唯一边界,见 §5.7 缺失③)**。**纪律:能力协商是内核侧裁剪**(端谎报只会拿到处理不了的事件,内核仍以 profile 为准做安全决策)。最终工具集 = 端 capability profile ∩ agent profile(每能力独立 prompt 前缀+工具子集)。

---

## 3) 五能力 × 五端 落点矩阵

> **档位定义**:**主场**=该端最优载体,UX 上限最高;**可用**=能力完整/接近完整,非最优;**裁剪**=受端限制做删减或改走远程/opt-in;**不适合**=平台原理性不匹配,仅最小入口/转发。

### 3.1 总矩阵表(能力 × 端,单元格=档位 + 一句话适配要点)

| 能力 ＼ 端 | **Web**(P0) | **CLI**(Bun+OpenTUI) | **桌面**(Tauri2) | **VSCode** | **Chrome**(MV3) |
|---|---|---|---|---|---|
| **写代码** | **主场**:Monaco diff + iframe 沙箱终端 + SSE coalescing | **可用**:OpenTUI 文本 diff + 反射闭环;无图形 diff | **可用**:复用 Web + 本地 sidecar + 本地沙箱 | **主场†**:diff/LSP/SCM 走编辑器原生,内核出意图落 WorkspaceEdit(†Copilot 依赖见脚注) | **不适合**:仅代码托管页只读分析入口 |
| **写文章** | **主场**:富文本所见即所得 + 分阶段审批 + 溯源脚注 | **裁剪**:触发 + 流式文本 + 落 .md/.docx;y/n 审批 | **主场**:复用 Web 编辑器 + 本地文档库 + 离线草稿 | **可用**:Markdown-as-code,原生预览+diff+SCM | **裁剪**:side panel 划词取材 + 在线编辑器旁辅助 |
| **调研** | **主场**:subtopics 流式审批 + 进度 SSE + 可点击溯源 + 断点续研 | **可用**:流式进度 + 落 .md;引用降级脚注列表 | **主场**:复用 Web + 系统通知 + 本地归档 | **裁剪**:Chat 内发起,报告落工作区 Markdown | **裁剪**:就地对页面取材发起,转 Web/桌面看长报告 |
| **computer use** | **主场**:云浏览器(Browserbase/Steel)+ 截图独立 WS/WebRTC 帧差 | **不适合**:无截图载体,仅触发+文本审批 | **可用→裁剪**:浏览器复用 Web;OS 级 GUI 控制裁剪(远程沙箱+强 HITL,后置) | **不适合**:非 GUI 操控,仅转发触发 | **天然主场‡**:content script 就地操控真实会话 DOM/AX,推理在内核(‡真实登录会话风险见脚注) |
| **日常规划** | **可用**:日历/看板/checklist 全 UI + Web Push;无后台常驻 | **裁剪**:仅软件任务 Plan/Act+FocusChain+cron;无生活域 | **主场**:系统通知/托盘 + 后台常驻心跳 + 每日简报弹窗 | **裁剪**:仅编码任务 Plan/Act+task_progress;无生活域/提醒 | **不适合**:无常驻通知/随身性,仅 side panel 只读待办 |

> **脚注 †(VSCode 写代码"主场"定级的诚实定价,评审 M3):** 第三方 Chat Participant 经 Copilot Chat 暴露,通常须在 `package.json` 声明对 `github.copilot`/`github.copilot-chat` 的 `extensionDependencies`,**即用户必须装并登录 GitHub Copilot,你的 participant 才出现在 Chat 里**;且 participant 经 Copilot Chat 暴露时**模型路由权在 Copilot,不在你的内核**——这与全文"内核是唯一推理域"的核心纪律直接打架。故"主场"附带**二选一**(详见 §4.5),不再无保留标注。
>
> **脚注 ‡(Chrome 写文章/computer-use 主场的安全失效面,评审缺失③):** content script 操控的是**用户真实已登录会话**(带真实 cookie/session),浏览器已替 agent 鉴权——prompt injection 让 agent 在已登录的 GitHub/银行页点"转账/删库"**不需要任何凭证签名放行**。故此端的"沙箱内零凭证"硬边界**失效**,域名白名单 + 高危动作 HITL 在此**是唯一边界**,见 §4.6/§5.7。
>
> 全表凡"执行"均遵守端无关硬边界:**默认本地沙箱、凭证沙箱外签名放行、Chrome/移动无本地执行后端则走远程 opt-in**;唯一例外是 Chrome 操控真实登录会话(脚注‡)。

### 3.2 跨端共享内核 vs 端特定执行后端(总结论)

- **"跨端共享内核、仅 UI/输入/通知差异"的纯薄壳能力 = 写文章 / 调研**:全部业务逻辑在内核(paper-* 流水线 / Orchestrator-Subagent / CitationAgent / 持久化 / 断点续研),端仅换编辑器/审批 UI 与输入方式(键盘/语音/划词)+ 完成通知通道,**无端特定执行后端**。
- **"内核共享决策 + 端特定后端落地"能力 = 写代码 / computer use / 日常规划**:

| 能力 | 端特定后端 | 各端落地 |
|---|---|---|
| **写代码** | **编辑落地 + 沙箱执行后端** | VSCode:WorkspaceEdit + 原生 LSP/diff/SCM;桌面/CLI:内核本地沙箱;Web:云 iframe 沙箱 |
| **computer use** | **GUI 操控执行后端(差异最大)** | **Chrome:content script DOM 动作(天然后端,但操控真实登录会话→§5.7 缺失③特判)**;Web/桌面:远程云浏览器 CDP(Browserbase/Steel,干净会话);桌面 OS 级(后置)。**感知/推理/安全闭环不变,仅后端可插拔** |
| **日常规划** | **主动提醒通知投递后端** | 桌面:Tauri 系统通知/托盘;Web:Web Push;CLI:终端打印;VSCode:编辑器通知。**心跳协调器在内核决定"何时/是否夜间静默",端仅按本端通道投递** |

三类端特定后端均**可插拔、不改内核感知/推理/安全闭环**。**Chrome MV3 无 eval/SW 非常驻 + content script 操控真实登录会话** 是矩阵 Chrome 行所有"裁剪/天然主场/特判"判定的根因。

---

## 4) 逐端详设

> 各端保留 ASCII 架构图、能力裁剪、鉴权/密钥/同步、分发更新、硬约束、复用边界、排期。

### 4.1 Web 网页端(先发 / P0)

**定位:全平台参照实现端**——内核契约先在此打通,其他端复用。

```
┌─ 浏览器 ─────────────────────────────────────────────────────────────────┐
│  Next.js App Router (RSC + Client Components)                            │
│   Route/Page/Layout(RSC,SSR 首屏) → Client Components('use client')     │
│   ┌─ ChatShell ──┐ ┌─ CapabilityPanel ──────────────────────────────┐   │
│   │ MessageList   │ │ CodeEditor(Monaco diff) · ResearchPanel(溯源)  │   │
│   │ ToolCards     │ │ WritingFlow(章节流式) · ComputerUse(截图+HITL) │   │
│   │ InputBar      │ └──────────────────────────────────────────────┘   │
│   └──────────────┘  PermissionModal(权限/HITL)                          │
│   ┌─ @arclight/client-core(纯 TS,端无关) ──────────────────────────┐    │
│   │ EventStreamManager(SSE 重连+去重) · SessionReducer(ArcEvent→UI)│    │
│   │ CommandClient(C1 POST) · EpochTracker(乐观锁/StaleEpochError)  │    │
│   └────────────────────────────────────────────────────────────────┘    │
│   assistant-ui(无头流式,消费 threadStore)                              │
│   PWA Service Worker(@serwist/next):静态缓存 · 离线只读 · Web Push     │
└──────┬──────────────────────────────┬───────────────────────────────────┘
       │ C1 POST / C2 SSE             │ C4 独立 WS/WebRTC(截图)
       ▼                              ▼      C3 WS(按需)
┌─ @arclight/core (Bun+Hono) ─ Hono Router → Auth → 主循环 → SSE/媒体端点 ─┐
```

**技术选型**:Next.js 15 App Router(MIT)/ Vercel AI SDK v6(**Apache-2.0**,`streamText`，**仅内核侧**)/ assistant-ui(MIT,无头,`ExternalStoreRuntime`)/ Monaco Editor(MIT,懒加载)/ marked+shiki(MIT)/ Tailwind v4+shadcn(MIT)/ Zustand(MIT)/ @serwist/next(MIT,PWA)/ web-push VAPID(MIT)/ @tanstack/react-virtual(MIT)/ Auth.js v5(ISC)。**刻意不引**:effect(beta)、LangChain/LangGraph、protobuf/buf、AG-UI 适配器(后置)、**`@assistant-ui/react-ai-sdk`（D1 选型修订移除，见 DEV_PLAN §7.2）**。

**能力裁剪**:写代码/写文章/调研=主场(无裁剪);computer-use=主场(云浏览器,MVP 不交付,组件占位);日常规划=可用非主场(Web Push 在 iOS Safari 仅 PWA 装主屏才生效,稳定性弱于移动原生,阶段五交付)。

**鉴权/密钥/同步**:① 自托管单用户(MVP)=localhost 信任 + pairing secret(经环境变量注入,非明文提交),session 走 httpOnly Cookie,**前端 JS 永不接触 refresh token**;② 远程多租户(P5)=Auth.js OAuth2.1+PKCE,refresh 内核 KMS,access 短效 httpOnly Cookie。provider key/MCP token 全内核保管。CSP 硬化 + Trusted Types 防 XSS。断点续传靠 `Last-Event-ID` + EpochTracker(epoch 跳跃/缓冲过期时拉全量快照,见 §2.3)。弱离线:SW 缓存只读快照,写操作 IndexedDB 排队按 epoch 重放。

**分发/更新**:`next build`,Vercel / 自托管 Docker。**无商店审核,秒级部署**——五端运维灵活性最高。PWA Service Worker 更新弹 toast 提示(不静默 skipWaiting,防长任务丢状态)。

**硬约束与坑(诚实)**:① **Vercel SSE 超时**(Serverless 30s/Edge 25s)与长推理不兼容→前端直连独立部署的内核(VPS/Fly.io),SSE 不经 Vercel 函数代理;② `EventSource` 无法设自定义 header(已确认的硬限制)→**鉴权优先级(评审 B3 收紧)**:(a) **同源 + httpOnly Cookie(默认,最优)**;(b) **跨域优先用 `fetch`+`ReadableStream` 手写 SSE 解析(可带 `Authorization` header,绕开 EventSource 限制)**;(c) token-in-URL **仅作最后回退**且强制单次失效 + TTL 60s + 不记 access log(因 URL query token 会进 access log/history/Referer);③ 浏览器 HTTP/1.1 6 连接限制→内核强制 HTTP/2,同时只订阅一个活跃 session;④ Monaco 在 iOS Safari 输入法残缺→移动浏览器降级只读 diff;⑤ Web Push 在 iOS 仅 PWA 装主屏有效;⑥ SSE 重连"幻影重复"→内核短缓冲 ≥60s + turn 完成持久化 + epoch 跳跃/缓冲过期拉全量;⑦ Worker 与 CSP 冲突→`worker-src 'self' blob:` + 预 bundle worker。

**复用边界**:Web 端建立的 `@arclight/protocol` + `@arclight/client-core` 是参照实现,其他端复用不 fork;Web 独有=Next.js/RSC/PWA/Auth.js Route Handler/Monaco;Web 端**不 import** 任何 `@arclight/core` 内部模块(只经 HTTP/SSE 消费,monorepo workspace 依赖图强制)。

**排期**:阶段一 ~10 周(其中 client-core 1.5 周是各端公共基建,摊薄后净投入 ~8.5 周)。关键前置:内核 SSE endpoint 可用、`@arclight/protocol` v1 定稿、CapabilityProfile 协商端点、HTTP/2 配置。

### 4.2 CLI 终端(P2)

**定位:最早证明骨架解耦的端**(主蓝图阶段一验收明文要求"最小 CLI 客户端连上内核")。

```
┌─ arclight CLI 单二进制(Bun --compile --bytecode,arg0 multicall)────────┐
│ [交互 TUI 模式]                    │ [headless -p]  vs  [--stdio MCP]      │
│  OpenTUI:InputBar/MessageList/    │  -p:    stdin=ArcCommand · stdout=    │
│  ToolProgressPanel/PermissionModal│         ArcEvent NDJSON               │
│                                    │  --stdio: MCP JSON-RPC(互斥!见下)   │
│ ┌─ CLI 核心层(端无 UI 依赖)──────────────────────────────────────────┐│
│ │ CommandRouter · EventReducer(16ms coalesce)· SessionManager · PermHandler││
│ │ TransportAdapter:交互=HTTP POST(C1)+SSE(C2);headless=stdio JSONL 双向 ││
│ │ KernelConnector 连核发现:env→server.json→arc serve 自启 sidecar       ││
│ └────────────────────────────────────────────────────────────────────┘│
└──────────┬──────────────────────────┬──────────────────────────────────────┘
           │ HTTP/SSE                  │ stdio(-p NDJSON / --stdio JSON-RPC)
           ▼                           ▼
        ┌─ 内核服务(Bun+Hono,CLI 不重写任何内核逻辑)────────────────────────┐
```

**子命令/multicall**:`arclight`(TUI)/`-p`(headless)/`--stdio`(MCP server)/`serve`(daemon)/`login`(设备码流)/`sessions`/`resume`/`config`/`upgrade`。`arg0 multicall` 检测 basename 路由 `arclight-serve`/`arclight-mcp`(借 codex)。

**两套 stdio 协议互斥(评审 B5 补齐):** `-p` 与 `--stdio` 都占 `stdin/stdout` 但**帧格式不同、不可同时**:

| 模式 | stdin/stdout 协议 | 用途 | 路由 |
|---|---|---|---|
| `-p` headless | **ArcEvent NDJSON**(每行一帧,stderr 走人类日志) | CI/脚本/管道,退出码 0/1/2/3 | flag `-p` |
| `--stdio` MCP | **MCP JSON-RPC**(内核作 MCP server 暴露给第三方 IDE/agent) | 被外部 agent 接入(鉴权见 §5.7 缺失①) | flag `--stdio` 或 basename `arclight-mcp` |

> **纪律:`-p` 与 `--stdio` 互斥,同时给即报错退出。** 选择由 flag/basename 显式路由,文档与 `--help` 明示"这是两套不同协议"。

**技术选型**:Bun `--compile --bytecode`;OpenTUI(主蓝图指定);`@std/cli`/`citty`(轻量,multicall 自实现);`@napi-rs/keyring` 或独立 Rust helper 子进程(Bun compile 对 native addon 支持有限);`@arclight/protocol`+`@arclight/client-core`。**不引** ink/blessed/LangGraph/mem0/AG-UI/Effect。

**能力裁剪**:写代码=可用(OpenTUI 文本 diff,RepoMap/SEARCH-REPLACE/反射闭环/本地沙箱全保留,`/undo`→`arclight undo`,headless 退出码语义 0/1/2/3);写文章=裁剪(流式文本+y/n 审批+落文件);调研=可用(流式 subtopics+`resume`+`--detach`);computer-use=不适合(无截图载体,仅触发+文本日志);日常规划=裁剪(仅软件任务 Plan/Act+FocusChain+cron,无生活域/主动通知)。

**鉴权/密钥/同步**:设备码流(RFC 8628,SSH/无浏览器友好);本地 sidecar 模式读 server.json 的 localToken;token 存 OS keychain;rotating refresh;**Linux 无 keyring 守护进程**→提示装 gnome-keyring/用 `pass`/`ARC_TOKEN` 环境变量(session-only)/`--token-file`(K8s secret),**绝不回落明文文件**。强离线(本地 serve)。断点续连 `Last-Event-ID`。

**分发/更新**:Bun cross-compile 8 target(Windows 元数据需 windows runner + rcedit);签名 codesign+notarize(macOS)/Authenticode(Windows)/minisign(Linux)+sha256;GitHub Releases + `install.sh` 一键;`arclight upgrade` 验签后原子替换(Windows 两步式)。**无商店审核**,即时发安全修复。

**硬约束与坑**:① headless 输出污染→`--stdio`/`-p` 强制 NO_COLOR+日志走 stderr+CI 校验每行合法 JSON;② 大输出 stdio 背压→`spillRef` 落盘 + `--output-file`;③ Linux/Docker/CI 无 keyring→env/token-file;④ Windows 路径/元数据/非原子 rename→platformDataDir 封装 + 两步式更新;⑤ 非 TTY 检测→`isTTY` 判断 + `--tui`/`--no-tui` + 失败回落纯文本;⑥ Bun --compile native addon 限制→Rust helper 子进程;⑦ SSE 帧丢失→内核环形缓冲 + seq 跳跃警告 + `resume`。

**排期(评审重定价)**:**最小 spike(仅 `-p`,2-3 天)放阶段一末**(验收骨架解耦 + headless 服务 CI eval harness,工时合理)。**完整版(TUI+全子命令)放阶段五:`--bytecode` 仍是较新特性、跨 8 target 交叉编译 + Windows 元数据 + 各平台签名/公证是真实运维重活,"~4-6 周"对单/双人偏紧,按 ~6-8 周(单端口径)且预留签名/CI 打通缓冲更现实。** 与 VSCode 共用 `@arclight/auth-device-flow`(可抽),与桌面共用 keyring helper + server.json 发现。

### 4.3 桌面端(Tauri 2.0 / P3,先 PWA 过渡)

**定位:Web 前端 + 本地内核 sidecar + Rust 薄壳 + 原生集成的组合装配**,核心价值=本地优先/离线/原生体验三增益。

```
┌─ 桌面 App (Tauri 2.0, 单进程双层) ─────────────────────────────────────┐
│ ┌─ WebView 层(复用 Web 前端 100%)──────────────────────────────────┐ │
│ │ Next.js + AI SDK v6 + assistant-ui + @arclight/client-core          │ │
│ │ HostProvider(desktop 实现)── 平台能力抽象(文件对话框/通知/托盘/   │ │
│ │   快捷键/deep-link),同一前端 Web/桌面切实现 ─┐                     │ │
│ └──────┬───────────────────────────────────────┼─────────────────────┘ │
│   ① HTTP POST(C1)+SSE(C2)+WS(C3/C4) 指 127.0.0.1│ ② Tauri IPC(仅平台能力)│
│ ┌──────▼─────────────────────────────────────────▼──────────────────┐  │
│ │ Rust 壳层(tauri-core,薄):Sidecar 管理器(spawn+stdio 握手) ·     │  │
│ │ 连接发现/编排 · 原生集成(托盘/快捷键/通知/deep-link/单实例) ·    │  │
│ │ 安全存储桥(keyring crate→Keychain/DPAPI/libsecret;Stronghold 兜底)│  │
│ └──────┬─────────────────────────────────────────────────────────────┘ │
└────────┼─────────────────────────────────────────────────────────────────┘
         │ spawn(stdout 首行 {"port","token","pid"})← stdio 仅握手/健康/关停
         ▼
   ┌─ 内核 sidecar(@arclight/core,Bun+Hono,绑 127.0.0.1)─ 业务全走 loopback ─┐
   └─ 或 远程模式:WebView 直连 https://remote(OAuth2.1,不 spawn sidecar)──┘
```

**两路径纪律**:业务流量(C1/C2/C3/C4)WebView 直发 loopback HTTP/SSE,**绝不走 Tauri IPC 或 stdio**;IPC 只承载平台能力(文件对话框/系统通知/keychain/快捷键/deep-link),**不承载业务**(cline HostProvider 模式)。

**技术选型**:Tauri 2.0(系统 WebView ~12MB,不用 Electron)+ Rust 薄壳;前端复用 Web;`keyring` crate(MIT/Apache)+ `tauri-plugin-stronghold` 兜底;`tauri-plugin-updater`(minisign 签名增量);notification/global-shortcut/shell/deep-link/autostart/single-instance/dialog/fs 插件(MIT/Apache)。内核以 Bun `--compile --bytecode` 单二进制作 externalBin 嵌入。

**能力裁剪**:写文章/调研/日常规划=主场(本地文档库/系统通知/托盘/后台常驻心跳);写代码=可用(本地 sidecar+本地文件直读,缺 VSCode 编辑器生态);computer-use=可用→裁剪(浏览器复用 Web,OS 级 GUI 控制后置)。

**鉴权/密钥/同步**:本地=loopback bearer token+sidecar 握手;远程=OAuth2.1 系统浏览器回环(`tauri-plugin-shell` 开系统浏览器,**不内嵌登录页**,loopback redirect+PKCE 或 `arclight://` deep-link)。密钥三 OS:Keychain/DPAPI/libsecret,Linux 无 keyring 时回落 Stronghold(KDF 加密文件,非明文)。**强离线**(本地 sidecar 即真相源)。epoch 乐观锁复用,冲突合并/durable 后置阶段二。

**loopback token 信任面硬化(评审 M4 必须修复——主蓝图未覆盖、本文新引入面):** `server.json` 里的 loopback `token` **是访问内核全部能力(含触发凭证签名放行)的 bearer**,同机任意能读该用户 `~/.config` 的进程/恶意脚本拿到 `port+token` 即可直连内核接管全部能力。**`loopback ≠ 可信`,绝不能因"不是密钥本体"就降级为"非密"。** 修复三条:
1. **`server.json` 文件权限强制 `0600` + 内核启动时校验 owner**;
2. **token 绑定 `pid` + 短 TTL**,内核侧校验调用方进程身份(macOS `SecCode` / Linux `SO_PEERCRED` / Windows process token);
3. **文档与 §5.3 明确写出"loopback token 是 bearer,泄露 = 完全接管内核(含凭证签名放行链)",不再标"非密钥本体"。**

**分发/更新/合规**:Tauri bundler(.dmg/.msi/.AppImage/.deb);**macOS notarize + Windows 代码签名是硬门槛**(但远低于商店审核);Tauri updater 签名增量近即时下发;sidecar 随壳签名打包,Linux 只 exec 系统 bwrap 不 vendoring;Mac App Store 仅可选受限版(App Sandbox 限制 spawn sidecar/本地文件/快捷键,非主路径)。

**硬约束与坑**:① 系统 WebView 碎片化(WKWebView/WebView2/WebKitGTK,Linux 尤其落后)→三平台 E2E + SSE 重连兜底 + Windows 分发 WebView2 Runtime;② Linux webkit2gtk 依赖差异→.deb/.rpm 声明 + AppImage 自带 + PWA 兜底;③ sidecar 孤儿进程/端口冲突→stdio 健康探针 + 随机端口 + pid 检测 stale 清理 + single-instance + 空闲超时自退;④ stdio 大流量误用→架构强制 stdio 仅握手;⑤ notarize/签名成本→CI 集成(需 macOS+Windows runner);⑥ 多端并发状态(cline 实证 StateManager 无跨实例同步)→内核单一真相源+epoch+SessionUpdated 广播从根避免;⑦ Linux keyring 缺失→Stronghold/pass 兜底,绝不明文 `~/.config`;⑧ **loopback token 同机信任面→见上"硬化三条"。**

**排期**:P3 / 阶段五全平台壳。前置:Web 前端稳定 + 内核 sidecar 化(CLI 先验) + 共享包抽出 + 签名证书。工作量集中在 Rust 壳层 + 打包签名,小于从零新端,**~6-8 周(单端口径)**。

### 4.4 VSCode 插件(P3)

**定位:写代码主场(附 Copilot 依赖二选一,见下)**——编辑器原生 diff/LSP/SCM 即端特定执行后端,内核出编辑意图,VSCode 落地。

```
┌═ VSCode Extension Host Process(@arclightagent)════════════════════════════┐
║ extension.ts:注册 Chat Participant + MCP server + authentication + Commands ║
║ ┌─ ArcKernelClient(C1/C2/C3)─┐  ┌─ VSCodeHostProvider(cline 模式)──────┐ ║
║ │ HTTP POST · SSE · WS(按需)  │  │ DiffView · WorkspaceEdit · Terminal · │ ║
║ │ seq/Last-Event-ID · 250ms 退避│  │ Diagnostics · SecretStorage · SCM     │ ║
║ └──────────┬───────────────────┘  └───────────────────────────────────────┘ ║
║ ┌──────────▼─ EventReducer(@arclight/client-core,各端共享)───────────────┐ ║
║ └──────┬──────────────┬───────────────────────────────────────────────────┘ ║
║ ┌──────▼──────┐  ┌────▼─ Webview Panel(内核推理主路径,独立 Vite+React)──┐ ║
║ │Chat Participant│  │ ↕ postMessage envelope(类型化,不上 protobuf)        │ ║
║ │(可选轻入口)   │  │ diff 审批/写作分阶段审批/调研报告/FocusChain          │ ║
║ └──────────────┘  └──────────────────────────────────────────────────────┘ ║
║ Native 集成:WorkspaceEditApplier · DiagnosticsWatcher · SCMProvider ·       ║
║             TerminalManager · TaskTreeView · StatusBarItem                   ║
╚════════════════════════════╤═════════════════════════════════════════════════╝
                  HTTP/SSE(localhost or HTTPS+OAuth)→ @arclight/core
```

**Copilot 依赖与"内核唯一推理域"的二选一(评审 M3 必须修复——不能两头都要):** Chat Participant 经 Copilot Chat 暴露时,(a) 用户须装并登录 GitHub Copilot(`extensionDependencies` 声明),(b) **模型路由权在 Copilot 而非你的内核**。这与全文"内核是唯一推理域"直接冲突。两条路明确选一,**本文采路线 B 为主、A 为可选轻入口**:

| 路线 | 主路径 | 推理域 | 代价 | 取舍 |
|---|---|---|---|---|
| **A. Chat Participant 为主** | `vscode.chat.createChatParticipant` | **模型由 Copilot 提供,内核退化为工具/MCP 提供方** | 放弃"内核唯一推理域"在此端的纯粹性;依赖第三方商业扩展存在与登录 | **不取为主**(违背核心纪律) |
| **B. Webview Panel 为主(本文采用)** | 独立 Vite+React Webview,host 持 SSE 连内核 | **内核推理**,纯粹性保持 | "零聊天 UI 开发""复用 Copilot 订阅"卖点落空;Webview UI 工时上调 | **采为主路径**;Chat Participant 仅作**可选轻入口**(Copilot 在时给个 `/arc` 命令转发,缺失时纯 Webview) |

> **结论:VSCode 写代码"主场"=Webview Panel 主路径 + 内核推理;Chat Participant 降为可选轻入口。** 工作量按"含 Webview Panel"口径定价(见下排期),不再用"零 UI 开发"的乐观估计。

**技术选型**:TS + esbuild;`vscode.chat.createChatParticipant`(1.90+,**可选轻入口**)/`authentication`/`SecretStorage`/`WorkspaceEdit`/`DiagnosticCollection`/`SourceControl`;`@arclight/client-core`+`@arclight/protocol`;webview UI=React+Vite(**主路径**,不引 Next.js/assistant-ui);`@modelcontextprotocol/sdk`(Streamable HTTP)。**不引** protobuf/buf/LangGraph/mem0/AG-UI。

**能力裁剪**:写代码=主场(**Webview Panel 主路径**,`message.delta`→Webview 流式渲染,内核 SEARCH/REPLACE→`WorkspaceEdit`,**LSP 走 `onDidChangeDiagnostics` 回传内核作反射闭环输入**,shadow-git→SCM 面板回滚;图形 diff `vscode.diff()`;Chat Participant 在 Copilot 存在时作 `/arc` 轻入口);写文章=可用(Markdown-as-code);调研=裁剪(Webview/Chat 发起+落工作区+TaskTreeView);computer-use=不适合(仅 GitHub/GitLab 只读分析入口);日常规划=裁剪(仅软件任务 FocusChain,无生活域)。

**鉴权/密钥/同步**:首选 `registerAuthenticationProvider`(OAuth2.1+PKCE via `openExternal`+loopback);本地=server.json localhost 信任(同 §4.3 loopback token 硬化);vscode.dev 回落设备码流。token 存 `SecretStorage`(底层 keychain),provider key/MCP token 内核保管。host 持 SSE,webview 刷新 host 重推快照。epoch StaleEpochError/缓冲过期→QuickPick 提示重试/全量 resync。**离线=中**,不做离线写队列。

**分发/更新/合规**:webview-ui Vite build(CSP-safe nonce)+ src esbuild bundle → `vsce package`;**Marketplace + Open VSX 同步发布**(覆盖 VSCodium/Cursor/Windsurf);Marketplace 内置更新无需自建 updater;CSP 禁 eval/unsafe-inline,权限/telemetry 遵守 VSCode 设置;README 声明"推理在内核,插件不执行远程 JS";审核数小时(重大权限变更 1-3 天)→安全修复走内核。

**硬约束与坑(诚实)**:① **Extension Host 共享进程**(cline 实证 heavy lifting 致 IDE 卡顿)→内核独立进程,Host 只做 client+reducer+UI,**绝不跑推理/沙箱**,16ms coalescing 防 postMessage 风暴,spillRef 不缓存大输出;② webview 双 API 问题(cline 旧路径并存)→统一类型化 envelope `{channel,seq,payload}`,不留旧路径;③ **Chat Participant 限制(只支持 MarkdownString、不支持多模态、`extensionDependencies` 依赖 Copilot Chat 存在与登录、模型路由权在 Copilot)→故主路径走 Webview Panel(内核推理),Chat Participant 仅可选轻入口**;④ Remote/Codespaces/vscode.dev 拓扑差异;⑤ **vscode.dev Web Extension 无 Node.js**→P3 初版不支持(`engines` 标注),P5 再评估;⑥ MCP server 注册两跳链路(Copilot→插件 MCP→内核)→插件 MCP 做薄代理无状态幂等。

**排期**:P3 / 阶段五。前置:内核 HTTP/SSE 稳定、`@arclight/protocol`、client-core 提取、OpenAPI→TS SDK 基建、OAuth、MCP native。**工作量按"含 Webview Panel 主路径"口径上调:~45-66 人日(2 人×4.5-6.5 周)**;里程碑 M1 写代码 Webview 主路径(2-3 周)→M2 认证+MCP(1 周)→M3 写文章/调研适配+发布(1 周)→M4 Chat Participant 可选轻入口(0.5-1 周)。

### 4.5 Chrome 扩展(MV3 / P4)

**定位:computer-use 天然主场(附真实登录会话安全特判,见下)**——content script 就地操控用户真实已登录会话的 DOM/AX,推理在内核。

```
┌─ Chrome 浏览器进程 ───────────────────────────────────────────────────────┐
│ ┌─ side panel(主 UI,React+assistant-ui)─┐ ┌─ content script(注入页面)─┐│
│ │ 消息流 + @arclight/client-core reducer    │ │ DOM/AX 动作执行器           ││
│ │ 权限/HITL 弹层 · computer-use 截图面板    │ │ click/type/scroll/extract   ││
│ └────────────┬──────────────────────────────┘ │ AX 快照+视觉兜底截图        ││
│              │ chrome.runtime(port:'ui')        └──────────┬──────────────────┘│
│ ┌════════════▼═ background service worker(中枢,唯一持网络)═══════════════┐│
│ │ WS 客户端→内核(C1+C2 复用同一 WS,带 ArcAck 关联) ·                       ││
│ │ ★ SW 无状态可被随时杀死并重启(非"保活"):心跳只防 30s 空闲,~5min 仍周期回收 ││
│ │ 消息路由(WS事件 fan-out / 命令汇聚) · capability 声明(liveSession:true) · ││
│ │ 短效 access token(chrome.storage.session 内存域)· 最小快照(sessionId/   ││
│ │ epoch/lastSeq → 重启发 {k:'resume',afterSeq:N,epoch} 续接;过期→resync)    ││
│ └════════════════════════════════┬═══════════════════════════════════════════┘│
│        (可选)offscreen document:WebRTC/媒体解码、Transformers.js 轻量前处理  │
└────────────────────────────────────┼───────────────────────────────────────────┘
              WS ws://127.0.0.1(本地,默认)/ wss://host(远程)
                                     ▼
   ┌─ @arclight/core ─ 唯一推理域+沙箱域+凭证代理;computer-use 决策/规划在内核 ─┐
   └─ 云浏览器路径:Browserbase/Steel CDP-VNC(干净会话,非本浏览器会话时)→ side panel ─┘
```

**MV3 四上下文纪律**:SW 是唯一持网络连接的中枢,side panel/content script/offscreen 一律经 `chrome.runtime` 与 SW 通信,绝不各自连内核。**C1+C2 复用同一条 WS**(SW 无法稳定持 SSE),用 `commandId`↔`ArcAck` 恢复命令关联(§2.1 B1)。

**SW 生命周期如实表述(评审 M2):** **SW 不是"被保活"而是"无状态可被随时杀死并重启"**——Chrome 116+ 的 WS 活动只重置 30s 空闲计时器,**防不了 ~5min 周期性回收**(此回收不被 WS 活动豁免)。故唯一可靠设计 = SW 无状态 + 状态全在内核 + 每次重启发 `{k:'resume', afterSeq:N, epoch}` 续接 + `lastSeq/epoch/sessionId` 持久化 `chrome.storage.session` + 缓冲过期回 `resync` 拉全量。computer-use 长会话(动辄数分钟到数十分钟)**必须**假设 SW 会被周期性杀死,把"连接保持"建在"续接"而非"保活"上。

**技术选型**:MV3 + service worker(ES module)+ side panel(`chrome.sidePanel`)+ React+assistant-ui;`@arclight/client-core`+`@arclight/protocol`;WebSocket+`chrome.alarms`;content script DOM/AX + html2canvas/captureVisibleTab 视觉兜底 + 云浏览器 CDP;`chrome.identity.launchWebAuthFlow`(PKCE);Vite+`@crxjs/vite-plugin`。**Chrome Prompt API(Gemini Nano)不用于正式发布**(Origin Trial,Web Store 不允许),仅 Transformers.js 作可选轻量前处理(非推理)。

**能力裁剪**:computer-use=天然主场(content script 即执行后端,截图本地采集不过网);写文章=裁剪(side panel 划词取材+在线编辑器旁辅助);调研=裁剪(就地取材发起,转 Web/桌面看长报告);写代码/日常规划=不适合(仅只读入口)。capability:`localSandbox:false, screenshot:'binary-ws', background:'limited', fileSystem:'none', push:false, realtimeControl:true, liveSession:true`。

**真实登录会话安全特判(评审缺失③——本端独有的更高风险面,"零凭证"硬边界在此失效):** content script 操控的是**用户真实已登录会话**(带真实 cookie/session),**浏览器已替 agent 鉴权**——prompt injection 让 agent 在已登录的 GitHub/银行页点"转账/删库"**不需要任何凭证签名放行**,内核的"凭证不在执行域"硬边界在此**失效**。因此对真实登录会话的 computer-use:
- **域名白名单 + 高危动作 HITL 不再是纵深防御补充,而是唯一边界;**
- **动作必须分类(`cls: read | write | irreversible | funds`,见 §2.3 `permission.ask`),写/不可逆/资金类一律强制 HITL,默认拒绝;**
- isolated world 降注入面 + 页面文本来源标注/隔离 + 二次 LLM 审查 仍作纵深;
- 干净会话需求(无用户身份)走云浏览器 CDP(Browserbase/Steel),不在本浏览器真实会话执行。

**鉴权/密钥/同步**:`launchWebAuthFlow`(redirect `https://<ext-id>.chromiumapp.org/`),短效 access 存 `chrome.storage.session`(内存域,关闭即清),**refresh+provider key+MCP token 全程内核**;本地内核用 pairing code(扩展沙箱读不到 server.json);**`chrome.storage` 非加密→禁存任何密钥**(浏览器=不可信执行域,密钥换的是动作结果);CSP 禁 eval/远程脚本,host_permissions 收窄;**离线=弱**(只读快照+epoch 校验)。

**分发/更新/合规**:Vite+crxjs→zip→Chrome Web Store;Web Store 托管自动更新(需重审);**审核数小时-数天,敏感权限(`<all_urls>`/`debugger`/computer-use 类)触发深审**→最小化权限(activeTab 优先于 `<all_urls>`)+ 用途说明;**安全逻辑收敛内核**(审核周期使端侧修复无法即时下发,薄壳红利)。

**硬约束与坑(诚实)**:① **SW 30s 空闲休眠 + ~5min 周期性回收(WS 活动不豁免)**→WS+心跳防 30s 空闲、**resume 续接防 5min 回收**(非保活),长任务绑内核;② MV3 禁 eval/远程 JS→推理全内核,Prompt API 不正式发布;③ chrome.storage 非加密→禁存密钥;④ **computer-use 操作真实登录会话(风险面最大,"零凭证"硬边界失效)→见上"安全特判":域名白名单+动作分类+写/资金类强制 HITL 是唯一边界**,isolated world 降注入面;⑤ content script 注入限制(file://、Web Store 页、严格 CSP 站点、SPA 时序)→失败降级提示+元素就绪轮询+回退云浏览器 CDP;⑥ 本地内核发现(读不到 server.json)→pairing/loopback OAuth;⑦ 审核延迟→安全逻辑内核;⑧ 截图带宽→本地采集不过网/云浏览器走独立二进制 WS/WebRTC 帧差。

**排期**:**P4(五端最低)/ 阶段五,绝不前置**。硬前置:**阶段四 computer-use 内核能力**(无此则无主场)、协议+共享包稳定、内核 WS 端点+resume/resync+capability materialize、OAuth/token-refresh。工作量 ~3-5 人周(SW WS 中枢+resume 续接最核心坑最多;content script DOM/AX 执行器 + 真实会话动作分类是主场核心)。

---

## 5) 跨端横切关注点

> **横切关注点的"真相"全在内核**。各端只是"如何安全地把请求/凭证句柄/遥测托管给内核",而非各自实现一套。

### 5.1 横切 × 五端总览矩阵

| 关注点 \ 端 | Web `[P0]` | CLI `[P2]` | 桌面 `[P3]` | VSCode `[P3]` | Chrome `[P4]` |
|---|---|---|---|---|---|
| **鉴权** | OAuth2.1/PKCE / localhost 信任 | **设备码流** | localhost 信任 / OAuth2.1 系统浏览器回环 | VSCode `authentication` / 设备码流 | OAuth2.1 via `chrome.identity` |
| **token 存储** | httpOnly Cookie(前端不持 refresh) | OS keychain | OS keychain | `SecretStorage` | `chrome.storage.session`(短效,refresh 内核) |
| **密钥(provider key)** | **不存本端,内核保管** | OS keychain | OS keychain | `SecretStorage` | **不存本端,内核中转** |
| **loopback bearer** | n/a(远程 OAuth) | server.json(0600+pid 绑定) | server.json(0600+pid 绑定) | server.json(0600+pid 绑定) | pairing code(读不到 server.json) |
| **配置真相源** | 内核 | `~/.config` + 内核同步 | `~/.config`(XDG)+ 内核同步 | `globalState` + 内核同步 | `chrome.storage.local`(仅偏好)+ 内核同步 |
| **离线** | 弱(PWA 只读) | 强(本地内核) | 强(本地内核) | 中(依网络) | 弱(SW 只读) |
| **分发/更新** | 即时部署/PWA SW | 自更新 GitHub Releases | Tauri updater 签名增量 | Marketplace+Open VSX | Chrome Web Store 审核 |
| **可观测/计费/审计** | 内核归集(本端零落地) | 同左 | 同左 | 同左 | 同左(SW 短命,trace 内核重建) |

### 5.2 鉴权与会话

**统一身份模型(内核侧)**:`User → Tenant(MVP 单租户但从第一天按 tenant_id 建模)→ Session → Device`。**三类 OAuth token 严格分层不混用**:① **app-session token**(用户登录 arclightagent 本身,各端持有或持句柄);② **MCP/工具 OAuth token**(Google Calendar/Gmail/GitHub,**永不下发任何端**,只存内核凭证代理 KMS 信封加密);③ **provider API key**(Anthropic/OpenAI,同 ②,端不可见)。

**Token 刷新统一纪律**:① 所有 refresh token **旋转(rotating)**,检测重用即吊销整条会话链;② access 短 TTL(15-60min);③ 登出=内核吊销+各端清本地句柄,跨端登出经内核会话广播(吊销最坏延迟=access TTL)。

### 5.3 密钥与 loopback bearer 管理

**核心原则**(主蓝图 §5.5 投影到各端):只有 app-session token 类可下发到"有 OS 安全存储的端";provider key/MCP token 永远只在内核侧。**无安全本地存储的端(Chrome 扩展、Web 前端)连 refresh 都不持有,必须经内核中转**——这是"沙箱内零凭证 + 凭证代理外置签名放行"在"浏览器=不可信执行域"上的同一条纪律。

**各端安全存储后端**:macOS Keychain / Windows DPAPI / Linux libsecret(均经 `keyring` crate,无 keyring 守护进程回落 Stronghold KDF 加密文件,**非明文**)/ VSCode SecretStorage / **Web·Chrome 无安全本地存储→一律内核中转**。

**loopback bearer token 纪律(评审 M4,与"密钥"分级但同样要保护):** `server.json` 的 loopback token **是接管内核全部能力的 bearer,不是"非密"**。纪律:① 文件权限 `0600` + 校验 owner;② token 绑定 pid + 短 TTL,内核校验调用方进程(`SecCode`/`SO_PEERCRED`/process token);③ 文档明示"泄露 = 完全接管内核含凭证签名放行链"。`~/.config/arclightagent/` 只存非密配置 + session 句柄 + `server.json`(端口+受保护 token);**禁明文 `~/.config` 存任何 provider key/MCP token/Google 凭证**;多租户(P5)内核 KMS/Vault + 信封加密 + 轮换;CI 核新依赖许可证(`keyring` MIT/Apache,合规)。

### 5.4 配置/状态同步与离线

**单一真相源=内核 server**(绝不桥接进程,主蓝图反面教材 1)。配置三层:① 机器级本地(`~/.config`/`globalState`/`chrome.storage.local`,非密,不上行);② 用户级(内核权威 + 各端缓存:agent profile/模型偏好/Skills 启用集/quota 视图);③ 密钥(各端 OS 安全存储 / 内核 KMS,仅同步引用)。

**跨设备会话同步**:会话历史/transcript/cost rollup 全在内核(SQLite→PG + epoch + migrations);实时推 SSE;跨端广播 `SessionUpdated{epoch}`,各端按 epoch 决定拉新。**乐观锁 epoch 是并发控制不是租户隔离**;写带 epoch,不等抛 `StaleEpochError`。

**离线写队列的最终语义(评审缺失④——调和"LWW"与"epoch 拒陈旧覆盖"的矛盾):** 二者并列出现是不自洽的(拒绝陈旧覆盖 ≠ 最后写赢)。**最终语义统一为"epoch-gated,非朴素 LWW":**
- MVP 只做"刷新不丢"(服务端短缓冲 + 重连续推);**不做离线写队列**;
- 离线写队列后置阶段二,**重连时按 epoch 闸门合并**:每条离线写携带其**生成时的 base epoch**,内核接收时若该 session 的当前 epoch > base epoch(期间已被他端/压缩推进)→**拒绝该写并回 `StaleEpochError`**,客户端将冲突项呈现给用户**人工解决(非静默覆盖)**;仅当 base epoch == 当前 epoch 时才接受。
- **即"最后写赢"仅适用于无 epoch 冲突的写;一旦 epoch 推进即拒陈旧覆盖并走人工合并 UX。** 两机制不再并列,而是"epoch 相等→接受(表现为 LWW),epoch 推进→拒绝(走人工合并)"。

### 5.5 分发与自动更新(审核周期差异是发布节奏根本约束)

| 端 | 更新通道 | 审核/上线周期 | 关键纪律 |
|---|---|---|---|
| Web | 即时部署 + PWA SW | **秒-分钟级(无审核)** | SW 更新提示刷新,不静默 skipWaiting |
| CLI | 自更新 install.sh | 即时 | checksum+签名验证再替换 |
| 桌面 | Tauri updater 签名增量 | 即时(GitHub Releases) | 更新包必须签名;macOS notarize + Windows 代码签名 |
| VSCode | Marketplace(+Open VSX) | 数分钟-数小时(重大权限 1-3 天) | Open VSX 同步覆盖 VSCodium/Cursor |
| Chrome MV3 | Web Store | 数小时-数天(敏感权限深审) | 禁远程 JS,最小化权限声明 |

**统一纪律**:① 签名/校验贯穿所有自更新;② **商店审核周期(Chrome/VSCode)前置进路线图**——紧急修复无法即时上线,故**安全关键逻辑收敛在可即时更新的内核**,端做薄壳(薄客户端架构的运维价值);③ 端连内核上报 client 版本,内核按兼容矩阵决定降级/提示升级,防协议漂移。

### 5.6 可观测/计费/审计的多端统一归集

**三者全部归集到内核,端侧零落地**(薄客户端 + 内核单一真相源的直接红利)。**为什么必须在内核**:① 计费真金白银发生在内核(LLM token/E2B 沙箱时长/Browserbase/Steel 会话/外部 API,全由内核代理发起,端拿不到 provider key);② 多代理 ~15× token 放大,成本归因需 per-user+per-session+per-subagent 完整 span 树;③ 审计完整性(认证失败/权限提权/计费/computer-use 动作放行跨端统一落一处)。

**本地内核拓扑下计费的意义区分(评审缺失⑤——防阶段一过度建设):** 本地 sidecar 单用户拓扑下用户用自己的 provider key,**per-user metering/quota 不是"向用户收费",而是"成本可观测"**(让用户看到自己烧了多少 token/沙箱时长)。**纪律:阶段一只建"成本可观测"骨架(metering span + cost rollup 展示),不建 quota 强制/账单系统;真正的 per-user 计费/quota 强制是远程多租户(阶段五)才有意义。** 二者用同一 metering 数据但目的不同,阶段一实现者不得把账单/quota 强制提前建设。

**各端接入(薄)**:统一请求头带 **trace-context(W3C traceparent)+ device-id + client-version**,内核据此挂同一 trace；**端不计费、不写审计**(内核在代理调用处计量,在登录/审批/高危动作处记审计);Chrome MV3 SW 短命→遥测改为内核侧重建。**统一纪律**:trace-context 跨端透传(Web 发起、CLI 续跑同一 session 在 Langfuse 是一条连续 trace);端侧崩溃上报可选且脱敏、与计费/审计物理隔离;quota 在内核强制(端只展示余量,且仅远程拓扑);数据导出/删除(GDPR 类)归内核统一执行并记审计。

### 5.7 安全模型补缺(评审缺失项①③ 集中收口)

**① 内核作为 MCP server 被外部接入时的反向鉴权(评审缺失①):** 内核经 `--stdio`(JSON-RPC)/Streamable HTTP 把自己暴露为 MCP server 给第三方 IDE/agent(如 Copilot、qwen-code ACP)。此**暴露方向必须独立鉴权,绝不能让外部 agent 越过 capability profile 触发凭证签名放行**:
- 外部 MCP 接入走**独立 token + 独立、最小的 capability profile**(默认 `localSandbox:false`、无凭证签名放行权、只读工具子集),与内部各端的 profile 隔离;
- 凭证签名放行**只对内部认证会话开放**,外部 MCP 调用一律不可触发资金/不可逆/写真实会话类动作(强制 HITL 且默认拒绝);
- `--stdio` MCP 模式下,内核仅作"工具/上下文提供方",**外部 agent 拿到的是裁剪后的能力面,不是完整内核**。

**③ Chrome content-script 真实登录会话特判(评审缺失③,与 §4.6/§3.1 脚注‡ 同源):** 见 §4.6"真实登录会话安全特判"——对真实登录会话的 computer-use,域名白名单 + 动作分类(`read/write/irreversible/funds`)+ 写/资金类强制 HITL **是唯一边界**(浏览器已替 agent 鉴权,凭证签名放行不参与),`liveSession:true` 触发内核此特判。

---

## 6) 全平台分阶段排期(评审重定价:阶段五按端拆子阶段)

> 基于主蓝图 §9"阶段五=全平台壳"。**五端**落地顺序:**Web → CLI/桌面验证骨架解耦 → VSCode/Chrome**(移动 App 作附录 A 提案,另行决策)。模型分层纪律全程强制(central 综合/架构→Opus;执行类→Sonnet;机械工作→Haiku/Flash)。
>
> **关键纠偏(评审):主蓝图自己已痛批"原 6-8 周五端骨架严重失真"(§9 第 25/445 行)。本文不照单全收"阶段五 ~6-8 周塞下五端壳 + 多租户 + Postgres/RLS/KMS + 多代理 + provider 下沉 + 分层路由"——那是同一失真复发。** 故把阶段五重定价为:**"~6-8 周"仅指单个端的壳工作量量级;五端是按端串行/多人并行的多月工程**;且把"多租户服务化 / provider 下沉 / 多代理 / 分层路由"与"端壳"视为**可并行但各自计量**的工作流,不混在一个 6-8 周里。

### 6.1 排期主线

```
阶段一(MVP,~6-8 周,1-3 人):Web 单端 + 写代码 + 五块地基
  ├─ 内核服务(Bun+Hono):async-generator 主循环 + 工具系统 + provider 抽象
  │   + 单级压缩 + SQLite + epoch + 按 tenant_id 建模 + SSE endpoint
  ├─ @arclight/protocol(v1 类型,零 codegen)+ @arclight/client-core(reducer/重连)
  ├─ Web 端(Next.js + AI SDK v6 + assistant-ui):写代码主场 UI + PWA + 地基
  │   + 计费仅"成本可观测"骨架(非 quota 强制,见 §5.6)
  └─ [阶段一末] 最小 CLI spike(-p headless,2-3 天)← 验证骨架解耦 + 服务 CI eval

阶段二(~5-7 周):持久化加固 + 写作能力
  ├─ resumable-stream(Redis)+ durable 输入 + epoch-gated 离线写合并 UX(§5.4)+ 三级压缩
  ├─ paper-* 流水线 + 富文本编辑器 + 分阶段审批 + 文档生成
  └─ [可选] CLI TUI 初版 + @arclight/client-core 提取为正式共享包

阶段三(~5-7 周):Deep Research 独立 MVP
  └─ Orchestrator-Subagent + CitationAgent + 断点续研;[可选] CLI 调研支持

阶段四(~6-8 周):computer-use + 沙箱强化 + 日常规划
  └─ DOM/AX + Stagehand v3 + Browserbase/Steel + 独立截图通道 + 凭证签名放行
     + 动作分类(read/write/irreversible/funds)；心跳协调器 + Plan/Act + FocusChain
     + cron + Google Cal/Gmail MCP
     ← Chrome 扩展的硬前置(computer-use 内核能力 + 真实会话动作分类)在此就绪

阶段五(全平台壳 + 多租户服务化 + 高级编排 + 省钱)——按工作流并行/串行计量,非单一 6-8 周:
  ├─ 〔基建工作流〕第二端基建:C1 OpenAPI→TS SDK + C2 自建流式 codegen(非 OpenAPI)
  │                + AG-UI 适配器
  ├─ 〔服务化工作流〕多租户:Postgres + RLS + 沙箱 per-tenant + KMS + 多租户计费/quota
  │                (这是独立多月工程,不计入任何"端壳"的 6-8 周)
  └─ 〔端壳工作流,按端串行/多人并行,每端 ~3-8 周单端口径〕:
       CLI 完整版(P2,~6-8 周单端,最简单先交付)
       → 桌面 Tauri2(P3,~6-8 周单端)/ VSCode 插件(P3,~45-66 人日含 Webview)并行
       → Chrome 扩展(P4,~3-5 人周,前置阶段四)
       〔移动 App:见附录 A,非五端主交付,另行决策〕
```

### 6.2 逐端前置/工作量/验收(单端口径,评审重定价)

| 端 | 优先级/阶段 | 硬前置 | 工作量量级(单端口径) | 验收 |
|---|---|---|---|---|
| **Web** | P0 / 阶段一 | 内核 SSE endpoint、protocol v1、CapabilityProfile 协商、HTTP/2 | ~10 周(client-core 1.5 周为公共基建) | 网页端完成真实编码任务(改多文件+跑测试+检查点回滚),全程沙箱本地零凭证;eval ≥10 golden 通过 |
| **CLI** | P2 / 阶段一末 spike + 阶段五完整 | 内核 HTTP/SSE、protocol、client-core、设备码流端点 | spike 2-3 天;完整 **~6-8 周**(8 target 交叉编译+签名+CI 重活) | 最小 CLI 连上内核(证明骨架解耦);`-p`/`--stdio` 两协议互斥每行合法 JSON;三平台 keychain 读写 |
| **桌面** | P3 / 阶段五 | Web 前端稳定、内核 sidecar 化(CLI 先验)、共享包抽出、签名证书 | **~6-8 周**(集中 Rust 壳+签名+loopback token 硬化) | 三平台 spawn sidecar + loopback 业务流 + 离线可用 + 签名公证通过 + server.json 0600/pid 绑定 |
| **VSCode** | P3 / 阶段五 | 内核 HTTP/SSE、protocol、client-core、SDK 基建、OAuth、MCP native | **~45-66 人日(含 Webview Panel 主路径)** | Webview 写代码主路径(内核推理)+ WorkspaceEdit 落地 + Marketplace/Open VSX 发布;Chat Participant 仅可选轻入口 |
| **Chrome** | P4 / 阶段五 | **阶段四 computer-use 内核能力 + 动作分类**、WS 端点+resume/resync、capability materialize、OAuth | ~3-5 人周 | content script 就地操控真实会话 + SW 无状态可重启续接 + 真实会话写/资金类强制 HITL + Web Store 过审 |

**通用验收纪律**:每端连同一内核 server;全平台用户配置共享;多租户隔离与计费经审计验证;合规自检(零 GPL/LGPL、Apache NOTICE、签名)。

---

## 7) 全平台风险与缓解

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 1 | **Chrome MV3 SW ~5min 周期性回收(WS 活动不豁免)+ 30s 空闲休眠** | **高** | **如实表述为"SW 无状态可重启 + 续接",非"保活"**:心跳防 30s 空闲、`resume`/`resync` 续接防 5min 回收;状态全在内核;`lastSeq/epoch` 持久化 `chrome.storage.session`;长任务绑内核 |
| 2 | **Chrome content-script 操控真实登录会话,"沙箱内零凭证"硬边界失效** | **高** | 域名白名单 + 动作分类(read/write/irreversible/funds)+ 写/资金类强制 HITL **是唯一边界**(浏览器已替 agent 鉴权);isolated world 降注入面;干净会话需求走云浏览器 CDP |
| 3 | **MV3 其余限制**——禁 eval/远程 JS、storage 非加密、Prompt API 仅 Origin Trial | 中 | 推理全内核、扩展零模型代码;禁存密钥(内核中转);Prompt API 不用于正式发布,仅 Transformers.js 轻量前处理 |
| 4 | **VSCode "写代码主场" 的 Copilot 硬依赖 + 模型路由权与"内核唯一推理域"打架** | 中 | 主路径采 Webview Panel(内核推理),Chat Participant 降为可选轻入口;工作量按"含 Webview"口径定价,不用"零 UI"乐观估计(§4.4) |
| 5 | **loopback `server.json` token 被当"非密"**,同机任意进程可接管内核 | 中-高 | 文件 0600 + 校验 owner;token 绑 pid + 短 TTL + 内核校验调用方进程(SecCode/SO_PEERCRED/process token);文档明示"bearer,泄露=完全接管内核"(§4.3/§5.3) |
| 6 | **Tauri sidecar 生命周期**——孤儿进程、端口冲突、stdio 大流量误用、多端复用关停归属 | 中 | stdio 仅握手/健康/关停,业务走 loopback;随机端口 + server.json 发现 + pid 检测 stale 清理 + single-instance + 空闲超时自退;C4 截图独立通道绝不混 stdio/SSE |
| 7 | **各端商店合规**——Chrome 敏感权限深审、VSCode 权限变更、审核周期阻塞安全修复 | 中-高 | **安全关键逻辑收敛在可即时更新的内核,端做薄壳**;强 HITL 默认 + 域名白名单 + 审计;能力声明诚实(`localSandbox:false`);最小化权限 + 用途说明;Open VSX 同步覆盖非微软 VSCode |
| 8 | **Vercel/边缘 SSE 超时** 与长推理不兼容 | 中 | 前端直连独立部署内核(VPS/Fly.io),SSE 不经 Vercel 函数;边缘仅可选用于无状态认证端点(脚注降级),长任务/流式/沙箱回落常驻内核 |
| 9 | **Linux keyring 缺失**(桌面/CLI/Docker/CI) | 中 | 回落 Stronghold(KDF 加密文件,非明文)/ `pass` / `ARC_TOKEN` env / `--token-file`,**绝不写明文 `~/.config`** |
| 10 | **多端并发状态不一致**(cline 实证 StateManager 无跨实例同步) | 中 | 内核单一真相源 + epoch 乐观锁 + `SessionUpdated` 广播从根避免;离线写 epoch-gated 合并(§5.4)非朴素 LWW |
| 11 | **协议漂移**——端与内核版本不匹配、事件模型演进破坏旧端 | 中 | `Arc-Protocol-Version` 协商 min(client,server);non-exhaustive forward-compat(未知 `t` 静默忽略、未知 `risk`/`cls` fail-closed);新增可选字段不升 `v`;端上报 client 版本走兼容矩阵 |
| 12 | **截图带宽打爆**(computer-use 长会话) | 中 | C4 独立二进制 WS/WebRTC + JPEG/WebP 帧差,绝不混 C2;高保真用云浏览器 CDP/VNC;Chrome 本浏览器路径截图本地采集不过网 |
| 13 | **内核作为 MCP server 被外部接入的反向鉴权缺口** | 中 | 外部 MCP 接入走独立 token + 最小裁剪 profile;凭证签名放行只对内部会话开放;外部 agent 不可触发资金/不可逆/写真实会话(§5.7①) |
| 14 | **阶段五范围失真复发**——五端壳 + 多租户 + 多代理塞进单一 6-8 周 | 中 | 阶段五按工作流(基建/服务化/端壳)各自计量;"~6-8 周"仅单端口径;服务化是独立多月工程不计入端壳(§6) |
| 15 | **SDK 自建流式 codegen 预算**(OpenAPI 对 SSE 表达力弱) | 低-中 | C1 用 OpenAPI→openapi-typescript;C2 **完全不走 OpenAPI**,以 ArcEvent union 为单一源自建流式 codegen(不找 OpenAPI→SSE 银弹);MVP 单 repo 共享类型零 codegen 规避 |

**核心收口**:**五端**全部消费同一内核、同一协议、同一 `ArcEvent`,差异只在传输/UI/端特定后端三处。所有决策均落在主蓝图既定选型内(SSE 默认、凭证沙箱外签名放行、本地优先沙箱、Tauri 不用 Electron、CLI Bun --compile、VSCode 写代码端、Chrome MV3、禁明文 `~/.config`、从第一天按 tenant_id 建模、许可证 MIT/Apache 无 GPL/LGPL),仅把"单内核多端"骨干细化到帧级、握手级、字段级。**与主蓝图的唯一口径差异(移动 App 是否为交付端)已显式纠正:本文按主蓝图"五端"为主交付,移动 App 降为附录 A 探索性提案**,不再单方面扩成"既定六端"。

---

## 8) 附录 A —— 移动 App(探索性增量提案,非五端主交付)

> **定位声明(评审 M1):本附录不是主蓝图既定交付端。** 主蓝图 §1/§9/§10 一致表述为"五端"(Web + CLI + 桌面 + 浏览器/IDE 插件),§9 阶段五枚举"CLI/桌面/插件"且 §10 收口写"五端",**从未把移动 App 列为独立交付物**;§7 桌面行的 "Tauri 2.0 覆盖 iOS/Android" 指 Tauri 的跨平台*能力*、其"先 PWA 过渡"指*桌面*。**若要正式交付移动 App,须回主蓝图补一次正式决策**;在此之前,本附录仅作探索性设计参考。

### A.1 第一性约束与主路径倒置结论

**第一性约束(贯穿):** 无本地沙箱、无本地浏览器驱动、后台执行受限 → 凡"执行"走远程内核 + opt-in 远程沙箱/云浏览器,移动壳只做**输入+观测+审批+通知**;**没有本地内核路径**,几乎只走拓扑 B。经此裁剪,移动端是**几乎纯 WebView 壳**。

**壳技术主路径倒置(评审 M1 核心结论):** 因移动端只做薄壳——最不需要 Tauri 的 Rust 原生能力、最需要成熟的推送/商店插件生态,而 Tauri 2 官方明确 "**Tauri 2.0 will not be the 'mobile as a first class citizen' release**"、移动插件不全、部分需自写 Swift/Kotlin 桥——**主路径倒置为:**

| 顺序 | 壳技术 | 理由 | 何时选 |
|---|---|---|---|
| **首选** | **PWA**(@serwist/next + Web Push,已在 §4.1 具备) | 纯复用 Web 前端,零额外壳,覆盖约 80% 需求(输入/观测/审批 + Android 推送 + iOS 装主屏 Web Push) | 默认 |
| **次选** | **Capacitor** | 最薄、纯复用 Web 前端、**原生推送插件成熟**;仅在 PWA 的 **iOS 后台原生推送不达标**时引入 | PWA iOS 推送不达标 |
| **最后/不做** | **Tauri 2 移动** | 架构一致但移动生态最不成熟、薄壳用不上其 Rust 能力 | 仅在前两者都不满足且确需 Rust 原生能力时 |

> 真正缺的只有"可靠后台原生推送"——这正是 Capacitor 成熟、Tauri 移动不成熟的地方,故倒置。

### A.2 核心设计:前台 SSE + 后台 Push(iOS 现实性诚实降级,评审 B4)

**前台 SSE + 后台 Push 双通道**:App 前台用 `EventSource` 持流(PWA/Capacitor WebView);进后台被 OS 冻结、SSE 断,**任务仍在内核侧常驻续跑**;里程碑(调研完成/审批点/computer-use 高危动作)经 Web Push(PWA)/APNs/FCM(Capacitor)推送。

**iOS 现实性诚实表述(评审 B4):** iOS 上**静默推送(content-available)被系统严格节流/不保证投递**,**用户可见通知不会自动唤起 App 重连**(需用户点击)。故 **"无缝恢复"在 iOS 上不成立,应降级表述为"用户点通知后恢复"**:用户点通知深链唤起 App 回前台,`EventSource` 重连带 `Last-Event-ID` replay,reducer 按 seq 去重;**长任务结果的真相始终在内核,App 仅在用户回前台时拉取**(缓冲过期→`resync` 拉全量)。

### A.3 能力/合规/排期(若交付)

**capability profile**:`localSandbox:false, screenshot:'webrtc', background:'limited', fileSystem:'none', terminal:false, push:true, realtimeControl:语音开关, liveSession:false`。

**能力裁剪**:日常规划=主场(原生推送,活跃时段掩码映射系统勿扰);写文章=裁剪(语音成稿+阅读审阅+单段精修);调研=可用(发起+轻审批+Push+读报告);写代码=裁剪(远程 opt-in 沙箱,仅审阅/批 PR/触发远程测试);computer-use=裁剪(远程云浏览器观测+审批,无本机执行)。

**鉴权/合规**:ASWebAuthenticationSession/Custom Tabs(OAuth2.1+PKCE)/ 设备码流兜底;app-session token 存 Keychain/Keystore(rotating refresh),provider key/MCP token 永不下发手机;**商店对"AI 执行任意操作"高度敏感(移动独有最高合规风险)**→安全逻辑收敛内核、强 HITL 默认、能力声明诚实(`localSandbox:false`)、隐私清单最小权限、PWA 过渡作审核缓冲。

**排期(若经主蓝图决策后交付)**:PWA 过渡小(随 Web 端);Capacitor 壳中(壳+推送插件+合规);Tauri 2 移动大且不推荐。硬前置:远程服务化(RLS+KMS+metering)、OAuth/设备码流、第二端基建、opt-in 远程沙箱+云浏览器、推送通道对接。

---

**配套文件**:主蓝图 `/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md`(§4 分层架构 / §5 网页落地 / §6 五大能力 / §7 跨平台 / §8 决策表 / §9 路线图 / §10 风险表)。
**建议实现包**:`@arclight/protocol`(类型源,含 `ArcEvent`/`ArcCommand`/`ArcAck`)、`@arclight/client-core`(reducer/重连/discovery,各端复用)、`@arclight/core`(内核)、`@arclight/auth-device-flow`(CLI/VSCode 共用)、`@arclight/adapter-agui`(后置)、各端 host 适配(借 cline HostProvider 模式)。
**评审吸收清单**:M1(移动降格附录+主路径倒置)、M2(MV3 5min 回收/无状态续接)、M3(VSCode Webview 主路径+Copilot 定价)、M4(loopback token 硬化);B1(ArcCommand/ArcAck)、B2(C2 不走 OpenAPI 措辞)、B3(SSE 跨域 fetch+ReadableStream)、B4(iOS 点通知恢复)、B5(-p/--stdio 互斥)、B6(边缘降脚注);缺失①(MCP server 反向鉴权)②(seq 持久化/缓冲过期 resync)③(真实登录会话特判)④(epoch-gated 离线合并)⑤(本地计费=成本可观测);阶段五按工作流重定价。