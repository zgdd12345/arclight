现在我有了充足的完整信息。下面直接输出选型清单：

---

# 写作能力子系统：拿来即用选型清单

> 范围：结构化写作流水线 · 富文本/Markdown 编辑器 · 文档生成 · 引用脚注 UI
> 项目阶段：MVP = Web 单端 + 写代码单能力（阶段一）；写文章 = 阶段二交付

---

## 一、结构化写作流水线

### 1.1 opensquilla paper-* skill 体系

| 项 | 内容 |
|---|---|
| **来源** | `/Users/fsm/project/arclightagent/opensquilla/src/opensquilla/skills/bundled/` 下：`meta-paper-write`、`paper-outline-author`、`paper-section-author`、`paper-abstract-author`、`paper-citation-planner`、`paper-refbib-stub`、`paper-revision-author`、`paper-source-curator`、`paper-preference-planner`、`paper-experiment-stub`、`paper-plot-stub`（共 11 个 SKILL.md） |
| **许可证** | **Apache-2.0，origin: opensquilla-original**（经 `THIRD_PARTY_NOTICES.md` 核验，不涉 OpenClaw；不是 `clawhub-mit0` 批次） |
| **它提供什么** | 完整 Outline→Section→Abstract→Citation→Revision 学术写作拓扑流水线；`meta-paper-write` 用 composition 块编排全流程，内含 COMPACT\_SKELETON / FULL\_MANUSCRIPT / REPAIR\_EXISTING / COMPILE\_ONLY 四个模式；单步 skill 可独立调用；prompt 工程精细（字数合同、引用分配、风格变量、多语言）；LaTeX/PDF 编译触发 `latex-compile` skill（需宿主有 xelatex） |
| **复用方式** | **可直接复用代码**：SKILL.md 是纯文本 prompt 模板 + frontmatter，不含 Python 运行时逻辑，可逐文件搬入 arclightagent 的 skills/ 目录；需按 Apache-2.0 NOTICE 义务在根目录 `NOTICE` 文件中标注上游来源与许可证 |
| **集成成本** | **轻度封装**：需把 opensquilla Meta-Skill `composition` 编排逻辑（Python）移植为 arclightagent TS `SKILL.md` + MetaSkill 编排器；核心 prompt 零改动；编排骨架约 200-400 行 TS |
| **成熟度** | 生产可用（opensquilla v0.3.1，已在多语言学术写作场景验证） |
| **风险** | 流水线按学术论文设计，用于通用长文写作时需新增「通用文章」模式（outline/section 节奏不同）；非 paper 场景 prompt 要额外维护 |

**保留的最小自研接缝**：TS MetaSkill 编排器（把 composition 步骤按拓扑序调用子 Agent，失败回退普通轮）；阶段二约 2-3 天实现。

---

### 1.2 MetaGPT ActionNode（结构化输出 + 自校正）

| 项 | 内容 |
|---|---|
| **来源** | `geekan/MetaGPT`，`metagpt/actions/action_node.py`，MIT License |
| **它提供什么** | 把期望输出建模为"字段+类型+指令"节点树，自动生成 format example、约束 LLM 输出到 `[CONTENT]` 包裹的 JSON/Markdown，内置 auto/human review→revise 自校正循环与语言对齐约束 |
| **复用方式** | **仅借设计，得自己写**：MetaGPT 是 Python，arclightagent 内核为 TS；ActionNode 的核心思想（声明式字段约束 + 自校正）用 Zod schema + 自研小型 `StructuredOutputNode` 在 TS 侧复现，约 100-200 行 |
| **集成成本** | **仅借设计** |
| **成熟度** | 设计成熟（MetaGPT 核心机制，大量生产案例），TS 移植约 1-2 天 |

**保留的最小自研接缝**：`StructuredOutputNode`（Zod schema → LLM prompt 约束 → parse → review/revise 闭环），约 150 行 TS。

---

### 1.3 STORM（大纲驱动，仅借设计）

| 项 | 内容 |
|---|---|
| **来源** | `stanford-oval/storm`，MIT，[github.com/stanford-oval/storm](https://github.com/stanford-oval/storm) |
| **它提供什么** | 多专家视角对话驱动大纲生成（Writer 与 Expert 交替追问），再产出带 inline citations 的 Wikipedia 风格长文 |
| **复用方式** | **仅借设计**：Python 库，与 TS 内核语言边界隔离；其"多专家视角对话生成大纲"的提示词工程思路可作为 paper-outline-author skill 的补充增强方向 |
| **集成成本** | **仅借设计** |
| **成熟度** | 成熟开源（MIT，70k+ 用户，NAACL 2024） |
| **适用时机** | 阶段二写文章能力打磨大纲生成质量时，作为 prompt 设计参考 |

---

## 二、富文本 / Markdown 编辑器

### 2.1 marked + shiki（MVP 阶段二最小配置）

| 项 | 内容 |
|---|---|
| **来源** | `marked`（MIT，[npmjs.com/package/marked](https://www.npmjs.com/package/marked)）；`shiki`（MIT，[shiki.matsu.io](https://shiki.matsu.io/)） |
| **它提供什么** | `marked`：Markdown → HTML，支持 GFM、流式增量解析；`shiki`：代码块语法高亮（TextMate grammar，支持 200+ 语言，SSR/CSR 均可） |
| **集成成本** | **拿来即用**：两个 npm 包，直接 import；流式章节渲染约 50 行胶水代码 |
| **成熟度** | 生产可用（主蓝图 §6.2 已明确选用） |
| **风险** | 无；`marked` 不支持 WYSIWYG 编辑，只做渲染输出侧 |

### 2.2 TipTap（所见即所得编辑器，阶段二主选）

| 项 | 内容 |
|---|---|
| **来源** | `tiptap-editor/tiptap`，MIT（核心），部分 Pro 扩展商业授权，[tiptap.dev](https://tiptap.dev/)；npm `@tiptap/react`、`@tiptap/starter-kit` |
| **它提供什么** | 基于 ProseMirror 的无头富文本编辑器框架；React 原生适配；支持 Markdown 输入/输出、协同编辑（Y.js）、自定义节点/扩展；AI 流式写入内容（通过 `insertContent`/`setContent`）；内置 StarterKit 覆盖标题/段落/列表/代码块/加粗/斜体等常用格式 |
| **集成成本** | **轻度封装**：安装 `@tiptap/react` + `@tiptap/starter-kit`，封装 WritingEditor 组件；流式 SSE chunk → `editor.commands.insertContent()` 约 80 行；引用脚注需自定义 Extension 约 100-200 行 |
| **成熟度** | 生产可用（行业主流选择，npm 周下载 600k+） |
| **风险** | 协作功能（Tiptap Cloud/Hocuspocus）为商业组件，单用户 MVP 不需要；Pro Extensions 部分需付费，但 StarterKit 已够阶段二 |

**备选：BlockNote（`@blocknote/react`，MPL-2.0）**——基于 TipTap 的 block-based 编辑器，开箱即用更强但许可证是 MPL-2.0（文件级 copyleft，需确认是否影响分发）；**Lexical（Meta，MIT）**——更底层、更灵活，但集成成本高于 TipTap；**ProseMirror（MIT）**——TipTap 的底层，直接用需自建较多。**推荐：TipTap MIT 核心即可，MVP 不引 BlockNote MPL-2.0。**

---

## 三、文档生成

### 3.1 docx 生成：docx（npm 库）

| 项 | 内容 |
|---|---|
| **来源** | `docx`，MIT，[npmjs.com/package/docx](https://www.npmjs.com/package/docx)；纯 TS/JS，无 native 依赖 |
| **它提供什么** | 纯 TS 生成 `.docx` 文件；支持段落/标题/表格/列表/图片/超链接/样式；输出 Buffer 可直接发到前端下载 |
| **集成成本** | **拿来即用**；封装 `generateDocx(sections)` 工具约 50-100 行 |
| **成熟度** | 生产可用（npm 周下载 400k+，持续维护） |
| **风险** | 无。注意：opensquilla 的 `docx` skill 用的是 `python-docx`（origin: clawhub-mit0，MIT-0），其 SKILL.md 是可参考的实现思路文档，但底层库在 TS 项目应换成 `docx` npm 包，**不要直接复用 opensquilla docx skill 的 Python 脚本** |

### 3.2 pptx 生成：PptxGenJS

| 项 | 内容 |
|---|---|
| **来源** | `pptxgenjs`，MIT，[gitbrent.github.io/PptxGenJS](https://gitbrent.github.io/PptxGenJS/)；npm `pptxgenjs` |
| **它提供什么** | 纯 JS 生成 `.pptx` 文件；支持文字/图片/表格/图形/主题；Browser + Node 两端均可用 |
| **集成成本** | **拿来即用**；封装 `generatePptx(slides)` 约 80 行 |
| **成熟度** | 生产可用（opensquilla pptx skill 的 references/pptxgenjs.md 有详细用法文档，即开箱参考） |
| **风险** | 无 |

### 3.3 xlsx 生成：ExcelJS

| 项 | 内容 |
|---|---|
| **来源** | `exceljs`，MIT，[npmjs.com/package/exceljs](https://www.npmjs.com/package/exceljs) |
| **它提供什么** | 读写 `.xlsx`；支持样式/公式/图表/数据验证；流式读写大文件 |
| **集成成本** | **拿来即用** |
| **成熟度** | 生产可用（npm 周下载 500k+） |
| **风险** | 无 |

### 3.4 Markdown → HTML → PDF：Puppeteer / @playwright/browser

| 项 | 内容 |
|---|---|
| **来源** | `puppeteer`，Apache-2.0，[npmjs.com/package/puppeteer](https://www.npmjs.com/package/puppeteer)；或 `@playwright/test` 的 `page.pdf()`，Apache-2.0 |
| **它提供什么** | Headless Chromium 渲染 HTML/CSS → 高保真 PDF，支持页眉页脚、分页控制；支持数学公式（KaTeX/MathJax）和代码块渲染 |
| **集成成本** | **轻度封装**：约 30-50 行 `html → pdf` 工具包装；Chromium binary 约 130MB（需纳入部署考虑） |
| **成熟度** | 生产可用 |
| **风险** | Chromium 二进制体积大；服务端用 `puppeteer-core` + 系统 Chrome 可压体积；**在沙箱内运行时需与代码执行沙箱共存（不能嵌套 E2B），走独立进程** |

**备选：md-to-pdf（MIT，`npm i md-to-pdf`）**——封装了 Puppeteer，接口更简单，但配置灵活性弱；**WeasyPrint（Python，LGPL-2.1）**——opensquilla html-to-pdf skill 用此方案，**但 LGPL-2.1 且为 Python**，TS 项目优先 Puppeteer 路线。**Typst（Apache-2.0，命令行二进制）**——排版质量接近 LaTeX，编译速度比 LaTeX 快 10×+，Rust 编写；作为 LaTeX 的现代替代，阶段二可考虑封装为工具调用，但需要用户安装 typst CLI；**不是 npm 直装**，集成成本高于 Puppeteer 方案。

### 3.5 LaTeX → PDF：系统 xelatex（现成二进制，非 npm）

| 项 | 内容 |
|---|---|
| **来源** | TeX Live / MacTeX / tinytex，系统包，MIT-compatible |
| **它提供什么** | 学术论文标准输出；opensquilla `latex-compile` skill（Apache-2.0）已封装完整的 `xelatex × bibtex × xelatex × xelatex` 编译流程 + 错误日志提取 |
| **复用方式** | `latex-compile` SKILL.md 可直接移植（Apache-2.0，需 NOTICE）；底层调系统 `xelatex` 二进制，不引 LGPL |
| **集成成本** | **拿来即用（SKILL.md 级）**；部署时需沙箱内预装 TeX Live |
| **成熟度** | 生产可用 |
| **风险** | TeX Live 镜像约 4GB，容器部署需 tinytex 精简版（约 200MB）；云端按需触发 |

---

## 四、引用脚注 UI

### 4.1 脚注渲染（TipTap 自定义 Extension）

| 项 | 内容 |
|---|---|
| **方案** | TipTap 自定义 `FootnoteNode` Extension：渲染带编号的 `<sup>` 角标，hover 弹出引用详情 tooltip，点击跳转原始 URL |
| **集成成本** | **轻度封装**（自研接缝）：约 100-200 行 TS，利用 TipTap 节点扩展 API |
| **来源参考** | opensquilla `paper-citation-planner`（Apache-2.0）的引用键管理逻辑可借设计 |

### 4.2 引用格式化：citation-js

| 项 | 内容 |
|---|---|
| **来源** | `citation-js`，MIT，[npmjs.com/package/citation-js](https://www.npmjs.com/package/citation-js) |
| **它提供什么** | 解析 BibTeX/DOI/URL → CSL JSON；渲染 APA/MLA/Chicago/GB-T 等格式；支持 `@citation-js/plugin-bibtex` |
| **集成成本** | **拿来即用**；调用 `Cite` 类格式化引用文本约 20 行 |
| **成熟度** | 生产可用（npm 周下载 120k+） |
| **风险** | 无；进阶功能（DOI 解析）需网络请求 |

### 4.3 引用核验（CitationAgent，纯自研接缝）

| 项 | 内容 |
|---|---|
| **方案** | 独立 CitationAgent 阶段：综合写作完成后，对每条重要声明存 source chunk 指针，专门做句级可溯源验证（FACTUM 论文 arXiv:2601.05866 的机制参考） |
| **集成成本** | **需较多缝合**：这是整个写作子系统中最需要自研的部分，约 3-5 天；但阶段二先做基础引用渲染，CitationAgent 可在阶段三（调研能力）一并建设 |
| **来源参考** | opensquilla `paper-citation-planner` + `paper-refbib-stub` 的引用键追踪设计（仅借设计）；FACTUM 论文（仅借机制） |

---

## 五、现在不要自研、推迟到产品成熟后的部分

| 功能 | 推迟原因 |
|---|---|
| **通用写作风格定制引擎**（跨风格人格切换、读者定向调整） | opensquilla `paper-preference-planner` 有学术写作偏好系统；通用场景的风格引擎（营销文/博客/技术文）需自建，但阶段二先跑论文/报告场景，风格系统数据来自用户反馈后迭代 |
| **协同实时编辑**（Y.js + Hocuspocus/Liveblocks） | 单用户 MVP 无需，多用户协作是阶段三之后的能力 |
| **自研 Markdown AST 编辑器**（替代 TipTap ProseMirror） | ProseMirror 生态已足够成熟，自研无收益；待 TipTap 产生明确瓶颈（如渲染性能、移动端）再评估 |
| **PDF 版面智能分析**（读入 PDF 理解版式、提取结构化内容） | `pdfplumber`/`pypdf` 方案在 opensquilla 已有（Python），TS 侧 `pdf-parse`（MIT）可做基础文本提取；复杂版面理解（表格、多栏、图注）推迟到调研能力阶段 |
| **Typst 排版引擎深度集成**（替代 LaTeX 的现代排版） | Typst 技术优秀（Apache-2.0），但生态/用户习惯未到主流；系统 xelatex 已能满足学术场景，Typst 等产品成熟后评估引入 |
| **写作质量自动评分/幻觉检测**（FACTUM 风格引用核验 + 内容准确率评估） | 阶段三（调研）的 CitationAgent 会打基础，全套写作核验体系依赖大量真实写作数据，产品成熟后再建 |
| **BibTeX 数据库管理 UI**（Zotero 风格的文献库） | 阶段二只需要 `citation-js` 按键渲染，文献管理 UI 是独立产品需求 |
| **结构化写作 RL 训练**（à la DeepResearcher，端到端 RL 优化写作流水线） | 需要大量写作轨迹和评估信号，产品成熟后才有数据基础 |

---

## 六、MVP 最小依赖集（阶段一 Web + 写代码，真正需要的写作相关现成件）

**阶段一（Web 单端 + 写代码单能力）不需要任何写作子系统组件**；写作能力在阶段二交付。以下是**阶段二（写文章）启动时的最小依赖集**：

| 角色 | 现成件 | npm / 来源 | 许可证 |
|---|---|---|---|
| 流水线 prompt 模板 | opensquilla paper-* SKILL.md（11 个） | 本地仓库移植 | Apache-2.0（需 NOTICE） |
| Markdown 渲染 | `marked` | npm | MIT |
| 代码高亮 | `shiki` | npm | MIT |
| 富文本编辑器 | `@tiptap/react` + `@tiptap/starter-kit` | npm | MIT |
| docx 生成 | `docx` | npm | MIT |
| pptx 生成 | `pptxgenjs` | npm | MIT |
| xlsx 生成 | `exceljs` | npm | MIT |
| HTML→PDF | `puppeteer-core` + 系统 Chrome | npm | Apache-2.0 |
| 引用格式化 | `citation-js` + `@citation-js/plugin-bibtex` | npm | MIT |
| 结构化输出约束 | 自研 `StructuredOutputNode`（Zod + LLM prompt） | 自研，约 150 行 TS | — |
| 引用脚注 UI | 自研 TipTap `FootnoteNode` Extension | 自研，约 150 行 TS | — |
| MetaSkill 编排器 | 自研 composition 拓扑执行（TS 移植自 opensquilla 设计） | 自研，约 300 行 TS | — |

**自研接缝总量（阶段二）**：约 600 行 TS（3 个小模块），其余全部拿现成件，符合"最大化复用现成成熟实现"总原则。

---

## 七、许可证合规备忘（写作子系统专项）

1. **opensquilla paper-* SKILL.md 移植**：根目录 `NOTICE` 文件中写入 `opensquilla/arclightagent/paper-*/meta-paper-write`，声明上游为 opensquilla v0.3.1、Apache-2.0、Copyright OpenSquilla Contributors；保留各 SKILL.md 头部 `provenance` 字段。
2. **opensquilla docx/pptx/xlsx/html-to-pdf SKILL.md** 的 origin 为 `clawhub-mit0`，非 opensquilla-original，**不能直接当 Apache-2.0 代码移植**；仅作为实现思路参考文档，底层用 npm `docx`/`pptxgenjs`/`exceljs`/`puppeteer` 各自的 MIT/Apache-2.0 实现。
3. **TipTap Pro Extensions**（Collaboration、AI 等）为商业授权，阶段二只用开源 MIT 核心，不引 Pro 组件。
4. **WeasyPrint / python-docx / python-pptx / openpyxl / reportlab / pdfplumber**：opensquilla 用于 Python 服务端，arclightagent 内核为 TS，**不引这些 Python 包**；其中 WeasyPrint 为 LGPL-2.1，更应避免。
5. **BlockNote（MPL-2.0）**：文件级 copyleft，涉及分发时需开放修改文件，阶段二不引入，用 TipTap MIT 替代。