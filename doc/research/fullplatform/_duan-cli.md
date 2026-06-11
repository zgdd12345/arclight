现在我已经完整读取了主蓝图。可以直接输出 CLI 终端(P2) 详设，无需再读 JSON 文件（地基1/2/3 已在 prompt 中完整提供）。

---

# arclightagent CLI 终端(P2)详细设计

> 锚定文件:`/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md`(§7 CLI 行、§2.1 栈、§9 阶段五排期)+ 地基1/2/3 契约。**所有决策与主蓝图无矛盾。**

---

## 1. 组件级架构

### 1.1 端内部分层

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    arclight CLI 单二进制 (Bun --compile --bytecode)             │
│                    arg0 multicall: arclight / arclight-serve / arclight-mcp    │
├──────────────────────────┬───────────────────────────────────────────────────┤
│    [交互 TUI 模式]          │  [headless / 管道模式 -p / --stdio]                 │
│  OpenTUI 渲染层             │  无 TUI 依赖, 纯 stdio JSONL 双向                   │
│  ┌─────────────────────┐   │  ┌────────────────────────────────────────────┐  │
│  │ InputBar             │   │  │ stdin: 逐行读 ArcCommand JSON               │  │
│  │ MessageList (滚动)   │   │  │ stdout: 逐行写 ArcEvent JSON (NDJSON)        │  │
│  │ ToolProgressPanel    │   │  │ stderr: 人类可读日志/错误                    │  │
│  │ PermissionModal      │   │  └────────────────────────────────────────────┘  │
│  │ StatusBar             │   │  触发场景: CI/脚本/自动化/管道链                  │
│  └─────────────────────┘   │                                                   │
├──────────────────────────┴───────────────────────────────────────────────────┤
│                          CLI 核心层 (端无 UI 依赖的业务逻辑)                      │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────┐  ┌───────────────┐  │
│  │ CommandRouter   │  │ EventReducer  │  │ SessionManager │  │ PermHandler   │  │
│  │ 子命令分发       │  │ ArcEvent→TUI  │  │ 会话 ID / epoch│  │ y/n 终端审批  │  │
│  │ multicall 检测  │  │ 16ms coalesce│  │ 断点续连        │  │ --yes 自动化  │  │
│  └────────────────┘  └──────────────┘  └────────────────┘  └───────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │  TransportAdapter (协议地基1 C1/C2 在 CLI 的落地)                          │  │
│  │  交互模式: HTTP POST (C1) + SSE (C2)  ←→  本地/远程内核                    │  │
│  │  headless 模式: stdio JSONL 双向  (单进程,无 HTTP server)                   │  │
│  │  C4 media: 不支持 (无截图载体, computer-use 仅文本日志+触发)                │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────────── ┐ │
│  │  KernelConnector: 连核发现链                                               │ │
│  │  1. env ARC_SERVER_URL  2. ~/.config/arclightagent/server.json(端口+token)  │ │
│  │  3. arc serve --daemon 自启本地内核 sidecar → 写 server.json → 连           │ │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
         │ HTTP POST(C1) / SSE(C2)         │ stdio JSONL(headless)
         ▼                                 ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│           内核服务 (headless agent server, Bun + Hono)                         │
│           [CLI 不重写任何内核逻辑; 仅 TransportAdapter 差异]                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 子命令与 multicall 映射

```
arclight                  # TUI 交互主入口 (交互模式)
arclight chat             # 同上, 显式子命令
arclight -p "prompt"      # headless 单次对话 (管道模式, stdout NDJSON)
arclight --stdio          # MCP stdio server 模式 (供 VSCode/其他 host 消费)
arclight serve            # 启本地内核 daemon (arc serve --daemon)
arclight login            # 设备码流登录
arclight logout           # 吊销 + 清本地 keychain 句柄
arclight sessions         # 列会话
arclight resume <id>      # 断点续连已有会话 (带 Last-Event-ID 重连)
arclight config           # 查看/编辑 ~/.config/arclightagent/config.json
arclight upgrade          # 自更新
```

`arg0 multicall` 实现:二进制检测 `path.basename(process.argv[0])`,匹配到 `arclight-serve`/`arclight-mcp` 等时直接路由到对应子命令,**无需多个分发包**(借 codex `arg0 multicall` 思路)。

---

## 2. 技术选型与关键依赖

与主蓝图 §2.1 栈严格一致,无例外引入。

| 层 | 选择 | 版本约束 | 理由 |
|---|---|---|---|
| **运行时** | `Bun --compile --bytecode` | Bun stable | 零外部依赖单二进制;`--bytecode` 加速启动、轻度混淆;主蓝图 §7 CLI 行明文 |
| **TUI** | **OpenTUI** | 主蓝图指定 | 主蓝图 §7 明文;TS 原生,与栈同构;可渲染 diff/进度/modal |
| **HTTP 客户端** | Bun 原生 `fetch` + `EventSource` polyfill | — | SSE C2 消费;内核侧 Hono 暴露标准 SSE |
| **CLI 框架** | **`@std/cli` (Bun built-in) 或 `citty`** | — | 轻量;避免引重型 commander/yargs;multicall 自实现 |
| **keychain** | `keyring` crate Rust helper (napi/Bun FFI 桥) **或** `@napi-rs/keyring` | MIT/Apache-2.0,合规 | OS keychain 桥;macOS Keychain / Windows DPAPI / Linux libsecret;**禁明文 `~/.config`** |
| **类型共享** | `@arclight/protocol` (单 repo,零 codegen) | — | 地基1 §3.1: MVP 单 repo 共享 TS 类型 |
| **client-core** | `@arclight/client-core` (EventReducer/重连/coalescing) | — | 地基1 §2.2: 六端复用同一 reducer 包 |
| **JSONL 解析** | `@arclight/protocol` + 手写行解析 | — | headless stdio 模式;每行一个 `ArcEvent` |
| **持久会话状态** | `~/.config/arclightagent/server.json` + OS keychain | — | 非密配置落文件;密钥落 keychain |
| **许可证** | `keyring` MIT/Apache-2.0; `citty` MIT; OpenTUI (核查); Bun MIT | — | CI 拦截 GPL/LGPL 入树(主蓝图 §3.4) |

**不引入的依赖(刻意排除)**:
- `ink` / `blessed` / `charm`——已选 OpenTUI,不重复引 TUI 框架
- `LangGraph`——主蓝图 §8/风险表明文禁止(「先增后拆」净负)
- `mem0` / `AG-UI` / `ToolExposure` ——全部后置(主蓝图 §9 阶段二/五)
- `Effect` 4.x——主蓝图 §3.2 明文避开(opencode 的问题教训)

---

## 3. 本端承载能力与裁剪

依据地基2 五能力 × 六端矩阵。

### 3.1 写代码 — **可用(P2)**

**裁剪清单**:
- `diff` 展示:OpenTUI 文本 diff (unified diff 渲染),无图形 diff(Monaco 在 Web 主场)
- 内嵌终端:本地终端即沙箱终端(CLI 本身运行在终端),无 iframe 内嵌
- shadow-git `/undo`:降级为 `arclight undo` 子命令,内核侧 shadow-git 逻辑与 Web 完全共享
- LSP:无编辑器原生 LSP(VSCode 主场特权);内核侧内置基础 LSP 调用依然可用,但诊断展示为纯文本
- 权限审批:TUI PermissionModal(y/n/always + `--yes` 自动化标志,详见 §4)

**保留完整**:
- RepoMap、SEARCH/REPLACE、反射验证闭环、本地沙箱默认(CLI 运行在本机,nono/系统 bwrap exec 天然可用)、shadow-git 检查点(内核侧)、Git 集成

**headless 管道场景**(`arclight -p "修复 bug" < context.txt`):
- stdout 输出纯 NDJSON ArcEvent 流,CI/脚本可 `jq` 过滤
- 适合 CI diff review、PR 描述生成、批量重构
- 退出码语义:0=成功,1=模型错误,2=权限被拒,3=沙箱错误

### 3.2 写文章 — **裁剪(P2 后期或 P3)**

- OpenTUI 流式输出大纲/章节文本
- 分阶段审批降级为终端 y/n (`-p` 模式时 `--yes` 跳过)
- 文档生成在内核侧:输出 `.md`/`.docx` 文件路径,CLI 打印路径或用 `open` 打开
- 裁剪掉:富文本所见即所得、可视化多栏审批、大纲拖拽

### 3.3 调研 (Deep Research) — **可用(阶段三后)**

- OpenTUI 流式 subtopics 进度 + 检索子代理状态条
- 引用脚注:降级为脚注列表 + 链接(无可点击溯源)
- 断点续研:`arclight resume <task-id>` 重连内核侧持久化任务
- 长任务后台:`arclight research --detach` 后台运行,`arclight status` 查进度

### 3.4 Computer Use — **不适合**

- 终端无截图载体,无法做可视化 HITL 确认
- 仅保留:`arclight computer-use trigger --url "..."` 触发远程任务 + 文本日志流
- **不作为 computer-use 端**

### 3.5 日常规划 — **裁剪**

- 保留:Plan/Act 双模式、FocusChain checklist、Cron 触发(`arclight cron list/run`)
- 裁剪掉:日历视图、生活域 MCP 工具、主动通知(终端无常驻通知,通知降级为下次进终端时打印待办)
- `arclight plan` 产可审阅计划再 `arclight act` 执行(两步必须分离,不默认自动执行)

---

## 4. 鉴权 / 会话 / 密钥 / 离线同步

依据地基3 §1(鉴权)、§2(密钥)、§3(同步)。

### 4.1 登录流程

```
arclight login
  → 打印 user_code + https://arclightagent.app/activate
  → 若本机有浏览器: open 自动打开(可 --no-browser 跳过)
  → 轮询 /oauth/token (device_code flow, RFC 8628)
  → 收到 access_token + refresh_token
  → access_token 写 OS keychain (key: "arclight/access/<userId>")
  → refresh_token 写 OS keychain (key: "arclight/refresh/<userId>")
  → server.json 写非密信息: { userId, tokenRef: "arclight/access/<userId>", ... }
```

**本地内核模式(不需 OAuth)**:
- `arc serve` 启动内核时在 stdout 打一行握手 JSON:
  `{"port":PORT,"token":"<random>","pid":PID,"version":"..."}`
- CLI 读到后写 `~/.config/arclightagent/server.json`:
  `{ "port": PORT, "localToken": "<token>", "pid": PID }` (非密:token 是短期本地 pairing,不是用户密钥)
- 后续所有请求带 `Authorization: Bearer <localToken>`,仅 `127.0.0.1` 接受

### 4.2 Token 刷新

```
CLI 发 HTTP 请求 → 收到 401 → 从 keychain 取 refresh_token
  → POST /oauth/token (grant_type=refresh_token)
  → 收新 access + 新 refresh (rotating refresh)
  → 写回 keychain
  → 重试原请求
```

**rotating refresh 纪律**:旧 refresh 一次性使用后失效;重用旧 refresh = 内核吊销整条会话链。

### 4.3 密钥存储

| 秘密 | 存储位置 | 接入 |
|---|---|---|
| access_token | OS keychain | `@napi-rs/keyring` / Rust FFI |
| refresh_token | OS keychain | 同上 |
| provider API key | OS keychain (用户执行 `arclight config set-key`) | 同上 |
| MCP OAuth token | **内核侧 keychain/KMS, CLI 从不接触** | — |
| 本地 pairing token | `~/.config/arclightagent/server.json` (短期,非长效密钥) | 文件读 |

**禁止事项**:任何长效密钥**不写** `~/.config/arclightagent/`(主蓝图 §5.5 硬纪律)。

### 4.4 Linux 无 keyring 守护进程的降级(地基3 风险5)

```
CLI 启动时探测 keyring daemon (D-Bus Secret Service):
  存在 → 正常用 libsecret
  不存在 → 提示用户:
    "No system keyring detected. Options:
     1. Install gnome-keyring or KWallet
     2. Use 'arclight config --use-pass' (delegates to `pass`)
     3. Set ARC_TOKEN env var (session only, not persisted)"
```

**绝不回落明文文件**。SSH/headless server 场景推荐 `pass` 或环境变量注入(不持久化)。

### 4.5 会话与离线同步

- **强离线模式**:本地 `arc serve` 启动内核 sidecar → 本地即真相源,完全离线可用(主蓝图 §7 桌面/CLI 强离线)
- **断点续连**:SSE 重连带 `Last-Event-ID: <seq>`,内核 replay > seq 的帧;CLI EventReducer 按 seq 单调过滤去重(`@arclight/client-core` 共享逻辑)
- **乐观锁 epoch**:CLI 提交命令时带读到的 `epoch`,内核返回 `StaleEpochError` 时 CLI 打印提示并拉新状态重试(MVP 版:最朴素"刷新不丢",冲突合并 UX 后置阶段二)
- **headless 管道模式**:进程内无需续传;崩溃靠 `arclight resume <session-id>` 重跑

---

## 5. 打包 / 分发 / 自动更新

### 5.1 打包

```bash
# 交叉编译 8 target (bun --compile 支持)
bun build ./src/cli.ts --compile --bytecode \
  --target bun-linux-x64        -o dist/arclight-linux-x64
bun build ./src/cli.ts --compile --bytecode \
  --target bun-linux-arm64      -o dist/arclight-linux-arm64
bun build ./src/cli.ts --compile --bytecode \
  --target bun-darwin-x64       -o dist/arclight-darwin-x64
bun build ./src/cli.ts --compile --bytecode \
  --target bun-darwin-arm64     -o dist/arclight-darwin-arm64
bun build ./src/cli.ts --compile --bytecode \
  --target bun-windows-x64      -o dist/arclight-windows-x64.exe
# ... 等其余 target
```

**注意**:Windows 二进制元数据(FileDescription/ProductName 等)需 Windows runner + `rcedit` 注入,不能在 macOS cross 一次性完成。CI matrix 中为 Windows 单独开一个 `windows-latest` job。

### 5.2 签名与校验

| 平台 | 签名方案 |
|---|---|
| macOS | `codesign` + Apple Developer ID,`xcrun notarytool` 公证(Gatekeeper) |
| Windows | Authenticode 代码签名证书(`signtool`) |
| Linux | `minisign` / `gpg` 对每个二进制生成 `.sig` 文件 |
| 全平台 | `sha256sum` checksum 文件随 Release 附带 |

**自更新时必须验证签名/checksum 后再替换**,见 §5.4。

### 5.3 分发通道

```
GitHub Releases
  arclight-linux-x64        + .sig + .sha256
  arclight-linux-arm64      + .sig + .sha256
  arclight-darwin-x64       + .sig + .sha256
  arclight-darwin-arm64     + .sig + .sha256
  arclight-windows-x64.exe  + .sig + .sha256

install.sh (curl 一键安装):
  curl -fsSL https://arclightagent.app/install.sh | sh
  → 检测 OS/arch → 下载对应二进制 → 验证 sha256 + minisign → 放 /usr/local/bin
```

**无商店审核**(CLI 自托管 GitHub Releases):可即时发布安全修复,这是 CLI 相比移动/Chrome 端的核心运维优势。

### 5.4 自动更新

```bash
arclight upgrade
  → GET https://api.github.com/repos/arclightagent/arclightagent/releases/latest
  → 比较版本号
  → 下载新二进制到临时路径
  → 验证 sha256 + minisign 签名 (公钥内置于二进制,防中间人)
  → 原子替换: rename(tmp, currentBinary) (Unix atomic rename)
  → 打印 "Upgraded to vX.Y.Z. Please restart."
```

`arclight upgrade --check` 仅打印可用版本,不自动下载(CI/脚本场景)。

**后台自检(可选)**:进程启动时异步检查新版本,若有则在 TUI StatusBar 提示,不阻塞启动。

---

## 6. 本端特有硬约束与坑

### 6.1 headless / 管道模式的输出规范问题

**坑**:stdio 模式下,若任何依赖库向 stdout 打印调试日志或 ANSI escape code,会破坏 NDJSON 解析。

**缓解**:
- `--stdio` / `-p` 模式下强制 `process.env.NO_COLOR=1`、`process.env.ARC_LOG_LEVEL=error`
- 所有内部日志走 stderr(不混 stdout)
- 依赖库引入时核查其 stdout 行为(OpenTUI 等 TUI 库必须在 headless 模式下完全静默)
- CI 上写集成测试:管道模式输出每行必须合法 JSON

### 6.2 大文件/大输出在 stdio 管道的背压问题(地基1 §1.2 已指出)

**坑**:若 `tool.output` 直接写大文本到 stdout,上游消费者来不及消费会导致背压积压和进程卡住。

**缓解**:
- `tool.output` 携带 `spillRef` 引用,大输出落盘;CLI 可按需拉取 `GET /v1/outputs/:spillRef` 或直接输出文件路径
- `message.delta` 的高频 token 流:headless 模式下按 `\n` 或固定字节数 flush(不积累大缓冲)
- 有 `--output-file <path>` 选项:把长输出直接写文件而非 stdout,适合 CI 场景

### 6.3 Linux keyring 不可用场景

已在 §4.4 给出降级策略。**额外坑**:Docker 容器内通常无 D-Bus / keyring daemon,CI 机器也常无。

**缓解**:
- `ARC_TOKEN` 环境变量注入(仅 session 有效,进程退出即失,**不持久化**)
- `arclight --token-file /run/secrets/arc-token`(读文件,适合 Kubernetes Secret volume 挂载)
- 这两种方式均不写 `~/.config` 明文

### 6.4 Windows 路径与二进制元数据

**坑**:
- `~/.config` 在 Windows 是 `%APPDATA%` 路径,需 XDG 兼容适配(用 `os.homedir()` + 条件拼接)
- `keyring` crate 在 Windows 走 Credential Manager,注意 credential name 长度限制(512 bytes)
- `rename` 原子替换在 Windows 需 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`,Bun 的 `fs.rename` 在 Windows 可能不原子

**缓解**:
- 配置路径用 `platformDataDir()` 封装(Linux: `$XDG_CONFIG_HOME`, macOS: `~/Library/Application Support`, Windows: `%APPDATA%`)
- 自更新时 Windows 改用"写新文件 → 重命名 → 下次进程启动完成替换"的两步式(先标记待更新,下次启动时执行实际替换)

### 6.5 TUI 与 headless 的模式检测

**坑**:在非 TTY 环境(CI、管道、VSCode 集成终端某些配置)下 OpenTUI 可能检测失败或渲染乱码。

**缓解**:
- 启动时检测 `process.stdout.isTTY && process.stdin.isTTY`;非 TTY 则强制 headless/日志模式
- `--tui` / `--no-tui` 显式覆盖开关
- OpenTUI 实例化失败时回落纯文本流(降级而非崩溃)

### 6.6 Bun --compile 的原生模块限制

**坑**:Bun `--compile` 对包含原生 `.node` addon 的依赖支持有限;`@napi-rs/keyring` 是原生 addon。

**缓解**:
- keyring 访问改用**独立 Rust helper 子进程**(`arclight-keyring-helper` 极小二进制),CLI 经 stdio 与其通信(类似 GPG agent 模式)
- 或使用纯 JS 实现的 keyring 桥(性能略差但无 native addon 问题),仅在 Bun compile 不支持时启用
- 在 CI 中对三平台实际测试 keyring 读写(不能只本地 macOS 测)

### 6.7 SSE 重连在网络差环境的帧丢失

**坑**:移动网络/VPN 切换时内核侧的 SSE 缓冲窗口可能不足以 replay 所有帧。

**缓解**:
- 内核侧 SSE buffer 保留最近 N 秒/N 条帧(MVP 最朴素:固定长度环形缓冲)
- CLI EventReducer 检测 seq 跳跃 → 打印警告 `[Warning: event gap detected, seq N→M]` + 提示用户 `arclight resume <session-id>`
- 完整 Redis resumable-stream 后置阶段二(主蓝图 §5.2)

---

## 7. 与其他端 / 内核的代码复用边界

```
arclightagent/
├── packages/
│   ├── protocol/           # @arclight/protocol
│   │   └── src/
│   │       ├── events.ts   # ArcEvent union (六端共享,零 codegen)
│   │       ├── commands.ts # ArcCommand 请求体
│   │       └── types.ts    # Usage / CapabilityProfile / RequestContext
│   │
│   ├── client-core/        # @arclight/client-core
│   │   └── src/
│   │       ├── reducer.ts  # EventReducer (16ms coalescing, seq 去重)
│   │       ├── reconnect.ts# SSE/WS 250ms 退避重连逻辑 (六端复用)
│   │       └── session.ts  # sessionId / epoch 本地状态管理
│   │
│   └── kernel/             # @arclight/core (内核服务, 不含任何 UI 依赖)
│       └── ...
│
├── apps/
│   ├── web/                # Next.js (P0 MVP)
│   ├── cli/                # 本端 ← 复用 protocol + client-core
│   │   └── src/
│   │       ├── cli.ts         # 入口 / arg0 multicall
│   │       ├── tui/           # OpenTUI 渲染层 (CLI 特有,六端不共享)
│   │       ├── headless/      # stdio JSONL 模式 (CLI 特有)
│   │       ├── transport/     # TransportAdapter: HTTP/SSE + stdio JSONL
│   │       ├── auth/          # 设备码流 + keychain (CLI 特有)
│   │       └── commands/      # 子命令实现
│   │
│   ├── desktop/            # Tauri2 (P3)
│   ├── vscode/             # VSCode 插件 (P3)
│   └── chrome/             # Chrome MV3 (P4)
```

**复用边界清单**:

| 模块 | CLI 复用方式 | 不复用原因 |
|---|---|---|
| `@arclight/protocol` 事件/命令类型 | **直接 import** | 六端共享唯一类型源,零 codegen |
| `@arclight/client-core` EventReducer / 重连 | **直接 import** | 六端同一 reducer 逻辑,CLI 不例外 |
| 内核 Agent Runtime / 工具系统 / 沙箱 | 经 HTTP/SSE 消费,不 import 内核包 | 内核零 UI 依赖,CLI 是薄客户端 |
| OpenTUI 渲染层 | CLI 特有,不暴露给其他端 | TUI 渲染是 CLI 私有实现 |
| stdio JSONL 双向通道 | CLI + VSCode host 可复用 headless 逻辑 | Web/桌面/移动/Chrome 不走 stdio |
| 设备码流 OAuth | CLI + 移动 + VSCode(部分)共享逻辑,但实现细节各端有差异 | 可抽为 `@arclight/auth-device-flow` 共享包(P2 后期) |
| keychain 访问 | CLI / 桌面 / VSCode 可共用同一 keyring helper 二进制 | Chrome/Web 无 keychain |
| `~/.config/arclightagent/server.json` 发现逻辑 | CLI / 桌面 / VSCode host 均读同一文件 | 地基1 §6.4 连接发现统一约定 |

**CLI 是"骨架解耦最早可证明端"**:主蓝图阶段一验收标准中明文「同一内核 server 可被一个最小 CLI 客户端连上(证明骨架解耦)」。因此 CLI 的 `TransportAdapter` 层(HTTP POST C1 + SSE C2)是验证「六端共同消费同一内核」这一架构假设的**最轻最快路径**。

---

## 8. 工作量量级 / 前置依赖 / 在全平台排期中的位置

### 8.1 前置依赖(必须就绪才能开工 CLI 完整版)

| 前置 | 所在阶段 | CLI 依赖原因 |
|---|---|---|
| 内核服务 HTTP/SSE 端点稳定 | **阶段一(MVP)** | CLI 的核心工作就是连这个端点 |
| `@arclight/protocol` 类型包发布 | 阶段一 | CLI 需 import ArcEvent union |
| `@arclight/client-core` EventReducer 包 | 阶段一 | 六端复用 reducer,CLI 第一个消费者(阶段一 MVP 验收用) |
| 内核 `session.started` / `message.delta` / `turn.completed` 事件稳定 | 阶段一 | TUI 渲染依赖这些帧 |
| OS keychain 桥方案确定(napi vs Rust helper) | 阶段一/二 | 密钥管理地基 |
| 设备码流 OAuth 端点(内核侧) | **阶段一** | `arclight login` 必须能走通 |

**最小 CLI(阶段一验收用)**:仅需 `arclight chat -p "..."` 能连本地内核、收 SSE 事件流、把 `message.delta` 打印到 stdout。**不需要 TUI、不需要完整子命令**。工作量约 **2-3 天**,作为阶段一骨架解耦验收的最小 spike。

### 8.2 完整 CLI(P2)工作量分解

| 模块 | 估时 | 备注 |
|---|---|---|
| 最小 spike(仅 `-p` 模式,proof of decoupling) | 2-3 天 | 阶段一 MVP 验收附带 |
| TransportAdapter 完整(C1/C2 + 重连 + seq 去重) | 3-5 天 | 复用 `@arclight/client-core` |
| headless stdio JSONL 双向模式 | 3-4 天 | 独立于 HTTP 模式,需专门测管道场景 |
| OpenTUI 交互 TUI(InputBar / MessageList / PermModal) | 5-8 天 | TUI 渲染细节工作量高 |
| 子命令完整(login/logout/sessions/resume/serve/config/upgrade) | 4-6 天 | `login` 设备码流最复杂 |
| keychain 集成(三平台测试) | 3-5 天 | Linux keyring 降级最坑 |
| 打包/签名/分发(CI matrix 8 target) | 3-4 天 | macOS 公证 + Windows 签名需证书到位 |
| 自更新(`arclight upgrade`) | 2-3 天 | |
| 写代码能力适配(TUI diff 渲染 + 沙箱集成) | 3-4 天 | 内核逻辑复用,适配层薄 |
| 测试(单元 + 集成 + 管道模式 e2e) | 3-5 天 | |
| **合计** | **~4-6 周** | 1-2 人;依赖 OpenTUI 成熟度 |

### 8.3 在全平台排期中的位置

```
阶段一 (MVP, ~6-8周)
  └─ Web 单端 + 写代码 + 地基
       └─ [附带] 最小 CLI spike (2-3天, 验证骨架解耦)

阶段二 (~5-7周)
  └─ 持久化加固 + 写文章
       └─ [可选] CLI TUI 初版 (若 Web UX 已验证,可并行启动 CLI P2)

阶段三 (Deep Research, ~5-7周)
  └─ [可选] CLI 调研支持 (arclight research + 流式进度)

↓ CLI P2 完整版建议排期 ↓

阶段五 全平台壳 (~6-8周) ← 主蓝图把 CLI 列在此阶段
  └─ CLI 完整版 (TUI + 全子命令 + 自更新 + 三平台签名)
       并行: 桌面 Tauri / VSCode / Chrome

实用建议: CLI 的「最小 spike + headless 管道模式」
  应在阶段一末尾就做(2-3天), 因为:
  1. 主蓝图阶段一验收标准明文要求
  2. headless 管道模式对 CI eval harness 有用(eval golden case 可用 CLI 管道跑)
  3. 成本极低但能提前验证多端协议契约
  TUI 完整版可以推到阶段五并行做。
```

### 8.4 与其他端协同开发的节奏

- **CLI 与 VSCode 插件可共用** `@arclight/auth-device-flow` 包(P2 后期可抽),减重复
- **CLI 与桌面(Tauri2)共用** keyring helper 二进制和 `server.json` 发现逻辑
- **CLI headless 模式**是内核协议契约的最快 smoke test 通道,建议 CI 每次内核变更时跑一遍管道模式 e2e(`arclight -p "hello" | jq .t`)
- CLI 上的**设备码流实现**可作为移动端(Tauri2)同款体验的参考实现先行验证

---

**文件相关**:`/Users/fsm/project/arclightagent/ARCHITECTURE_BLUEPRINT.md`(§2.1 栈 / §4.1 架构图 / §5.5 密钥 / §7 跨平台 CLI 行 / §9 阶段五全平台壳排期 / §9 阶段一验收"最小 CLI 客户端"要求)