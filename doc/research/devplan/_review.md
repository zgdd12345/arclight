I now have full grounding for the consistency verdict. The key divergence is clear and confirmed: all three upstream docs (blueprint §2.1/§4.1, full-platform §4.1, 选型清单 §2.4 + dependency list) prescribe **Vercel AI SDK v6 + `useChat` + `@assistant-ui/react-ai-sdk` (AISDKRuntime)** for the frontend, with `ai` listed as a *frontend* dependency. The dev plan unilaterally switches to **ExternalStoreRuntime + zero `ai` in frontend** and calls it a "细化裁定". The 选型清单 mentions both "ExternalStore/AISDKRuntime" as the bridge target but its dependency list and §4.1 design name AISDKRuntime + frontend `ai`. This is a substantive architectural divergence dressed as a refinement — worth flagging, though technically the plan's reasoning (ArcEvent has no native UIMessage representation for epoch/resync/approval) is sound.

I have everything needed. Writing the adversarial review now.

---

# 对抗式技术评审：《arclightagent 开发方案（阶段一）》

> 默认它过于乐观。已对 5 份源文档逐条 Read 核对。结论先行：**方向与量级口径（6000-9000+ 行、主循环/前端非薄接缝）是诚实的，切片可演示性总体成立**；但仍有 1 处真·架构矛盾、若干处把"接现成"说轻的复发、3 处 WBS 缺失任务、2 处过度设计前置。逐项如下。

---

## 一、必须修复（硬伤，落地前必须解决）

### MF-1 前端 Runtime 选型与 3 份源文档直接矛盾，"细化裁定"措辞掩盖了实质偏离
方案 §2.2 把 `ExternalStoreRuntime` 称作"对选型清单 §2.4 的**细化裁定而非偏离**"，并令**前端零 `ai` 运行时**。但核对源文档：
- `ARCHITECTURE_BLUEPRINT.md:106`：前端 AI 层 = **AI SDK v6（streamText/useChat）+ assistant-ui**，卖点明确写"**useChat resume**"。
- `FULL_PLATFORM_DESIGN.md:307`：技术选型 = **Vercel AI SDK v6（`useChat` 流式）**。
- `拿来即用-全栈选型清单.md:60/126/234`：前端 AI UI = `@assistant-ui/react` + **`@assistant-ui/react-ai-sdk`（AISDKRuntime）**，且依赖集第 234 行**把 `@assistant-ui/react-ai-sdk` 列为前端硬依赖**。

三份文档一致以 **AISDKRuntime + 前端带 `ai`** 为既定路线；方案把它换成 **ExternalStore + 前端禁 `ai`** 并删除 `@assistant-ui/react-ai-sdk` 依赖。这**不是细化，是选型替换**。技术理由本身站得住（ArcEvent 的 `seq/epoch/resync/permission.ask` 在 AI SDK `UIMessage` 协议里确无原生表达，硬套 AISDKRuntime 会丢 epoch 续接），但必须**以"修订源文档选型"的姿态显式记账**，而非用"细化裁定"一笔带过——否则下游实现者拿着选型清单装了 `react-ai-sdk` 又按方案走 ExternalStore，两套 runtime 心智打架。
**修复**：把它写成对选型清单 §2.4 的**正式选型修订**，同步删除选型清单/blueprint 里"useChat resume"作为卖点的表述，并在 NOTICE/决策记录里留痕。

### MF-2 `useChat resume` 被静默否定，但"刷新不丢"的源文档承诺挂在它上
blueprint 把 "useChat resume" 当作前端不造轮子的核心理由（:106）。方案改用手写 `fetch`+`ReadableStream` SSE 解析（§2.2，~120 行）后，**useChat 这条"现成续接"能力链整体作废**——这恰恰意味着续接、coalescing、去重、退避全部落到自研 `EventStreamManager`。方案在 §2.2 已认领这部分工程（计入 1500-3000 行），**逻辑自洽**，但它没有回头声明"blueprint 的 useChat resume 路线作废"。这是 MF-1 的连带账，一并修。

### MF-3 沙箱"三级回退"在阶段一 WBS 里只实现了一级，DoD 却承诺三级语义
方案 §6 R3、§2.3、DoD §5.2.4 反复承诺 `local-nono → docker-fallback → opt-in 远程 → 拒绝` 四级阶梯，CI 还"直接用 docker-fallback"。但 slice2 的 WBS 只建 `sandbox/backends/localNono.ts`，**`dockerFallback.ts` / `remoteVercel.ts` 没有任何 slice 认领其实现工时**（目录树 §1.2 列了文件，WBS §4 无对应任务）。若 CI 真要走 docker-fallback（§3.4），那 `dockerFallback` 就是**阻塞 CI 跑通的前置**，不能当"以后再说"。源文档 `P0-沙箱方案.md:78` 把降级阶梯列为硬要求。
**修复**：把 `dockerFallback` 实装明确塞进 slice0 或 slice2（CI 依赖它），`remoteVercel` 可诚实标"阶段二 opt-in，阶段一只留 interface stub + 返回 `SANDBOX_UNAVAILABLE`"。

### MF-4 `ai` 版本 `~6.x` 与 provider 数量承诺不一致
方案 §0 栈表写 `ai ~6`、§1.4 依赖写 `@ai-sdk/anthropic`，DoD/eval 全程单 provider（Anthropic）。但 blueprint 阶段一交付物 #1（:469）写"AI SDK + LiteLLM，**至少 Anthropic/OpenAI/Gemini**"。方案把多 provider 砍成单 provider（且不起 LiteLLM）——这其实是**合理收窄**（选型清单 §2.3 也支持单 provider 成本最优），但与 blueprint 阶段一交付物字面冲突。属"方案比源文档更紧"的善意偏离，**需在一致性声明里显式记一笔"阶段一收窄为单 provider，多 provider 降阶段二"**，否则验收时会被 blueprint #1 卡。

---

## 二、工作量现实性核对

### 总量口径：诚实，未缩水 ✅
方案全程坚持 **6000-9000+ 行**、主循环 800-1500、前端 1500-3000+、编码链 2000-2800，与选型清单 §5.1 重估表、blueprint 决策记录 v2 第 4 条**逐条对齐**，没有把前端折叠回 200 行 ArcTransport 的旧病复发。这一点过关。

### 但 1-3 人扛不动的隐忧（方案过于乐观处）
- **`queryLoop` 借 pi 省力假设被我实测证伪——方案自己也说了，但 demo 排期没给够缓冲**。核对 `pi/packages/agent/src/agent-loop.ts`：pi 的循环是 **callback/emit 模型**（`AgentEventSink = (event) => Promise<void>`，:25），**不是 async-generator**。方案 §2.1 诚实写了"把 pi 的 `emit(AgentEvent)` 回调换成 `yield ArcEvent`"——但这是**把整个控制反转翻过来**（push→pull），不是"借代码"，是"借结构、重写执行模型"。pi 的 `runLoop`（:155）整个流程都建在 `await emit(...)` 串行副作用上，改成 generator 后**审批挂起（`awaiting_approval` 不占 provider 调用）、`.return()` 触发 `finally` 清理、单 SQLite 事务内 seq+yield 原子性**这三件都得重写。800-1500 行的下沿（800）偏乐观，按这个改造量更可能贴上沿（1500）。slice2 把"queryLoop 主干"和"provider-adapter"塞同一个 slice，对 1-3 人是**最容易拖期的单点**。
- **slice6 塞了太多**：反射闭环 + usage/SessionStatusBar + 单级压缩（compaction）+ 补齐 10 条 golden + eval.yml + license-gate.yml + pino + auditLog + traceparent。**单级压缩本身是 200 行带 epoch 边界的独立硬骨头**（选型清单 §5.1 #5），和反射闭环挤在收尾 slice，是典型"末期堆积"。建议把 compaction 上提到 slice5 或独立成 slice5.5。

### 编码链 2000-2800：基本对齐，但 RepoMap 行数下沿偏乐观
方案 §2.3 RepoMap ~400 行"逐字对齐 aider"。我核对了 `aider/repomap.py:487-514`：`×10`（mentioned）/`×10`（长标识符 ≥8）/`×0.1`（`_` 前缀）/`×0.1`（过度定义 >5）/`×50`（chat referencer）/`sqrt(num_refs)` **全部属实**，自环 `weight=0.1`（:479）也对。但方案漏了一个坑：aider 的长标识符判定是 **`is_snake or is_kebab or is_camel` 且 `len>=8`**（:489-494，三种命名风格分别判定），不是简单"长标识符"。TS 移植这段命名风格检测 + `tree.delete()` WASM 无 GC 管理，~400 行是**下沿**。

---

## 三、伪轻量警示（"接现成"说得太轻的地方）

### PL-1 ✅ 已自带免疫：Bun 原生模块 / tree-sitter WASM / CheckpointTracker 剥 VSCode
难得地，方案**没有**犯选型清单 §0.2 点名的伪轻量病：
- node-pty / web-tree-sitter / nono **第一周强制 smoke test**（§3.3），且标 blocking，与选型清单 #12 一致。
- tree-sitter WASM 坑（`Parser.init()` 全局一次、`locateFile` 指 node_modules、`tree.delete()` 必调、每语言独立 `Language.load`）在 §2.3 ① 逐条列出，**这是真做过功课**。
- CheckpointTracker 剥 VSCode 在 §2.3 ③ 列了具体剥离项（`MultiRootCheckpointManager`/folder-lock/gRPC/`vscode.workspace`→`ToolContext.cwd`/`globby`→`Bun.Glob`），R7 也认领了余量。

### PL-2 ⚠️ aider editblock "借算法"被低估为 ~350 行
方案 §2.3 ② 说"MVP S1 只跑阶梯 1-3，fuzzy 作 S2 opt-in（aider 当前默认关 edit-distance fuzzy，L183 提前 return）"。我核对 `editblock_coder.py:183`：**确有裸 `return` 挡在 fuzzy 之前（:184-187 死代码）**，方案这个事实陈述**精确无误**。但"借算法"省不掉的是 `try_dotdotdots`（:190-214 省略号配对，`Unpaired ... → ValueError`）、`replace_part_with_missing_leading_whitespace`（:243）、`find_similar_lines` 0.6 阈值的 "Did you mean" —— 这些是 Python 正则 + 启发式的**逐行 TS 重写**，~350 行偏紧，~280→实际更可能 350-450。属"轻度低估"，非硬伤。

### PL-3 ⚠️ `bun --hot` + Next.js `next dev` 并行 dev 脚本（§1.3）的 Bun 兼容性没进 smoke
方案根 `package.json` 的 `dev` 脚本并行起 `core(bun --hot)` + `web(next dev)`。Next.js 15 在 Bun runtime 下的开发服务器兼容性**不在第一周 smoke 清单**（§3.3 五项都是内核侧原生模块）。Next 官方支持的是 Node，Bun 跑 `next dev` 历来有边缘问题。这是个**未登记的 runtime 假设**——建议要么把 web 端明确跑在 Node（而非 Bun），要么补一条 smoke。

### PL-4 ⚠️ `@anthropic-ai/tokenizer` 计 token（§2.1 压缩）的依赖未进 §1.4 依赖集
方案 §2.1 说压缩用 `@anthropic-ai/tokenizer` 计数"不自研"，但 §1.4 npm 依赖边界**没列这个包**。小账，但 compaction slice 会缺依赖。

---

## 四、缺失项（回滚/错误处理/并发/取消在 WBS 里是否有对应任务）

| 语义 | 设计中有否 | WBS 有无对应任务 | 判定 |
|---|---|---|---|
| **回滚 /undo** | §2.3 ③ 有（二分定位 sha + reset --hard） | ✅ slice4 明确 | 过 |
| **取消/中断** | §2.1 双路径汇于 AbortController，写得很细 | ✅ slice3 隐含、queryLoop 可测点列了"中断传播" | 过 |
| **错误 envelope** | 5 键，§2.1/§2.3 多处 | ✅ slice2 验收"失败抛 5 键 envelope" | 过 |
| **并发分批** | 只读≤8 / 写串行 | ✅ slice2 验收 | 过 |
| **MISSING-1：`docker-fallback` 实装** | §6 R3 承诺 | ❌ **无 slice 认领**（见 MF-3） | **缺** |
| **MISSING-2：MCP 接入 + Tool Poisoning 审计** | §1.2 目录有 `mcp/{adapter,audit,credentialProxy}.ts`，§0 栈表列 `@modelcontextprotocol/sdk` | ❌ **6 个 slice 无一实现 MCP**；blueprint 阶段一交付物 #5（:473）**把 MCP 接入列为一等交付** | **缺/矛盾** |
| **MISSING-3：DB 迁移/并发写冲突纪律** | §1.3 提 `db:generate/migrate` | ⚠️ slice0 建表，但 **drizzle 迁移并行冲突**（选型清单 §1 "迁移并行冲突需纪律"）无对应任务/测试 | 弱缺 |
| **MISSING-4：`/redo`** | Demo 剧本 §5.3 步骤⑤明说"再 redo" | ❌ slice4 只做 `/undo`，**redo 无 WBS、无验收** | **缺**（Demo 承诺了实现没有） |

**最严重的是 MISSING-2**：方案把 MCP 列进栈表、目录、依赖三处，营造"阶段一有 MCP"的印象，但 **6 个 slice 没有任何一条实现 MCP adapter / audit / credentialProxy**，而 blueprint 阶段一交付物 #5 把 MCP 接入定为**一等不可省**。要么诚实地把 MCP 降到阶段二（并从栈表/目录移除或标 stub），要么补一个 slice。当前是"画了饼没排期"。

---

## 五、可砍项 / 过度设计（阶段一塞了该后置的东西）

### OD-1 `api/proxy/[...path]/route.ts`（Next.js 透传层）是阶段一不必要的中间层
方案目录 §1.2 web 端有 `app/api/proxy/[...path]/route.ts`"MVP 透传 localhost Hono"。但本地优先拓扑下 **Web 与 Hono 内核同源同机**（`arclight serve` 同托管），前端直连 `localhost:port` 即可，`FULL_PLATFORM_DESIGN.md:315` 硬约束②还专门说"前端直连独立部署内核，SSE 不经 Vercel 函数代理"。**多塞一个 Next API proxy 层 = 多一跳、多一处 SSE 流式转发的 backpressure/超时坑**（Next route handler 转 SSE 有自己的超时问题）。阶段一**应砍**，直连内核；真要跨域再用 §2.2 已设计的 `fetch`+bearer。

### OD-2 `traceparent` / W3C OTel 接口预留（slice6）属阶段二关注点前置
方案 §3.4 在 slice6 注入 `traceparent` 经 Hono 中间件 → ToolContext → ArcEvent.meta"为 OTel 留接口"。选型清单 §2.5 明确 **OTel 全套后置、Langfuse 降阶段二、MVP 仅 pino**。阶段一塞 traceparent 透传链虽轻（中间件几行），但属"为没上的 OTel 预埋"，是典型 YAGNI。**可砍或降为"留 meta 字段不接线"**。

### OD-3 `epoch-jump 全量 resync` 在阶段一是否值得做满，存疑（可保留但标风险）
三续接路径（增量/buffer-expired/epoch-jump）方案 slice1 就要做满。但 **epoch-jump 只在压缩边界触发**，而压缩（compaction）排在 slice6。也就是说 **slice1-5 全程没有真实 epoch 递增源**，epoch-jump 路径在 slice1 做完后**到 slice6 之前无法被真实触发测试**，只能 mock。这不算过度设计（续接是脊柱，早做对），但**排期上有"测试悬空"问题**：建议 slice1 先做①②两路径 + epoch-jump 的**接口与 409 分支**，把 epoch-jump 的端到端验收**绑到 slice6**（压缩落地后）。当前 slice1 验收"409 epoch-jump → snapshot 全量重建"在 slice1 阶段无法用真实压缩触发。

### OD-4 `secrets_metadata` / `usage` 等 12 表全量建于 slice0——可接受，不砍
有人会说阶段一用不到 `secrets_metadata`。但源文档 `P0 施工图` 明确"第一天 12 表全建 + tenant_id 建模"防 breaking migration，方案遵守，**这是对的，不砍**。

---

## 六、总评

**一句话**：这是一份**罕见地诚实**的开发方案——它没有复发"伪轻量"主病（量级、smoke、WASM 坑、剥 VSCode 全部认领），切片划分总体可逐片演示，与源文档的数据模型/协议/沙箱/许可证**绝大部分逐条对齐**。它的问题不是"过度乐观地缩小工程量"，而是**几处"画了饼没排期"和一处"选型替换伪装成细化"**。

**按严重度排序的修复清单**：
1. **MF-1 / MF-2（必修）**：ExternalStore 替换 AISDKRuntime + 废 useChat resume，须正式记为**选型修订**，同步改源文档，删 `@assistant-ui/react-ai-sdk` 依赖的矛盾。
2. **MISSING-2（必修）**：MCP 接入在 6 个 slice 全部缺席却列进栈表/目录/依赖，与 blueprint 一等交付 #5 冲突——补 slice 或诚实降级。
3. **MF-3 / MISSING-1（必修）**：`docker-fallback` 是 CI 前置却无 slice 认领。
4. **MISSING-4（必修）**：Demo 承诺的 `/redo` 无实现无验收。
5. **MF-4（记账）**：单 provider 收窄须显式对齐 blueprint #1 的"至少三 provider"。
6. **工作量（调排期）**：slice2 的 queryLoop（pi 是 emit 模型，改 generator 是控制反转重写，800 下沿偏乐观）和 slice6 的过载（compaction 上提）。
7. **可砍**：OD-1 Next api/proxy 透传层（直连内核）、OD-2 traceparent 预埋。

**放行判断**：方向、量级、切片骨架**可作为施工基线**；但上述 4 个"必修"（尤其 MCP 缺席与 ExternalStore 选型记账）不补，下游会按错误的一致性假设施工。**修订后可施工，当前版本不可直接开工。**

**核对覆盖**：5 份源文档 + pi `agent-loop.ts`（实测 emit 模型）+ aider `repomap.py`（实测权重）+ `editblock_coder.py:183`（实测 fuzzy 默认关 L183 return）均已 Read 比对，方案对这三处代码事实的引用**全部属实**。