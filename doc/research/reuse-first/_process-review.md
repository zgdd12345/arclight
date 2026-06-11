All licenses confirmed. I now have everything needed. Key verified discrepancies:

1. **web-push is MPL-2.0**, not MIT as the list claims (twice: §1 table and §3 MVP dep block). Same copyleft class the list explicitly avoids for BlockNote.
2. **node-cron is ISC**, list says MIT (minor — both permissive).
3. **opensquilla `deep-research` skill exists as MIT-0**, directly reusable, but the research subsystem says "open_deep_research is Python, design-only."
4. **docx/pptx/html-to-pdf skills are clawhub-mit0 / MIT-0** (reusable with attribution), not the vague "design reference only" the list implies.
5. **THIRD_PARTY_NOTICES.md self-contradicts** its per-file provenance for 6 skills.

Now writing the adversarial review.

---

Hi Alba,

# 对抗式评审:全栈"拿来即用"选型主清单

> 审查基准:实测 `/Users/fsm/project/arclightagent` 下 10 个参考仓 LICENSE + opensquilla `THIRD_PARTY_NOTICES.md` + 每个 SKILL.md 的 `provenance` 头 + npm registry 真实 SPDX。下文每条断言都标注「实测」或「判断」。

---

## 一、许可证风险

### 1.1 实锤错误:`web-push` 是 MPL-2.0,不是 MIT(清单标错两处)

**实测**:`npm view web-push license` → **MPL-2.0**。清单在 §1 总表(规划:推送)和 §3 MVP 依赖块两处都写成 `// MIT`。

这是清单内部**双重标准**:它在 §4.2 明确"**不引 BlockNote(MPL-2.0,文件级 copyleft)**",却把同样 MPL-2.0 的 `web-push` 当 MIT 收进依赖集。MPL-2.0 是文件级 copyleft——只要你**修改** `web-push` 的源文件并分发,被改文件必须开源;纯依赖不改源则只需保留声明,风险低于 GPL,但绝不等于 MIT。规划子系统在阶段四,可控,但**许可证标注本身错误**,且暴露清单"许可证快照"不是逐包核验而是凭印象填的。

> 处置:标注改 MPL-2.0;若洁癖,VAPID Web Push 可用 `web-push-libs` 之外的轻量自实现或仅作运行时依赖(不改源)。无论如何,§4.1"MVP 全栈全部 MIT/Apache/ISC/BSD/Public Domain"这句**当前为假**。

### 1.2 `node-cron` 是 ISC 不是 MIT(轻微)

**实测**:ISC。清单标 MIT。ISC 与 MIT 等价宽松,无实质风险,但同样说明标注未逐包核。

### 1.3 `diff` 实测 BSD-3-Clause(清单写"BSD-3",正确);`sqlite-vec` 实测 `MIT OR Apache`,`@xenova/transformers` Apache-2.0,`diff-match-patch` Apache-2.0——这几项清单标注与实测一致,无问题。

### 1.4 opensquilla 复用边界:清单的批次划分**部分错误且过度保守**

**实测**(每 SKILL.md `provenance` 头 + 全量统计):

| origin 批次 | 数量 | license | 清单说法 | 实测纠正 |
|---|---|---|---|---|
| `opensquilla-original` | 42 | Apache-2.0 | "paper-* 可搬,需 NOTICE" | ✅ 正确。`paper-*`(11 个)、`meta-paper-write`、`latex-compile`、`deep-research`?—见下 |
| `clawhub-mit0` | 11 | **MIT-0** | "docx 等=clawhub-mit0 仅参考,不能当 Apache 移植" | ⚠️ **过度保守**:MIT-0 比 MIT 还宽松(**连 attribution 都不强制**),docx/pptx/html-to-pdf **可直接搬代码**,不是"仅思路参考" |
| `openclaw-derived` | 8 | MIT | "sub-agent/cron/github 等需追 attribution" | ✅ 正确,需保留 Peter Steinberger 版权 |

**实测纠正三点**:

1. **`deep-research` 是 `clawhub-mit0` / MIT-0,可直接搬。** 清单调研子系统(2.8、§2.8)通篇说"open_deep_research / GPT-Researcher 是 Python 仅借设计,TS 复现 ~500 行"——**却完全没提 opensquilla 自带一个 MIT-0 的 `deep-research` SKILL.md 可直接复用**。这是清单最大的"现成件漏网":它在别处反复强调最大化复用,这里却放着一个可搬的现成 skill 不用,凭空多算 500 行自研。(见下文"被低估的自研量"——实际是"被忽略的可复用现成件"。)

2. **docx/pptx/html-to-pdf 的脚本(`create_docx.py` 等)实测无 license header、无 copyright 注释**(只有 docstring)。它们是 MIT-0,可搬,但既然是 Python 而你用 `docx`/`pptxgenjs`(npm),搬 SKILL.md 指令文本即可。清单"不引 python-docx/WeasyPrint LGPL"的结论正确,但"clawhub-mit0 仅作思路参考、不能当代码移植"的措辞与实际 MIT-0 许可证矛盾——**你本可以移植**,只是没必要。

3. **opensquilla `THIRD_PARTY_NOTICES.md` 自相矛盾,清单照单全收了错误。** 该文件的"OpenClaw-derived MIT"段落列了 `sub-agent`/`cron`/`github`/`nano-pdf`/`skill-creator`/`summarize`,但同一文件的"OpenSquilla-original Apache-2.0"段落**又把这 6 个全列了一遍**;而每文件 `provenance` 头实测它们是 `openclaw-derived / MIT`。**上游文档冲突**。清单 §4.3 直接采信了 NOTICE 的批次划分("sub-agent/cron/github 等 8 个=OpenClaw MIT 派生"),没发现上游 attribution 文件本身打架。处置:以**每文件 `provenance` 头为准**(更细粒度、更可信),不要信 NOTICE 的汇总列表。

### 1.5 claudecode "闭源一字不抄"——实测成立,清单正确

**实测**:`claudecode/` 下无 LICENSE、无 NOTICE、无 root `package.json`、无 license 字段。清单"代码与文本资产一律不可搬,仅学架构"的红线**正确且必须保留**。这是清单做对的地方。

### 1.6 codex NOTICE 的传染未被清单提及

**实测**:`codex/NOTICE` 显示 codex 含**派生自 Ratatui(MIT)的代码**。清单说"借 codex 设计因 Rust 语言不匹配不触发义务"——对于纯"借设计"成立。但若哪天真搬了 codex 的 `apply_patch` `.lark` 语法或提示词(清单 §4.3 说"plan.md 提示词可直接复用"),**codex 的 Apache-2.0 NOTICE 链条(含 OpenAI + Ratatui)需一并保留**。清单只说"复制提示词落 NOTICE",未点明 NOTICE 是有上游链的,容易漏。

---

## 二、伪轻量警示(看似拿来即用,实则重缝合/自运维/语言边界)

清单自己的 §0.2 列了 10 条"伪轻量",这部分做得**相当诚实**——Vercel AI SDK 当 agent 框架、resumable-stream/Redis、Python deep-research/browser-use sidecar、Auth.js v5 beta、OPA/Cedar、OmniParser、Postgres RLS、LiteLLM 版本、MV3 SW——这些点名都站得住。下面是清单**没充分警示或低估**的补充:

### 2.1 `@assistant-ui/react` 被标"拿来即用",实为本前端最大隐形缝合点

清单给 `@assistant-ui/react` 打"拿来即用",自研接缝只算 `ArcTransport` ~200 行 + "工具调用自定义渲染(Monaco diff/终端)+ 权限对话框 UI"。**这个括号里的东西不是薄接缝**:把内核的 ArcEvent(自研 async-generator 事件)桥进 assistant-ui 的 `ExternalStore`/`AISDKRuntime` 语义、做 Monaco diff 渲染、终端流渲染、流式工具调用的 part 级更新、权限审批模态的双向往返——这是**前端的核心工程**,清单自己在风险列也写了"深度定制有学习曲线"。把它和 `ArcTransport` 合计 ~400 行偏乐观,真实量级更可能是数千行 React + 多轮联调。**这是把"产品级聊天前端"说成"薄接缝"。**

### 2.2 `node-pty` / `node-pty` 类原生模块的 Bun 兼容是真风险,清单只轻描淡写

清单给 `node-pty` 打"拿来即用",风险栏写"原生模块 Bun N-API 需锁版本"。实测判断:`node-pty` 是 prebuilt N-API 原生模块,**在 Bun runtime 下的兼容性历来不稳**(Bun 的 N-API 实现仍在补齐),`@napi-rs/keyring` 同理。清单内核选 Bun 作 runtime,却把多个原生模块(node-pty、@napi-rs/keyring、sqlite-vec 的原生绑定)标"拿来即用"。**这是 Bun-first 架构下被系统性低估的一类风险**:任一原生模块在 Bun 下挂了,要么降级 Node,要么自己编。建议在 MVP 立项第一周就跑通"Bun + node-pty + sqlite-vec + @napi-rs/keyring"四件原生模块的 smoke test,否则这是会让整个 runtime 选型翻车的暗雷。

### 2.3 `simple-git` / `node-pty` 依赖系统二进制——"零依赖"假象

`simple-git` 风险栏诚实写了"依赖系统 git 二进制";但清单 §0.1 "约 85% 拿现成"的口径里,这类**依赖宿主机有 git / xelatex / language-server 二进制**的项被算作"现成件"。对单机 MVP 没问题,但一旦上**远程沙箱/多租户**,"用户机器上有 git"变成"沙箱镜像里要预装 git + tsserver + pyright + xelatex",这是镜像维护与体积成本,不是 npm install 能解决的"拿来即用"。清单把这部分运维成本隐藏在了"拿现成"口径里。

### 2.4 社区 MCP server(Google Calendar/Gmail)质量参差——清单提了但低估

清单规划子系统说"社区 MCP server 质量参差需审查",对。但同时把它算进"轻度封装"。实测判断:**第三方 MCP server 是 §0.2 第 3 条 Tool Poisoning(CVE-2025-54136)的主要入口**,审查一个第三方 server 的工具描述 + 鉴权隔离 + 凭证不下发,远不止"轻度封装"。清单自己在内核子系统把"MCP 安全审计 + 凭证代理"列为安全关键自研接缝(~150 行),但在规划子系统又把接入社区 MCP server 当轻度封装——**两处对同一风险的估值不一致**。

---

## 三、成熟度风险(把 alpha/preview 当既定依赖)

### 3.1 `ai` (Vercel AI SDK) **v6** 被当既定依赖——v6 在清单成文时的稳定性存疑

清单多处锁定 `"ai": "^6"`,调研子系统明确写"ai(v6)"。**判断**:AI SDK v6 是相对新的大版本,major bump 通常伴随 breaking API(`streamText`/`useChat`/provider 协议都可能变)。清单把整个内核主循环、流式桥接、provider 路由、前端 runtime **全部押在 `ai` 单一库的某个大版本**上,而这个库正是 §0.2 第 1 条承认"被 marketing 包装、只是 turn 原语"的那个。这是**单点依赖 + 新 major** 的双重成熟度风险:`ai` 的任何 v6→v7 迁移会同时冲击内核与前端。建议锁 minor、把对 `ai` 的依赖收敛到一个 adapter 层(清单的 ArcTransport/桥接已部分做到,应明确强制)。

### 3.2 Claude computer-use `computer-use-2025-11-24` beta + Gemini 2.5 CU——清单已标 beta,但"OSWorld 66.3% SOTA"是会过期的营销数字

清单 computer-use 子系统把 `computer-use-2025-11-24`(beta header)当主路径,风险栏写"beta header 迭代"。诚实。但"OSWorld 66.3% SOTA"这种 benchmark 数字**半年就过时**,不应写进"既定选型理由"。这块在 P3,影响可控,清单处理基本合格(标了 beta、标了截图独立通道、HITL),仅提醒别把 benchmark 当架构依据。

### 3.3 `OmniParser v2` —— 清单处理正确

标 alpha 级、唯一无 TS SDK、仅 P3 兜底、主路径不依赖。**这是把成熟度风险处理对的范例**,无异议。

### 3.4 `opentui` —— 清单标"生态小",但 CLI 在 P2,且给了 `ink` 备选,处理合格。

### 3.5 真正的成熟度盲点:`sqlite-vec`

清单给 `sqlite-vec` 打"拿来即用 / 生产可用",风险栏只说"百万级向量后不如 Qdrant"。**判断**:`sqlite-vec` 是相对年轻的扩展(由 Alex Garcia 开发,长期处于 `v0.x`),`MIT OR Apache` 实测无误,但 **v0.x 意味着 API/磁盘格式可能 breaking**,且它是**需要加载的 SQLite 扩展(原生)**——叠加 §2.2 的 Bun 原生模块风险。清单把它从 MVP"可选缓上"是对的,但"生产可用"的措辞对一个 v0.x 原生扩展偏乐观。

---

## 四、MVP 最小依赖集可再砍项

清单 §3 自报内核 ~22 + 前端 ~8。审查下来**仍可再砍**,清单的"最小集"对一个"Web 单端 + 写代码单能力 + 单用户 + 本地沙箱"的 MVP 偏厚:

| 可砍项 | 清单位置 | 砍的理由 | 处置 |
|---|---|---|---|
| **`sqlite-vec` + `@xenova/transformers`/embed + FTS5 检索整套** | MVP 内核 | 清单自己注"RepoMap 已够则可缓上"。写代码 MVP 的上下文来源是 **RepoMap(tree-sitter + graphology pagerank)**,语义检索是锦上添花。**整条向量检索链(向量扩展 + 本地 embedding 模型,后者还是几百 MB 下载)对单能力 MVP 是纯负担** | **砍出 MVP**,进阶段二 |
| **`@napi-rs/keyring`** | MVP 内核 | 单用户本地 MVP 用 loopback token,provider key 可以直接读环境变量 / 本地 `.env`(清单自己 §2.5 说认证用 loopback 零库)。OS keychain 是多用户/桌面端才需要的 | **降级为环境变量**,keyring 进 P3 桌面端 |
| **`langfuse`** | MVP 内核 | LLM trace 对"起步跑通"非必需,清单自己把完整可观测 pipeline 放阶段五。MVP 有 `pino` 结构化日志足够定位问题 | **可选**,或直接砍到阶段二 |
| **`playwright`** | MVP 内核(dev) | 清单注"写代码沙箱内测试运行(非 computer-use)"。这是**被测项目自己的测试依赖,不是 arclightagent 内核依赖**,不该出现在内核 MVP 依赖集里 | **从内核依赖集移除**(它属于沙箱镜像/用户项目) |
| **`vscode-languageserver-protocol` + `vscode-jsonrpc` + LspManager(~300 行)** | MVP 内核 | LSP 提供"跳转/诊断/补全"给 agent,是**写代码体验增强**,不是 MVP 跑通 SEARCH/REPLACE 编辑闭环的必需。清单自研量这里就 ~300 行 | **砍出 MVP**,进阶段二(MVP 用 tree-sitter + 编译器报错即可) |
| **`@serwist/next` (PWA)** | MVP 前端 | 清单自己注"可 MVP 末期加"。Web 单端起步不需要 PWA/离线 | 默认不装 |
| **`sqlite-vec` 连带的 RRF 融合 ~150 行自研** | 自研清单 #(检索) | 随上面砍向量检索一起消失 | 一并推迟 |

**再砍后的真·MVP 内核依赖**:`ai`、`@ai-sdk/anthropic`、`zod`、`@modelcontextprotocol/sdk`、`gray-matter`、`hono`、`drizzle-orm`+`drizzle-kit`、`web-tree-sitter`+`tree-sitter-typescript`、`graphology`、`diff-match-patch`+`diff`、`simple-git`、`node-pty`、`shell-quote`、`pino`、`vitest`——约 **17 个**(对比清单 22)。砍掉的是**向量检索链(2-3 个 + 本地模型下载)、keyring、langfuse、LSP 两件、playwright 误列项**。

**对应自研量也跟着减**:RRF 融合 ~150 行、AgentLspClient ~300 行 推迟,MVP 自研立省 ~450 行。

> 注:`@anthropic-ai/sdk` 清单已标"可选(极致 KV-cache 时直连)",MVP 单 provider 走 `@ai-sdk/anthropic` 即可,这个可不装,清单标注正确。

---

## 五、被低估的自研量(把真工程说成"薄接缝")

清单 §5.1 自报 MVP 自研 **3000-3500 行**。逐项审查,**多处明显低估**:

| 接缝 | 清单标 | 实评 | 低估倍数/理由 |
|---|---|---|---|
| **async-generator 主循环 `queryLoop()`** | 300-400 | **800-1500** | 可中断 + 压缩边界 + steering 队列 + per-turn 重建 + 工具结果回灌 + 错误恢复 + 取消传播,这是整个 agent 的心脏。借 pi 代码能省一部分,但"借 MIT 代码改成自己的事件模型"本身是重活。**最被低估的一项。** |
| **内核事件→UIMessage/streamSSE 桥接 + 心跳 + token 限流 + 刷新不丢** | 200 | **400-700** | 清单 §0.2 自己把 resumable/刷新不丢列为"bug 密度最高处"。即便砍到"最朴素刷新不丢"(SQLite event 表 + 重连续推),event 表 schema + epoch 合并 + replay 去重 + 心跳 + backpressure 处理,200 行打不住 |
| **`@assistant-ui` 工具渲染 + 权限 UI + ArcTransport** | 200 | **1500-3000+** | 见 §2.1。Monaco diff 渲染、终端流渲染、流式 part 更新、审批模态双向往返——**这是产品级前端,不是 200 行接缝**。清单整个前端自研只算了 ArcTransport,把 UI 工程当成了"现成 assistant-ui 自动给"|
| **编码 8 接缝** | 1600 | **2000-2800** | RepoMapBuilder(aider 算法 Python→TS 移植 + pagerank 调参 + 二分裁剪 + 缓存失效)清单自己标 ~400 行且"需较多缝合"。CheckpointTracker 剥 VSCode 依赖 ~250、EditBlockParser+EditGuard ~280、LspClient ~300——这些"剥依赖/移植/自测"清单都标了"需较多缝合/新实现需自测",但总数仍偏乐观。tree-sitter 多语言 grammar 加载 + WASM 初始化的坑没计入 |
| **MCP 安全审计 + 凭证代理** | 150 | **300-500** | Tool Poisoning 审计(解析 + 比对 + 隔离)+ 沙箱外凭证代理(按动作签名放行)是安全关键,清单 §0.2 自己列为高危。150 行是乐观下限 |
| **权限审批 presets + 黑名单 + SSE 模态** | 150 | **300-500** | presets×profile + 渐进 allowlist + RiskTier×渠道 fail-closed + 审批状态机 + SSE 双向。清单自己说"最像有现成实则必须自研" |

**重估 MVP 自研总量**:清单 3000-3500 行 → 实评 **6000-9000+ 行**(主要差额在前端 UI 工程 +1500~2800、主循环 +500~1100、流桥接 +200~500、编码接缝 +400~1200)。**清单低估约 2-2.5 倍**,核心原因是**系统性地把"前端产品工程"折叠进了一个 200 行的 ArcTransport**,以及对主循环这个"心脏"过度依赖"借 pi 代码"的省力假设。

**但方向正确**:这些确实没有"现成 agent 框架"可整体安装(清单刻意不用 LangGraph/Mastra 的判断成立),自研是真无法避免的——问题只在**工程量被乐观地标小了**,不在"该不该自研"。

---

## 六、总评

**清单整体质量:高于一般选型文档,自我批判意识强(§0.2 的 10 条伪轻量、§4 的许可证批次区分、§5.2 的推迟清单都相当诚实),但乐观偏差集中在三处,且许可证快照有实锤错误。**

**实锤硬伤(必须改)**:
1. **`web-push` 是 MPL-2.0 不是 MIT**,与清单"不引 BlockNote(MPL-2.0)"自相矛盾;§4.1"MVP 全栈全部宽松许可"当前为假。`node-cron` 是 ISC 非 MIT(轻微)。
2. **opensquilla `deep-research` skill 是 MIT-0,可直接搬,清单调研子系统完全漏掉**,凭空多算 ~500 行 Python-design 复现自研。
3. **opensquilla 批次划分采信了上游 `THIRD_PARTY_NOTICES.md` 的自相矛盾**(6 个 skill 同时被列为 OpenClaw-MIT 和 OpenSquilla-Apache);应以每文件 `provenance` 头为准。docx/pptx/html-to-pdf 实测 MIT-0(可搬),清单"仅参考不可移植"过度保守。

**系统性低估(方向对、量级错)**:
4. **前端被严重低估**:`@assistant-ui` 工具渲染 + 权限 UI 是产品级工程(1500-3000+ 行),被折叠进一个 200 行的 ArcTransport。
5. **主循环 `queryLoop()` 低估**:300-400 行 → 实评 800-1500,这是 agent 心脏,"借 pi 代码"省不掉移植与重接的重活。
6. **MVP 自研总量**:清单 3000-3500 行 → 实评 **6000-9000+**,低估约 2-2.5 倍。

**成熟度盲点**:
7. **`ai` v6 单点依赖 + 新 major**:内核主循环、流式、provider、前端 runtime 全押一个库的大版本,且这正是清单承认"被营销包装"的库——务必收敛到 adapter 层并锁 minor。
8. **Bun + 原生模块**(node-pty / sqlite-vec / @napi-rs/keyring)兼容性是 runtime 级暗雷,清单只逐个轻描淡写,未作为架构级风险统一对待——MVP 第一周应跑四件原生模块 smoke test。

**MVP 仍可再砍**:向量检索链(sqlite-vec + 本地 embedding 模型)、keyring、langfuse、LSP 两件、误列的 playwright——砍后内核依赖 22→17,自研立省 ~450 行。清单的"最小集"对单能力 MVP 仍偏厚。

**做对的地方(保留)**:claudecode 闭源一字不抄(实测无 LICENSE,正确);paper-*=Apache-2.0 可搬(实测正确);OmniParser/RLS/resumable-stream 后置(成熟度处理范例);"无现成 agent 框架可整体安装、自研只发生在接缝"的核心判断成立。

**一句话总评**:选型方向和许可证洁癖的大框架是对的,但这份清单是**一份偏乐观的"接缝"叙事**——它把两处真正的产品级工程(agent 主循环、聊天前端)和一处可直接复用的现成件(opensquilla deep-research MIT-0)说轻了,又在一个 MPL-2.0 依赖上自打了"全宽松许可"的脸。改掉这三类问题(修许可证标注 + 认领前端/主循环真实工程量 + 捡回 deep-research skill),它就是一份可信的主清单。

---

**核实依据文件**(均为绝对路径):
- 参考仓 LICENSE:`/Users/fsm/project/arclightagent/{pi,opencode,MetaGPT}/LICENSE`(MIT)、`/{cline,codex,gemini-cli,aider,opensquilla,qwen-code}/LICENSE`(Apache-2.0)、`/OpenHands/LICENSE`(MIT + enterprise/ 例外)、`claudecode/`(无 LICENSE/NOTICE,确认闭源)
- `/Users/fsm/project/arclightagent/opensquilla/THIRD_PARTY_NOTICES.md`(批次自相矛盾来源)
- `/Users/fsm/project/arclightagent/opensquilla/src/opensquilla/skills/bundled/*/SKILL.md`(provenance 头实测:42 Apache-2.0 / 11 MIT-0 / 8 MIT;`deep-research`=MIT-0;`docx`/`pptx`/`html-to-pdf`=MIT-0;`paper-*`=Apache-2.0)
- `/Users/fsm/project/arclightagent/codex/NOTICE`(Ratatui MIT 上游链)
- npm registry 实测 SPDX:`web-push`=MPL-2.0、`node-cron`=ISC、其余(node-pty/simple-git/web-tree-sitter/graphology/shell-quote/diff-match-patch/sqlite-vec/@xenova/transformers 等)与清单一致