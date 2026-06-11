现在我已经有足够的材料来生成完整的选型清单。让我直接输出结果：

---

# arclightagent 编码能力件选型清单
## 子系统：RepoMap / 编辑格式 / LSP / shadow-git / PTY / git

---

## 1. tree-sitter — AST 解析基础层

### 直接采用的现成方案

| 属性 | 内容 |
|---|---|
| **库** | `web-tree-sitter` (npm) |
| **来源** | https://github.com/tree-sitter/tree-sitter — MIT |
| **提供什么** | 在 Node/Bun/浏览器中以 WASM 运行 tree-sitter 解析器；从各语言 Grammar WASM 包（`tree-sitter-javascript`、`tree-sitter-typescript`、`tree-sitter-python` 等，MIT/Apache-2.0）中提取 AST、函数/类边界、def/ref 符号 |
| **许可证** | MIT（主库）；各 Grammar 包独立许可证，主流均 MIT/Apache-2.0 |

**集成成本量级**：拿来即用（npm install + 加载 WASM Grammar 文件，10 行初始化）。

**成熟度**：生产可用。Neovim、Helix、VSCode、Cursor、Cline、opencode 均在生产中使用。`web-tree-sitter` 的 WASM 构建稳定，Bun 下也能正常运行。

**最小自研接缝**：仅需编写一个`TagExtractor`（遍历 AST、按语言规则收集 definition tag 与 reference tag），约 100–200 行 TS。

**推迟自研**：多语言 Grammar 的精细调优（私有名称过滤规则、每种语言的 def/ref query 调整）等细节，MVP 阶段用现成 query 文件（aider 的 `queries/` 目录可参考，Apache-2.0 可复用设计思路，但因 Python/TS 语言差异需翻写为 TS）。

---

## 2. RepoMap — 代码库地图

### 直接采用的现成方案

**首选**：自行移植 aider 的 repomap 算法到 TS，借助以下现成库完成：

| 属性 | 内容 |
|---|---|
| **图计算** | `graphology` (npm) + `graphology-metrics`/`graphology-generators` — MIT |
| **PageRank** | `graphology-algorithms` 中的 `pagerank` 实现 — MIT；或 `pagerank-algorithm`（npm，MIT） |
| **tag 缓存** | 任何 SQLite 库（见 git 节）；key = filepath + mtime |
| **算法来源** | aider `repomap.py`（Apache-2.0）— **不能直接搬 Python 代码，但算法逻辑（MultiDiGraph + Personalized PageRank + 二分搜索裁剪）属于思路借鉴** |

**备选/参考（仅借设计，不直接用代码）**：
- `RepoMapper`（https://github.com/pdavis68/RepoMapper）— 同为 aider 算法的社区移植，MIT，但为 CLI 工具而非库，不直接安装使用
- `cocoindex realtime-codebase-indexing`（Apache-2.0）— 提供增量更新思路

**有无"拿来即用"的 npm 包**：目前没有一个可直接安装、API 稳定的 JS/TS RepoMap 库。**这是本子系统唯一需要"薄自研"的核心算法件**，但依赖全部现成（tree-sitter + graphology + pagerank）。

**集成成本量级**：需较多缝合——tree-sitter 提取 tags → graphology 建图 → pagerank 排序 → 二分搜索裁剪，约 400–600 行 TS，逻辑参考 aider `repomap.py`（Apache-2.0 算法思路可借鉴，代码须自写）。

**成熟度**：算法本身生产可用（aider 在生产中运行多年）；TS 移植属新实现，需自测。graphology 本身生产可用。

**最小自研接缝**：
- `RepoMapBuilder`：接受 TagExtractor 输出，建 graphology MultiDiGraph，跑 pagerank，按 token 预算二分裁剪后输出 Markdown 符号摘要
- 个性化向量权重（chat 文件 ×50、mentioned ident ×10、私有名 ×0.1）直接复刻 aider 逻辑

**推迟自研**：多 token 预算策略的细粒度调优；embedding 语义层叠加（MVP 不需要）。

---

## 3. 编辑/diff 格式 — 文件修改引擎

### 直接采用的现成方案

**主格式（SEARCH/REPLACE Block）**：

| 属性 | 内容 |
|---|---|
| **解析实现来源** | aider `editblock_coder.py`（Apache-2.0）— **算法可借鉴，需自写 TS** |
| **fuzzy 匹配辅助** | `diff-match-patch`（npm，Apache-2.0）或 `fast-fuzzy`（MIT）— 用于 SEARCH 块的容错对齐 |
| **diff 展示** | `diff`（npm，BSD-3-Clause）— 生成可读 unified diff 供 UI 展示 |

**备用格式（apply_patch / OpenAI-style patch）**：

| 属性 | 内容 |
|---|---|
| **Cline 的 apply_patch 工具** | Cline `apply_patch`（Apache-2.0）— TS 实现，**可直接复用代码**（Apache-2.0 允许，需保留许可声明）；路径：`cline/apps/vscode/src/core/task/tools/handlers/` |
| **opencode 的 apply-patch 工具** | opencode `packages/core/src/tool/` 下的 apply-patch（MIT）— **可直接复用** |

**坑警告**：Codex 的 `apply_patch` 有自定义 `.lark` 语法（非标准 unified diff），**不可直接用，只借思路**。

**集成成本量级**：
- SEARCH/REPLACE 解析器：轻度封装（200 行 TS，参考 aider 逻辑自写）
- apply_patch：从 Cline/opencode 直接复用，拿来即用

**成熟度**：SEARCH/REPLACE 格式生产可用（Aider 默认格式，业界验证）；apply_patch 两个 TS 实现均来自活跃维护项目。

**最小自研接缝**：
- `EditBlockParser`：解析 LLM 输出的 `<<<<<<< SEARCH / >>>>>>> REPLACE` 块，带容错（允许轻微缩进偏差、trim 空白行）
- `EditGuard`：行数验证 + 省略号检测（防止 LLM 用 `...` 偷懒）+ 连续错误计数器
- SEARCH 块精确匹配 → 失败时 fuzzy 降级（用 `diff-match-patch`）

**推迟自研**：Script Generation（sed 脚本）格式（大文件 ≥10 处修改时用，MVP 阶段不需要）；whole-file 替换格式优化。

---

## 4. LSP 客户端

### 直接采用的现成方案

| 属性 | 内容 |
|---|---|
| **库** | `vscode-languageclient`（npm，MIT）—— VSCode 生态的成熟 LSP 客户端 |
| **或** | `@volar/language-server` / `volar-language-tools`（MIT）—— TS/Vue 特化但更现代 |
| **或（更薄）** | `vscode-languageserver-protocol`（npm，MIT）—— 仅协议类型定义，自己管连接，适合 headless 使用 |
| **Language Server 本体** | `typescript-language-server`（MIT）针对 TS/JS；`pyright`（MIT）针对 Python；`rust-analyzer`（MIT/Apache-2.0）针对 Rust |

**opencode 的 LSP 集成**（MIT，**可直接借鉴 TS 代码**）：V2 中 LSP 配置 schema 和诊断集成已写出骨架（`packages/core/src/lsp/`），正在补齐，是最贴近本项目技术栈（Bun + TS）的参考。

**LSAP（Language Server Agent Protocol）**（https://github.com/lsp-client/LSAP）— v0.2.0，早期活跃开发，**不推荐 MVP 使用**，仅跟踪。

**集成成本量级**：轻度封装——启动 language server 进程、建立 stdio/IPC 通道、发送 `initialize` + `textDocument/didOpen`，然后调 `textDocument/definition`、`textDocument/diagnostic`、`textDocument/documentSymbol`。约 300 行 TS 封装层。

**成熟度**：`vscode-languageclient` 生产可用（VSCode 自身使用）；`vscode-languageserver-protocol` 仅类型，极稳定。Language Server 本体各自独立维护，均生产可用。

**坑**：`vscode-languageclient` 内部有对 `vscode` 模块的软依赖，在 headless（非 VSCode 扩展）使用时需用 `vscode-languageclient/node` 子路径并绕过 activation 逻辑，有一定踩坑成本（约 1–2 天）。更简单的方案是直接用 `vscode-languageserver-protocol` + 手动管理 JSON-RPC 连接（用 `vscode-jsonrpc`，MIT）。

**最小自研接缝**：
- `LspManager`：管理多个 language server 进程的生命周期（按工作区按语言懒启动、健康检查）
- `AgentLspClient`：将 LSP 原子操作（`goToDefinition`、`getDiagnostics`、`findReferences`）封装为 Agent 友好的 TS 函数，返回结构化数据而非原始 LSP response

**推迟自研**：全面的多语言 LSP 路由（MVP 只支持 TS/JS + Python 即可）；LSAP 协议层（等协议成熟后再评估）。

---

## 5. shadow-git 检查点

### 直接采用的现成方案

| 属性 | 内容 |
|---|---|
| **git 操作库** | `simple-git`（npm，MIT）—— 成熟的 Node.js git 封装，Cline 在生产中使用 |
| **或** | `isomorphic-git`（npm，MIT）—— 纯 JS 实现，无 git 二进制依赖，支持浏览器，但功能比 simple-git 少 |

**Cline 的 CheckpointTracker**（Apache-2.0，路径 `cline/apps/vscode/src/integrations/checkpoints/CheckpointTracker.ts`）— **可直接借鉴逻辑，部分代码可复用**（需剥离 VSCode API 依赖）。核心思路：在工作区外用哈希路径维护独立的 shadow git 仓库，每次工具调用前后 commit 快照，支持 diff 对比与 restore。

**集成成本量级**：轻度封装（以 `simple-git` 为底层，封装 shadow-git 初始化 + checkpoint commit + restore + diff 接口，约 200–300 行 TS，参考 Cline 实现）。

**成熟度**：`simple-git` 生产可用（周下载量 800 万+）；shadow git 模式经 Cline 生产验证。`isomorphic-git` 生产可用但性能较慢、部分高级 git 功能缺失，**MVP 优先用 `simple-git`**。

**坑**：`simple-git` 依赖系统 git 二进制，部署时需确保 git 可用；shadow git 仓库路径需用工作区路径哈希确定，防止多工作区冲突（参考 Cline 实现）。

**最小自研接缝**：
- `CheckpointTracker`（剥离 VSCode 依赖后的纯 TS 版本）：
  - `init(workspacePath)`：初始化 shadow git 仓库
  - `checkpoint(label)`：将当前工作区文件快照提交
  - `restore(commitHash)`：恢复到某检查点（文件 + 对话历史截断联动）
  - `diff(fromHash, toHash)`：生成两检查点间的差异

**推迟自研**：多根工作区（MultiRoot）支持；与 ContextManager 对话历史的 O(log n) 二分截断联动（MVP 阶段可先用简单线性查找）。

---

## 6. PTY（伪终端）

### 直接采用的现成方案

| 属性 | 内容 |
|---|---|
| **库** | `node-pty`（npm，MIT）—— 业界标准，VSCode Terminal、Cline、opencode 均在生产中使用 |
| **来源** | https://github.com/microsoft/node-pty — Microsoft 维护，MIT |
| **提供什么** | 在 Node/Bun 中创建真正的 PTY（macOS/Linux `posix_openpt`，Windows ConPTY），支持流式读写、resize、kill |

**集成成本量级**：拿来即用（`node-pty` 文档完整，10 行初始化）。

**成熟度**：生产可用。VSCode 内置终端的底层实现。Bun 下已有社区验证可用。

**坑**：`node-pty` 是原生 N-API 模块，需要在目标平台编译（`node-gyp`）；若用 Bun，需确认 N-API 兼容性（Bun 已支持大部分 N-API，node-pty 在 Bun 下可用但偶有版本适配问题，建议锁定已验证版本）。Docker 镜像需包含编译工具链。

**最小自研接缝**：
- `PtyManager`：封装 PTY 的生命周期（创建、输出流转 WebSocket/SSE、stdin 写入、resize、超时 kill）
- 输出截断与内存安全上限（参考 opencode 的 bash 工具，输出超 1MB 写文件、模型只见预览）

**推迟自研**：PTY 录制/回放（session replay）；多 PTY 复用（tmux-like 会话管理）。

---

## 7. git 操作（常规 git 集成）

### 直接采用的现成方案

| 属性 | 内容 |
|---|---|
| **库** | `simple-git`（npm，MIT）—— 与 shadow-git 节复用同一依赖 |
| **来源** | https://github.com/steveukx/git-js — MIT，周下载量 800 万+ |
| **提供什么** | 封装 git CLI 全部常用操作：`status`、`diff`、`add`、`commit`、`log`、`stash`、`branch`、`push`/`pull`、`show` 等，Promisified API，TypeScript 类型完整 |

**集成成本量级**：拿来即用（API 语义与 git CLI 一一对应）。

**成熟度**：生产可用，维护活跃，是 Node.js 生态 git 操作的事实标准。

**最小自研接缝**：
- `GitService`：将 simple-git 操作封装为 Agent 工具接口（`getStatus()`、`commitChanges(message)`、`generateCommitMessage(diff)` 等）
- AI 生成 commit message：直接调用 LLM，传入 `diff` 内容，约 20 行逻辑（参考 aider `repo.py` 中的思路，Apache-2.0）

**推迟自研**：git worktree 并行开发支持（MVP 不需要）；复杂的 merge conflict 自动解决。

---

## 许可证合规总结

| 参考来源 | 许可证 | 代码复用状态 |
|---|---|---|
| aider（`repomap.py`、`editblock_coder.py`） | Apache-2.0 | **仅借算法思路，须自写 TS**（Python→TS 语言差异太大，不存在逐行搬运） |
| Cline（`CheckpointTracker.ts`、`apply_patch`） | Apache-2.0 | **可复用逻辑**，需剥离 VSCode 特定 API，保留许可声明 |
| opencode（`apply-patch`、LSP 骨架） | MIT | **可直接复用**，保留 copyright 声明即可 |
| node-pty、simple-git、web-tree-sitter、graphology | MIT | **直接安装使用** |
| vscode-languageserver-protocol | MIT | **直接安装使用** |

---

## MVP 最小依赖集（阶段一：Web + 写代码）

以下是真正需要安装的 npm 包，覆盖"Web 单端 + 写代码单能力"所需：

```
# 核心功能依赖
web-tree-sitter              # AST 解析 → RepoMap 的 tag 提取
tree-sitter-typescript       # TS/JS Grammar
tree-sitter-python           # Python Grammar（可选，按目标语言加）

graphology                   # 图数据结构 → RepoMap 的 PageRank 图
graphology-library           # 包含 pagerank 算法实现

diff-match-patch             # SEARCH/REPLACE 容错 fuzzy 匹配
diff                         # unified diff 生成（UI 展示用）

simple-git                   # git 操作 + shadow-git 检查点

node-pty                     # PTY 交互式终端执行

vscode-languageserver-protocol  # LSP 协议类型（headless LSP 客户端）
vscode-jsonrpc               # LSP JSON-RPC 连接管理
```

**阶段一暂不引入**（可推迟）：
- LSAP（协议不稳定，等 v1.0）
- `isomorphic-git`（simple-git 已够用，浏览器端沙箱走 E2B，无需浏览器原生 git）
- 向量/embedding 库（RepoMap MVP 阶段 PageRank 已足够，语义检索推迟）
- graphology 只需 `graphology` + pagerank，无需整个 `graphology-library` 全集

**阶段一自研接缝清单**（薄、有界）：

| 接缝 | 行数估计 | 依赖 |
|---|---|---|
| `TagExtractor`（tree-sitter → def/ref tags） | ~150 行 | web-tree-sitter |
| `RepoMapBuilder`（tags → PageRank → Markdown） | ~400 行 | graphology + pagerank |
| `EditBlockParser`（SEARCH/REPLACE 解析 + fuzzy） | ~200 行 | diff-match-patch |
| `EditGuard`（行数验证 + 省略号检测） | ~80 行 | — |
| `CheckpointTracker`（shadow-git 快照） | ~250 行 | simple-git |
| `AgentLspClient`（LSP 工具封装） | ~300 行 | vscode-jsonrpc + protocol |
| `PtyManager`（PTY 生命周期 + 输出截断） | ~150 行 | node-pty |
| `GitService`（git 工具 + AI commit msg） | ~100 行 | simple-git |

**总自研量约 1600 行，全部为"薄接缝"而非轮子**，核心算法（图计算、AST 解析、diff 应用、PTY、git）均由现成库承载。