I now have all the source material. I have a complete picture of the blueprint's decisions and the five reference repos' protocol approaches. I'll write the detailed contract spec directly as my response (per instructions: do NOT write a .md file, return findings as the final message).

Let me synthesize the full《内核 ↔ 各端协议契约 详设》covering all six required sections, keeping it concrete and implementable, consistent with the blueprint.

---

Hi Alba，以下为《全平台架构详设 — 内核 ↔ 各端协议契约 详设》。六端 = Web / 桌面(Tauri2) / 移动(Tauri2 iOS+Android) / CLI / VSCode 插件 / Chrome 扩展(MV3)，全部消费同一 headless 内核服务(Bun+Hono)。所有决策与主蓝图 §2.1/§4/§5/§7、风险表保持一致（MVP 单 repo 共享 TS 类型零 codegen、SSE 默认、截图独立二进制通道、本地优先、凭证沙箱外、不绑架内核语义于 AG-UI）。

---

# 内核 ↔ 各端协议契约 详设

> 适用范围：六端均为 `@arclight/core`(headless agent server, Bun+Hono) 的薄客户端。本契约是所有端共享的骨干，**内核侧只实现一套**，各端只做「传输适配 + 事件 reducer + UI 渲染」。
> 与主蓝图一致性纪律：(1) 内核零 UI 依赖；(2) MVP 单 repo 共享 TS 类型、零 codegen，SDK 自动生成/AG-UI 适配器后置到「第二端起」(主蓝图 §5.4/§9 阶段五)；(3) SSE 为默认数据通道，WebSocket 仅双向控制叠加，截图走独立二进制通道(主蓝图 §5.2/M1)；(4) 凭证一律沙箱外、按动作签名放行(主蓝图 §5.5/§5.7)；(5) 数据访问层从第一天按 `tenant_id` 建模(主蓝图 §5.6)。

---

## 0. 契约总览：四条逻辑通道

内核对每端暴露**四条逻辑通道**，物理上按端能力映射到不同传输（详见 §1）。这是整份契约的心智模型：

| 通道 | 方向 | 语义 | 默认物理传输 | 载荷 |
|---|---|---|---|---|
| **C1 控制面 (Command)** | 端→核 | 提交输入/中断/审批回传/能力声明/会话管理 | HTTP POST(请求-响应) | JSON，单条命令 |
| **C2 事件面 (Event)** | 核→端 | token/工具进度/压缩边界/权限请求/子代理通知/生命周期 | SSE(单向流) | NDJSON 帧，见 §2 统一事件模型 |
| **C3 双向实时面 (Realtime)** | 双向 | 仅在需要服务端→端实时打断、语音 Realtime、computer-use 控制面板时叠加 | WebSocket | JSON 控制消息 |
| **C4 二进制媒体面 (Media)** | 核→端(主) | computer-use 截图/屏幕帧、音频 | 独立 WS/WebRTC | JPEG/WebP+帧差 或 CDP/VNC，**绝不混入 C2** |

**关键纪律（吸收 codex SQ/EQ 模式 + 主蓝图 M1）**：C1 是「命令队列入」(Submission)，C2 是「事件流出」(Event)，二者**逻辑解耦**——这正是 codex `Op`/`EventMsg` 的 SQ/EQ 契约精神，但我们用 HTTP POST + SSE 落地而非进程内队列（因为网页优先、需跨网络）。`response_id`/`epoch` 作书签支持续接（借 codex `response_id` 作书签 + opencode durable 输入）。

---

## 1. 传输层矩阵：各端传输选择与理由

### 1.1 矩阵

| 端 | C1 控制面 | C2 事件面 | C3 实时面 | C4 媒体面 | 连核方式 | 核心约束/理由 |
|---|---|---|---|---|---|---|
| **Web (P0)** | HTTP POST `/v1/...` | **SSE** `/v1/sessions/:id/events` | WS(按需) | 独立 WS/WebRTC | 直连 HTTP server(同源/CORS) | 纯 HTTP 无 sticky session、易横扩、EventSource 自带 Last-Event-ID 重连(主蓝图 §5.2/topic-web-first) |
| **桌面 Tauri2** | HTTP POST | **SSE** | WS(按需) | 独立 WS/WebRTC | Tauri **sidecar 进程** spawn 本地内核 → 子进程 **stdio 握手**拿端口/token，再走 localhost HTTP/SSE；或连远程 | sidecar 用 stdio 仅做「启动握手 + 健康/关停信令」，业务流量仍走 localhost loopback(性能优于 stdio 大流量) |
| **移动 Tauri2 (iOS/Android)** | HTTP POST | **SSE** | WS(按需) | WebRTC(优先) / 独立 WS | **几乎总是连远程**(端侧不跑内核 sidecar) | 移动无法稳定跑 Bun sidecar；后台执行受 OS 限制→长任务靠远程内核 + Push 唤醒(见 §5) |
| **CLI** | HTTP POST | **SSE**(交互) / **stdio JSONL**(headless 管道) | — | — | `serve` 启本地内核 daemon → 同机 HTTP；或 `--stdio` 直连内核子进程 | headless/管道场景(`-p`)用 stdio JSONL 双向(借 codex `exec` JSONL、gemini-cli nonInteractiveCli)；交互 TUI 走 HTTP/SSE |
| **VSCode 插件** | HTTP POST | **SSE** | WS(按需) | iframe webview 内嵌 | 插件 host 进程连本地/远程内核 HTTP；webview↔host 走 **VSCode postMessage** | webview 与 host 间用 postMessage(VSCode 强制)，host 再代理到内核 HTTP；可注册为/消费 MCP(主蓝图 §7) |
| **Chrome 扩展 (MV3)** | HTTP POST(经 SW) | **WS**(经 SW，非 SSE) | WS | side panel 内 | service worker 作 MCP/HTTP client；**WS keep-alive 防 SW 30s 休眠** | **MV3 关键限制**：SW 30s 无活动休眠 + 禁 eval/远程 JS。SSE 在 SW 中断连后状态易丢→**改用 WS 心跳保活**(主蓝图 §7/topic-cross-platform caveat) |

### 1.2 逐端理由（load-bearing）

**Web — SSE 默认**：单向 token 流恰好匹配 LLM 输出模式；SSE 是纯 HTTP，无需 sticky session，浏览器 `EventSource` 自带 `Last-Event-ID` 重连。WebSocket 仅在语音 Realtime / computer-use 控制面板时叠加(C3)。这是 topic-web-first.json 的事实标准结论，主蓝图 §5.2 已采纳。

**桌面/CLI sidecar — stdio 仅做握手，不做大流量**：Tauri/CLI spawn 本地内核进程后，内核**在 stdout 打印一行 JSON 握手**(`{"port":N,"token":"...","pid":N}`)，端读到后切到 `http://127.0.0.1:N` 走 HTTP/SSE。**不**把 token 流塞进 stdio——stdio 在大流量下背压/缓冲行为差，且 loopback HTTP 已足够快。stdio 通道保留给「关停信令、健康探针、崩溃日志」。**例外**：CLI `-p`(headless 管道，给脚本/CI)走纯 stdio JSONL 双向——此时无 HTTP server，命令从 stdin 读、事件往 stdout 写 NDJSON(借 codex `exec` 的 JSONL 双输出、gemini-cli `nonInteractiveCli.ts`)。

**Chrome MV3 — 必须用 WS 而非 SSE**：MV3 service worker **30s 无活动即休眠**(topic-cross-platform caveat 明确)。SSE 长流在 SW 休眠后连接被回收、`EventSource` 重连但服务端生成态已丢。**对策**：side panel/content-script 不直接持流，由 **service worker 持一条 WebSocket** 到内核，WS 的周期帧(心跳)即可延长 SW 存活；SW 再用 `chrome.runtime` 消息把事件分发给 side panel UI。MV3 禁 eval/远程 JS → **所有推理在内核侧完成**，扩展只发命令收事件，零模型代码加载(主蓝图 §7)。computer-use 在浏览器侧是天然载体，截图帧经同一条 WS 的二进制子流或独立 WS(C4)。

**computer-use 截图独立二进制通道(C4，全端共性，吸收主蓝图 M1)**：多分钟会话每步一帧数百 KB，几十步即数十 MB，混入 C2 的 token SSE 会打爆 SSE 与出口带宽。**硬约束**：截图走**独立二进制 WS 或 WebRTC**，编码 **JPEG/WebP + 帧差增量**；高保真长会话直接用云浏览器(Browserbase/Steel)的 **CDP/VNC 远程渲染**(多租户云浏览器场景 VNC 反而更省带宽，主蓝图 §5.2 已纠正「VNC 一概反面教材」的旧判)。媒体面与事件面**永不复用同一连接**。

---

## 2. 统一事件模型：内核 async-generator → 各端帧

### 2.1 内核侧：单一 async-generator 事件源

内核主循环是**自研最小 async-generator**(主蓝图 §4.2/M7，不引 LangGraph)，`yield` 出**统一事件枚举**。这一套事件是**唯一事实源**——SSE/WS/stdio JSONL/postMessage 各端帧都是它的同构投影(借 gemini-cli `Turn.run(): AsyncGenerator<ServerGeminiStreamEvent>` 的事件总线设计，但内核语义自有，不绑 Gemini)。

```ts
// @arclight/protocol —— 内核与各端共享的唯一类型源(MVP 单 repo,零 codegen)
type ArcEvent =
  | { t: 'session.started';   v: 1; sessionId: string; epoch: number }
  | { t: 'turn.started';      v: 1; turnId: string }
  | { t: 'message.delta';     v: 1; turnId: string; role: 'assistant'; text: string }   // token 增量
  | { t: 'reasoning.delta';   v: 1; turnId: string; text: string }                       // 思维链增量(可关)
  | { t: 'tool.requested';    v: 1; callId: string; name: string; argsPreview: string }
  | { t: 'tool.progress';     v: 1; callId: string; pct?: number; note?: string }        // 工具进度
  | { t: 'tool.output';       v: 1; callId: string; ok: boolean; preview: string; spillRef?: string } // 超限落盘投影
  | { t: 'context.compacted'; v: 1; turnId: string; epoch: number; keptTokens: number }  // 压缩边界
  | { t: 'permission.ask';    v: 1; askId: string; risk: 'low'|'med'|'high'; action: string; detail: object } // 权限请求
  | { t: 'subagent.spawned';  v: 1; agentId: string; parentTurnId: string; role: string }
  | { t: 'subagent.update';   v: 1; agentId: string; status: 'running'|'completed'|'failed'; summary?: string } // 子代理通知
  | { t: 'turn.completed';    v: 1; turnId: string; responseId: string; usage: Usage }
  | { t: 'session.error';     v: 1; code: string; message: string }                      // 5键 envelope,绝不泄 traceback
  | { t: 'interrupted';       v: 1; turnId: string; reason: 'user'|'abort'|'overflow' };  // 中断
```

**每帧三个不变量**：`t`(类型标签)、`v`(事件版本，见 §2.4)、单调递增 `seq`(由 SSE `id:` 承载，用于断点续传)。`epoch` 是 opencode Context Epoch / 乐观锁 epoch 的统一编号——压缩边界(`context.compacted`)递增 epoch，客户端据此知道 cache 前缀已变。

### 2.2 端帧映射（同一事件，六端不同物理帧）

| 物理传输 | 帧格式 | seq 承载 | 断点续传机制 |
|---|---|---|---|
| **SSE** (Web/桌面/CLI 交互/VSCode) | `event: <t>\nid: <seq>\ndata: <json>\n\n` | SSE `id:` | 重连带 `Last-Event-ID` header，服务端 replay > seq 的帧 |
| **WS** (Chrome MV3/实时面) | `{seq, ...ArcEvent}` 单 JSON 帧 | 帧内 `seq` | 重连后客户端发 `{op:'resume', afterSeq:N}` |
| **stdio JSONL** (CLI headless) | 每行一个 `{seq, ...ArcEvent}` | 行内 `seq` | 进程内无需续传；崩溃靠 rollout replay |
| **postMessage** (VSCode webview↔host) | `host.postMessage({channel:'event', frame})` | 帧内 `seq` | host 持 SSE，webview 刷新后 host 重推快照 |

**前端 reducer 三个工程纪律(借 opencode `server-sdk.tsx`)**：(1) **16ms 帧 coalescing** —— `message.delta` 高频，按动画帧合批渲染防抖；(2) **250ms 重连退避**；(3) **去重** —— 按 `seq` 单调过滤，重连 replay 的重复帧丢弃。这套 reducer 是**端无关的共享包** `@arclight/client-core`，六端复用。

### 2.3 关键事件的跨端处理约定

- **token (`message.delta`)**：所有端增量渲染；CLI 直接 print，Web/桌面 assistant-ui 流式，Chrome side panel 经 SW 转发。
- **工具进度 (`tool.progress`/`tool.output`)**：`tool.output` 携 `spillRef`(超限落盘投影，借 opencode `ToolOutputStore.bound`/opensquilla 落盘)，端按需二次拉取完整输出 `GET /v1/outputs/:spillRef`。
- **压缩边界 (`context.compacted`)**：端更新本地 epoch；任何带旧 epoch 的 C1 命令将被内核拒为 `StaleEpochError`(乐观锁，借 opensquilla)。
- **权限请求 (`permission.ask`)**：Web/桌面弹模态、CLI 弹 y/n、Chrome side panel 弹确认、VSCode 弹 `window.showInformationMessage`。回传走 C1：`POST /v1/sessions/:id/permission` `{askId, decision:'allow'|'deny'|'always', scope?}`(借 cline `bridgePermissionCallbacks` 远程回传 + codex `ExecApprovalRequest`/`ExecPolicyAmendment` 渐进信任)。
- **子代理通知 (`subagent.*`)**：MVP 后置(主蓝图阶段三)，但事件位先占；端渲染为可折叠子任务流(借 codex `multi_agents_v2`、cline `TeamSessionCoordinator` 状态机)。
- **中断 (`interrupted`)**：端→核走 C1 `POST /v1/sessions/:id/interrupt`，内核对 async-generator `.return()`/`AbortController`(主蓝图 §4.2)；核→端回一帧 `interrupted` 确认。

### 2.4 事件版本化与向后兼容

- **字段级**：每帧带 `v`(整数)。新增**可选**字段不升 `v`(向后兼容)；删除/改语义字段才升 `v`。
- **枚举可演进**：`t` 与 `risk`/`status` 等枚举设计为 **non-exhaustive**(借 codex `EventMsg` non_exhaustive)——客户端遇到未知 `t` **静默忽略并继续**(forward-compat)，遇到未知枚举值降级到安全默认(如未知 `risk`→按 `high` 处理，fail-closed)。
- **协议版本协商**：连接建立时客户端在 `Arc-Protocol-Version: 1` header 声明支持的最高版本，内核回 `Arc-Protocol-Version` 取 `min(client, server)`，并在 `session.started` 附 `negotiatedProtocol`。MVP 固定 v1。
- **SSE 命名 event 兼容**：用 `event: <t>` 命名而非匿名 `message`，新增事件类型不影响旧端的 `addEventListener` 注册。

---

## 3. 类型化 SDK 策略：取舍结论

### 3.1 MVP：单 repo 共享 TS 类型，零 codegen（主蓝图 §5.4 硬约束）

`@arclight/protocol` 包导出全部 `ArcEvent` / 命令请求体 / 响应体类型，内核与 Web 端 `import` 同一份。Web 是唯一端时**没有任何 codegen**——这是主蓝图反复强调的「SDK 自动生成是第二端才需要的基建」。客户端 reducer/重连逻辑封在 `@arclight/client-core`(纯 TS，端无关)。

### 3.2 第二端起：自建流式 codegen，而非裸 OpenAPI→TS

**OpenAPI→TS SDK 的局限(主蓝图 B4 已点明，此处给实现级结论)**：OpenAPI 对**请求-响应**(C1 命令)表达力足够，但对 **SSE/流式事件**(C2)表达力弱——OpenAPI 的 `text/event-stream` 只能描述为不透明字符串，无法生成「按 `t` 判别的 discriminated union + 类型化 reducer」。opencode 正是因此**自建 codegen**(其 server 用 Effect HttpApi 自动产 OpenAPI，但 SDK client 对事件流另做处理)。

**结论(分两半)**：
- **C1 命令面**：可用 OpenAPI(内核 Hono 产 OpenAPI doc) → `openapi-typescript` 生成请求类型。低成本、标准化。
- **C2 事件面**：**自建流式 codegen** —— 以 `@arclight/protocol` 的 `ArcEvent` union 为单一源(TS 即 schema)，生成各端的(a) discriminated-union 解析器、(b) `Last-Event-ID`/`afterSeq` 续传桩、(c) 类型化 reducer 骨架。预算上**预留这块自建 codegen 工作量**(主蓝图 §9 阶段五已列)。

### 3.3 五个参考实现的取舍结论（指名道姓）

| 来源 | 机制 | 借鉴 | 不采纳的部分 | 结论 |
|---|---|---|---|---|
| **opencode** | server 用 Effect HttpApi 自动产 OpenAPI；`@opencode-ai/sdk` 生成类型化 client + SSE 订阅 | **直接照搬「单后端多端 + 类型化 SDK + SSE coalescing」骨架**；其 `server-sdk.tsx` 的帧批处理/重连/eviction 是 reducer 范本 | 不引 Effect 4.x beta(主蓝图 §3.2 半成品/生态风险) | **骨架蓝本采用**；SDK 生成思路采用但用更轻的 Hono+openapi-typescript 替 Effect HttpApi |
| **cline** | gRPC-over-postMessage：protobuf 定义 Service/RPC，buf 生成 TS，webview↔扩展强类型，streaming RPC 用 `isLast` 模拟 | **VSCode 端 webview↔host 的 postMessage 强类型契约思路**；`HostProvider` 依赖注入(核心不 import 平台 API)——这是「一套内核 N 个壳」的关键 | **不采纳 protobuf/buf 作为主协议** —— protobuf 重，引入 `buf generate`+三处转换映射易「静默回退」(cline 自己文档警告的高熵错误) | **HostProvider 模式采用**(各端 host 适配)；**协议不上 protobuf**，用 JSON+TS 类型;VSCode webview 内部 postMessage 包一层薄类型 envelope 即可 |
| **codex** | SQ/EQ(Submission/Event 队列)进程内协议 + app-server JSON-RPC 长驻服务；`Op`/`EventMsg` non_exhaustive；ts-rs 导出类型 | **SQ/EQ 的「命令入/事件出」解耦语义**(我们的 C1/C2)；**`response_id` 作书签续接**；**non_exhaustive 枚举的 forward-compat**；app-server「一个长驻服务供桌面/IDE/SDK」= 我们 headless 内核 | 不用进程内队列(网页优先需跨网络)；不用 JSON-RPC 作 C2(JSON-RPC 是请求-响应，对单向事件流不自然，需 server-push 扩展) | **SQ/EQ 语义采用、落地为 HTTP POST(C1)+SSE(C2)**；app-server 定位采用；JSON-RPC 仅在 CLI stdio headless 与 VSCode 可选 |
| **qwen-code** | ACP(Agent Client Protocol)：`qwen serve` 暴露 HTTP/ACP；Java/Python SDK 经 ACP 调 `qwen --acp` 子进程 | **「daemon 模式 + 子进程 ACP」给非 TS 生态(未来 Java/Python SDK)留口子**的思路 | 不把 ACP 作为六端主协议(ACP 面向 IDE-agent 客户端关系，语义比我们窄) | **ACP 作为「可选外部适配器」**：未来若要被第三方 IDE 当 agent 接入，在内核外挂 ACP 适配层，不进核心 |
| **gemini-cli** | A2A(Agent-to-Agent) v1.0：`A2AClientManager` 支持 JSON-RPC/REST/gRPC；`packages/a2a-server` 把本 agent 暴露为 A2A 端点；`AgentSession.stream()` 支持 `eventId` 断点续播 | **A2A 用于「agent 间」**(未来子代理跨进程/跨网络编排)；**`eventId` 断点续播设计**印证我们 `seq`+`afterSeq` 方案 | 不把 A2A 当「内核↔端」协议(A2A 是 agent↔agent，不是 agent↔UI——主蓝图 §1.4 三件套各司其职) | **A2A 仅留作多代理远程编排的可选传输**(阶段三/五)，**不**用于六端 UI 连接 |

### 3.4 AG-UI 作为可选适配器的边界（主蓝图硬纪律）

**AG-UI 不绑架内核语义**(主蓝图 §1.4/§4.2/风险表)。内核**只认自有的 `ArcEvent`**。AG-UI 的约 16 种标准事件(message/tool-call/state-patch/lifecycle)**覆盖不全我们的事件**(无原生「压缩边界」「子代理通知」「凭证签名放行」语义)。**结论**：
- AG-UI 作为**外挂适配器** `@arclight/adapter-agui`：把 `ArcEvent` → AG-UI 事件**单向投影**，供想用 CopilotKit/assistant-ui AG-UI 适配器的第三方前端接入。
- **投影是有损的、显式声明的**：内核独有语义(epoch 压缩边界、签名放行)在 AG-UI 侧降级为 `custom`/`state-patch` 事件或丢弃，**绝不**为了迁就 AG-UI 而裁剪内核事件。
- MVP **不做** AG-UI 适配器(主蓝图 §9：后置)。

---

## 4. 鉴权 / 会话 / 租户上下文传播

### 4.1 信任分级（localhost 信任 vs 远程 OAuth2.1）

| 部署 | 端→核鉴权 | 理由(主蓝图 §5.5) |
|---|---|---|
| **本地内核(localhost)** | **loopback 信任 + 一次性 sidecar token** | 桌面/CLI sidecar 在 stdio 握手时拿到内核随机生成的 `token`，后续 HTTP/SSE 带 `Authorization: Bearer <sidecar-token>`；仅 `127.0.0.1` 接受。单用户本机无需 OAuth |
| **自托管远程 / 边缘** | **OAuth 2.1 + PKCE**(Auth.js/Clerk) | 「用户登录 arclightagent 本身」是一等体系，不只用于 MCP 工具。每请求带短期 access token |
| **MCP/外部工具凭证** | 独立 OAuth 2.1/PKCE，存**沙箱外凭证代理** | 沙箱内零真实凭证，按动作签名放行(主蓝图 §5.7/M1) |

### 4.2 每请求传播的上下文三元组

每条 C1 命令 / C2 订阅 / C3·C4 连接，内核解析出并强制贯穿：

```
RequestContext = {
  tenantId,        // 租户(MVP 单用户=default tenant,但从第一天建模,主蓝图 §5.6)
  userId,          // session↔user 强绑定
  sessionId,       // 会话
  capabilityProfile, // 见 §5
  authScope        // OAuth scopes / sidecar 信任级
}
```

**传播链(session↔user↔tenant 绑定)**：
1. 端建立连接 → 内核认证中间件(Hono middleware)从 `Bearer` token 解出 `userId`+`tenantId`(本地 sidecar token 映射到 default tenant；远程从 OAuth claim)。
2. `userId` ↔ `sessionId`：会话创建时写入 `sessions(tenant_id, user_id, id, epoch, ...)`，每次访问校验 `session.user_id == ctx.userId && session.tenant_id == ctx.tenantId`，否则 403(防越权，借 cline/codex 会话隔离教训)。
3. `tenantId` 下沉到数据层：所有查询带 `tenant_id`(MVP)；远程多租户阶段升 Postgres **RLS**(主蓝图 §5.6)。
4. **凭证不随请求体传输**：provider key / MCP token 绝不进 C1 命令载荷；内核按 `userId` 从 keychain(本地)/KMS(远程)取(主蓝图 §5.5，禁明文 `~/.config`)。

### 4.3 各端鉴权落地差异

| 端 | token 获取 | 存储 |
|---|---|---|
| Web | OAuth 重定向(远程) / 同源 cookie(本地) | httpOnly cookie / 内存 |
| 桌面 Tauri | sidecar token(本地) / OAuth(远程，系统浏览器回调 deep-link) | OS keychain |
| 移动 Tauri | OAuth(系统浏览器/ASWebAuthenticationSession) | iOS Keychain / Android Keystore |
| CLI | sidecar token / `arc login`(device code flow) | OS keychain(libsecret/Keychain/DPAPI) |
| VSCode | 复用 VSCode `authentication` provider 或独立 OAuth | VSCode SecretStorage |
| Chrome MV3 | `chrome.identity.launchWebAuthFlow`(OAuth) | `chrome.storage.session`(非 sync，防泄漏) |

---

## 5. 能力协商：端声明 capability profile，内核裁剪

### 5.1 端在连接时声明 capability profile

每端连接时 C1 发 `POST /v1/sessions/:id/capabilities` 或在 `session.started` 前的握手帧声明：

```ts
type CapabilityProfile = {
  localSandbox: boolean;      // 端机能否跑本地沙箱(nono/bwrap)：桌面/CLI=true, Web/移动/Chrome=false
  screenshot: 'none' | 'binary-ws' | 'webrtc' | 'cdp-vnc';  // 截图通道能力
  background: 'full' | 'limited' | 'none';  // 后台执行：桌面/CLI=full, 移动=limited, Chrome SW=limited, Web=none
  fileSystem: 'native' | 'browser-fsa' | 'none';  // 本地文件访问
  terminal: boolean;          // 能否内嵌终端(iframe/pty)
  push: boolean;              // 能否收推送(移动/Web Push/桌面通知)
  maxBinaryChannel: number;   // 媒体面带宽档位
  realtimeControl: boolean;   // 能否开 WS 双向控制(语音/computer-use 面板)
};
```

### 5.2 内核据此裁剪工具/能力

内核 `materialize(profile)`(借 opencode `ToolRegistry.materialize` 按权限过滤 + gemini-cli `ToolRegistry.clone()` 子集隔离)：

| profile 信号 | 内核裁剪动作 |
|---|---|
| `localSandbox=false` (Web/移动/Chrome) | 本地执行类工具(bash/本地沙箱 exec)**不暴露**；代码执行强制走 **opt-in 远程沙箱**(E2B/Vercel)或拒绝；UI 提示「需桌面端或开启远程沙箱」 |
| `screenshot='none'` | computer-use 视觉工具裁剪；仅留 DOM/AX 文本路径或整体禁用 |
| `background='none'` (Web 纯标签页) | 长任务(deep research/长 computer-use)**绑定到远程内核 + 断点续研**，不依赖端常驻；端关闭后任务在内核侧继续 |
| `fileSystem='none'` | `read/write/edit` 落到内核工作区(远程)而非端机本地 FS |
| `terminal=false` | 不下发内嵌终端 iframe 指令；命令输出仅以 `tool.output` 文本流呈现 |
| `realtimeControl=false` | 不允许开 C3，语音/computer-use 面板降级或禁用 |

**纪律**：能力协商是**内核侧裁剪**(server 决定暴露什么)，不是端侧隐藏。端谎报能力只会拿到自己处理不了的事件，内核仍以 profile 为准做安全决策(如 `localSandbox=false` 时绝不下发本地 exec)。每能力的 agent profile(独立 prompt 前缀+工具子集，主蓝图 §4.2)与端 capability profile **求交集**得到最终工具集。

---

## 6. 连接拓扑：三种部署下各端如何连

### 6.1 拓扑 A — 本地内核(localhost)：默认、数据不出本机(主蓝图默认沙箱在本地)

```
桌面 Tauri ─spawn sidecar→ [内核:127.0.0.1:N] ←HTTP/SSE─ 同机
CLI       ─arc serve daemon→ [同一内核] (或 --stdio 直连子进程)
VSCode    ─host 进程───────→ [同一内核] ;webview↔host=postMessage
Web       ─localhost:N─────→ [同一内核] (浏览器直连本地端口)
Chrome MV3─SW WS───────────→ [同一内核:127.0.0.1:N] (WS 保活)
移动      ✗ 不适用(端机不跑内核)
```
- **单内核多端共享**：桌面 spawn 的 sidecar 内核可被同机的 CLI/Web/Chrome **复用同一进程**(通过约定端口+token 发现，借 opencode desktop sidecar + 主蓝图「`~/.config/arclightagent/` 共享发现」)。Chrome 扩展经本地内核中转(主蓝图 §7)。
- 鉴权=loopback 信任 + sidecar token；密钥=OS keychain。

### 6.2 拓扑 B — 自托管远程(VPS)：多端 + 移动主路径

```
                         ┌──────────── [自托管内核 (Bun+Hono, VPS)] ──────────┐
Web (浏览器)──HTTPS/SSE──→│  OAuth2.1 网关 · 每请求 tenantId/userId          │
桌面/移动 Tauri──HTTPS───→│  · 会话隔离(RLS) · 凭证 KMS                       │
CLI(arc login)──HTTPS────→│  · 沙箱 per-tenant(本地 nono / opt-in E2B)        │
VSCode host──HTTPS───────→│  · 计费 metering + quota                          │
Chrome SW──WSS───────────→└──────────────────────────────────────────────────┘
                          截图媒体面: 云浏览器 Browserbase/Steel CDP-VNC ──→ 端
```
- 全端走 **OAuth 2.1 + TLS**；移动端**几乎只走此拓扑**(端不跑 sidecar，长任务靠远程内核 + Push 唤醒)。
- 多租户隔离(RLS/schema-per-tenant + 沙箱 per-tenant)、KMS 密钥、per-user 计费全启用(主蓝图 §5.6/阶段五)。
- C4 媒体面优先走云浏览器 CDP/VNC(已隔离，不叠 E2B，主蓝图 M4)。

### 6.3 拓扑 C — 边缘(Cloudflare Workers)：内核 webHandler 可跑边缘

```
全端──HTTPS/SSE/WSS──→ [内核 Hono webHandler @ Workers 边缘]
                        · 无状态请求 → 会话态落 D1/外部 Postgres
                        · 长任务/durable 流 → 回退到拓扑 B 的常驻内核
```
- Hono 的 `toWebHandler` 可部署 Workers(借 opencode `HttpRouter.toWebHandler` 边缘能力)。
- **边缘的约束**：Workers 无长驻进程，**长 SSE 流 + durable 输入 + 本地沙箱不适合边缘**。结论：**边缘只承载无状态短请求(认证、列会话、轻命令)**，**长任务/流式/沙箱回落到拓扑 B 的常驻内核**。这与主蓝图「resumable-stream(Redis)后置 + 沙箱本地优先」一致——边缘不是 MVP 目标，是阶段五可选优化。

### 6.4 端的「连接发现」统一约定

各端用同一套发现顺序(失败回退)：
1. 环境变量 `ARC_SERVER_URL`(显式远程) → 直连，OAuth。
2. `~/.config/arclightagent/server.json`(本地 sidecar 写入的 `{port, token, pid}`) → loopback 直连(主蓝图 §7 XDG 共享，密钥不明文存此，仅存端口+短期 token)。
3. 自启本地 sidecar(桌面/CLI) → 写 `server.json` → 连。
4. 移动/Web 无本地选项 → 必须配置远程 URL。

---

## 附：与主蓝图一致性自检清单

- ✅ 传输：SSE 默认、WS 仅双向叠加、截图独立二进制通道(§5.2/M1)；Chrome MV3 SW 用 WS 保活(§7 caveat)；桌面/CLI sidecar stdio 仅握手(§7)。
- ✅ 事件模型：自研 async-generator 单源(§4.2/M7)、压缩边界=epoch(opencode Context Epoch)、5键 envelope 不泄 traceback、中断走 `.return()`/AbortController(§4.2)。
- ✅ SDK：MVP 零 codegen 单 repo 共享类型(§5.4)；OpenAPI 对 SSE 弱→自建流式 codegen(B4)；AG-UI 仅可选适配器不绑架内核(§1.4)；A2A=agent↔agent 不用于 UI(§1.4)。
- ✅ 鉴权：localhost 信任 vs 远程 OAuth2.1(§5.5)；凭证沙箱外签名放行(§5.7)；禁明文 `~/.config`(§5.5)；从第一天按 tenant_id 建模(§5.6)。
- ✅ 能力协商：内核侧裁剪、本地沙箱默认/SaaS opt-in(§2.1/M4)、与 agent profile 求交。
- ✅ 拓扑：本地默认数据不出本机、远程 RLS+KMS+计费、边缘只承载无状态短请求(长任务回落常驻)。
- ✅ 借鉴取舍逐仓指名：opencode 骨架/SDK 生成、cline HostProvider 采纳但 protobuf 不采纳、codex SQ/EQ 语义采纳落地为 HTTP+SSE、qwen-code ACP 留作可选外部适配、gemini-cli A2A 留作 agent 间可选传输。

**未另起炉灶/未矛盾**：本契约所有传输/事件/SDK/鉴权/能力/拓扑决策均落在主蓝图既定选型内，仅把「单内核多端」这一骨干**细化到可实现的帧级、握手级、字段级**。涉及文件：内核服务参见主蓝图 §4.1 架构图与 §5；本契约对应实现包建议为 `@arclight/protocol`(类型源)、`@arclight/client-core`(reducer/重连)、`@arclight/adapter-agui`(后置)、各端 host 适配(借 cline `HostProvider` 模式)。