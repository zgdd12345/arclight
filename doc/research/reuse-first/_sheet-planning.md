现在我有足够的信息输出完整的选型清单。

---

# 日常规划子系统：拿来即用选型清单

> 范围：调度/cron · 日历邮件 · 提醒推送 · Plan/Act + checklist · 心跳协调  
> 原则：最大化复用现成件，自研只留薄接缝；参照架构已在 `ARCHITECTURE_BLUEPRINT.md §6.5` 和 `FULL_PLATFORM_DESIGN.md §4.x` 定案，本清单以该定案为基准落实到具体库/工具层。

---

## 一、调度 / Cron

### 1.1 直接采用：`node-cron`

| 项 | 内容 |
|---|---|
| 来源 | npm: `node-cron` v3.x — https://github.com/node-cron/node-cron |
| 许可证 | MIT |
| 提供什么 | 纯 TS/JS 进程内 cron 调度；标准 5/6 字段 cron 表达式解析；`schedule(expr, fn)` 一行启动；不依赖任何外部进程或数据库 |
| 集成成本 | **拿来即用** — 一行 `import`，三行代码注册 job |
| 成熟度与风险 | **生产可用**，周下载量 4M+，API 稳定多年。风险：纯进程内，进程重启 job 丢失（本项目 MVP 单用户单进程可接受；多实例横向扩展时需外挂持久化）。**不是坑**，只是边界清晰。 |
| 备注 | opensquilla 用的是 Python 侧 `APScheduler + croniter`；JS 生态对应件是 `node-cron`（表达式解析部分对应 `croniter`）。arclightagent 内核 TS/Bun，直接取 `node-cron` 无需绕 Python 栈。 |

**opensquilla 借鉴边界**：`scheduler/engine.py`（cron 解析 + 下次运行计算 + job 预约防重复执行）是**仅借设计，不搬代码**——Python APScheduler 无法直接用，但其"入库持久化 job + 预约时间戳 + 防重复执行"逻辑可按同样思路自写一个 TS 薄层套在 `node-cron` 外。

### 1.2 后置替换方案（现在不要）：`BullMQ` / `Temporal`

| 方案 | 场景 | 为何后置 |
|---|---|---|
| `BullMQ`（MIT，Redis 依赖） | 高并发任务队列、重试、优先级、多 worker | MVP 单用户单进程，引 Redis 是过度设计；等多用户/多 worker 有需求再上 |
| `Temporal`（MIT，独立服务） | 长时程持久化工作流、跨进程状态机 | 工程重，需运行独立 Temporal server；产品成熟后需要跨节点可靠性时评估 |

---

## 二、日历 / 邮件接入

### 2.1 直接采用：Google Calendar MCP Server + Gmail MCP Server（官方 / 社区 MCP）

| 项 | 内容 |
|---|---|
| 来源 | `@modelcontextprotocol/server-google-calendar`（或社区 `zapier-mcp` / `composio-mcp` 集成件）— MCP 社区目录 https://github.com/modelcontextprotocol/servers |
| 许可证 | MIT（官方 servers 仓）；第三方集成件需逐个核验 |
| 提供什么 | 通过 MCP 协议把 Google Calendar CRUD、Gmail 读写暴露为 agent 工具；OAuth 2.0 PKCE 流程由 MCP server 自身处理；agent 侧只调工具，不碰 OAuth token |
| 集成成本 | **轻度封装** — arclightagent 内核已有 MCP 客户端接入管线（见 `ARCHITECTURE_BLUEPRINT.md §3` "MCP 接入经 Streamable HTTP + OAuth 2.1/PKCE"），Calendar/Gmail MCP server 作为新 server 注册进来即可；**唯一额外工作**是实现凭证代理（OAuth token 存 KMS 信封加密，不下发任何端） |
| 成熟度与风险 | **生态成熟、官方维护**。风险：MCP server 质量参差（研究文件 `topic-multi-agent-orch.json` 明确指出"未经验证的社区 MCP Server 存在安全风险"）；**必须人工审查所选 server 的权限范围与数据处理策略，优先选 Google 官方 SDK 包装的实现，而非随机社区件**。 |

**凭证安全强制要求**（来自 `FULL_PLATFORM_DESIGN.md §5.2`）：Google Calendar / Gmail 的 OAuth token **永不下发任何端**，只存内核凭证代理 KMS 信封加密；MCP 工具调用经内核签名放行。这是接缝，不是可选项。

### 2.2 备用：googleapis npm SDK（直接调用，不经 MCP）

| 项 | 内容 |
|---|---|
| 来源 | npm: `googleapis` v144.x — https://github.com/googleapis/google-api-nodejs-client |
| 许可证 | Apache-2.0 |
| 提供什么 | Google 官方 Node.js SDK，覆盖 Calendar / Gmail / Drive 全部 REST API；完整 OAuth2 client 内置；TS 类型自动生成 |
| 集成成本 | **轻度封装** — 需自己包一层成 MCP tool 或 arclightagent 内置 tool |
| 成熟度与风险 | **生产可用，Google 官方维护**。直接调 SDK 比套 MCP server 多一层封装工作，但对 MCP server 质量不放心时这是更可控的替代 |
| 使用建议 | 若 MCP server 侧找不到质量可信的实现，用 `googleapis` 自包装一个薄 MCP server（<100 行 TS），封装成本可接受 |

---

## 三、提醒推送

### 3.1 直接采用：`web-push`（VAPID / Web Push Protocol）

| 项 | 内容 |
|---|---|
| 来源 | npm: `web-push` v3.x — https://github.com/web-push-libs/web-push |
| 许可证 | MIT |
| 提供什么 | 服务端 VAPID 密钥生成 + Web Push 协议实现；向浏览器/PWA Service Worker 推送通知；标准 W3C Push API |
| 集成成本 | **拿来即用** — 生成 VAPID 密钥对、存 subscription endpoint、`webpush.sendNotification()` 三步 |
| 成熟度与风险 | **生产可用**，周下载量 700K+，已在 `FULL_PLATFORM_DESIGN.md §4.1` 技术选型中明确列出（`web-push VAPID(MIT)`）。**已知限制（架构文件已收录）**：iOS Safari 仅 PWA 装主屏才生效，稳定性弱于移动原生 Push；Android Chrome/Firefox 全覆盖；这是 Web Push 的平台现实，不是 `web-push` 库的问题。 |

前端侧配套：`@serwist/next`（MIT）已在架构中选定，提供 Next.js Service Worker 集成，`web-push` 在服务端与之配合。

### 3.2 移动端补充（现在不要，PWA 优先）

| 方案 | 说明 |
|---|---|
| APNs（苹果原生） | Capacitor `@capacitor/push-notifications` + 苹果 APN HTTP/2 API；仅 Capacitor 路线才需要，PWA 路线不用 |
| FCM（Firebase Cloud Messaging） | Android Capacitor 路线备选；同上，PWA 路线不用 |

架构定案（`FULL_PLATFORM_DESIGN.md §8 附录 A`）：**PWA 首选 → iOS 推送不达标则 Capacitor → Tauri 2 移动排最后**。现阶段 Web 端 MVP，只上 `web-push`，APNs/FCM **后置**。

---

## 四、Plan/Act + Checklist

### 4.1 设计借鉴源（仅借设计，得自己写）

| 来源仓 | 可借鉴内容 | 复用性质 |
|---|---|---|
| cline（Apache-2.0） | `plan_mode_respond` 工具分离 plan/act 两模式；`FocusChainManager`（task_progress checklist 持久化 + chokidar 监听防目标漂移）；`TaskState` plan/act flag 集中管理 | **仅借设计**——cline 是 VSCode 扩展形态，核心 `Task` 类深绑 VSCode API，不能直接搬；但 Plan 模式下"只读探索、不触发工具副作用"的双模式逻辑 + checklist 持久化文件可完全移植为 TS 薄层 |
| codex（Apache-2.0） | `collaboration-mode-templates/templates/plan.md`（Plan Mode 提示词：只读探索 + 产出 decision-complete 的 `<proposed_plan>` + `PlanDelta` 流式）；`update_plan` 工具（待办/进度更新） | **提示词可直接复用**（Apache-2.0，遵循 NOTICE 义务）；`update_plan` handler 可参考移植（~50 行 TS） |
| opensquilla（Apache-2.0） | Meta-Skill 编排：SKILL.md composition 块声明 + MetaOrchestrator 拓扑序 sub-Agent；`meta-daily-operator-brief` 等 bundled skill | **SKILL.md 格式与 skill loader 逻辑可直接复用**（Apache-2.0）；注意区分 opensquilla-original SKILL vs. OpenClaw 派生 SKILL（架构文件 §3.5 已核验：`sub-agent`/`cron`/`github` 等 8 个是 OpenClaw MIT 派生，需追 attribution；`paper-*` 流水线是 opensquilla-original Apache-2.0） |

### 4.2 最小自研接缝

Plan/Act 双模式本身是 **薄自研**（~200 行 TS），核心逻辑：

```
type Mode = 'plan' | 'act'
// plan 模式：注入"只读探索"系统提示组件，工具集过滤掉所有写操作工具
// act 模式：完整工具集，task_progress checklist 落文件
// checklist 持久化：写 ~/.arclight/sessions/<id>/task_progress.md
// 文件监听：chokidar watch（MIT）防目标漂移
```

`chokidar`（MIT，npm）直接引入，不自研文件监听。

---

## 五、心跳协调器

### 5.1 设计借鉴源：opensquilla `scheduler/heartbeat.py`

| 项 | 内容 |
|---|---|
| 来源 | opensquilla `src/opensquilla/scheduler/heartbeat.py`（Apache-2.0） |
| 复用性质 | **仅借设计，得自己写** — 源码 Python，内核 TS/Bun，无法直接搬；但设计极完善：事件 coalesce 窗口合并 + 优先级带冷却 + 活跃时段掩码夜间不打扰 + poll 驱动非常驻后台任务 + `heartbeat_ticks` 表落盘（schema_version 字段） |
| 移植成本 | **~150 行 TS**，逻辑清晰，全量移植不超过半天 |
| 核心价值 | 主动提醒场景的节流器：夜间不打扰、突发事件不刷屏、poll 驱动便于测试与确定性 |

**心跳表持久化**：opensquilla 用 aiosqlite；arclightagent 内核用 Bun 内置 SQLite（`bun:sqlite`，零依赖，直接可用）。心跳 tick 落 `heartbeat_ticks` 表（含 `schema_version`、`priority_band`、`coalesced_at`），schema 跟随主库 migration。

---

## 六、许可证合规汇总

| 库/设计 | 许可证 | 操作要求 |
|---|---|---|
| `node-cron` | MIT | 无额外要求 |
| `web-push` | MIT | 无额外要求 |
| `googleapis` | Apache-2.0 | 保留 NOTICE 文件；若分发需含 Apache 声明 |
| MCP servers（官方） | MIT | 无额外要求 |
| codex `plan.md` 提示词 | Apache-2.0 | 根 `NOTICE` 记录派生来源（codex/openai） |
| opensquilla heartbeat 设计 | Apache-2.0（仅借设计，不搬代码） | 自写 TS 实现，无需 attribution |
| opensquilla SKILL（opensquilla-original） | Apache-2.0 | 保留 NOTICE；**不混入 OpenClaw MIT 派生的 8 个** |
| cline Plan/Act 设计 | Apache-2.0（仅借设计） | 自写 TS 实现，无需 attribution |
| `chokidar` | MIT | 无额外要求 |

---

## 七、仅保留的最小自研接缝

以下是真正需要写的"薄胶水"，**都不是轮子**：

1. **CronJobRegistry（~100 行 TS）**：套 `node-cron` 外的薄层；维护 job 表（SQLite `scheduled_jobs`）实现进程重启恢复；防重复执行（`job_id` 唯一键 + `last_run_at`）。
2. **HeartbeatCoordinator（~150 行 TS）**：移植 opensquilla `heartbeat.py` 设计；coalesce 窗口 + 优先级带 + 活跃时段掩码 + poll 驱动；落 `heartbeat_ticks` 表。
3. **PlanActController（~200 行 TS）**：管理 `mode: 'plan'|'act'` 状态；plan 模式过滤写操作工具；act 模式落 `task_progress.md` + `chokidar` 监听。
4. **CredentialProxy（凭证代理，~80 行 TS）**：存 Google OAuth token 进 KMS 信封加密；按动作签名放行；工具调用侧只收签名 URL，不见裸 token。这是**架构强制要求**（`FULL_PLATFORM_DESIGN.md §5.2`），不能省略。
5. **NotificationDispatcher（~80 行 TS）**：内核决定何时/是否发通知（夜间静默逻辑在内核）；实际投递按端：Web 调 `web-push`，CLI 打印，桌面调 Tauri notification API。

---

## 八、现在不要自研、推迟到产品成熟后的部分

| 组件 | 原因 |
|---|---|
| **BullMQ + Redis 任务队列** | MVP 单用户单进程，`node-cron` 已足够；多用户/多 worker 横向扩展时再上 |
| **Temporal 持久化工作流** | 需独立 Temporal server，工程重；长时程跨节点可靠工作流是产品成熟后的需求 |
| **APNs / FCM 原生推送** | PWA + `web-push` 优先；仅当 iOS Web Push 不达标且决定做 Capacitor 路线时才上 |
| **自研日历/邮件 OAuth 流程** | 先用 MCP server 或 `googleapis` 官方 SDK；OAuth server 是成熟基础设施，不要自造 |
| **自研 cron 表达式解析器** | `node-cron` 已有成熟实现；croniter（Python）或手写 JS 版均无意义 |
| **自研记忆巩固（Dream 等）** | 架构文件明确：MVP 不引 mem0/Zep；日常规划场景的 archival memory 待阶段四验证收益后再评估 |
| **GTD/OKR 结构化目标引擎** | 产品方向未定，不要提前在引擎层固化理念；先用 checklist + cron 覆盖 80% 场景 |

---

## 九、MVP 最小依赖集（阶段一 Web + 写代码真正需要的）

**阶段一 MVP = Web 单端 + 写代码单能力 + 单用户 + 本地沙箱**

日常规划子系统**不在阶段一交付**（架构排期：阶段四才上 cron + 日历 + Web Push）。但以下件需要**从第一天即纳入设计、但不必立即实现**：

| 类别 | 最少件 | 时机 |
|---|---|---|
| **阶段一实际需要** | 无（日常规划阶段四交付） | — |
| **阶段一应预留设计槽** | `CredentialProxy` 凭证代理接口（空实现占位）；`HeartbeatCoordinator` 接口（空实现）；SQLite `scheduled_jobs` 表 schema（migration 先建表，不写逻辑） | 阶段一 schema 版本里建表，避免后续 breaking migration |
| **阶段四最小实装集** | `node-cron`（MIT） + `web-push`（MIT） + Google Calendar/Gmail MCP server（MIT）或 `googleapis`（Apache-2.0）+ `chokidar`（MIT） + 自研 4 个薄接缝（CronJobRegistry / HeartbeatCoordinator / PlanActController / NotificationDispatcher） | 阶段四 |

**一句话**：阶段一只预留 schema 槽和接口占位符；阶段四用 `node-cron` + `web-push` + Google MCP（或 `googleapis`）+ 4 个薄接缝（共计约 530 行 TS）完成整个日常规划子系统，无需任何自研轮子。