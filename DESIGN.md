# Design System — arclight · CARBON ARC

> 本文件是 arclight 全部视觉/UI 决策的**设计源真相**。任何界面施工前先读这里；偏离须经用户明确批准。
> 预览页（含明暗双模式实景 mockup）：`~/.gstack/projects/zgdd12345-arclight/designs/design-system-20260611/carbon-arc-preview.html`

## Product Context

- **What this is:** 全平台个人 AI Agent。阶段一为本地优先 Web 界面：`arclight serve --repo` 拉起聊天式写代码 Agent（读/改文件、沙箱跑命令、自校正）。
- **Who it's for:** 在自己仓库上跑 Agent 的开发者。
- **Space/industry:** Coding agent 工具。同类：OpenAI Codex（严酷黑白、排版驱动）、Cursor（冷石板蓝）、Claude Code（暖珊瑚橙）、cline。
- **Project type:** 开发者工具 Web 应用（数据密集、暗色优先）。

## Aesthetic Direction

- **Direction:** CARBON ARC（碳弧灯）——暖色工业仪器台。Industrial/Utilitarian × 暖光。
- **Decoration level:** minimal——零渐变、零阴影、零装饰插画；细线制图网格是唯一"装饰"，且承担分隔功能。
- **Mood:** 深夜亮着灯的工程师工作台。95% 的时间温暖、安静、精确；Agent 请求危险操作的瞬间全场降温变冷（见信任面纪律）。
- **核心隐喻:** 产品名即碳弧灯——暖的、物理的光。机器产出是仪表读数，不是聊天气泡。
- **借鉴纪律（来自 Codex 产品研究）:** 排版扛层级、语义色专色专用、零装饰。借其纪律，不借其黑白。

## Typography

三字体各司其职，"双声道"是本系统的排版骨架：

- **机器声（Data/Code/Terminal）:** **Commit Mono** —— 一切机器产出必须用 mono：文件路径、diff、终端输出、时间戳、token 数、成本、exit code。回退 `JetBrains Mono, ui-monospace`。
- **人声（Body/UI/Labels）:** **Hanken Grotesk** —— 一切给人读的散文：对话正文、按钮、标签、提示。回退 `system-ui sans`。
- **大时刻（Display）:** **Fraunces**（600）—— 仅 wordmark 与空状态，克制使用，不进常规 UI。
- **付费升级项（后置）:** Berkeley Mono 替换 Commit Mono、Söhne 替换 Hanken Grotesk；当前三款全部 OFL 免费，MVP 不花钱。
- **Loading:** Google Fonts（Hanken Grotesk / Fraunces）+ Fontsource CDN（Commit Mono）；生产环境自托管 woff2。
- **Scale:** 11 / 12 / 13 / 14 / 16 / 20 / 28 / 40px。机器声常用 11-13，人声正文 14-16，标题 20-28，wordmark 40+。
- **Weights:** 400 正文 / 600 标签与小标题 / 700 强调与按钮。

## Color

- **Approach:** restrained——单 accent + 暖中性色 + 严格的语义专色。

### Dark · "Night Bench"（手动切换保留）

| Token | Hex | 用途纪律 |
|---|---|---|
| `--base` | `#14110E` | 画布。暖棕黑，**永不蓝黑** |
| `--surface` | `#1C1813` | 卡片/侧栏 |
| `--panel` | `#262019` | 浮起面板/激活态 |
| `--hairline` | `#3A3128` | 制图细线，唯一边框色 |
| `--text` | `#ECE3D4` | 主文字（暖骨白） |
| `--muted` | `#9A8F7F` | 次要文字 |
| `--accent` | `#F4933A` | **灯丝琥珀，唯一 accent**：主按钮、激活态、Agent 思考灯丝 |
| `--accent-hot` | `#FFC56B` | accent 的高亮点（hover/呼吸峰值） |
| `--violet` | `#A07BFF` | 电弧紫：仅"升级风险"徽章（network/elevated） |
| `--positive` | `#7FB069` | 暖鼠尾草：diff 新增、成功态 |
| `--brass` | `#C9A86A` | 黄铜：usage/成本仪表读数专用 |
| `--hazard` | `#FF4D2E` | **危险红：全产品仅审批面可用，他处一律禁止** |
| `--del-ash` | `#6B5F52` | diff 删除（灰烬+删除线，不用尖叫红） |

### Light · "Paper Bench"（默认，2026-06-12 修订）

| Token | Hex |
|---|---|
| `--base` | `#FFFFFF`（亮白） |
| `--surface` | `#F9F7F4`（暖米白：侧栏/卡片） |
| `--panel` | `#F1EEE8` |
| `--hairline` | `#E8E4DC`（柔和暖灰，借 ChatGPT 软线语言） |
| `--text` | `#211C15` |
| `--muted` | `#8A8071` |
| `--accent` | `#B85A10`（压暗保对比度） |
| `--accent-hot` | `#D97A1F` |
| `--violet` | `#5B3FD6` |
| `--positive` | `#4F7A3D` |
| `--brass` | `#8A6F35` |
| `--hazard` | `#C62A12` |
| `--del-ash` | `#A89A87` |

- **与 Claude Code 区隔纪律:** 琥珀必须偏金/橙黄（非珊瑚），机器声 mono 占比高。
- **主题策略（2026-06-12 修订）:** light 亮白为默认（用户决策）；dark "Night Bench" 经切换保留且持久化（localStorage `arclight.theme`）。

## Spacing

- **Base unit:** 4px
- **Density:** compact-comfortable（开发者工具，数据密度优先，但日志条目间留呼吸）
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48)

## Layout

- **Approach:** grid-disciplined。制图桌精度：细线分隔、基线网格、左对齐为主。
- **核心模式——工程日志流（无聊天气泡）:** 消息流是带基线网格的 ruled transcript。左 gutter（~88px）放 mono 角色标识（USER 黄铜色 / AGENT 琥珀色）、时间戳、token 增量。正文区上限 ~680px 行宽。
- **工具卡 = 台架仪器:** 单线边框卡片，头部一行：风险徽章 + 工具名（琥珀 mono）+ 目标路径 + 右侧读数（exit code / 耗时 / 字节数）。diff 卡：行号 gutter + 鼠尾草新增/灰烬删除线；终端卡：碳黑底 mono 流。
- **状态栏 = 仪表条:** 顶栏右侧黄铜成本仪表（细 bar + 游标），wordmark 用 Fraunces。
- **Grid:** 侧栏 264px（可折叠至 52px 窄栏，仿 ChatGPT）+ 主区居中对话列（~840px）；移动端收起侧栏。
- **Border radius（2026-06-12 修订）:** 常规交互面允许适度圆角（卡片/输入框/按钮 6-16px，柔和化，借 ChatGPT）；**审批模态等信任面保持方角严酷**——危险时刻的视觉降温不打折。

## Motion

- **Approach:** minimal-functional + 一个签名动效。
- **签名动效——灯丝呼吸:** Agent 思考时琥珀圆点 2.2s 呼吸发光（`box-shadow` 扩散），是"灯丝预热"的直译。必须尊重 `prefers-reduced-motion`。
- **Easing:** enter `ease-out` / exit `ease-in` / move `ease-in-out`
- **Duration:** micro 100-160ms（hover）/ short 150-250ms（面板）/ medium 250-400ms（模态）。借 Codex 的克制区间。

## 信任面纪律（本系统的灵魂，实现时不可妥协）

1. **hazard 红 `#FF4D2E` 全产品仅审批面出现。** 任何其他组件想用红色一律驳回——红色出现 = 真有危险，这个条件反射不能被稀释。
2. **审批模态 = "断电闸刀":** 弹出时背景压暗降饱和（`rgba(5,4,3,.78)` + `saturate(.4)`），暖光退场；命令全文 mono 展示；默认焦点在**拒绝**（误按回车 = 拒绝）；高危（irreversible/funds）批准用 hold-to-confirm；底部常驻 "fail-closed · 60s 自动过期" 说明。
3. **风险徽章四级标尺:** READ 鼠尾草 → WRITE/confirm 琥珀 → NETWORK/elevated 电弧紫 → IRREVERSIBLE 危险红。mono 字体 + 圆点 + 单线边框，像电压表不像彩色 chip。未知风险按最高档显示。
4. **diff 必须可长读:** 新增鼠尾草底纹、删除灰烬色+删除线（不用红绿对撞）。用户在 diff 里审计 Agent 的工作，视觉必须冷静。

## Anti-patterns（在本项目中出现即为 bug）

- 任何紫色渐变、彩色渐变按钮、装饰性 blob/插画
- 聊天气泡（rounded speech blob）
- 蓝黑底色（`#0f172a` 一类 slate）、"AI 蓝/teal" accent
- hazard 红用于非审批场景
- 机器产出（路径/数字/命令）用非 mono 字体
- 默认圆角卡片堆叠 + 阴影层级（我们用细线，不用阴影）

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-11 | CARBON ARC 初版定稿 | /design-consultation：竞品研究（Codex 严酷黑白/排版纪律）+ Claude 子代理提案（暖弧光洞察）双声音综合；Codex CLI 外部声音超时弃用（已记账）。用户审阅 HTML 预览页（明暗双模式 + 实景 mockup）后批准 |
| 2026-06-11 | 字体用免费三件套（Commit Mono / Hanken Grotesk / Fraunces） | Berkeley Mono / Söhne 为付费字体，列为后置升级项 |
| 2026-06-11 | 方角（radius 0）为默认 | 制图美学一致性；与 Codex 胶囊语言、品类圆角卡片惯例双向区隔 |
| 2026-06-12 | 默认主题改 light 亮白（Paper Bench）；线条柔和化：hairline 减淡、消息间分隔线改留白、常规交互面适度圆角；侧栏可折叠 | 用户明确指示参照 ChatGPT 修订（覆盖 radius-0 与 dark-默认两条原决策）；信任面（审批模态）维持方角+hazard 纪律不变 |
