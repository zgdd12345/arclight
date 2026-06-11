I now have enough verified data. Let me check one more load-bearing claim: whether `EventSource`/SSE genuinely can't set custom headers (the doc's hard constraint #2 for Web) and whether the Vercel AI SDK license claim in the doc (Apache-2.0) is correct — it is. The MV3 keep-alive claim is partially confirmed but the doc has a subtle error worth verifying: the 5-minute hard cap on long-running events even with WebSocket activity.

I have sufficient verified grounding. Writing the adversarial review now.

---

# 全平台架构详设 — 对抗式评审

> 评审对象:`/Users/fsm/project/arclightagent/PLATFORM_ARCHITECTURE.md`(593 行)
> 核对基准:`/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md`(521 行,已逐节读完 §7/§8/§9/§10)
> 立场:默认有问题,逐项找硬伤。已对四个 load-bearing 外部事实做了核查(见文末 Sources)。

总体先给一句话:**这份详设工程素养很高,与主蓝图的一致性"自我宣称"基本属实,没有发现颠覆性的选型矛盾。** 但它有一处与主蓝图**直接冲突的硬伤(移动端纳入 Tauri 2)**、一处**自身技术事实错误(MV3 5 分钟硬上限被 WebSocket 心跳掩盖)**、若干**过度承诺**和**协议/排期的内部不自洽**。下面分级列出。

---

## 一、必须修复(硬伤 / 与主蓝图或外部事实冲突)

### M1. 移动端"纳入 Tauri 2"与主蓝图存在选型口径冲突,且把高风险决策伪装成既定结论
这是最严重的一条。

- **主蓝图证据**:主蓝图 §7 跨平台表(521 行第 410 行)对桌面写的是 "**Tauri 2.0 …… 覆盖 iOS/Android**",但**主蓝图全文从未把"移动端"列为一个独立交付端**——它没有移动端的行、没有移动端的排期、§9 五阶段里 **"阶段五=全平台壳"枚举的是"CLI/桌面/插件",不含移动 App**(第 487-489 行)。§9 阶段五交付物里 "桌面(Tauri 2.0,先 PWA 过渡)" 的"PWA 过渡"指的是**桌面**,不是移动。
- **详设做了什么**:详设把"六端"里**凭空升格出一个独立的"移动(Tauri2 iOS/Android)P3"端**(§0 定位表、§4.3 整节、排期表都有它),并在 §4.3 给出"RN/Capacitor 备选对比结论:纳入 Tauri 2 …… Capacitor 为首选回退"。
- **为什么是硬伤**:① 主蓝图的"五端/全平台壳"被详设单方面扩成"六端",这是**引入了主蓝图未决策的新交付物**,违背它自己开篇第 7 行"不另起炉灶"的纪律;② 移动端 Tauri 2 的成熟度风险被**严重低估**——核查确认,Tauri 团队官方明确 "**Tauri 2.0 will not be the 'mobile as a first class citizen' release**",桌面插件并非都已移植到移动,部分能力需自写 Swift/Kotlin 桥;对一个需要 APNs/FCM 后台推送、深链、生物识别、系统勿扰映射的"日常规划主场"端,这恰恰是踩在 Tauri 移动最不成熟的面上。
- **修复**:
  1. 口径上明确"移动 App 是**主蓝图之外的增量提案**",不能写成"主蓝图既定六端之一";要么回主蓝图补一次正式决策,要么在详设里降格为"探索性附录"。
  2. 移动端的**主路径结论应当倒过来**:鉴于 Tauri 2 移动不成熟 + 移动端能力已被诚实裁到"只做输入/观测/审批/通知"(§4.3 第一性约束),这是一个**几乎纯 WebView 壳**的端——**PWA(已有 §4.1 的 @serwist/next + Web Push)就能覆盖 80%**,真正缺的只有"可靠后台原生推送"。因此更诚实的结论是:**移动端首选 PWA;若 PWA 的 iOS 推送不达标,优先用 Capacitor(最薄、纯复用 Web 前端、原生推送插件成熟),Tauri 2 移动反而应排到最后或不做**。详设现在把 Tauri 2 放第一、Capacitor 放"回退",与"各端只做薄壳"的实际能力裁剪自相矛盾——薄壳恰恰最不需要 Tauri 的 Rust 原生能力,却最需要成熟的推送/商店插件生态。

### M2. MV3 的 5 分钟硬上限被"WS 心跳保活"叙述掩盖(技术事实错误)
详设 §2.2/§4.6/§7-风险2 反复主张:"SW 30s 休眠 → WS 心跳 + `chrome.alarms` 保活 + resume 续接",读起来像是**只要心跳就能让 SW 长活**。

- **核查结论**:Chrome 116+ 确实让 **活跃 WebSocket 收发消息会重置 30s 空闲计时器**(这部分详设对)。但 Chrome 还有**第二条独立的上限:单个事件/任务运行超过约 5 分钟会被强制终止**,这条**不被 WebSocket 活动豁免**。也就是说,心跳能解决"30s 空闲",**解决不了"5 分钟硬顶"**——SW 仍会被周期性回收。
- **影响**:详设把"长任务绑内核 + SW resume 续接"当成兜底是对的方向,但**风险表把 MV3 风险等级标"高"却把缓解写得像已解决**,并且**没有点名 5 分钟硬上限**这条最关键的事实。一旦实现者照此乐观假设设计 computer-use 控制面板的连接保持,会在真实长会话(computer-use 动辄数分钟到数十分钟)上踩坑。
- **修复**:明确写出"MV3 SW 即使有 WS 活动也存在 ~5min 周期性回收,心跳只防 30s 空闲不防 5min 回收;**唯一可靠设计 = SW 无状态可重启 + 状态全在内核 + 每次重启 `{op:'resume', afterSeq:N}` 续接 + lastSeq/epoch 持久化到 `chrome.storage.session`**"。好消息是 §4.6 的 resume 机制其实已经具备这个能力,**问题只是叙述把它写成"保活"而非"可被随时杀死并续接"**——把措辞和风险等级如实改正即可,不需要重做设计。

### M3. VSCode 写代码"主场"对 GitHub Copilot 的硬依赖未被诚实定价
详设 §0/§3.1/§4.5 把 VSCode 定为"**写代码=主场**",主路径走 Chat Participants。

- **核查结论**:第三方扩展用 Chat Participant API 接入 Copilot Chat,通常需要在 `package.json` 声明对 `github.copilot` / `github.copilot-chat` 的 `extensionDependencies`,**即用户必须装并登录 GitHub Copilot**,你的 participant 才出现在 Chat 里。§4.5 硬约束③只轻描淡写提了"依赖 Copilot Chat,缺失时 fallback Webview",但 §0 定位表和矩阵仍把它列为**无保留的"主场"**。
- **为什么是硬伤**:① "推理在内核、复用 Copilot 订阅"是详设反复强调的卖点(§7 表 P3 行),但**当 participant 经 Copilot Chat 暴露时,模型路由权在 Copilot,不在你的内核**——这与全文"内核是唯一推理域"的核心纪律**直接打架**;如果坚持"推理必须走自己内核",那就**不能依赖 Copilot 的模型**,只能走 Webview Panel 自渲染,于是"零聊天 UI 开发""复用 Copilot 订阅"的卖点全部落空。② 把一个**依赖第三方商业扩展存在与登录**的端标"主场",定价不诚实。
- **修复**:二选一并写清楚:(A) "主场=Chat Participant",则承认**模型由 Copilot 提供、内核退化为工具/MCP 提供方**,放弃"唯一推理域"在此端的纯粹性;(B) 坚持内核推理,则 VSCode 主路径**必须是 Webview Panel**,Chat Participant 仅作可选轻入口,工作量与"零 UI 开发"的乐观估计要上调。当前文档想两头都要,不自洽。

### M4. 桌面/CLI 的 "stdio 仅握手、业务走 loopback" 在远程多端发现上有未处理的安全缝隙
详设 §1.2 连接发现约定 + §4.2:本地 sidecar 把 `{port, token, pid}` 写入 `~/.config/arclightagent/server.json`,**"单内核多端共享 …… 复用同一进程"**;Chrome 扩展则因"沙箱读不到 server.json"改用 pairing code。

- **问题**:`server.json` 里的 loopback `token` 是**同机任意进程可读**的(任何能读该用户 `~/.config` 的本地进程/恶意脚本都能拿到 port+token 直连内核,而内核此时是"唯一沙箱执行域 + 持有凭证代理签名放行权")。详设花大力气论证"沙箱内零凭证",却在**宿主同机进程信任**这一面上,用一个明文 token 文件把整条凭证签名放行链暴露给本地任意进程。loopback 不等于可信。
- **与主蓝图关系**:主蓝图 §5.5 只说"禁明文 `~/.config` 存**密钥**",详设据此认为"token 不是密钥本体所以可以"。但这个 loopback token **就是访问内核全部能力(含触发凭证签名放行)的 bearer**,把它当"非密"是降级。
- **修复**:① `server.json` 文件权限强制 `0600` 并校验 owner;② token 绑定到 pid + 短 TTL + 内核侧校验调用方进程(macOS `SecCode`/Linux `SO_PEERCRED`/Windows token);③ 明确写出"loopback token 是 bearer,泄露=完全接管内核",别再标"非密钥本体"。这条主蓝图没覆盖,属于详设新引入面,必须补。

---

## 二、建议改进(应处理但非阻塞)

### B1. C1+C2 over 同一条 WS(Chrome)与"C1 是命令队列、C2 是事件流逻辑解耦"的纪律有张力
§2.1 立"C1/C2 逻辑解耦(借 codex SQ/EQ)"为关键纪律,§2.2/§4.6 又让 Chrome 把 **C1+C2 复用同一条 WS**。复用本身没错(MV3 没得选),但详设没说清:同一条 WS 上命令的请求-响应关联(原本 HTTP POST 的天然 req-resp)如何在多路复用帧里恢复——需要 `commandId` ↔ ack/result 的关联协议,否则 Chrome 端会丢失 HTTP 那套幂等/重试语义。`ArcEvent` 里只有事件没有命令 ack 类型。**补一个 `ArcCommand`/`ArcAck` 的最小契约**。

### B2. SDK 自动生成对 SSE 的表达力——结论对,但 §2.4 自相矛盾地把它列为"opencode 思路采用"
§2.4 一边说"opencode SDK 生成思路采用",一边又说"用 openapi-typescript 替 Effect HttpApi"。**opencode 的 SDK 生成恰恰是它自建 codegen(不是 OpenAPI)才解决 SSE 表达力问题的**——主蓝图 §5.4 自己也承认"opencode 正是自建 codegen 才做到"。所以详设的 C2 自建流式 codegen 是对的,但**不应把它说成"采用 opencode 的 OpenAPI 思路"**——opencode 没用 OpenAPI。措辞会误导实现者去找 OpenAPI→SSE 的银弹(不存在)。建议直接写:"C1 走 OpenAPI/openapi-typescript;C2 完全不走 OpenAPI,以 ArcEvent union 为唯一源自建 codegen"。

### B3. EventSource 鉴权方案("60s 一次性 token query param")会污染日志且与 §2.5"凭证不随请求体传输"精神相悖
§4.1 硬约束②:`EventSource` 不能设自定义 header → 跨域用 short-lived token query param(TTL 60s)。这是 SSE 的真实痛点,方案可行,但 **URL query 里的 token 会进 access log / 浏览器 history / Referer**。建议优先级改为:① 同源 + httpOnly Cookie(已是默认,好);② 跨域优先用 `fetch`+`ReadableStream` 手写 SSE 解析(可带 Authorization header,绕开 EventSource 限制)而非 token-in-URL;③ token-in-URL 仅作最后回退并强制单次失效 + 不记日志。当前把 token-in-URL 当跨域主方案,偏弱。

### B4. 移动端能力裁剪诚实,但"前台 SSE + 后台 APNs/FCM 双通道续接"的 iOS 现实性偏乐观
§4.3 核心设计依赖"App 进后台 → 任务在内核续跑 → 里程碑 Push 唤醒 → 重连 replay"。方向正确,但 iOS 上 **静默推送(content-available)被系统严格节流/不保证投递**,而**用户可见通知不会自动唤起 App 重连**(需用户点击)。所以"无缝恢复"在 iOS 上**依赖用户主动点通知**,不是自动的。建议把措辞从"无缝恢复"降级为"用户点通知后恢复",并明确长任务结果的**真相在内核、App 仅在用户回前台时拉取**(这点 §4.3 其实已隐含,但叙述过于丝滑)。

### B5. CLI 的 `--stdio` MCP server 模式与 headless `-p` stdio JSONL 双向——两个 stdio 协议共存,易混
§4.4 子命令里 `--stdio` 是"MCP server"、`-p` 是"headless JSONL 双向",两者都占 stdin/stdout 且帧格式不同(MCP 用 JSON-RPC,`-p` 用 ArcEvent NDJSON)。文档没说清两者互斥/如何选择。建议显式声明这是两套不同协议、不可同时、并给出 basename/flag 的明确路由表(multicall 已提但没落到协议层）。

### B6. 边缘拓扑 C(Cloudflare Workers)写"全端 仅无状态短请求"——基本是个无用拓扑,建议删或降级为脚注
§1.2 拓扑 C 自己就承认"长任务/流式/沙箱全部回落拓扑 B"。那 Workers 只剩"认证/列会话/轻命令",而这些在拓扑 B 的常驻内核上一样能做。它**不构成一个有意义的部署拓扑**,只是给读者增加认知负担,且与"SSE 不经 Vercel/边缘函数"(§4.1 硬约束①、§7 风险5)的结论叠加后,边缘几乎无落点。建议降为一句脚注"边缘仅可选用于无状态认证端点"。

---

## 三、各端现实性核对(逐端结论)

| 端 | 详设主张 | 评审裁定 |
|---|---|---|
| **Web** | 参照实现端,SSE 默认,PWA 安装 | **现实**。硬约束清单(Vercel 30s 超时、EventSource 无 header、HTTP/1.1 6 连接、iOS Web Push 需装主屏、SSE 幻影重复)是少见的诚实,基本踩全了真实坑。仅 token-in-URL 见 B3。 |
| **桌面 Tauri 2** | 系统 WebView ~12MB,sidecar loopback | **现实**。桌面是 Tauri 2 最成熟面。`keyring`/Stronghold 兜底、notarize/签名硬门槛、孤儿进程清理都点到了。仅 server.json token 信任见 M4。 |
| **移动 Tauri 2** | 纳入 Tauri 2,Capacitor 回退 | **被高估 + 与主蓝图冲突**。见 M1。结论应倒置:PWA 首选 → Capacitor 次选 → Tauri 2 移动最后。能力裁剪本身诚实(`localSandbox:false`、无本地驱动),但壳技术选型方向错。 |
| **CLI** | 最早证明解耦,Bun --compile multicall | **现实但略过度承诺**。Bun `--compile` 对 native addon 支持有限(详设自己承认,用 Rust helper 子进程绕),但 `--bytecode` 仍是较新特性、跨 8 target 交叉编译 + Windows 元数据 + 各平台签名是**真实的运维重活**,"~4-6 周完整版"对单/双人偏紧。`-p` spike 2-3 天合理。 |
| **VSCode** | 写代码主场,Chat Participants | **主场定级过度**,见 M3。Copilot 硬依赖 + 模型路由权问题未定价。vscode.dev 无 Node → P3 不支持(已诚实标注,好)。 |
| **Chrome MV3** | computer-use 天然主场,WS 保活 | **方向对,5min 硬顶被低估**,见 M2。其余 MV3 限制(禁 eval/远程 JS、storage 非加密禁存密钥、content script 注入限制、Prompt API 仅 Origin Trial 不用于发布)核对**全部正确且诚实**——这部分质量高。 |

---

## 四、缺失项(应有而无)

1. **A2A / MCP server 暴露方向的鉴权**:详设把内核说成"也是 MCP server"(主蓝图 §7),`--stdio` 暴露 MCP。但**当 arclightagent 内核作为 MCP server 被第三方 IDE/agent 接入时,如何鉴权、如何防止外部 agent 越过 capability profile 触发凭证签名放行**——完全没写。这是"凭证沙箱外签名放行"模型的一个未设防入口。
2. **协议版本与 `seq` 的持久化语义边界**:`seq` 是 per-session 还是 per-connection?重连后服务端 replay "> seq" 需要服务端**按 session 持久化 seq 序**,但 §4.1 只承诺"短缓冲 ≥60s"。**超过缓冲窗口的断线重连如何处理**(拉全量快照?epoch 跳跃?)说了一半,没有给出"缓冲过期 → 强制全量 resync"的明确帧。
3. **computer-use 在 Chrome content script 内的注入面**(用户点名要查):详设 §4.6 提了"isolated world 降注入面 + 凭证签名放行 + HITL",但**漏了关键一面**——content script 操控的是**用户真实已登录会话**(带真实 cookie/session),这意味着**即便"凭证不在执行域",页面本身已携带用户完整身份**。prompt injection 让 agent 在用户已登录的 GitHub/银行页面点击"转账/删库",**不需要任何凭证签名放行**——浏览器已经替它鉴权了。这是 Chrome 主场相对云浏览器(干净会话)**独有的、更高的**风险面,详设的"沙箱内零凭证"硬边界**在这里失效**。必须补:对真实登录会话的 computer-use,域名白名单 + 高危动作 HITL **不再是纵深防御补充,而是唯一边界**,且需要更严格的动作分类(读 vs 写 vs 资金/不可逆)。
4. **离线写队列的 epoch 合并冲突 UX**:§5.4 反复说"离线写队列重连合并 + 最后写赢 + epoch 拒陈旧覆盖",但**"最后写赢"与"epoch 拒陈旧覆盖"是矛盾的**——拒绝陈旧覆盖意味着不是 LWW。两个机制并列出现没有调和,会议性地后置到阶段二但没说清最终语义。
5. **计费在"本地内核"拓扑下的意义**:§5.6 说计费全归内核。但本地 sidecar 拓扑下用户用自己的 provider key,**per-user metering/quota 是给谁看的**?本地单用户场景计费骨架的目的(成本可观测 vs 真正计费)没区分,容易让阶段一实现者过度建设。

---

## 五、总评

**可信度:中高。** 这份详设不是注水文档——六端硬约束清单(Vercel SSE 超时、EventSource 无 header、MV3 四上下文、Tauri WebView 碎片化、Bun compile native addon 限制、Linux keyring 缺失)展现了真实的工程踩坑经验,**绝大多数技术细节经得起核对**,与主蓝图的一致性"自我宣称"也基本属实(SSE 默认 / 凭证沙箱外 / 本地优先沙箱 / Tauri 不用 Electron / 禁明文 `~/.config` / tenant_id 建模 / MIT-Apache 无 GPL-LGPL,均未发现矛盾)。

**但它有四个必须挡下的问题**:① **移动端 Tauri 2 既与主蓝图"五端/全平台壳"口径冲突、又把最不成熟的技术放在主路径**(M1,最严重);② **MV3 5 分钟硬上限被"WS 保活"叙述掩盖**(M2,技术事实错误);③ **VSCode "写代码主场" 的 Copilot 硬依赖与"内核唯一推理域"打架且未定价**(M3);④ **loopback server.json token 被当"非密"**,在宿主同机信任面上开了缝(M4)。外加一个**最危险的缺失**:Chrome content script 操控**用户真实登录会话**时,"零凭证"硬边界**失效**——这是详设安全模型里没识别到的注入面(缺失项 3)。

**排期现实性**:总体把主蓝图"全平台壳塞进阶段五"这件事如实继承了,移动端排"最后"也对。但**阶段五要并行交付 CLI 完整版 + 桌面 + VSCode + Chrome + 移动 5 个端 + 多租户服务化 + Postgres/RLS/KMS + 多代理升级 + provider 网关下沉 + 分层路由,全部压在 "~6-8 周" 一个阶段**——这与主蓝图自己刚刚痛批过的"原 6-8 周五端骨架严重失真"是**同一个错误的复发**。详设没有对这个明显超载的阶段五提出异议,反而照单全收。**建议:把阶段五按端拆成多个子阶段,或明确标注"~6-8 周仅指单个端的壳工作量,五端是顺序/多人并行的多月工程"**,否则就是主蓝图批判过的范围失真在详设里借尸还魂。

**一句话**:选型方向可放行,但 M1-M4 + 缺失项 3 必须修复后才算"自洽可执行";阶段五的工时承诺要重新定价,否则它复刻了主蓝图自己否定过的乐观主义。

---

Sources:
- [Tauri 2.0 Stable Release — "not the mobile as a first class citizen release"](https://v2.tauri.app/blog/tauri-20/) · [Mobile Plugin Development | Tauri](https://v2.tauri.app/develop/plugins/develop-mobile/)
- [The extension service worker lifecycle | Chrome for Developers (30s idle / 5min cap)](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) · [Use WebSockets in service workers (Chrome 116+ resets idle timer)](https://developer.chrome.com/docs/extensions/mv3/tut_websockets/)
- [Chat Participant API | VS Code (Copilot extensionDependencies)](https://code.visualstudio.com/api/extension-guides/ai/chat)
- [vercel/ai LICENSE (Apache-2.0)](https://github.com/vercel/ai/blob/main/LICENSE)