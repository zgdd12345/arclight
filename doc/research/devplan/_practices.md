文档已写入 `/Users/fsm/project/arclightagent/research/工程实践与测试eval策略.md`。以下是各节要点汇总：

---

**① TDD 流程**

vitest 分两套 config：单元测（`pool:forks`，30s timeout，v8 coverage 70%/70%/60%）和集成测（`singleFork:true`，120s）。核心设计：`queryLoop()` 用 `async function*` + 依赖注入（`QueryLoopDeps` 接口注入 `streamTurn/executeTool/emit/compactor`），单元测全 mock，无需启动 HTTP server 也无需调真实 API。前端 `ArcTransport` 把 `foldEventsToMessages()` / `deriveApprovalState()` 抽为纯函数，可独立 vitest；组件层用 MSW mock SSE endpoint。

**② Golden Eval Harness**

目录结构：`evals/fixtures/<repo>/`（git submodule，固定 commit） + `evals/cases/case-NN-*/`（task.json + expected/ + judge.ts）+ `evals/runner/`（harness.ts + sse-client.ts + fixture-reset.ts + report.ts）。10 条基准 case 覆盖：add-function / fix-bug / refactor-extract / add-types / py-fix-import / py-add-docstring / py-type-hints / multi-file-bug / approval-write（含 blacklist ssh 拒绝链路）/ checkpoint-restore（interrupt + shadow-git 恢复）。每条 case 都走 `arclight serve` 真实 HTTP/SSE/tool/nono 链路。Judge 二级：确定性 judge（file-exists / ast-parseable / test-pass / no-new-lint-error）作 CI hard gate；LLM judge 只写报告不 gate。metrics（inputTokens / outputTokens / cacheReadTokens / costUsdMicros / durationMs / turns）每次写 `results/summary.json`。通过标准：MVP 目标 ≥8/10，发布里程碑 10/10，平均 ≤25k tokens/case，p95 ≤60s。

**③ Bun 原生模块 Smoke Test**

`scripts/smoke-test-native.ts` 5 个 case：bun:sqlite（内置，blocking）、drizzle-orm/bun-sqlite（blocking）、node-pty（P0 blocking，spawn+onData+onExit 验证）、sqlite-vec（阶段二预探路，non-blocking）、@napi-rs/keyring（P3 预探路，non-blocking）。Blocking 项任一 FAIL 即 exit(1) 并输出具体降级方案（node-pty FAIL → Bun.spawn pipe 或 Node 子进程；sqlite-vec FAIL → 仅 FTS5 BM25；keyring FAIL → 加密文件）。

**④ CI**

三个 workflow：`ci.yml`（PR+main：install → biome check → tsc --noEmit → vitest unit → smoke test → integration test，20min timeout）；`eval.yml`（push main + manual_dispatch：完整 10 case eval，60min，PR 结果自动 comment）；`license-gate.yml`（PR+main：license-checker JSON + `check-licenses.ts` 拦截 GPL/LGPL/AGPL/EUPL，MPL-2.0 人工豁免 allowlist）。CI 沙箱用 docker-fallback（Linux Landlock 内核 ≥5.13 要求，GH Actions ubuntu 满足但 nono 安装复杂，fallback 更稳）。

**⑤ 可观测 + commit/branch 策略**

pino 工厂（`rootLogger` + `childLogger(ctx)`）：dev 接 pino-pretty，生产 NDJSON；serializers 脱敏 token/apiKey/secret。独立 `auditLog(kind, payload, ctx)` 写 `.arclight/audit/audit-YYYYMMDD.ndjson`，覆盖 14 种安全敏感 AuditEventKind。W3C `traceparent` 在 Hono 中间件注入，进入 ToolContext → ArcEvent.meta，为后续 OTel 留接口（业务代码零改动）。biome.json 统一格式（space/2/100 linewidth，noExplicitAny warn，noGlobalEval error）。分支：main squash merge，`feat/fix/refactor/chore` 四类，lefthook pre-commit 并行跑 biome check + tsc。