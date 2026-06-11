我已掌握全部信息。关键事实已确认:codex 的横切代码(execpolicy/secrets/keyring-store/otel)是 Rust 写的(对 TS/Bun 内核只能"借设计、自己写"),opensquilla 的横切代码(safety/tool_tiers、permission_matrix、cost_rollup、pricing/usage)是 Python 写的(同样跨语言,只借设计)。蓝图已明确技术倾向:Auth.js/Clerk、OS keychain(`keyring` MIT/Apache)、Langfuse、W3C traceparent/OTel、Postgres RLS+Drizzle、≥10 golden eval。现在直接产出选型清单。

---

# arclightagent · 权限安全 + 横切地基子系统 · 拿来即用选型清单

> 总原则:现阶段最大化复用现成成熟实现,自研只留薄接缝,自研推迟到产品成熟后。
> 范围:认证 / 密钥 / 计费计量 / 可观测 / eval / 多租户隔离 / 权限审批。
> 已对齐蓝图既定倾向(`ARCHITECTURE_BLUEPRINT.md` §5.5/§5.6/§2.1、`FULL_PLATFORM_DESIGN.md` §5.6/§5.5)。
> **关键前提结论**:11 个参考仓里与本子系统相关的横切代码——codex 的 `execpolicy`/`secrets`/`keyring-store`/`otel`/`process-hardening`(全 Rust)与 opensquilla 的 `safety/`、`session/cost_rollup.py`、`engine/pricing.py`/`usage.py`、`safety/permission_matrix.py`(全 Python)——**两仓均为 Apache-2.0(许可证允许搬),但语言均非 TS/Bun**。因此对纯 TS/Bun 内核它们一律是「仅借设计、得自己写」,**不能直接复用代码**。能直接拿来用的现成件,全部来自 TS/JS 的 npm 生态。

---

## 一、认证 / 授权(Auth)

**1) 直接采用的现成方案**
- **MVP(阶段一,Web 单端 + 单用户)**:**不引任何认证库**。采用「localhost loopback bearer token」信任模型——内核 `server.json` 写入 `0600` 权限的短 TTL token,端通过 `Authorization: Bearer` 调内核(蓝图 `FULL_PLATFORM_DESIGN.md` 第522行 M4 纪律)。这是「现成机制 + 薄接缝」,零外部依赖。
- **多端起(阶段五)**:**Auth.js (NextAuth) v5**(`next-auth`,npm,**ISC/MIT**)——与 Next.js 前端一体,内置 OAuth2.1/PKCE、session 管理、Drizzle adapter(`@auth/drizzle-adapter`),开箱给「用户登录 arclightagent 本身」的一等身份体系。
- **托管 SaaS 替代(可选)**:**Clerk**(`@clerk/nextjs`,商业 SaaS + 免费档,SDK 为 MIT)——若不想自管 session/找回/MFA,Clerk 提供组织/多租户(Organizations)开箱即用,直接出 `userId`+`orgId(tenantId)`。

**2) 集成成本**:MVP loopback token = 拿来即用(纯接缝);Auth.js = 轻度封装(配 provider + adapter);Clerk = 拿来即用(但引入厂商依赖)。

**3) 成熟度与风险**:Auth.js v5 生产可用,但 v5 长期 beta、文档与 v4 混杂,升级 breaking 多——**坑:看似拿来即用,实际 callback/session 策略与 Drizzle adapter 接线需较多调试**。Clerk 生产可用但厂商锁定 + 按 MAU 计费。

**4) 最小自研接缝**:① 认证中间件从 token/OAuth claim 解出 `userId`+`tenantId` 注入每请求上下文(蓝图 §208 传播链);② loopback token 的 pid 绑定 + owner 校验。**这俩是接缝,不是轮子。**

**5) 现在不要自研、推迟到产品成熟后**:自建用户库/密码哈希/会话存储/MFA/SSO/设备码流——全部推迟,届时用 Auth.js/Clerk 现成能力。

---

## 二、密钥管理(Secrets)

**1) 直接采用的现成方案**
- **本地(MVP)**:**`keytar` 的现代继任者**——优先 **`@napi-rs/keyring`**(npm,**MIT**,Rust napi 实现,跨平台 Keychain/DPAPI/libsecret,无 node-gyp 编译痛点);备选老牌 **`keytar`**(npm,MIT,Electron 社区维护,但已 archived/维护停滞,**坑:node-gyp 原生编译在 Bun 下易踩坑**)。提供 OS keychain 读写,满足蓝图「禁明文 `~/.config`」硬约束。蓝图已点名 `keyring` MIT/Apache 合规。
- **多租户(阶段五)**:**信封加密 KMS**——自托管选 **Infisical**(`@infisical/sdk`,npm;Infisical 核心 **MIT**,部分企业功能 商业)或 **HashiCorp Vault**(`node-vault`/官方 SDK;Vault 自 1.15 起 **BUSL-1.1**,自用 OK、再分发需注意)或云 **AWS KMS/GCP KMS**(官方 SDK,按调用计费)。给「provider key/MCP token/Google 凭证」做信封加密 + 轮换。

**2) 集成成本**:`@napi-rs/keyring` = 拿来即用;KMS/Vault = 需较多缝合(信封加密封装 + 轮换策略 + 凭证代理对接)。

**3) 成熟度与风险**:`@napi-rs/keyring` 生产可用、Bun 友好;`keytar` 生产可用但**维护停滞 + gyp 编译风险**,新项目不建议。Vault BUSL 许可证需法务确认再分发场景。

**4) 最小自研接缝**:① 「沙箱外凭证代理」——按动作签名放行,沙箱内零真实凭证(蓝图 M1,这是 arclightagent 的差异化安全设计,必须自研但只是薄编排层);② keychain 读写的统一 `SecretStore` 接口(本地 keychain / 远程 KMS 双实现)。

**5) 现在不要自研、推迟到产品成熟后**:自研加密算法、自建 KMS、密钥轮换调度器——推迟,届时接 Infisical/Vault/云 KMS。

---

## 三、计费 / 计量(Metering & Billing)

**1) 直接采用的现成方案**
- **token 用量来源**:**直接用 SDK 回传的 usage**——Vercel AI SDK(`ai`,Apache-2.0)的 `result.usage`(promptTokens/completionTokens)、或 LiteLLM Proxy 的 `/spend` 端点已自带成本核算。**不需要自己数 token**;若要本地估算用 `tokenlens` / `gpt-tokenizer`(MIT)。
- **定价表**:**借鉴 opensquilla `engine/pricing.py` 的「provider→model→单价」表设计**(Apache-2.0,但 Python,得自己用 TS 重写一张 JSON 表),或直接消费 LiteLLM 的 `model_prices_and_context_window.json`(BSD,可直接当数据源)。
- **MVP 计费骨架**:**薄自建计数**——`usage(tenant_id,user_id,session_id,model,in_tok,out_tok,cost,ts)` 一张表 + quota 检查。这是蓝图明确的「自建薄计数」(`ARCHITECTURE_BLUEPRINT.md` §455「per-user token 计数 + quota」)。
- **成熟 metering(推迟用)**:**OpenMeter**(`@openmeter/sdk`,npm;OpenMeter 核心 **Apache-2.0**)做事件计量 + 聚合;计费收款用 **Stripe**(`stripe`,npm,MIT SDK)的 usage-based billing。

**2) 集成成本**:MVP 薄计数 = 轻度封装(一张表 + 中间件埋点);OpenMeter/Stripe = 需较多缝合(事件管道 + 对账 + webhook)。

**3) 成熟度与风险**:SDK usage 直接读 = 生产可用、零风险。**坑:多代理 ~15× token 放大**(蓝图反复强调),必须 per-subagent span 归因,否则成本不可控——这是计量设计的真实难点,不是库的问题。OpenMeter 生产可用但对个人 MVP 偏重。

**4) 最小自研接缝**:① 在内核 provider 代理处埋点写 usage 表;② quota 在内核强制(端只展示余量);③ per-user/per-session/per-subagent 成本归因(借 opensquilla `cost_rollup.py` 设计)。**接缝,不是轮子。**

**5) 现在不要自研、推迟到产品成熟后**:自建计量聚合引擎、发票/订阅/收款系统、用量分析仪表盘——推迟,届时接 OpenMeter + Stripe。MVP 只要「能数 + 能限额 + 能归因」。

---

## 四、可观测(Observability)

**1) 直接采用的现成方案**
- **LLM trace**:**Langfuse**(`langfuse` / `@langfuse/*` npm SDK,SDK 与核心 **MIT**,可自托管或云)——蓝图已点名。直接接,给每步 reasoning/tool-call/token 用量的 span 树。**单次 research 可产 40-200 span**,Langfuse 专为此设计。
- **通用 trace/metrics**:**OpenTelemetry JS**(`@opentelemetry/*`,Apache-2.0)——W3C `traceparent` 跨端透传(蓝图 §553),内核据此挂同一 trace(Web 发起、CLI 续跑是一条连续 trace)。Vercel AI SDK 原生支持 OTel telemetry(`experimental_telemetry`),直接打开即可。
- **指标**:**Prometheus**(`prom-client`,npm,Apache-2.0)。
- **替代(可选)**:**Helicone**(1 行改 baseURL 代理即接,SDK MIT;但走代理意味着流量经第三方,与「数据不出本机」默认相悖,**仅 opt-in**)。

**2) 集成成本**:Langfuse + AI SDK telemetry = 拿来即用(SDK callback / 包裹);OTel 跨端 traceparent = 轻度封装(中间件透传);Prometheus = 拿来即用。

**3) 成熟度与风险**:Langfuse、OTel JS、prom-client 全生产可用。**坑:** OTel JS 的 auto-instrumentation 生态庞杂、版本碎片化,Bun 运行时对部分 instrumentation 兼容性需验证——建议只用手动 span + AI SDK 内建 telemetry,**别一上来全套 auto-instrument**。

**4) 最小自研接缝**:① W3C traceparent 跨端透传中间件;② 统一审计日志去向(认证失败/权限提权/计费/computer-use 放行落一处)——这是「统一去向」编排,不是日志库,用 `pino`(MIT)输出即可。

**5) 现在不要自研、推迟到产品成熟后**:自建 trace 后端、指标存储、告警系统——推迟。MVP 接 Langfuse + 结构化日志(`pino`)即可,Prometheus/告警阶段二再上。

---

## 五、评测(Eval)

**1) 直接采用的现成方案**
- **eval harness**:**promptfoo**(`promptfoo`,npm/CLI,**MIT**)——直接拿来跑 ≥10 条 golden 编码 case(蓝图 §326/§455 硬要求)。YAML 定义 test + assertion(含 LLM-rubric、文件 diff、自定义 JS assertion),CLI/CI 可跑,作为「移植无能力退化」回归基线。
- **备选**:**Vitest**(`vitest`,MIT)直接写 10 条断言式 golden case——若不想引 promptfoo 的 YAML DSL,用已有测试框架写 eval 更轻、零新依赖。

**2) 集成成本**:promptfoo = 拿来即用(写 YAML);Vitest golden = 拿来即用(团队已有 TS 测试栈)。

**3) 成熟度与风险**:promptfoo 生产可用、社区活跃。**坑:** promptfoo 面向「prompt/模型对比评测」,而蓝图要的是「编码任务端到端(多文件改 + 跑测试 + 验证 + 回滚)无退化」——这类 agentic golden case 用 promptfoo 的 provider 抽象包内核反而绕,**很可能 Vitest 直接驱动内核跑 10 个真实任务更直接**。建议:MVP 优先 Vitest golden,promptfoo 留给「模型分层路由」阶段做成本-质量基线对比。

**4) 最小自研接缝**:10 条 golden 编码 case 的输入/期望/校验脚本(这是项目专属内容,必须自写,但只是数据 + 断言,不是 harness 轮子)。

**5) 现在不要自研、推迟到产品成熟后**:自建 eval 平台、自动评分模型、回归看板——推迟。MVP 只要「10 case 能跑能通过/失败」。**注意蓝图红线:无 eval 不谈自动降级路由**,所以 eval 是阶段一一等交付,不可省。

---

## 六、多租户隔离(Multi-tenancy)

**1) 直接采用的现成方案**
- **ORM**:**Drizzle ORM**(`drizzle-orm`,npm,**Apache-2.0**)——蓝图已定。SQLite(MVP)→ Postgres(阶段五)平滑迁移,schema 即 TS。
- **租户隔离(阶段五)**:**Postgres Row-Level Security(RLS)**——Postgres 原生能力,Drizzle 通过 `sql` 模板设 `SET app.current_tenant` + RLS policy 实现。可选现成封装 **`drizzle-orm` 的 RLS 辅助**(Drizzle 已内建 `pgPolicy`/`crudPolicy` 支持,Neon/Supabase RLS 一等)。
- **MVP**:**不开 RLS**,但数据访问层「从第一天以 `tenant_id` 维度建模」(蓝图 §296 硬纪律)。

**2) 集成成本**:Drizzle + tenant_id 建模 = 拿来即用;Postgres RLS = 需较多缝合(policy 编写 + 每查询 set tenant + 测试跨租户不泄漏)。

**3) 成熟度与风险**:Drizzle、Postgres RLS 全生产可用。**坑:** RLS policy 写错 = 静默跨租户泄漏(高危),必须有「跨租户访问返回空/403」的专门测试;`SET app.current_tenant` 在连接池下需用 `SET LOCAL` + 事务包裹,否则连接复用串租户——**这是 RLS 最常见的生产事故**。

**4) 最小自研接缝**:① 每请求 `tenant_id` 下沉数据层(MVP 带列,远程升 RLS)的访问层包装;② 「沙箱 per-tenant 隔离」编排(不同用户代码/浏览器会话不共享执行域)——这是策略接缝,沙箱本身已定案。

**5) 现在不要自研、推迟到产品成熟后**:schema-per-tenant 自动化、跨租户数据迁移工具、RLS 全套——MVP 单用户不需 RLS,只需 tenant_id 建模。RLS 推迟到阶段五迁 Postgres 时。

---

## 七、权限审批 / 命令策略(Approval & Policy)

**1) 直接采用的现成方案**
- **结论:此处无可直接安装的成熟 TS policy 引擎适配 agent 场景**——codex 的 `execpolicy`(`.policy` DSL + allowlist)与 opensquilla 的 `safety/tool_tiers.py`(RiskTier 三档)、`permission_matrix.py`(渠道矩阵 fail-closed)都是范本级设计,但**前者 Rust、后者 Python,均 Apache-2.0 可借设计但不能搬代码**。
- **可借的现成通用件**:命令解析用 **`shell-quote`**(MIT)安全分词;若要规则引擎可用 **OPA/Rego**(`@open-policy-agent` WASM,Apache-2.0)——但对 MVP「仅命令黑名单」是过度设计,**不引**。
- **MVP**:**薄自研** approval presets(read-only/auto/full-access)+ 命令黑名单(蓝图 §48/§456「approval + 命令黑名单」),设计直接照搬 codex approval modes + opensquilla RiskTier×渠道矩阵 fail-closed 的思路。

**2) 集成成本**:轻度封装(规则表 + 黑名单 + 审批事件,设计现成、代码自写)。

**3) 成熟度与风险**:**坑:这是本子系统里「最像有现成方案、实则必须自研」的一块**——市面 policy 引擎(OPA/Cedar)都不是为「agent 命令审批 + 渐进信任 allowlist + turn 内提权」设计的,硬套反而更重。诚实结论:**借 codex/opensquilla 设计、用 TS 薄自研**,比引任何通用 policy 引擎都划算。

**4) 最小自研接缝**:① `AskForApproval × PermissionProfile` 预设;② 命令黑名单 + 前缀 allowlist 渐进免审批(借 codex `ExecPolicyAmendment`);③ RiskTier 三档 × 渠道矩阵 fail-closed(借 opensquilla);④ 审批事件经 SSE 回前端模态(借 cline `bridgePermissionCallbacks` 思路)。**全是接缝,不是轮子。**

**5) 现在不要自研、推迟到产品成熟后**:execpolicy 的完整 DSL、规则+LLM 分类器+硬黑名单三道闸的后两道、可演进 policy 治理(codex `guardian`)——推迟。MVP 只要第一道「命令黑名单 + approval presets」。

---

## 八、MVP 最小依赖集(阶段一:Web + 写代码,真正需要的最少现成件)

| 子系统 | MVP 最小现成件 | 许可证 | MVP 形态 |
|---|---|---|---|
| 认证 | **无库**:loopback bearer token(`0600` + pid 绑定) | — | 纯接缝,单用户 localhost 信任 |
| 密钥 | **`@napi-rs/keyring`** | MIT | OS keychain 存 provider key,禁明文 `~/.config` |
| 计费计量 | **AI SDK `result.usage`** + 自建一张 `usage` 表 + quota | Apache-2.0(ai) | per-user token 计数 + 限额(薄自建) |
| 可观测 | **Langfuse SDK** + **`pino`** 结构化日志 | MIT | trace + 统一审计去向(Prometheus/OTel 阶段二) |
| eval | **Vitest** 写 ≥10 golden 编码 case(promptfoo 后置) | MIT | 移植无退化基线(阶段一一等,不可省) |
| 多租户 | **Drizzle ORM** + 全表 `tenant_id` 建模(不开 RLS) | Apache-2.0 | SQLite 单用户,但从第一天按 tenant_id 建模 |
| 权限审批 | **薄自研** approval presets + 命令黑名单(借 codex/opensquilla 设计) | — | 第一道闸;`shell-quote`(MIT)做安全分词 |

**MVP 一句话定调**:这一阶段**唯二真正"安装即用"的库是 `@napi-rs/keyring`(密钥)、`langfuse`(可观测),外加已在内核栈里的 `ai`/`drizzle-orm`/`pino`/`vitest`**;认证(loopback token)、计费(usage 表 + quota)、权限审批(presets + 黑名单)、多租户(tenant_id 建模)四块**全是借现成设计的薄自研接缝,不引重型库**。所有「重型现成方案」——Auth.js/Clerk、KMS/Vault/Infisical、OpenMeter/Stripe、Prometheus/OTel 全套、promptfoo、Postgres RLS——**一律推迟到阶段五(多端 + 多租户服务化)**,符合「自研只留薄接缝、把重活推迟到产品成熟后」的总原则。

**许可证总账(本子系统范围内)**:拟用现成件全部为 MIT / Apache-2.0 / ISC / BSD,**零 GPL/LGPL**,对再分发友好;唯一需法务确认的是若选 **Vault(BUSL-1.1)**——但 Vault 是阶段五可选项,且有 Infisical(MIT)/云 KMS 替代。从 codex(Apache-2.0)、opensquilla(Apache-2.0)「借鉴」的全部是**设计而非代码**(语言不匹配),不触发任何 NOTICE/归属义务。