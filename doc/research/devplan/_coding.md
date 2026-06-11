I now have all the load-bearing source: aider's exact pagerank weights (×50 chat-referencer, ×10 mentioned/long-identifier, ×0.1 private-`_`/over-defined), the binary-search token-budget loop (`middle = max_map_tokens // 25`, 0.15 tolerance), the SEARCH/REPLACE parser regex (`HEAD/DIVIDER/UPDATED`, 5-9 chars), the fuzzy fallback ladder (perfect → whitespace-flex → dotdotdots → edit-distance 0.8), and cline's shadow-git mechanics (`core.worktree` config, nested-git disable suffix, `--allow-empty --no-verify`, hard-reset restore, `getDiffSet`).

I have everything needed to write the detailed design. This is the central synthesis deliverable — I'll produce it directly as my final output.

# 编码能力链详细设计（arclightagent 阶段一 Web + 写代码 MVP）

> 口径声明：与 5 份文档严格一致。沙箱=nono（`P0-沙箱方案`）；契约/数据模型=`P0-基础三件套`；选型/许可证/自研量=`拿来即用清单`。编码能力件总自研**实评 2000-2800 行**（清单 §2.6/§5.1 #12），其中 `AgentLspClient ~300` + RRF 向量链已推迟阶段二，本设计不含。MVP 自研整体 6000-9000+ 行，主循环与前端是真工程；本文件只覆盖编码 4 件，是其中的 2000-2800 行子集。所有 Python(aider)/VSCode(cline) 来源**仅借算法/机制，TS 重写**，Apache-2.0 落 NOTICE。

四件统一接入 `P0-基础三件套` 的 `Tool<In,Out>` 契约、`ToolContext`、`ToolErrorEnvelope`（5 键）、`SandboxService`、`artifacts` 落盘、`checkpoints` 表、`ArcEvent` 流。包结构 `packages/core/src/coding/{repomap,edit,checkpoint,exec}/`。

---

## 一、总览：四件 × 数据流 × MVP 切片

```
用户 submit ──▶ queryLoop(turn) ──▶ AI SDK streamText
                       │
        ┌──────────────┼───────────────────────────────┐
   ① RepoMap        ② Edit                         ④ bash/PTY
  (上下文注入)   (SEARCH/REPLACE→apply)        (SandboxService=nono)
        │              │                               │
        │      ③ CheckpointTracker.commit(前)   反射闭环 edit→lint/test
        │              │  edit 写盘                     │ 读失败→自校正
        │      ③ CheckpointTracker.commit(后)    max_reflections(默=3)
        └──────────────┴───────────────────────────────┘
                     events 落库 + SSE
```

**与 `P0` 落地顺序(§“P0 最小可跑切片”)对齐的编码件切片**：

| 切片 | 内容 | 对应 P0 步骤 | 依赖库 |
|---|---|---|---|
| **S1（先做）** | `apply_patch`/`write_file` 走 **SEARCH/REPLACE 逐字解析**(②无 fuzzy) + `bash`(④nono) | P0 步骤 5-7 | diff-match-patch(暂不启用)、node-pty/nono |
| **S2** | ② 加 **EditGuard**(行数/省略号) + **diff-match-patch fuzzy 回退** + apply_patch 兼容 | — | diff-match-patch、diff |
| **S3** | ③ **shadow-git CheckpointTracker** 执行前后快照 + `/undo` | P0 步骤 9 | simple-git |
| **S4** | ① **RepoMap**(tree-sitter→graphology pagerank→二分裁剪→diskcache) | （P0 步骤 5 之上的上下文增强） | web-tree-sitter、tree-sitter-typescript、graphology |
| **S5** | ④ **反射闭环**(edit→lint/test→读失败→自校正) 接进 `queryLoop` | P0 步骤 10(eval 同链路) | （复用③④） |

> 切片理由（清单 §5.1）：SEARCH/REPLACE+bash 是闭环最小核，能跑 eval；RepoMap/检查点是“上下文质量/安全网”，可后置而不阻塞主链路。

---

## 二、① RepoMap

**目标**：在有限 token 内把最相关的代码库符号送给 LLM。算法借 aider `repomap.py`（Apache-2.0，Python→TS 重写，落 NOTICE）。

### 2.1 流水线（与 aider 逐段对应）
```
源文件 ──web-tree-sitter──▶ Tag{kind:def|ref, name, line} ──▶ graphology MultiDiGraph
  └ mtime+sha 命中 diskcache 跳过解析       (def→defines, ref→references)
                                                      │
              personalization(chat=1×, mentioned=1×) + 边权 mul ──▶ pagerank
                                                      │
              rank 分摊到 def → ranked_tags(按 rank 降序) ──▶ 二分裁剪到 token 预算
```

### 2.2 关键算法常量（**逐字对齐 aider，不可改**）

边权乘数 `mul`（`get_ranked_tags` L487-514）：
- `ident ∈ mentioned_idents` → `×10`
- 长标识符(snake/kebab/camel 且 `len≥8`) → `×10`
- `ident.startsWith("_")`（私有名）→ `×0.1`
- `defines[ident] > 5`（过度定义/噪声符号）→ `×0.1`
- **referencer 是 chat 文件** → `use_mul ×= 50`
- `num_refs → sqrt(num_refs)`（高频引用降权，防主导）
- 无 ref 的 def 加自环边 `weight=0.1`（L475-479，修 tree-sitter def≠ref 漏算）

personalization（L383, 421-445）：`personalize = 100 / num_files`；chat 文件 `+personalize`；mentioned 文件 `max(cur, personalize)`；路径分量命中 mentioned_idents 再 `+personalize`。pagerank 传 `personalization=dangling=该向量`。

> 任务描述里的“chat×50/mentioned×10/私有名×0.1”即此三档，确认与 aider 一致。

### 2.3 TS 骨架

```ts
// packages/core/src/coding/repomap/types.ts
export type Tag = { relFname: string; fname: string; name: string; kind: "def"|"ref"; line: number };

// packages/core/src/coding/repomap/tag-extractor.ts  —— ~150 行(清单 §5 #12)
import Parser, { Language, Query } from "web-tree-sitter";
export class TagExtractor {
  private parsers = new Map<string, Parser>();         // lang -> Parser
  private queries = new Map<string, Query>();           // lang -> tags.scm Query
  private ready = false;

  // 坑①: WASM 必须一次性 init,再逐 grammar load
  async init() {
    await Parser.init();                                // 全局一次(Bun: locateFile 指向 node_modules)
    await this.loadGrammar("typescript", tsWasmPath, tsTagsScm);
    this.ready = true;
  }
  private async loadGrammar(lang: string, wasm: string, scm: string) {
    const language = await Language.load(wasm);         // 坑②: 每 grammar 独立 Language.load
    const p = new Parser(); p.setLanguage(language);
    this.parsers.set(lang, p);
    this.queries.set(lang, new Query(language, scm));   // tags.scm: name.definition.* / name.reference.*
  }
  extract(code: string, lang: string, relFname: string, fname: string): Tag[] {
    const p = this.parsers.get(lang); const q = this.queries.get(lang);
    if (!p || !q) return [];
    const tree = p.parse(code);
    const tags: Tag[] = [];
    for (const { name: capName, node } of q.captures(tree.rootNode)) {
      const kind = capName.startsWith("name.definition.") ? "def"
                 : capName.startsWith("name.reference.")  ? "ref" : null;
      if (!kind) continue;
      tags.push({ relFname, fname, name: node.text, kind, line: node.startPosition.row });
    }
    tree.delete();                                       // 坑③: 必须手动 delete,WASM 无 GC
    return tags;
  }
}
```

```ts
// packages/core/src/coding/repomap/cache.ts  —— mtime diskcache
// MVP: bun:sqlite 单表 tags_cache(fname PK, mtime, sha256, data JSON)。比 aider diskcache 更贴本仓栈。
export class TagCache {
  constructor(private db: Database) {/* CREATE TABLE IF NOT EXISTS ... */}
  get(fname: string, mtime: number): Tag[] | null {
    const row = this.db.query("SELECT mtime,data FROM tags_cache WHERE fname=?").get(fname) as any;
    return row && row.mtime === mtime ? JSON.parse(row.data) : null;   // mtime 不变即命中
  }
  set(fname: string, mtime: number, sha: string, data: Tag[]) {
    this.db.run("INSERT OR REPLACE INTO tags_cache(fname,mtime,sha256,data) VALUES(?,?,?,?)",
      [fname, mtime, sha, JSON.stringify(data)]);
  }
}
```

```ts
// packages/core/src/coding/repomap/builder.ts  —— ~250 行(图+pagerank+二分)
import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";

export class RepoMapBuilder {
  constructor(private extractor: TagExtractor, private cache: TagCache,
              private countTokens: (s: string) => number) {}

  async build(opts: {
    chatFiles: string[]; otherFiles: string[];
    mentionedFnames?: Set<string>; mentionedIdents?: Set<string>;
    maxMapTokens: number;                    // 默 1024; 无 chat 文件时 ×8 放大(map_mul_no_files)
  }): Promise<string> {
    const { defines, references, definitions, personalization, chatRel } =
      await this.collect(opts);              // ←§2.2 权重在 buildGraph 内
    const ranked = this.rankTags(defines, references, definitions, personalization,
                                 chatRel, opts.mentionedIdents ?? new Set());
    return this.binarySearchTree(ranked, opts.maxMapTokens, chatRel);   // §2.4
  }

  private rankTags(/*...*/): RankedTag[] {
    const G = new Graph({ type: "directed", multi: true, allowSelfLoops: true });
    // 1) 无 ref 的 def 自环 weight=0.1
    // 2) 对 idents=defines∩references 加边: mul 规则(§2.2) + chat referencer ×50 + sqrt(numRefs)
    G.forEachNode(n => {/* ensure */});
    const ranks = pagerank(G, { getEdgeWeight: "weight" /*, 注入 personalization 向量*/ });
    // 3) rank 按 out-edge weight 占比分摊到 (dst,ident) → ranked_definitions 降序
    // 4) chat 文件的 def 跳过(已在上下文); 拼接无 tag 的 other 文件兜底
    return /* sorted */;
  }
}
```

### 2.4 token 预算二分裁剪（aider L666-706，逐字对齐）

```ts
private binarySearchTree(ranked: RankedTag[], maxTokens: number, chatRel: Set<string>): string {
  let lo = 0, hi = ranked.length, best = "", bestTokens = 0;
  let mid = Math.min(Math.floor(maxTokens / 25), ranked.length);   // 起点: 经验 25 tok/tag
  while (lo <= hi) {
    const tree = this.toTree(ranked.slice(0, mid), chatRel);        // tree-sitter 上下文渲染
    const n = this.countTokens(tree);
    const pctErr = Math.abs(n - maxTokens) / maxTokens;
    if ((n <= maxTokens && n > bestTokens) || pctErr < 0.15) {      // 0.15 容差
      best = tree; bestTokens = n;
      if (pctErr < 0.15) break;                                     // 够近即停
    }
    if (n < maxTokens) lo = mid + 1; else hi = mid - 1;
    mid = Math.floor((lo + hi) / 2);
  }
  return best;
}
```

### 2.5 关键坑
- **tree-sitter WASM 初始化**：`Parser.init()` 全局**仅一次**；Bun 下 `locateFile` 须显式指回 `node_modules/web-tree-sitter/tree-sitter.wasm`，否则 fetch 失败。
- **多 grammar 加载**：每语言独立 `Language.load(wasm)` + 独立 `Query`；MVP 只装 `tree-sitter-typescript`（含 TS+TSX），Python 阶段二。
- **WASM 无 GC**：`tree.delete()` 必调，长会话否则内存泄漏。
- **tags.scm 来源**：直接复用 aider `queries/tree-sitter-language-pack/typescript-tags.scm`（MIT 同源 nvim-treesitter，落声明），避免自写 query。
- **缓存失效**：`mtime` 为主键命中条件；`sha256` 仅审计/防 mtime 抖动误判，不参与命中（贴 aider）。
- **诚实风险（清单 §2.6）**：pagerank 调参/二分裁剪/缓存失效是“移植新实现需自测”，非零成本，已计入 2000-2800。

---

## 三、② 编辑格式（SEARCH/REPLACE + EditGuard + apply_patch + fuzzy 回退）

**目标**：高精度文件编辑。借 aider `editblock_coder.py`（Apache-2.0）解析+fuzzy，借 opencode/cline `apply_patch`（MIT/Apache-2.0）兼容格式。

### 3.1 解析（逐字对齐 aider 正则）

```ts
// packages/core/src/coding/edit/parser.ts  —— EditBlockParser
const HEAD    = /^<{5,9} SEARCH>?\s*$/;     // 5-9 个 '<' 容错
const DIVIDER = /^={5,9}\s*$/;
const UPDATED = /^>{5,9} REPLACE\s*$/;

export type EditBlock = { path: string; search: string; replace: string };

export function parseEditBlocks(content: string, validFnames: string[]): EditBlock[] {
  const lines = content.split(/(?<=\n)/);   // keepends
  const out: EditBlock[] = []; let cur: string | null = null; let i = 0;
  while (i < lines.length) {
    if (HEAD.test(lines[i].trim())) {
      // 新建文件: HEAD 下一行即 DIVIDER → 不校验 validFnames(aider L490)
      const newFile = DIVIDER.test((lines[i+1] ?? "").trim());
      const path = findFilename(lines.slice(Math.max(0,i-3), i), newFile ? [] : validFnames) ?? cur;
      if (!path) throw editErr("Bad/missing filename", lines, i);   // 5键 envelope: VALIDATION
      cur = path;
      const search: string[] = [];
      i++; while (i < lines.length && !DIVIDER.test(lines[i].trim())) search.push(lines[i++]);
      if (!DIVIDER.test((lines[i] ?? "").trim())) throw editErr("Expected =======", lines, i);
      const replace: string[] = [];
      i++; while (i < lines.length && !(UPDATED.test(lines[i].trim()) || DIVIDER.test(lines[i].trim())))
        replace.push(lines[i++]);
      if (!(UPDATED.test((lines[i] ?? "").trim()) || DIVIDER.test((lines[i] ?? "").trim())))
        throw editErr("Expected >>>>>>> REPLACE", lines, i);
      out.push({ path, search: search.join(""), replace: replace.join("") });
    }
    i++;
  }
  return out;
}
// findFilename: 回看 3 行,fence/反引号剥离,validFnames 精确→basename→fuzzy(cutoff 0.8)→含'.'兜底 (aider L538-599)
```

### 3.2 EditGuard（行数验证 + 省略号检测）—— 自研接缝

```ts
// packages/core/src/coding/edit/guard.ts  —— ~80 行(EditBlockParser+EditGuard 合计 ~280, §5 #12)
export class EditGuard {
  check(b: EditBlock): { ok: true } | { ok: false; reason: string } {
    // 省略号检测: 防 LLM 用 '...' 偷懒省略代码却未配对(aider try_dotdotdots 要求 part/replace 的 ... 配对)
    const sDots = countDotLines(b.search), rDots = countDotLines(b.replace);
    if (sDots !== rDots) return { ok: false, reason: "Unpaired ... in SEARCH/REPLACE block" };
    // 行数验证: search 非空但被截断的启发(末行无换行 + 含 '...' 注释行) → 提示重发完整块
    if (b.search.trim() && hasTruncationMarker(b.replace))
      return { ok: false, reason: "REPLACE seems truncated (placeholder comment detected); resend full block" };
    return { ok: true };
  }
}
const DOT = /^\s*\.\.\.\s*$/m;
```

### 3.3 应用 + fuzzy 回退阶梯（aider `replace_most_similar_chunk`）

```ts
// packages/core/src/coding/edit/apply.ts
import { diff_match_patch } from "diff-match-patch";

export function applyEdit(content: string, search: string, replace: string): string | null {
  if (!search.trim()) return content + replace;            // 空 search = 追加/新建(do_replace)
  // 阶梯 1: 逐字完美匹配
  let r = perfectReplace(content, search, replace); if (r != null) return r;
  // 阶梯 2: 容忍前导空白(LLM 常统一缩进偏移)
  r = replaceWithMissingLeadingWs(content, search, replace); if (r != null) return r;
  // 阶梯 3: 处理 '...' 省略块(配对的逐段 replace)
  try { r = tryDotDotDots(content, search, replace); if (r != null) return r; } catch {/* 落 fuzzy */}
  // 阶梯 4(S2 才启用): diff-match-patch fuzzy 回退 —— aider 的 edit-distance 0.8 等价
  return fuzzyApply(content, search, replace);
}

function fuzzyApply(content: string, search: string, replace: string): string | null {
  const dmp = new diff_match_patch();
  dmp.Match_Threshold = 0.2;            // ≈ aider similarity_thresh 0.8 的反向阈
  dmp.Match_Distance = 1000;
  const loc = dmp.match_main(content, search, 0);
  if (loc === -1) return null;          // 失败 → 返回 null,上层进反射(§5)而非乱改
  // 在 loc 处构造 patch 应用 replace
  const patch = dmp.patch_make(content.slice(loc, loc + search.length), replace);
  const [out, results] = dmp.patch_apply(patch, content);
  return results.every(Boolean) ? out : null;
}
```

> aider 当前默认**关闭** edit-distance fuzzy（`replace_most_similar_chunk` L183 `return` 提前返回，L184 之后是死代码）。故 MVP **S1 也只跑阶梯 1-3**（逐字+空白+省略号），fuzzy(阶梯4)作为 **S2 显式 opt-in 回退**，与“先 SEARCH/REPLACE 逐字”切片一致，避免引入 fuzzy 误改风险。

### 3.4 apply_patch 兼容
opencode/cline 的 `apply_patch`（`*** Begin Patch / *** Update File / @@`）作为**第二解析器**：`detectFormat(content)` 路由到 `parseApplyPatch()` 或 `parseEditBlocks()`，两者都产出 `EditBlock[]` 走同一 `applyEdit`。MVP 内置工具 `apply_patch`（`P0` C 节最小集）默认用 SEARCH/REPLACE，apply_patch 格式兼容仅作 LLM 输出该格式时的降级解析。

### 3.5 关键坑
- 失败必须抛 `ToolErrorEnvelope`（`error_class:"VALIDATION"`, `retry_allowed:true`），`user_message` 含 `find_similar_lines`（threshold 0.6）的“Did you mean”提示，喂给反射循环——**绝不静默乱改**。
- `strip_quoted_wrapping`：剥 LLM 误加的文件名行/三反引号包裹（aider L335）。
- fuzzy 是**回退**不是主路；阈值过松会改错位置，故默认关，S2 才开且 `patch_apply` 全 true 才接受。

---

## 四、③ shadow-git 检查点

**目标**：工作区外独立 shadow 仓，执行前后快照，`/undo` 回任意时刻。借 cline `CheckpointTracker`/`CheckpointGitOperations`（Apache-2.0），**剥 VSCode 依赖**，落 NOTICE。接 `P0` `checkpoints` 表(`backend:"shadow-git"`, `ref`=sha, `changedFiles`)。

### 4.1 剥 VSCode 的替换清单（cline → arclight）

| cline 依赖 | 剥除后替换 |
|---|---|
| `vscode.workspace` 找 cwd | `ToolContext.cwd`/`workspace.repoPath`（来自 `P0` 数据模型） |
| `globby` 扫 `**/.git`（VSCode workspace API） | `Bun.Glob("**/.git")` 或 `fast-glob`（已在栈） |
| `sendCheckpointEvent`（gRPC-over-postMessage） | `ctx.emit(ArcEvent)` → `checkpoint.created/restored`（`P0` 事件流） |
| `telemetryService` / `Logger` | `pino`（`P0` 唯一可观测） |
| 全局 folder lock（多 VSCode 实例） | MVP 单进程：`P0` “同 session 同时一个 active turn” 已串行写，**lock 可省**；保留接口占位 |
| `getShadowGitPath` 在 `~/.cline` | `${workspace.arclightDir}/checkpoints/<cwdHash>.git`（`.arclight/`，`P0` 拓扑） |

### 4.2 TS 骨架（核心机制逐条对齐 cline）

```ts
// packages/core/src/coding/checkpoint/git-operations.ts  —— 借 CheckpointGitOperations
import simpleGit, { SimpleGit } from "simple-git";
const GIT_DISABLED_SUFFIX = "_disabled";

export class ShadowGitOps {
  constructor(private cwd: string, private shadowDir: string) {}

  async initShadowGit(): Promise<string> {
    const gitPath = path.join(this.shadowDir, ".git");
    if (await exists(gitPath)) {                          // 已存在: 仅校验 worktree
      const g = simpleGit(this.shadowDir);
      const wt = (await g.getConfig("core.worktree")).value;
      if (wt !== this.cwd) throw new Error("Checkpoints bound to different workspace: " + wt);
      return gitPath;
    }
    const g = simpleGit(this.shadowDir);
    await g.init();
    await g.addConfig("core.worktree", this.cwd);         // 核心: shadow 仓 worktree 指向真实工作区
    await g.addConfig("commit.gpgSign", "false");
    await g.addConfig("user.name", "Arclight Checkpoint");
    await g.addConfig("user.email", "checkpoint@arclight.local");
    await this.writeExcludes(gitPath);                    // .git/info/exclude: node_modules/.arclight/secrets 等
    await this.addAll(g);
    await g.commit("initial commit", { "--allow-empty": null, "--no-verify": null });
    return gitPath;
  }

  // 关键机制: 嵌套 .git 临时禁用(git 不能 add 子仓,否则当 submodule)
  async addAll(g: SimpleGit) {
    await this.renameNestedGitRepos(true);                // **/.git → **/.git_disabled
    try { await g.add([".", "--ignore-errors"]); }
    finally { await retry(() => this.renameNestedGitRepos(false)); }   // 必复原,3 次重试
  }
  private async renameNestedGitRepos(disable: boolean) {
    const glob = new Bun.Glob("**/.git" + (disable ? "" : GIT_DISABLED_SUFFIX));
    for await (const p of glob.scan({ cwd: this.cwd, onlyFiles: false, dot: true })) {
      if (p === ".git" || p.includes("node_modules/")) continue;       // 跳根仓+node_modules(防10s+扫描)
      await fs.rename(path.join(this.cwd, p),
        disable ? path.join(this.cwd, p + GIT_DISABLED_SUFFIX)
                : path.join(this.cwd, p.slice(0, -GIT_DISABLED_SUFFIX.length)));
    }
  }
}
```

```ts
// packages/core/src/coding/checkpoint/tracker.ts  —— 借 CheckpointTracker, ~250 行(§5 #12)
export class CheckpointTracker {
  constructor(private ops: ShadowGitOps, private cwdHash: string,
              private db: Database, private ctx: ToolContext) {}

  async commit(label?: string): Promise<string> {        // 执行前后各调一次
    const g = simpleGit(this.ops.shadowDir);
    await this.ops.addAll(g);
    const r = await g.commit(`checkpoint-${this.cwdHash}-${this.ctx.sessionId}`,
      { "--allow-empty": null, "--no-verify": null });
    const sha = r.commit.replace(/^HEAD\s+/, "");
    // 落 P0 checkpoints 表
    this.db.run(`INSERT INTO checkpoints(id,tenant_id,workspace_id,session_id,turn_id,backend,ref,label,changed_files,created_at)
                 VALUES(?,?,?,?,?,'shadow-git',?,?,?,?)`, [/* ... */ sha, label]);
    await this.ctx.emit({ t: "checkpoint.created", ref: sha, label } as any);
    return sha;
  }

  async resetHead(sha: string): Promise<void> {          // /undo 回任意时刻
    const g = simpleGit(this.ops.shadowDir);
    await g.reset(["--hard", sha.replace(/^HEAD\s+/, "")]);   // 硬重置,worktree 指真实工作区→直接还原文件
    await this.ctx.emit({ t: "checkpoint.restored", ref: sha } as any);
  }

  // O(log n) 回任意时刻: checkpoints 按 created_at 排序,/undo N 步即二分定位 sha 后 resetHead
  async diffSet(lhs: string, rhs?: string): Promise<FileChange[]> {
    const g = simpleGit(this.ops.shadowDir);
    await this.ops.addAll(g);                             // stage 让未跟踪文件进 diff
    const range = rhs ? `${lhs}..${rhs}` : lhs;
    /* git diff-tree --name-only + 读 before/after 内容 */ return [];
  }
}
```

### 4.3 与主链路接线（`P0` 时序）
- `queryLoop` 写操作前：`tracker.commit("pre-edit")` → 写盘(②) → `tracker.commit("post-edit")`，两 sha 入 `checkpoints` 表，`turnId` 关联。
- `/undo` 命令 → `ArcCommand`（扩 `{k:"undo", steps:N}`）→ 二分定位目标 sha → `resetHead` → emit `checkpoint.restored`。
- “回任意时刻 O(log n)”：`checkpoints` 表 `created_at` 有序，按步数/时间戳二分（贴 cline ContextManager 时序截断思路），非线性遍历。

### 4.4 关键坑
- **剥 VSCode 是真活**（清单 §5 #12 点名）：cline 的 `MultiRootCheckpointManager`/folder-lock/gRPC 事件全删，MVP 单 workspace 单进程。
- **依赖宿主 git 二进制**（清单伪轻量 #13）：`simple-git` 要宿主有 `git`；单机 MVP 接受，远程沙箱阶段镜像预装。
- **`core.worktree` 指向真实工作区**是零干扰用户 `.git` 的关键——shadow 仓在 `.arclight/checkpoints/`，提交的是真实工作区文件快照。
- **嵌套 git 复原必须 finally + 重试**：mid-disable 崩溃会留 `.git_disabled`，init 时先 best-effort 清理。
- **nono 快照备选**：`P0` checkpoints 表 `backend` 枚举含 `"nono-snapshot"`；MVP 主用 shadow-git，nono atomic snapshot 作沙箱内执行的补充快照（清单/沙箱方案一致），不互斥。

---

## 五、④ bash/PTY 执行 + 反射验证闭环

**目标**：交互式执行 + nono 沙箱隔离 + `edit→lint/test→读失败→自校正` 闭环。借 aider 反射循环（`max_reflections=3`）设计 + `P0` SandboxService(nono)。

### 5.1 执行：node-pty + nono SandboxService

`P0`/沙箱方案已定：`bash` 工具经 `SandboxService.run()`（`local-nono`），**不裸跑**。node-pty 用于需 TTY 的交互场景（REPL/带颜色输出）；非交互命令直接 `Bun.spawn` 经 nono 即可。

```ts
// packages/core/src/coding/exec/pty-manager.ts  —— ~150 行(PtyManager, §5 #12)
import * as pty from "node-pty";
export class PtyManager {
  // 坑: Bun + node-pty N-API(清单伪轻量 #12) —— 第一周 smoke test 必跑;不通则降级 Bun.spawn(无 TTY)
  spawn(cmd: string, args: string[], ctx: ToolContext): pty.IPty {
    const p = pty.spawn(cmd, args, { cwd: ctx.cwd, env: sanitizedEnv, cols: 120, rows: 40 });
    let bytes = 0;
    p.onData(d => {
      bytes += d.length;
      if (bytes > 524288) { /* 超 512KB(nono max_stdout_bytes) → spillRef artifact, 模型只见 preview */ }
      ctx.emit({ t: "tool.progress", chunk: d } as any);   // 100-250ms 合批(P0 事件边界)
    });
    ctx.signal.addEventListener("abort", () => p.kill());    // interrupt → kill;nono kill_process_tree_on_exit 兜底
    return p;
  }
}
```

```ts
// packages/core/src/coding/exec/bash-tool.ts  —— 接 P0 SandboxService(nono),非自研隔离
export const bashTool: Tool<BashInput, BashOutput> = {
  meta: { name: "bash", isReadOnly: false, isConcurrencySafe: false,   // 写工具串行(P0 并发规则)
          riskTier: "confirm", riskClass: "write", timeoutMs: 120000, maxResultSizeBytes: 524288, /*...*/ },
  inputSchema: BashInput, outputSchema: BashOutput,
  async execute(input, ctx) {
    // 风险分类: shell-quote 分词 + presets + 黑名单(rm -rf ~ / ~/.ssh / docker.sock / sudo) → 需审批则 permission.ask
    const res = await sandbox.run({                          // SandboxService = local-nono
      kind: "local-nono", command: input.cmd, cwd: ctx.cwd, signal: ctx.signal,
      onStdout: c => ctx.emit({ t: "tool.progress", stream: "stdout", chunk: c } as any),
      onStderr: c => ctx.emit({ t: "tool.progress", stream: "stderr", chunk: c } as any),
    });
    if (!res.ok) throw envelope("EXEC_FAILED", res.reason);   // 或 SANDBOX_UNAVAILABLE → docker-fallback
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, spillRef: res.spillRef };
  },
};
```

### 5.2 反射验证闭环（借 aider `run_one`，接进 `queryLoop`）

```ts
// packages/core/src/coding/exec/reflection.ts  —— 闭环编排(非沙箱,纯接缝)
export async function reflectiveEdit(turn: TurnCtx, opts: { maxReflections?: number } = {}) {
  const MAX = opts.maxReflections ?? 3;                       // aider max_reflections=3
  let reflected: string | null = null;
  for (let n = 0; n <= MAX; n++) {
    const reply = await streamLLM(turn, reflected);           // 反射消息作下一轮 user 输入回灌
    // 1) 解析+应用编辑(②)
    let editErr: string | null = null;
    try { applyAllEdits(reply.editBlocks); }                  // 失败抛 ValueError → did-you-mean 提示
    catch (e) { editErr = e.userMessage; }
    if (editErr) { reflected = editErr; continue; }           // 自校正: 喂回格式错误
    // 2) checkpoint post-edit(③)
    await turn.tracker.commit("post-edit");
    // 3) lint/test 反射(④ bash 经 nono)
    const lint = await runValidator(turn, "lint");            // edit→lint
    const test = lint.ok ? await runValidator(turn, "test") : null;  // edit→test
    if (!lint.ok) { reflected = formatFailure("lint", lint.output); continue; }  // 读失败→自校正
    if (test && !test.ok) { reflected = formatFailure("test", test.output); continue; }
    return { ok: true, reflections: n };                      // 闭环收敛
  }
  return { ok: false, reflections: MAX };                     // 达上限,如实上报(不假装成功)
}
```

闭环语义（与任务“edit→lint/test→读失败→自校正，max_reflections”一字对齐）：
1. **edit**：②解析+应用；解析失败的 did-you-mean(0.6)即“读失败→自校正”第一道。
2. **lint/test**：④经 nono 跑（lint 命令如 `eslint`/`tsc --noEmit`，test 如 `npm test`/`vitest`）。
3. **读失败→自校正**：失败 `stdout/stderr`（超限取 `preview`，`P0` 输出投影）作 `reflected` 喂回下一轮，最多 `MAX`。
4. **收敛/上限**：收敛即 `turn.completed`；达上限如实 `turn` 状态上报，绝不假装成功（诚实口径）。

### 5.3 关键坑
- **Bun + node-pty N-API**（清单伪轻量 #12，runtime 级暗雷）：**第一周强制 smoke test**；不通则 `bash` 退 `Bun.spawn`（丢 TTY 交互但保执行），交互终端能力降级阶段二。
- **不裸跑**（沙箱方案“绝不偷偷裸跑”）：nono 不可用 → docker-fallback → opt-in 远程 → 拒绝执行返回 `SANDBOX_UNAVAILABLE`，反射循环对待为可重试错误。
- **取消传播**：`interrupt` → `AbortController.abort()` → node-pty `kill()` + nono `kill_process_tree_on_exit`，反射循环检 `ctx.signal` 提前退出。
- **反射放大**：每轮反射多一次 LLM 调用 + 一次沙箱执行，`MAX=3` 防失控；test 仅 lint 通过才跑（省 token，贴 aider）。
- **输出落盘**：lint/test 输出常超 32KB，按 `P0` 投影落 `artifacts`，模型只见 16KB preview + spillRef。

---

## 六、自研量与一致性自检

**编码 4 件自研行数（对齐清单 §5 #12 的 2000-2800，含未充分计入项）**：

| 件 | 接缝 | 行数 | 借源(NOTICE) |
|---|---|---|---|
| ① RepoMap | TagExtractor ~150 + RepoMapBuilder ~250(图/pagerank/二分/缓存) | ~400 | aider(Apache-2.0,Py→TS) |
| ② Edit | EditBlockParser + EditGuard ~280 + apply/fuzzy + apply_patch 兼容 | ~350 | aider + opencode/cline |
| ③ Checkpoint | CheckpointTracker 剥 VSCode ~250 + ShadowGitOps + GitService ~100 | ~350 | cline(Apache-2.0,剥 VSCode) |
| ④ bash/PTY | PtyManager ~150 + bash-tool 接 nono + 反射闭环编排 | ~300 | aider 反射 + P0 SandboxService |
| — | tree-sitter WASM/多 grammar 坑、pagerank 调参、缓存失效、剥 VSCode 余量、测试 | (差额) | — |
| **合计** | | **~2000-2800** | |

> **推迟阶段二（清单“再砍”）**：`AgentLspClient ~300`（tree-sitter+编译器报错替代）、RRF 向量链 ~150（RepoMap 作上下文主源）。本设计已不含。

**一致性自检**：
- 契约↔编辑：② 失败抛 `ToolErrorEnvelope` 5 键（`VALIDATION`/`EXEC_FAILED`），绝不泄 traceback（`P0` C 节）。
- 沙箱↔执行：④ 一律经 `SandboxService(local-nono)`，不裸跑；失败阶梯 nono→docker→远程→拒绝（沙箱方案）。
- 数据模型↔检查点：③ 写 `checkpoints(backend:"shadow-git", ref=sha, changed_files)`，`turnId` 关联（`P0` schema）。
- 数据模型↔事件：四件 stdout/diff/checkpoint 经 `ctx.emit` 落 `events`，超限落 `artifacts` 带 `spillRef`，模型只见 preview（`P0` 输出投影）。
- 并发↔工具元数据：`bash`/`apply_patch`/`write_file` 全 `isConcurrencySafe:false` 串行；RepoMap 只读可并发（`P0` 并发规则）。
- 切片↔P0 落地：S1(SEARCH/REPLACE+bash)=P0 步骤 5-7；S3(检查点)=步骤 9；S5(反射+eval)=步骤 10，每 eval 走同一 HTTP/SSE/tool/sandbox 链路。

**关键源文件引用**（行号为算法锚点）：aider `repomap.py:487-514`(权重)/`666-706`(二分)、`editblock_coder.py:386-396`(正则)/`157-329`(fuzzy 阶梯,L183 默认关 edit-distance)/`439-535`(解析)；cline `CheckpointGitOperations.ts:59-115`(initShadowGit)/`148-181`(嵌套 git 禁用)、`CheckpointTracker.ts`(commit/resetHead/getDiffSet)。