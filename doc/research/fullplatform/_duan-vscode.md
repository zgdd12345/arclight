充分掌握所有地基材料。现在直接产出完整的 VSCode 插件(P3)详细设计 Markdown。

---

# arclightagent VSCode 插件(P3) 详细设计

> 阶段五交付物之一(主蓝图 §9 阶段五)。前置依赖:阶段一 Web MVP 内核骨架 + 阶段五 OpenAPI→TS SDK 自动生成 + AG-UI 适配器基建。本文是独立详设,供 VSCode 插件团队直接实施,与主蓝图及三份地基契约严格对齐,不另起炉灶。

---

## 1. 组件级架构

### 1.1 总体拓扑

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  VSCode Extension Host Process (@arclightagent extension)                 ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  Activation / Entry (extension.ts)                                  │  ║
║  │  • activate()  /  deactivate()                                      │  ║
║  │  • 注册 Chat Participant(@arclightagent)                             │  ║
║  │  • 注册 MCP server endpoint(Streamable HTTP / stdio)                │  ║
║  │  • 注册 vscode.authentication provider                              │  ║
║  │  • 注册 Commands(arclight.*)                                        │  ║
║  └──────────┬───────────────────────────────┬────────────────────────┘  ║
║             │                               │                            ║
║  ┌──────────▼─────────────┐   ┌─────────────▼────────────────────────┐  ║
║  │  ArcKernelClient       │   │  VSCodeHostProvider                  │  ║
║  │  (地基1 C1/C2/C3)       │   │  (cline HostProvider 模式)           │  ║
║  │  • HTTP POST → C1      │   │  • createDiffViewProvider()          │  ║
║  │  • SSE 订阅 → C2       │   │  • getWorkspaceEdit()                │  ║
║  │  • WS(按需) → C3       │   │  • getTerminalManager()              │  ║
║  │  • seq/Last-Event-ID   │   │  • getDiagnosticsProvider()          │  ║
║  │  • 250ms 重连退避      │   │  • getSecretStorage()                │  ║
║  │  • 16ms 帧 coalescing  │   │  • getOutputChannel()                │  ║
║  └──────────┬─────────────┘   └──────────────────────────────────────┘  ║
║             │ ArcEvent                                                    ║
║  ┌──────────▼─────────────────────────────────────────────────────────┐  ║
║  │  EventReducer (@arclight/client-core,六端共享包)                    │  ║
║  │  • discriminated-union 解析 ArcEvent                               │  ║
║  │  • seq 单调去重 / 断点续传桩                                        │  ║
║  │  • permission.ask → pendingPermissions Map                         │  ║
║  │  • tool.output spillRef → 二次拉取队列                             │  ║
║  └──────┬─────────────┬──────────────────────────────────────────────┘  ║
║         │             │                                                   ║
║  ┌──────▼───────┐  ┌──▼─────────────────────────────────────────────┐  ║
║  │  Chat        │  │  Webview Panel(可选,富交互)                     │  ║
║  │  Participant │  │  ┌──────────────────────────────────────────┐  │  ║
║  │  Handler     │  │  │  React App (webview-ui/,独立 Vite 产物)  │  │  ║
║  │  (Chat API)  │  │  │  ↕ postMessage envelope(类型化)          │  │  ║
║  │  • stream()  │  │  │  WebviewBridge(host↔webview)             │  │  ║
║  │  • followUp()│  │  │  • 写代码:diff 审批 / shadow-git 时间轴   │  │  ║
║  │  • 审批弹窗  │  │  │  • 写文章:Markdown 预览 + 分阶段审批     │  │  ║
║  └──────────────┘  │  │  • 调研:进度流 + 报告 + 引用             │  │  ║
║                    │  │  • 任务规划:FocusChain checklist         │  │  ║
║                    │  └──────────────────────────────────────────┘  │  ║
║                    └────────────────────────────────────────────────┘  ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  VSCode Native Integration Layer                                    │  ║
║  │  WorkspaceEditApplier │ DiagnosticsWatcher │ SCMProvider            │  ║
║  │  TerminalManager      │ TreeView(任务树)    │ StatusBarItem          │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
╚═══════════════════════════════════════════════════════════════════════════╝
         │ HTTP/SSE(localhost or HTTPS+OAuth)
         ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║  @arclight/core  headless agent server (Bun + Hono)                      ║
║  • Agent Runtime / Tools / Sandbox / Provider Gateway / MCP Hub          ║
║  • 会话 / 认证 / 计费 / 审计 — 单一真相源                                ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

### 1.2 内部模块划分

```
packages/vscode-extension/
├── src/
│   ├── extension.ts              # activate/deactivate,依赖注入根
│   ├── host/
│   │   └── VSCodeHostProvider.ts # 平台能力实现(diff/terminal/scm/secret)
│   ├── client/
│   │   ├── ArcKernelClient.ts    # C1 HTTP POST + C2 SSE + C3 WS(按需)
│   │   ├── discovery.ts          # 连接发现:env→server.json→sidecar→远程
│   │   └── auth.ts               # VSCode AuthenticationProvider 实现
│   ├── chat/
│   │   ├── participantHandler.ts # @arclightagent Chat Participant 主入口
│   │   ├── responseRenderer.ts   # MarkdownString 流式渲染 / 工具结果块
│   │   └── followUpProvider.ts   # 跟进建议
│   ├── mcp/
│   │   └── mcpServerRegistrar.ts # 把内核暴露为 MCP server(供 Copilot/其他消费)
│   ├── webview/
│   │   ├── WebviewPanel.ts       # 创建/销毁 webview 面板
│   │   └── WebviewBridge.ts      # host↔webview postMessage 类型化 envelope
│   ├── integration/
│   │   ├── WorkspaceEditApplier.ts # diff→WorkspaceEdit 落地
│   │   ├── DiagnosticsWatcher.ts   # LSP 诊断订阅 → 反馈给内核
│   │   ├── SCMProvider.ts          # shadow-git 检查点 ↔ VSCode SCM
│   │   └── TerminalManager.ts      # 内嵌终端 / 命令结果捕获
│   ├── ui/
│   │   ├── PermissionModal.ts    # permission.ask → showInformationMessage/QuickPick
│   │   ├── StatusBar.ts          # 当前任务状态 / token 用量
│   │   └── TaskTreeView.ts       # 侧边栏任务/子代理树
│   └── commands/
│       └── register.ts           # arclight.* command 注册
├── webview-ui/                   # 独立 Vite + React 产物(仅富交互面板)
│   └── src/
│       ├── App.tsx
│       ├── bridge.ts             # window.postMessage↔vscode.postMessage 桥
│       └── features/             # diff审批/写作审批/调研报告/FocusChain
└── package.json                  # engines.vscode / contributes / main
```

---

## 2. 技术选型与关键依赖

与主蓝图技术栈完全一致,无新增矛盾选型。

| 层 | 选择 | 理由/来源 |
|---|---|---|
| **语言/运行时** | TypeScript(插件宿主进程);esbuild 打包(快) | 主蓝图 §2.1;与内核同语言 |
| **VSCode API** | `vscode.chat.createChatParticipant` (Chat Participants API)、`vscode.authentication`、`SecretStorage`、`WorkspaceEdit`、`DiagnosticCollection`、`SourceControl` | VSCode 1.90+(Chat Participants GA) |
| **内核连接** | `@arclight/client-core`(六端共享,地基1 EventReducer + 重连)+ 标准 `fetch`(C1/C2)+ `WebSocket`(C3) | 地基1 协议契约;cline HostProvider 模式 |
| **共享类型** | `@arclight/protocol`(ArcEvent union、命令体、能力协商) | 地基1 §2.1;阶段五 OpenAPI→TS SDK |
| **webview UI** | React + Vite(独立构建产物);**不引 assistant-ui**(webview 无 Next.js) | cline webview-ui 同路线;主蓝图 §2.1 |
| **webview↔host 通信** | 薄类型 envelope(`{channel, seq, payload}`)over `postMessage`;**不上 protobuf/buf** | 地基1 §3.3:cline HostProvider 采纳但 protobuf 不采纳 |
| **认证** | `vscode.authentication.registerAuthenticationProvider` + `SecretStorage` | 地基3 §1.2 VSCode 端 |
| **MCP 注册** | `@modelcontextprotocol/sdk`(Streamable HTTP 模式) | 主蓝图 §4.2/§7;MCP 双向 native |
| **打包** | `@vscode/vsce`(打包 .vsix)+ `esbuild`(bundle)+ `tsup`(library 包) | 主蓝图 §7/§9 阶段五 |
| **测试** | Vitest(单元)+ `@vscode/test-cli`(集成) | 主蓝图 eval harness |
| **许可证** | MIT(插件自身,兼容 Marketplace);所有依赖核验 Apache-2.0/MIT | 主蓝图 §3.4-3.6 合规纪律 |

**明确不引入**:`protobuf`/`buf`(重,主蓝图已否,地基1 §3.3)、`LangGraph`(主蓝图 M7)、`mem0`(阶段四评估)、`AG-UI` 适配器(后置)、任何 LGPL 依赖(CI 拦截)。

---

## 3. 本端承载能力及裁剪/适配(依据地基2)

### 3.1 写代码 ★ 主场(与 Web 并列)

**档位**:主场。VSCode 是写代码的原生工作台,编辑器原生 diff/LSP/SCM 天然可用。

**Chat Participant 主路径**:
- 用户在 Chat 面板输入 `@arclightagent 重构这个函数`,插件向内核 `POST /v1/sessions/:id/commands` 提交请求,订阅 SSE 事件流。
- `message.delta` 帧 → `ChatResponseStream.markdown()` 流式渲染到 Chat 面板。
- `tool.requested`(edit_file/bash) → Chat 面板显示工具调用卡片 + 审批按钮。
- `permission.ask` → `vscode.window.showInformationMessage` 弹审批(risk=high 时弹 modal QuickPick)。

**端特定执行后端——VSCode 原生 API 落地(最关键适配)**:

内核输出"编辑意图"(SEARCH/REPLACE diff),插件侧 `WorkspaceEditApplier` 把它转换为 `vscode.WorkspaceEdit` 并 `workspace.applyEdit()` 落到编辑器。**LSP 走编辑器原生**:插件监听 `vscode.languages.onDidChangeDiagnostics`,把 lint/type 诊断结果回传内核作为反射验证闭环的输入(替代内核内置 LSP 在此端的角色)。

**shadow-git 检查点**:内核生成 shadow-git 检查点 epoch,插件 `SCMProvider` 在 VSCode SCM 面板展示检查点列表,用户可一键回滚(触发 C1 `POST /v1/sessions/:id/rollback`)。

**裁剪点**:
- Chat 面板无 Monaco 图形 diff(降级为 VSCode 原生 diff tab,`vscode.diff()` 命令)。
- 内核内置 LSP 在此端**让位**给编辑器原生 LSP;内核不重复启动 LSP 客户端。

### 3.2 写文章 ○ 可用

**档位**:可用,定位 Markdown-as-code 写作场景(技术文档/README/博客)。

- Chat 内触发写作流水线,内核 paper-* skill 流式推章节。
- `message.delta` → Chat 面板流式 Markdown 预览;或在 Webview Panel 中渲染富文本(可选,阶段五后补)。
- 精修改动以 diff 形式通过 `WorkspaceEdit` 落到工作区文件,VSCode 原生 SCM 版本化。
- 分阶段审批降级为 Chat 内确认消息(`ChatResponseStream.button()`或 QuickPick)。

**裁剪掉**:复杂多栏富文本审批 UI(非此端所长)、docx/pptx 生成的本端预览(文件写到工作区,用户自行打开)。

### 3.3 调研(Deep Research) △ 裁剪

**档位**:裁剪,定位"为当前项目做技术调研"。

- `@arclightagent 调研 X 框架的迁移路径`,触发内核 Orchestrator-Subagent。
- 流式 subtopics 审批降级为 Chat 内逐条确认。
- 报告以 Markdown 写到工作区(`research-report.md`)。
- `TaskTreeView` 侧边栏展示子代理进度。

**裁剪掉**:可点击溯源引用的富交互 UI(降级为 Markdown 脚注链接)、断点续研前端状态恢复 UI(内核有状态,Chat 内重新唤起即可)。

### 3.4 Computer Use ✗ 不适合

**档位**:不适合。IDE 非 GUI 操控场景,原理性不匹配。

仅保留最小入口:在 GitHub/GitLab URL 的 Chat 引用场景触发内核对远程 repo/PR 做只读分析。不做 DOM 动作执行、不做截图流呈现。

### 3.5 日常规划 △ 裁剪(仅软件任务)

**档位**:裁剪,定位编码任务的 Plan/Act + FocusChain。

- Chat 内 `@arclightagent 制定重构计划`,内核返回结构化 TODO(FocusChain)。
- `TaskTreeView` 渲染 checklist,支持勾选/展开子任务。
- `StatusBarItem` 显示当前活跃任务和进度。
- Cron/心跳协调器在内核侧,插件只接收 `subagent.update` 事件并更新树视图。

**裁剪掉**:日历视图、生活域 MCP 工具(Google Calendar/Gmail)、主动生活提醒(VSCode 无原生推送通道,编辑器通知(`vscode.window.showInformationMessage`)仅作工作时段轻量提示)。

---

## 4. 鉴权 / 会话 / 密钥 / 离线同步落地(依据地基3)

### 4.1 鉴权

**首选路径**:`vscode.authentication.registerAuthenticationProvider('arclightagent', 'Arclight Agent', provider)`。用户在 VSCode 账户面板(`Accounts`)管理登录状态,插件通过 `vscode.authentication.getSession('arclightagent', scopes)` 获取 session。

实现细节:
- `createSession()` 内部走 **OAuth 2.1 + PKCE**:调用 `vscode.env.openExternal(authUrl)` 打开系统浏览器,内核回调 `http://127.0.0.1:<ephemeral>/callback`(loopback redirect)捕获 `code`。
- 本地内核时退化为 **localhost 信任**:读 `~/.config/arclightagent/server.json` 中的 `{port, token}`,无需 OAuth。
- 远程/Web 版 VSCode(`vscode.dev`)无法 loopback → 回落**设备码流(device_code,RFC 8628)**:`vscode.env.clipboard.writeText(userCode)` + 通知提示用户在浏览器完成授权。

### 4.2 token 存储

- access token、refresh token → `context.secrets`(`vscode.SecretStorage`,底层即 OS keychain/DPAPI/libsecret)。
- **provider API key / MCP OAuth token 永不存本端**,全部由内核 keychain/KMS 保管。插件侧 `SecretStorage` 只存插件自身的 app-session token。
- token 旋转(rotating refresh):access 过期时插件调内核 `/token/refresh`,拿新 access 写回 `SecretStorage`;refresh 一次性旋转,重用检测即吊销。

### 4.3 密钥纪律

严格继承地基3 §2.1:
- **`~/.config/arclightagent/`** 只存非密配置(模型偏好、server 地址);**零密钥明文落此**。
- 插件的 `globalState` 同样只存 UI 偏好(主题/面板布局),不存任何 token。
- 内核凭证代理(Google Calendar/Gmail 等 MCP OAuth token)按动作签名放行,插件侧零接触。

### 4.4 会话同步

- 插件 host 进程持一条 SSE 长连到内核(`ArcKernelClient`),订阅当前 session 的 `ArcEvent` 流。
- `EventReducer`(来自 `@arclight/client-core`)维护前端视图状态;webview panel 刷新时 host 重推快照(`postMessage({channel:'snapshot', state})`),webview 不直接持 SSE。
- **epoch**:压缩边界 `context.compacted` 事件递增 epoch,任何带旧 epoch 的 C1 命令被内核拒为 `StaleEpochError`→插件弹 QuickPick 提示用户"会话已更新,请重试"。
- **断线重连**:250ms 退避,重连带 `Last-Event-ID: <lastSeq>`,内核 replay 未推帧。VSCode Remote/SSH/Codespaces 场景下内核运行在远程,连接中断后自动重连,**任务在内核侧持续进行**。

### 4.5 离线

**离线能力:中(依 VSCode 网络)**。
- 本地内核模式:VSCode 同机,localhost HTTP/SSE,VSCode 关闭即内核停(或内核 daemon 在后台持续)。
- 远程内核模式:断网时插件不可用,任务在远程内核侧持续;重连后事件流自动续。
- **不做离线写队列**:VSCode 侧无需缓存待提交变更,任务由内核管理,插件只是控制面板。

---

## 5. 打包 / 分发 / 自动更新方案与平台合规

### 5.1 打包

```
# 构建流程
1. webview-ui/ → Vite build → dist/webview/  (独立 CSP-safe 产物)
2. src/        → esbuild bundle → dist/extension.js  (CJS, externalize vscode)
3. vsce package → arclightagent-x.y.z.vsix
```

关键 `package.json` 字段:
```json
{
  "engines": { "vscode": "^1.90.0" },
  "main": "./dist/extension.js",
  "contributes": {
    "chatParticipants": [{
      "id": "arclightagent.agent",
      "name": "arclightagent",
      "description": "全平台 AI Agent — 写代码/写文章/调研/规划",
      "isSticky": true
    }],
    "commands": [
      { "command": "arclight.newSession", "title": "Arclight: New Session" },
      { "command": "arclight.openPanel",  "title": "Arclight: Open Panel" },
      { "command": "arclight.rollback",   "title": "Arclight: Rollback Checkpoint" }
    ],
    "authentication": [{
      "id": "arclightagent",
      "label": "Arclight Agent"
    }]
  }
}
```

### 5.2 分发通道

**主渠道:VSCode Marketplace**(`vsce publish`)。审核周期基本自动(数分钟到数小时),偶发人工审核。

**同步发布 Open VSX**(`ovsx publish`),覆盖 VSCodium / Cursor / Windsurf / GitHub Codespaces 等非微软 VSCode 分发。这是强制要求:主蓝图目标用户中有大量使用 Cursor/VSCodium 的开发者。

发布脚本(monorepo CI):
```yaml
# .github/workflows/publish-vscode.yml
- run: cd packages/vscode-extension && vsce package
- run: vsce publish --pat $VSCE_PAT
- run: ovsx publish arclightagent-$VERSION.vsix --pat $OVSX_PAT
```

### 5.3 自动更新

VSCode Marketplace 内置更新机制,无需自建 updater。用户设置"自动更新"后,VSCode 自动推送新版本 .vsix 并提示重载。**无需 Tauri updater 或自建 update server**。

### 5.4 平台合规要点

| 合规项 | 要求 | 做法 |
|---|---|---|
| **CSP** | Marketplace 要求 webview 有严格 CSP;MV3 类似限制 | webview HTML 注入 nonce + `Content-Security-Policy`;禁 `eval`/`unsafe-inline`;静态资源仅 `vscode-resource:` 协议 |
| **权限声明** | `package.json` 中 `capabilities.untrustedWorkspaces` 声明 | 非信任工作区限制沙箱命令执行 |
| **telemetry** | Marketplace 政策要求遵守 VSCode telemetry 设置 | 接入 `vscode.env.isTelemetryEnabled`;关闭时停止上报 |
| **商店审核** | 人工审核可能关注:网络请求目标、远程代码执行声明 | 在 README 和 Marketplace 描述中明确"所有推理在内核服务,插件不执行远程 JS";敏感能力(bash 执行)说明走本地沙箱 |
| **许可证** | 插件自身 MIT;所有依赖无 GPL/LGPL | CI `license-checker` 拦截;Apache-2.0 依赖附 NOTICE |
| **Open VSX** | 与 Marketplace 同步 | CI 同步发布步骤,版本号对齐 |

**审核周期风险**(地基3 §4 提及):Marketplace 审核通常数小时,但首次发布或重大权限变更可能 1-3 天。安全关键修复应优先在**内核侧**发布(可即时更新),插件只做薄壳——这正是"薄客户端"架构的运维价值。

---

## 6. 本端特有的硬约束与坑(诚实)

### 6.1 Extension Host 进程约束(最大硬约束)

VSCode 所有扩展共享同一个 Extension Host 进程(Node.js),与 VSCode 主进程**同生共死**。长时间 CPU 占用或内存泄漏会导致整个 IDE 卡顿/崩溃。

**cline 自己的警告**:「所有 heavy lifting(LLM 调用、文件 IO、terminal)都跑在扩展宿主进程,长任务或频繁 IO 可能导致 IDE 卡顿。」(repo-cline.json 第 157 行)

**缓解**:
- **内核必须是独立进程**——所有 Agent 运行时、LLM 调用、沙箱执行全在内核侧,Extension Host 只做 HTTP client + 事件 reducer + UI 渲染。**绝不在 Extension Host 进程内运行推理或沙箱**。
- `EventReducer` 中的 16ms 帧 coalescing 防止高频 `message.delta` 触发过多 `postMessage`/UI 更新。
- 避免在 Extension Host 持有大 buffer——tool.output 超限走 `spillRef` 二次拉取,不在内存中缓存完整输出。

### 6.2 webview 通信的双重 API 问题(cline 自己暴露的坑)

cline 在迁移到 gRPC-over-postMessage 后,仍保留了旧的直接 `postMessage` 路径("subscribeToX 系列"),新旧并存增加维护负担。

**我们的做法**:从第一天起统一 postMessage 通信格式为类型化 envelope:`{ channel: string, seq: number, payload: ArcEvent | Command }`,不留旧路径。WebviewBridge 封装所有 `panel.webview.postMessage` 调用,webview 侧对称解包。**不上 protobuf/buf**(过重,地基1 §3.3 已拍板)。

### 6.3 Chat Participants API 的限制

Chat Participants API(VSCode 1.90+)相对成熟,但有几个已知约束:
- **流式渲染只支持 MarkdownString**:复杂富交互(diff 审批、分阶段审批按钮)在 Chat 面板内能力有限,需用 `ChatResponseStream.button()` + follow-up providers 拼凑,或打开独立 Webview Panel。
- **不支持多模态输入**(目前 GA 版本):用户无法在 Chat 内直接粘贴截图给 @arclightagent(computer use 场景不走此路径本已合理)。
- **`@arclightagent` 命名空间独占**:一个扩展只能注册一个同名 participant,子能力用 `/` 命令区分(`@arclightagent /code`、`@arclightagent /research`等,对应 `chatParticipants.commands` 注册)。
- **Copilot Chat 依赖**:Chat Participants 需要 Copilot Chat 扩展存在(GitHub Copilot 或 Copilot Free)。在不安装 Copilot 的环境,退化到独立 Webview Panel 主 UI。

**缓解**:
- 核心写代码能力优先走 Chat Participant(体验最好);复杂富交互(写文章审批/调研报告)走独立 Webview Panel。
- 在 `package.json` 中声明 Copilot 为可选依赖(`extensionDependencies` 选填),提供 fallback Webview 模式。

### 6.4 VSCode Remote / Codespaces / Web 的网络拓扑差异

| 环境 | 内核位置 | 连接方式 | 特殊处理 |
|---|---|---|---|
| 本地 VSCode + 本地内核 | 同机 | localhost loopback | 最优路径,无特殊 |
| VSCode Remote SSH(远程机器) | 远程机器 | Remote Extension Host 在远程机运行,直接连远程机本地内核 | Extension Host 已在远程,localhost 即目标机 |
| GitHub Codespaces | 容器内 | Container 内 Extension Host + 容器内内核,或连外部远程内核 | 端口转发 / 环境变量 `ARC_SERVER_URL` |
| vscode.dev(浏览器 VSCode) | 远程 | 无法运行 Node.js Extension Host,只能 Web Extension | **最大坑**:vscode.dev 不支持完整 Node.js Extension Host(见 §6.5) |

### 6.5 vscode.dev(Web Extension)的严重限制

`vscode.dev` 中扩展运行在 Web Extension Host(浏览器,无 Node.js 能力)。**现有的 `main` 入口完全无法在此运行**。

**选项**:
- A. 提供独立的 `browser` 入口(Web Extension entrypoint),只暴露有限能力(OAuth 登录 + 只读 Chat)。
- B. 不支持 vscode.dev,在 Marketplace 中设 `engines.vscode: ">=1.90.0"` 并标注"不支持 Web 扩展"。

**建议选 B 作为 P3 初版**,原因:vscode.dev 用户量少,为其适配 Web Extension 需重写大量平台相关代码(文件系统、SecretStorage 均有差异),是净亏。P5 之后再评估 A。

### 6.6 MCP server 注册的鸡和蛋问题

插件注册为 MCP server 供 Copilot/其他 Chat Participants 消费时,**MCP server 必须在 Extension Host 内常驻**(`Streamable HTTP` over `vscode.env.asExternalUri` 或 `stdio` transport)。这意味着:
- Copilot 作为 MCP client 连插件的 MCP server
- 插件的 MCP server 再作为 MCP client 连内核

形成两跳链路:`Copilot → 插件 MCP server → 内核 MCP/HTTP`。延迟可接受(均 localhost),但增加了错误传播路径。

**缓解**:插件 MCP server 做薄代理(工具 schema 直接从内核拉,调用直接转发),不做复杂状态,保持无状态幂等。

---

## 7. 与其他端/内核的代码复用边界

### 7.1 完全复用(零修改)

| 包 | 内容 | 所有端共享 |
|---|---|---|
| `@arclight/protocol` | `ArcEvent` union、命令请求体、响应体、`CapabilityProfile` | Web / 桌面 / 移动 / CLI / VSCode / Chrome |
| `@arclight/client-core` | `EventReducer`(discriminated-union 解析、seq 去重、16ms coalescing、250ms 重连退避、`spillRef` 拉取队列) | 同上六端 |
| `@arclight/adapter-agui`(阶段五后置) | AG-UI 适配器 | 所有端可选用 |

### 7.2 VSCode 端特有(不共享)

| 模块 | 内容 | 不可共享原因 |
|---|---|---|
| `VSCodeHostProvider` | 平台能力实现(diff/terminal/scm/secret) | 依赖 `vscode.*` API,编译时 external |
| `ArcKernelClient` | SSE/HTTP/WS 连接管理(可部分共享 fetch 逻辑) | VSCode Remote 拓扑差异需特殊处理 |
| `WebviewBridge` | host↔webview postMessage | VSCode 专有通信机制 |
| `participantHandler` | Chat Participants API | VSCode 专有 |
| `mcpServerRegistrar` | MCP server 注册 | VSCode 专有 |
| `WorkspaceEditApplier` | diff→WorkspaceEdit | **端特定执行后端**,地基2 §1.3 |
| `DiagnosticsWatcher` | LSP 诊断订阅→内核反馈 | **端特定执行后端**,替代内核内置 LSP |

### 7.3 与 Web 端的前端代码复用

- `webview-ui/` 中的 React 组件**可复用** Web 端 Next.js 中对应的纯展示组件(调研报告渲染、FocusChain checklist、diff 审批卡),前提是组件无 Next.js 特有依赖(Server Components/Next router)。
- 建议把这类组件提取到 `@arclight/ui`(纯 React,无框架绑定),供 Web 端 Next.js + webview Vite 同时引用。

### 7.4 与 CLI 端的复用

- `ArcKernelClient` 的 HTTP/SSE 底层逻辑可与 CLI 的 `KernelHttpClient` 抽到 `@arclight/client-core` 的共同子模块。
- 连接发现逻辑(`discovery.ts`:env → `server.json` → sidecar → 远程)与 CLI/桌面**完全一致**,抽到 `@arclight/client-core/discovery`。

---

## 8. 工作量量级 / 前置依赖 / 排期位置

### 8.1 前置依赖(硬性,缺一不可)

| 前置 | 所在阶段 | 说明 |
|---|---|---|
| **内核 HTTP/SSE server 稳定** | 阶段一 MVP | 插件是薄客户端,内核不稳定则插件无法开发 |
| **`@arclight/protocol` 类型包稳定** | 阶段一 MVP | 协议契约是代码生成基础 |
| **`@arclight/client-core` EventReducer** | 阶段一(Web 端先实现)→ 提取为共享包 | Web 端先用,提取后 VSCode 复用 |
| **OpenAPI→TS SDK 自动生成基建** | 阶段五启动前 | 插件作为"第二端",需要 SDK 自动生成才能高效开发 |
| **OAuth 2.1 / VSCode AuthenticationProvider** | 阶段五 | 认证是插件连接内核的前提 |
| **MCP 双向 native 在内核侧稳定** | 阶段二/三 MCP 完善后 | MCP server 注册依赖内核 MCP 生态稳定 |

### 8.2 工作量量级估算

> 基准:1-2 人 TS 团队,主蓝图 §9 阶段五 6-8 周大范围(含 CLI/桌面/Chrome/多租户)。VSCode 插件是其中一条并行线。

| 模块 | 估算人日 | 备注 |
|---|---|---|
| Extension Host 骨架 + 激活/命令注册 | 3-5 | 标准 VSCode 扩展脚手架 |
| `ArcKernelClient`(SSE/HTTP/WS + 重连) | 3-5 | 大部分复用 `@arclight/client-core` |
| Chat Participant 主路径(写代码流式) | 5-8 | Chat Participants API 有学习曲线 |
| `WorkspaceEditApplier` + diff 落地 | 3-5 | VSCode WorkspaceEdit API 相对直接 |
| `DiagnosticsWatcher`(LSP 诊断→内核) | 2-3 | |
| `SCMProvider`(shadow-git 检查点 UI) | 3-5 | |
| `TerminalManager` | 2-3 | |
| `PermissionModal`(审批弹窗) | 2-3 | |
| `AuthenticationProvider` + token 存储 | 3-5 | OAuth loopback + device_code fallback |
| MCP server 注册(薄代理) | 3-5 | |
| Webview Panel(写文章/调研富交互,可选) | 8-12 | 可后置为 P3+ |
| `TaskTreeView` + `StatusBarItem` | 2-3 | |
| 打包/CI/Marketplace 发布 + Open VSX | 2-3 | |
| 集成测试 / eval case | 5-8 | |
| **合计(不含 Webview Panel)** | **~37-54 人日** | 约 2 人 × 3-4 周 |
| **含 Webview Panel** | **~45-66 人日** | 约 2 人 × 4-5 周 |

### 8.3 在全平台排期中的位置

```
阶段一(~6-8 周): Web MVP ← 内核服务、协议、EventReducer 在此成形
     ↓
阶段二(~5-7 周): 写作能力 + 持久化加固 ← @arclight/client-core 提取为共享包
     ↓
阶段三(~5-7 周): Deep Research ← 调研子代理、进度 SSE 稳定
     ↓
阶段四(~6-8 周): computer-use + 沙箱 + 日常规划
     ↓
阶段五(~6-8 周): 全平台壳并行:
     ├── CLI (P2, 最简单,先交付)
     ├── 桌面 Tauri2 (P3, 与 VSCode 并行)
     ├── VSCode 插件 (P3) ← 本文档
     │   └── 推荐顺序:骨架+写代码主路径(2周)→认证+MCP(1周)→写文章/调研适配(1周)→Webview Panel可选(1-2周)
     └── Chrome 扩展 (P4, 最后)
```

**VSCode 插件的关键里程碑**:
1. **M1(第1-2周)**:Extension Host 骨架 + `ArcKernelClient` + Chat Participant 写代码流式 + `WorkspaceEditApplier` + 基础权限弹窗。可用于内部 dogfooding。
2. **M2(第3周)**:`AuthenticationProvider` + token/SecretStorage + MCP server 注册。可连远程内核。
3. **M3(第4周)**:写文章/调研 Chat 适配 + `TaskTreeView` + Marketplace/Open VSX 发布。第一次公开版本。
4. **M4(可选,第5-6周)**:Webview Panel 富交互(diff 审批/分阶段写作审批)。提升体验上限。

---

## 附:与主蓝图一致性自检

- Chat Participants API(@arclightagent)+ MCP server 注册 → §7 P3 决策原文 ✔
- 复用 Copilot 订阅、零聊天 UI 开发 → §7 论证 ✔;Copilot 不存在时 Webview fallback ✔
- Extension Host 不跑推理/沙箱,内核独立进程 → §1.3 反面教材 1"内核不桥接终端进程" ✔
- VSCode 端 WorkspaceEdit + LSP/SCM 原生落地(端特定执行后端)→ 地基2 §1.3 ✔
- `@arclight/protocol` + `@arclight/client-core` 六端共享 → 地基1 §3.1 / §2.2 ✔
- postMessage envelope 类型化,不上 protobuf → 地基1 §3.3(cline HostProvider 采纳,protobuf 不采纳)✔
- `SecretStorage` 存 app-session,provider key 内核保管 → 地基3 §2.2/§2.3 ✔
- 禁明文 `~/.config` → 地基3 §2.4 / 主蓝图 §5.5 ✔
- OAuth 2.1 / device_code fallback → 地基3 §1.2 VSCode 端 ✔
- Marketplace + Open VSX 同步 + 审核周期安全关键修复走内核 → 地基3 §4 ✔
- 阶段五排期,前置阶段一内核骨架 → 主蓝图 §9 ✔
- 许可证 MIT;CI 拦截 GPL/LGPL → 主蓝图 §3.4-3.6 ✔
- computer-use 不适合 VSCode,仅最小入口 → 地基2 §4.1 ✔
- 日常规划裁剪为仅软件任务,无生活域 → 地基2 §5.1 ✔
- vscode.dev Web Extension 坑诚实标注,P3 初版不支持 → 本文 §6.5 新增风险 ✔