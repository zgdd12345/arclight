# arclightagent 工程实践 + 测试/Eval 策略
> 阶段一 Web + 写代码 MVP（本地优先 `arclight serve --repo`）
> 技术栈：Bun + Hono + drizzle-orm/bun:sqlite + Next.js App Router + @assistant-ui/react + Vercel AI SDK + @modelcontextprotocol/sdk + nono
> 与 5 份文档（ARCHITECTURE_BLUEPRINT / FULL_PLATFORM_DESIGN / 拿来即用选型清单 / P0-施工图 / P0-沙箱）严格对齐。

---

## 目录

1. [TDD 流程（vitest；单元 vs 集成；内核可测性靠纯函数主循环）](#1-tdd-流程)
2. [Golden Eval Harness（≥10 条编码 case，真链路）](#2-golden-eval-harness)
3. [Bun 原生模块第一周强制 Smoke Test 清单及回退判据](#3-bun-原生模块-smoke-test)
4. [CI（GitHub Actions：install + lint + typecheck + test + eval + license-gate）](#4-ci)
5. [可观测（pino 结构化日志 + 统一审计去向）+ commit/分支策略（biome 格式）](#5-可观测--commitbranch-策略)

---

## 1. TDD 流程

### 1.1 总体原则

施工图已明确：agent 主循环 `queryLoop()`（800-1500 行）和前端 `ArcTransport`（1500-3000+ 行）是两处真·产品级工程，不是薄接缝。TDD 的核心价值在于：

- **主循环**：强制把 `queryLoop()` 设计成 `async function*`，外部注入所有 I/O（AI SDK adapter、emit 函数、SandboxService、ApprovalService），单元测 mock 即可，无需启动 HTTP server。
- **工具契约层**：`ToolRegistry`、`ApprovalService`、`EpochGuard`、`ArtifactStore` 全部纯函数 + 依赖注入，可独立单元测。
- **集成测**：走 `arclight serve --repo` 完整 HTTP/SSE/tool/sandbox 链路，这就是 eval harness 的基础。

### 1.2 vitest 配置

**文件：`packages/core/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bun 原生模块 smoke test 在单独 suite 里跑（见第3节）
    environment: "node",
    globals: false,
    testTimeout: 30_000,       // 单元测试上限 30s
    hookTimeout: 10_000,
    pool: "forks",             // 隔离每个测试文件，防止 node-pty/sqlite 状态污染
    poolOptions: {
      forks: { singleFork: false },
    },
    include: [
      "src/**/__tests__/**/*.test.ts",
      "src/**/*.test.ts",
    ],
    exclude: [
      "src/**/__tests__/integration/**",  // 集成测单独项目
      "src/**/__tests__/eval/**",          // eval suite 单独项目
    ],
    coverage: {
      provider: "v8",
      include: [
        "src/core/**",           // 主循环 + 工具契约（必须覆盖）
        "src/tools/**",
        "src/approval/**",
        "src/db/**",
        "src/session/**",
      ],
      thresholds: {
        lines: 70,               // MVP 阶段目标，随版本收紧
        functions: 70,
        branches: 60,
      },
    },
    reporters: ["verbose", "junit"],
    outputFile: { junit: "test-results/unit.xml" },
  },
});
```

**文件：`packages/core/vitest.integration.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 120_000,      // 集成测含 AI SDK 真实请求，上限 2 min
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },  // 单进程序列跑，避免端口冲突
    include: ["src/**/__tests__/integration/**/*.test.ts"],
    reporters: ["verbose", "junit"],
    outputFile: { junit: "test-results/integration.xml" },
  },
});
```

### 1.3 测试分层

```
packages/core/src/
├── core/
│   ├── queryLoop.ts                     # 主循环（async generator，纯函数化）
│   └── __tests__/
│       ├── queryLoop.test.ts            # 单元：mock AI SDK adapter + mock emit
│       ├── compaction.test.ts           # 单元：纯函数，token 计数 + 摘要触发
│       └── integration/
│           └── queryLoop.e2e.test.ts   # 集成：真实 arclight serve + SSE replay
├── tools/
│   ├── ToolRegistry.ts
│   ├── approval/ApprovalService.ts
│   ├── artifacts/ArtifactStore.ts
│   └── __tests__/
│       ├── ToolRegistry.test.ts         # 单元：并发规则 / 超限落盘 / 5键envelope
│       ├── ApprovalService.test.ts      # 单元：状态机 pending→allowed/denied/expired
│       ├── ArtifactStore.test.ts        # 单元：32KB spill 边界
│       └── integration/
│           └── tools.e2e.test.ts       # 集成：bash 工具走 nono 沙箱真实执行
├── db/
│   ├── schema.ts                        # P0 施工图 §B 完整 schema
│   └── __tests__/
│       ├── schema.test.ts               # 单元：drizzle-orm 迁移幂等 / tenant_id 约束
│       └── epochGuard.test.ts           # 单元：StaleEpochError / epoch jump 逻辑
├── session/
│   ├── appendEvent.ts                   # seq 单调 + epoch 落库（一个 SQLite 事务）
│   └── __tests__/
│       └── appendEvent.test.ts          # 单元：并发 append 唯一性 / seq 递增
└── sandbox/
    ├── SandboxService.ts
    └── __tests__/
        └── integration/
            └── sandbox.e2e.test.ts      # 集成：nono probe / run / cancel / audit log
```

### 1.4 主循环可测性设计（关键）

`queryLoop()` 是 agent 心脏，必须纯函数化才能无副作用单元测：

```ts
// packages/core/src/core/queryLoop.ts
export interface QueryLoopDeps {
  /** Vercel AI SDK streamText，收敛进 adapter 层 */
  streamTurn: (messages: CoreMessage[], tools: AiToolSet, signal: AbortSignal) => AsyncIterable<ArcStreamPart>;
  /** 工具执行（含审批阻塞） */
  executeTool: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>;
  /** 事件持久化 + SSE 广播 */
  emit: (e: ArcEvent) => Promise<void>;
  /** 压缩判断 + 执行 */
  compactor: Compactor;
  /** token 计数 */
  tokenCount: (msgs: CoreMessage[]) => number;
  /** 日志（pino child logger） */
  logger: Logger;
}

export async function* queryLoop(
  input: SubmitInput,
  ctx: ToolContext,
  deps: QueryLoopDeps,
): AsyncGenerator<ArcEvent, void, "interrupt" | undefined> {
  // ...实现...
}
```

单元测时：`streamTurn` 传入产生 mock delta 的 async generator，`executeTool` 用 vitest mock，`emit` 收集到数组后断言。不启动任何 HTTP server、不调用真实 AI API、不启动 nono。

**单元测用例结构：**

```ts
// packages/core/src/core/__tests__/queryLoop.test.ts
import { describe, it, expect, vi } from "vitest";
import { queryLoop } from "../queryLoop";

describe("queryLoop", () => {
  it("should emit turn.started and turn.completed on happy path", async () => {
    const emitted: ArcEvent[] = [];
    const deps = buildMockDeps({ emitted });
    const gen = queryLoop(mockInput, mockCtx, deps);
    const events = await collectAll(gen);
    expect(events.map(e => e.t)).toContain("turn.started");
    expect(events.map(e => e.t)).toContain("turn.completed");
  });

  it("should pause and emit permission.ask when tool requires approval", async () => { ... });

  it("should trigger compaction when token count exceeds threshold", async () => { ... });

  it("should propagate AbortSignal on interrupt", async () => { ... });

  it("should retry tool on EXEC_FAILED with retry_allowed=true, max 3 times", async () => { ... });
});
```

### 1.5 前端可测性设计

`ArcTransport`（`packages/web/src/transport/ArcTransport.ts`）的 SSE→UIMessage 桥接逻辑应抽出纯函数：

```ts
// 纯函数：把 ArcEvent 序列折叠成 UIMessage 树（可独立 vitest）
export function foldEventsToMessages(events: ArcEvent[]): UIMessage[] { ... }

// 纯函数：计算审批 modal 是否应显示
export function deriveApprovalState(events: ArcEvent[]): ApprovalState { ... }
```

组件级测试用 `@testing-library/react` + MSW mock SSE endpoint（vitest browser mode 或 jsdom）。

---

## 2. Golden Eval Harness

### 2.1 设计原则

- **全链路**：每条 case 都走 `arclight serve --repo <fixture-repo>` 的 HTTP/SSE/tool/sandbox 真链路，不 mock AI SDK，不 mock nono。
- **幂等可重跑**：fixture repo 用 git 管理，每次 eval 前 reset 到 baseline commit。
- **量化记录**：token/cost/duration 每次都写 JSONL，便于趋势追踪（为后续 promptfoo 切换做准备）。
- **judge 二级**：先跑确定性 judge（文件存在 / AST 可解析 / 测试通过），再跑 LLM judge（代码语义正确性）；LLM judge 结果不作 CI 硬 gate（成本 + 非幂等），只写报告。

### 2.2 目录结构

```
evals/
├── README.md                        # harness 用法说明
├── fixtures/                        # git submodule 或 monorepo 子包，每个是独立 git repo
│   ├── ts-todo-app/                 # case-01 到 case-04 用到的 fixture
│   │   ├── src/
│   │   │   └── todo.ts
│   │   ├── tsconfig.json
│   │   ├── package.json
│   │   └── .arclight/              # 预先 init，不含 secrets
│   ├── py-data-pipeline/            # case-05 到 case-07
│   ├── ts-with-bugs/                # case-08 到 case-10
│   └── ts-refactor-target/          # case-11+（扩展）
├── cases/
│   ├── case-01-add-function/
│   │   ├── task.json                # 任务描述
│   │   ├── expected/                # 期望的文件 diff / 测试通过要求
│   │   │   ├── files.json           # { "src/todo.ts": { "mustContain": [...], "mustNotContain": [...] } }
│   │   │   └── tests.json           # { "cmd": "bun test", "exitCode": 0 }
│   │   └── judge.ts                 # 确定性 judge 脚本（可独立运行）
│   ├── case-02-fix-bug/
│   │   └── ...
│   └── ...（10+ cases）
├── runner/
│   ├── harness.ts                   # 主入口：遍历 cases，启动 server，发 POST，收 SSE，跑 judge
│   ├── server-lifecycle.ts          # arclight serve 启停 + 健康检查
│   ├── sse-client.ts                # SSE 流读取 + turn.completed 等待 + timeout
│   ├── fixture-reset.ts             # git checkout HEAD -- . 重置 fixture repo
│   ├── llm-judge.ts                 # 可选 LLM judge（GPT-4o / Claude）
│   └── report.ts                    # 写 results/YYYYMMDD-HHmm.jsonl + summary.json
├── results/                         # gitignore 大文件，但 summary.json commit
│   └── .gitkeep
└── vitest.eval.config.ts            # 套在 vitest 下跑（便于 CI 集成）
```

### 2.3 task.json 格式

```jsonc
// evals/cases/case-01-add-function/task.json
{
  "id": "case-01-add-function",
  "version": 1,
  "fixture": "ts-todo-app",
  "fixtureCommit": "a1b2c3d",         // 固定 baseline，每次 reset 到这个 commit
  "agent": "code",
  "mode": "edit",
  "prompt": "在 src/todo.ts 中添加 `filterByPriority(todos: Todo[], priority: 'low'|'medium'|'high'): Todo[]` 函数，写好 JSDoc，并在 src/todo.test.ts 里添加至少 3 条 vitest 测试用例（包含 low/medium/high 三种 priority 各一条）。",
  "passCriteria": {
    "hard": [
      // 硬判据：确定性 judge，CI gate
      { "type": "file-exists",    "path": "src/todo.ts" },
      { "type": "ast-parseable",  "path": "src/todo.ts", "parser": "typescript" },
      { "type": "text-contains",  "path": "src/todo.ts", "pattern": "filterByPriority" },
      { "type": "test-pass",      "cmd": "bun test",     "cwd": "fixture", "exitCode": 0 },
      { "type": "no-new-lint-error", "cmd": "bun run typecheck", "cwd": "fixture" }
    ],
    "soft": [
      // 软判据：LLM judge，仅报告
      { "type": "llm-judge", "aspect": "code-quality", "prompt": "评估代码可读性与 JSDoc 完整性，1-5 分" },
      { "type": "llm-judge", "aspect": "test-coverage", "prompt": "评估测试用例是否覆盖了边界情况，1-5 分" }
    ]
  },
  "budget": {
    "maxTurns": 8,                    // 主循环最大 turn 数
    "maxTokens": 40000,               // 超出即 FAIL（防止 token 爆炸）
    "maxDurationMs": 120000           // 超出即 FAIL
  },
  "tags": ["typescript", "function-addition", "test-writing"]
}
```

### 2.4 十条基准编码 Case（完整清单）

| # | ID | fixture | 任务摘要 | 核心 hard 判据 | 主要考察点 |
|---|---|---|---|---|---|
| 1 | `case-01-add-function` | ts-todo-app | 添加 `filterByPriority` 函数 + 3 条 vitest 测试 | file exists / ast-parseable / test-pass | read_file + write_file + apply_patch 基础链路 |
| 2 | `case-02-fix-bug` | ts-todo-app | 修复 `sortTodos` 里的 off-by-one 错误（已有失败测试） | existing test-pass（由失败变通过） | bash 运行测试 + 读错误 + apply_patch 定向修复 |
| 3 | `case-03-refactor-extract` | ts-todo-app | 把 `todo.ts` 中内联的 date 格式化逻辑提取到 `src/utils/date.ts`，原文件 import 引用，不破坏现有测试 | test-pass + text-contains（import）+ no-new-lint-error | RepoMap 上下文 + 多文件编辑原子性 |
| 4 | `case-04-add-types` | ts-todo-app | 把 `any` 替换为严格 Zod schema，生成 `src/schemas/todo.schema.ts`，原逻辑不变 | ast-parseable / typecheck-pass / text-not-contains（"any"） | tree-sitter tag extraction + typecheck 反馈循环 |
| 5 | `case-05-py-fix-import` | py-data-pipeline | 修复 Python 文件里因相对 import 路径错误导致的 ModuleNotFoundError | bash（python -m pytest）exit 0 | PTY + bash 工具跨语言环境 |
| 6 | `case-06-py-add-docstring` | py-data-pipeline | 为所有 public 函数添加 Google-style docstring，不改逻辑 | text-contains（Args: / Returns:）+ test-pass | read_file 大文件 + 多处 apply_patch |
| 7 | `case-07-py-type-hints` | py-data-pipeline | 用 `mypy --strict` 修复所有 type error（≤3 次迭代） | bash（mypy）exit 0 | bash 反馈→修复迭代，考察 max-turns 利用率 |
| 8 | `case-08-multi-file-bug` | ts-with-bugs | 跨 3 个文件的接口不一致导致运行时错误，全部修复 | test-pass（集成测试）+ typecheck-pass | shadow-git checkpoint + 多文件协调 |
| 9 | `case-09-approval-write` | ts-todo-app | agent 需写 `.env.example`（white-listed 路径），**并在一条操作中尝试读 `~/.ssh/config`（应被拒绝）** | approval-event-emitted + denied-event-for-ssh + .env.example-written | 审批链路：confirm write 通过 / blacklist ssh 拒绝 |
| 10 | `case-10-checkpoint-restore` | ts-with-bugs | agent 做出错误修改（写入 bad content），用户触发 `interrupt`，验证 shadow-git checkpoint 可 restore | checkpoint-ref-in-db + restore-makes-test-pass | CheckpointTracker + interrupt + restore 完整链路 |

**扩展 case（阶段一末期补充，CI 可选跑）：**

| # | ID | 考察点 |
|---|---|---|
| 11 | `case-11-large-repo-repomap` | RepoMap 在 500+ 文件 repo 的上下文选择准确性 |
| 12 | `case-12-compaction-boundary` | token 接近上限时压缩触发，压缩后继续完成任务 |
| 13 | `case-13-mcp-tool-invocation` | agent 通过 MCP tool 查询外部 server（mock stdio server），白名单审计通过 |

### 2.5 Judge 脚本（judge.ts 模板）

```ts
// evals/cases/case-01-add-function/judge.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse } from "@typescript-eslint/typescript-estree";
import type { EvalResult, HardCriterion } from "../../runner/types";

export async function judge(
  fixtureDir: string,
  runResult: SseRunResult,
  criteria: HardCriterion[],
): Promise<EvalResult> {
  const failures: string[] = [];

  for (const c of criteria) {
    switch (c.type) {
      case "file-exists": {
        const p = join(fixtureDir, c.path);
        if (!existsSync(p)) failures.push(`file-exists FAIL: ${c.path}`);
        break;
      }
      case "ast-parseable": {
        const src = readFileSync(join(fixtureDir, c.path), "utf8");
        try { parse(src, { jsx: true }); }
        catch (e) { failures.push(`ast-parseable FAIL: ${c.path} — ${e}`); }
        break;
      }
      case "text-contains": {
        const src = readFileSync(join(fixtureDir, c.path), "utf8");
        if (!src.includes(c.pattern)) failures.push(`text-contains FAIL: "${c.pattern}" not in ${c.path}`);
        break;
      }
      case "test-pass": {
        const result = spawnSync(c.cmd, { cwd: c.cwd === "fixture" ? fixtureDir : c.cwd, shell: true });
        if (result.status !== c.exitCode) failures.push(`test-pass FAIL: exit ${result.status}, expected ${c.exitCode}`);
        break;
      }
      case "no-new-lint-error": {
        const result = spawnSync(c.cmd, { cwd: fixtureDir, shell: true });
        if (result.status !== 0) failures.push(`no-new-lint-error FAIL: typecheck failed`);
        break;
      }
    }
  }

  return {
    caseId: runResult.caseId,
    passed: failures.length === 0,
    failures,
    metrics: runResult.metrics,  // { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsdMicros, durationMs, turns }
  };
}
```

### 2.6 Harness 主入口骨架

```ts
// evals/runner/harness.ts
import { startServer, stopServer, waitHealthy } from "./server-lifecycle";
import { resetFixture } from "./fixture-reset";
import { runCase } from "./sse-client";
import { judge } from "../cases/[id]/judge";
import { writeReport } from "./report";

const CASES_DIR = new URL("../cases", import.meta.url).pathname;

async function main() {
  const cases = loadCases(CASES_DIR);           // 读 task.json，按 tag 过滤
  const results: EvalResult[] = [];

  for (const c of cases) {
    console.log(`\n[eval] running ${c.id}...`);

    // 1. reset fixture repo 到 baseline commit
    await resetFixture(c.fixture, c.fixtureCommit);

    // 2. 启动 arclight serve（每 case 重启，避免状态污染）
    const { port, token } = await startServer({ repoPath: fixtureDir(c.fixture) });
    await waitHealthy(port);

    try {
      // 3. POST /api/commands + 读 SSE 直到 turn.completed 或 timeout
      const runResult = await runCase({
        port, token,
        prompt: c.prompt,
        agent: c.agent,
        mode: c.mode,
        budget: c.budget,
      });

      // 4. 确定性 judge
      const result = await judge(fixtureDir(c.fixture), runResult, c.passCriteria.hard);
      results.push(result);

      console.log(`[eval] ${c.id}: ${result.passed ? "PASS" : "FAIL"}`);
      if (!result.passed) result.failures.forEach(f => console.error(`  - ${f}`));

    } finally {
      await stopServer(port);
    }
  }

  // 5. 写 results/YYYYMMDD-HHmm.jsonl + summary.json
  await writeReport(results);

  // 6. 汇总：CI 用，任一 hard case FAIL 则 process.exit(1)
  const failCount = results.filter(r => !r.passed).length;
  if (failCount > 0) {
    console.error(`\n[eval] ${failCount}/${results.length} cases FAILED`);
    process.exit(1);
  }
  console.log(`\n[eval] all ${results.length} cases PASSED`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

### 2.7 SSE 读取 + Metrics 采集

```ts
// evals/runner/sse-client.ts
export async function runCase(opts: RunCaseOpts): Promise<SseRunResult> {
  const commandId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();

  // POST /api/commands
  const cmdResp = await fetch(`http://127.0.0.1:${opts.port}/api/commands`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.token}`,
    },
    body: JSON.stringify({
      k: "submit", v: 1, commandId, sessionId,
      input: { text: opts.prompt, agent: opts.agent, mode: opts.mode, baseEpoch: 0 },
    }),
  });
  const { turnId } = await cmdResp.json();

  // GET /api/sessions/:id/events (SSE)
  const events: ArcEvent[] = [];
  const metrics: Metrics = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicros: 0, durationMs: 0, turns: 0 };
  const startMs = Date.now();

  await readSse(`http://127.0.0.1:${opts.port}/api/sessions/${sessionId}/events`, opts.token, {
    onEvent(e: ArcEvent) {
      events.push(e);
      if (e.t === "usage.recorded") {
        metrics.inputTokens       += e.inputTokens;
        metrics.outputTokens      += e.outputTokens;
        metrics.cacheReadTokens   += e.cacheReadTokens ?? 0;
        metrics.cacheWriteTokens  += e.cacheWriteTokens ?? 0;
        metrics.costUsdMicros     += e.costUsdMicros ?? 0;
        metrics.turns             += 1;
      }
    },
    stopWhen: (e) => e.t === "turn.completed" || e.t === "session.error",
    timeoutMs: opts.budget.maxDurationMs,
  });

  metrics.durationMs = Date.now() - startMs;

  // token 预算超限视为 FAIL
  if (metrics.inputTokens + metrics.outputTokens > opts.budget.maxTokens) {
    return { caseId: opts.caseId, failed: true, reason: "token-budget-exceeded", metrics, events };
  }

  return { caseId: opts.caseId, failed: false, metrics, events };
}
```

### 2.8 通过标准与报告格式

**通过标准（CI hard gate）：**

- 阶段一 MVP 目标：**≥8/10 case PASS**（80%，允许 2 条 P0 排查中）
- 达到发布里程碑前须：**10/10 case PASS**
- token 预算：**每 case 平均 ≤25k tokens**（关注 cache read 率，目标 ≥60%）
- 耗时：**每 case p95 ≤60s**（本地 nono 沙箱）

**results/summary.json 格式：**

```jsonc
{
  "runId": "2026-06-09T14:30:00Z",
  "commit": "abc1234",
  "model": "claude-sonnet-4-5",
  "passRate": 0.9,
  "cases": [
    {
      "id": "case-01-add-function",
      "passed": true,
      "failures": [],
      "metrics": {
        "inputTokens": 8420,
        "outputTokens": 1830,
        "cacheReadTokens": 6100,
        "cacheWriteTokens": 2320,
        "costUsdMicros": 4200,
        "durationMs": 18340,
        "turns": 3
      }
    }
    // ...
  ],
  "aggregate": {
    "totalInputTokens": 89000,
    "totalOutputTokens": 19000,
    "totalCostUsdMicros": 45000,
    "avgDurationMs": 22000,
    "cacheHitRate": 0.63
  }
}
```

---

## 3. Bun 原生模块 Smoke Test

### 3.1 背景

选型清单 §0.2 伪轻量 #12 明确：`node-pty` / `sqlite-vec` / `@napi-rs/keyring` 在 Bun N-API 下历来不稳，任一挂掉 = 降级方案。**第一周必须验证**，不能等到集成测阶段才发现。

### 3.2 Smoke Test 清单（第一周强制全部跑通）

**文件：`scripts/smoke-test-native.ts`**

```ts
#!/usr/bin/env bun
/**
 * Bun 原生模块 smoke test — 第一周强制跑通
 * 跑法：bun run scripts/smoke-test-native.ts
 * 任一 FAIL 立即退出 1，输出降级建议
 */

import { spawnSync } from "bun";
import { tmpdir } from "os";
import { join } from "path";

type SmokeResult = { name: string; ok: boolean; note: string; fallback?: string };
const results: SmokeResult[] = [];

// ── Case 1: node-pty —— 必须通过（PTY 是 P0 bash 工具的核心） ──────────────
async function smokeNodePty(): Promise<SmokeResult> {
  try {
    // @ts-ignore — bun bundler 对 node_modules 原生模块的处理
    const { default: pty } = await import("node-pty");
    const term = pty.spawn("bash", ["-c", "echo 'arclight-pty-smoke-ok' && exit 0"], {
      name: "xterm-color", cols: 80, rows: 24,
      cwd: tmpdir(), env: process.env as Record<string, string>,
    });
    let output = "";
    await new Promise<void>((resolve, reject) => {
      term.onData(d => { output += d; });
      term.onExit(({ exitCode }) => {
        if (exitCode === 0) resolve();
        else reject(new Error(`exit ${exitCode}`));
      });
      setTimeout(() => reject(new Error("timeout 5s")), 5000);
    });
    const ok = output.includes("arclight-pty-smoke-ok");
    return { name: "node-pty", ok, note: ok ? "spawn+onData+onExit ok" : `unexpected output: ${output}` };
  } catch (e) {
    return {
      name: "node-pty",
      ok: false,
      note: String(e),
      fallback: "降级方案：改用 Bun.spawn pipe 模式（无 PTY，丢失 ANSI/interactive 支持）或以 Node.js 子进程运行 pty 层",
    };
  }
}

// ── Case 2: sqlite-vec —— 阶段二捡回前预验证（MVP 已砍出，但提前探路） ────
async function smokeSqliteVec(): Promise<SmokeResult> {
  try {
    const { Database } = await import("bun:sqlite");
    // @ts-ignore
    const sqliteVec = await import("sqlite-vec");
    const db = new Database(join(tmpdir(), `smoke-vec-${Date.now()}.db`));
    sqliteVec.load(db);
    // 简单验证：建 virtual table + insert + query
    db.exec("CREATE VIRTUAL TABLE t USING vec0(v FLOAT[3])");
    db.exec("INSERT INTO t VALUES (1, '[1.0, 0.0, 0.0]')");
    const rows = db.query("SELECT rowid FROM t WHERE v MATCH '[1.0,0.0,0.0]' ORDER BY distance LIMIT 1").all();
    db.close();
    return { name: "sqlite-vec", ok: rows.length > 0, note: rows.length > 0 ? "vec0 vtable + query ok" : "query returned 0 rows" };
  } catch (e) {
    return {
      name: "sqlite-vec",
      ok: false,
      note: String(e),
      fallback: "降级方案：阶段二向量检索改用 SQLite FTS5 BM25 单路（放弃向量混合检索）或升级 Bun 版本后重试",
    };
  }
}

// ── Case 3: @napi-rs/keyring —— P3 桌面端捡回前预验证（MVP 用环境变量） ──
async function smokeKeyring(): Promise<SmokeResult> {
  try {
    // @ts-ignore
    const { Entry } = await import("@napi-rs/keyring");
    const TEST_SERVICE = "arclight-smoke-test";
    const TEST_ACCOUNT = "smoke-user";
    const TEST_SECRET  = "smoke-secret-12345";
    const entry = new Entry(TEST_SERVICE, TEST_ACCOUNT);
    entry.setPassword(TEST_SECRET);
    const got = entry.getPassword();
    entry.deletePassword();
    const ok = got === TEST_SECRET;
    return { name: "@napi-rs/keyring", ok, note: ok ? "set/get/delete ok" : `got: ${got}` };
  } catch (e) {
    return {
      name: "@napi-rs/keyring",
      ok: false,
      note: String(e),
      fallback: "降级方案（MVP 已用环境变量，此项不阻塞 MVP）；P3 桌面端若不通则改用 keytar（注意 gyp 风险）或加密文件存储",
    };
  }
}

// ── Case 4: bun:sqlite 基础功能（保险验证，属内置） ────────────────────────
async function smokeBunSqlite(): Promise<SmokeResult> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(tmpdir(), `smoke-sqlite-${Date.now()}.db`));
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.exec("INSERT INTO t (v) VALUES ('hello')");
    const row = db.query("SELECT v FROM t LIMIT 1").get() as { v: string } | null;
    db.close();
    return { name: "bun:sqlite", ok: row?.v === "hello", note: "CREATE/INSERT/SELECT ok" };
  } catch (e) {
    return { name: "bun:sqlite", ok: false, note: String(e), fallback: "Bun 内置模块失败，检查 Bun 版本（要求 ≥1.1）" };
  }
}

// ── Case 5: bun:sqlite + drizzle-orm ──────────────────────────────────────
async function smokeDrizzle(): Promise<SmokeResult> {
  try {
    const { drizzle }         = await import("drizzle-orm/bun-sqlite");
    const { Database }        = await import("bun:sqlite");
    const { sqliteTable, text, integer } = await import("drizzle-orm/sqlite-core");
    const db = new Database(join(tmpdir(), `smoke-drizzle-${Date.now()}.db`));
    const orm = drizzle(db);
    const t = sqliteTable("t", { id: text("id").primaryKey(), v: text("v") });
    await orm.run(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)`);
    await orm.insert(t).values({ id: "1", v: "drizzle-ok" });
    const rows = await orm.select().from(t);
    db.close();
    return { name: "drizzle-orm/bun-sqlite", ok: rows[0]?.v === "drizzle-ok", note: "insert+select ok" };
  } catch (e) {
    return { name: "drizzle-orm/bun-sqlite", ok: false, note: String(e) };
  }
}

// ── 执行 ──────────────────────────────────────────────────────────────────
console.log("\n=== Bun Native Module Smoke Tests ===\n");
results.push(await smokeBunSqlite());       // 必须 PASS（内置）
results.push(await smokeDrizzle());         // 必须 PASS（内置 ORM）
results.push(await smokeNodePty());         // 必须 PASS（P0 核心）
results.push(await smokeSqliteVec());       // 阶段二预探路，FAIL 不阻塞 P0 CI
results.push(await smokeKeyring());         // P3 预探路，FAIL 不阻塞 P0 CI

// ── 输出 ──────────────────────────────────────────────────────────────────
let hasBlockingFail = false;
for (const r of results) {
  const status = r.ok ? "PASS" : "FAIL";
  const blocking = ["bun:sqlite", "drizzle-orm/bun-sqlite", "node-pty"].includes(r.name);
  console.log(`[${status}] ${r.name} — ${r.note}`);
  if (!r.ok && r.fallback) console.log(`       Fallback: ${r.fallback}`);
  if (!r.ok && blocking) hasBlockingFail = true;
}

console.log("\n=== Summary ===");
const pass = results.filter(r => r.ok).length;
console.log(`${pass}/${results.length} passed`);
if (hasBlockingFail) {
  console.error("\nBLOCKING FAIL: P0 MVP 受阻，执行上述降级方案后重跑");
  process.exit(1);
}
console.log("\nAll blocking modules OK. Non-blocking failures are phase-2/3 items.");
```

### 3.3 回退判据（决策树）

```
node-pty FAIL?
  ├─ Bun N-API binding 报错 → 升 Bun 版本（≥1.2）
  ├─ 升级后仍失败 → PtyManager 改用 Bun.spawn pipe 模式（无 PTY 交互，ANSI 输出截断）
  └─ 严重 → bash 工具整体落到 Node.js 子进程（spawn("node", [...])），内核其余部分仍用 Bun

sqlite-vec FAIL?（阶段二才捡回，P0 不阻塞）
  ├─ load() 报 symbol not found → 等 sqlite-vec 发布 Bun 兼容版本
  ├─ API breaking change（v0.x） → 锁定可用 minor 版本
  └─ 都不行 → 阶段二只用 FTS5 BM25，放弃向量混合；写代码 MVP 不依赖向量

@napi-rs/keyring FAIL?（P3 桌面才捡回，P0 用 .env，不阻塞 MVP）
  ├─ macOS Keychain 授权问题 → 检查 codesign + entitlements
  ├─ API 不兼容 → 降级 keytar（需 gyp，注意维护停滞风险）
  └─ 都不行 → 桌面端加密文件（crypto.subtle AES-GCM + 机器 ID 派生密钥）
```

---

## 4. CI（GitHub Actions）

### 4.1 Workflow 总览

```
.github/workflows/
├── ci.yml           # PR + push main：install + lint + typecheck + test
├── eval.yml         # push main + manual_dispatch：eval（花时间，不每 PR 跑）
└── license-gate.yml # PR + push main：license 扫描，拦截 GPL/LGPL
```

### 4.2 主 CI（ci.yml）

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, "feat/**", "fix/**", "refactor/**"]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    name: Install + Lint + Typecheck + Unit Test + Smoke
    runs-on: ubuntu-latest
    timeout-minutes: 20

    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.2"          # 锁定，避免 N-API 行为偷偷变

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Biome lint + format check
        run: bun run lint             # package.json: "lint": "biome check --diagnostic-level=error ."

      - name: Typecheck (tsc --noEmit)
        run: bun run typecheck        # "typecheck": "tsc --noEmit -p tsconfig.json"

      - name: Unit tests (vitest)
        run: bun run test:unit
        # "test:unit": "vitest run --config packages/core/vitest.config.ts"

      - name: Upload unit test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: unit-test-results
          path: test-results/unit.xml

      - name: Bun native module smoke test
        run: bun run scripts/smoke-test-native.ts
        # node-pty / bun:sqlite / drizzle FAIL → exit 1 → CI 失败
        # sqlite-vec / keyring FAIL → 仅警告（blocking=false）

  integration-test:
    name: Integration Test (real arclight serve)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    needs: ci
    # 只在 push main / PR → main 时跑，feature branch push 跳过节省时间
    if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main'

    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.2" }

      - name: Install nono (sandbox)
        run: |
          # CI 环境用 docker-fallback 替代 nono（nono 需 Landlock = Linux ≥5.13）
          # P0 沙箱方案已有 docker-fallback 降级，CI 明确用之
          echo "ARCLIGHT_SANDBOX_BACKEND=docker-fallback" >> $GITHUB_ENV

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Integration tests
        run: bun run test:integration
        # "test:integration": "vitest run --config packages/core/vitest.integration.config.ts"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_CI }}  # CI 专用低额度 key
          ARCLIGHT_SANDBOX_BACKEND: docker-fallback
```

### 4.3 Eval Workflow（eval.yml）

```yaml
# .github/workflows/eval.yml
name: Eval

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      case_filter:
        description: "Case tag filter (e.g. typescript,bug-fix). Empty = all."
        required: false

jobs:
  eval:
    name: Golden Eval Harness (≥10 coding cases)
    runs-on: ubuntu-latest
    timeout-minutes: 60        # 10 cases × ~3min each + overhead

    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive   # fixture repos 作 git submodule

      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.2" }

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build arclight (内核 + CLI)
        run: bun run build

      - name: Run eval harness
        run: bun run evals/runner/harness.ts --filter "${{ github.event.inputs.case_filter || '' }}"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_EVAL }}
          ARCLIGHT_MODEL: claude-sonnet-4-5
          ARCLIGHT_SANDBOX_BACKEND: docker-fallback

      - name: Upload eval results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-results-${{ github.sha }}
          path: evals/results/

      - name: Comment eval summary on PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const summary = JSON.parse(fs.readFileSync('evals/results/summary.json'));
            const rate = (summary.passRate * 100).toFixed(0);
            const body = `## Eval Results\n\n**Pass rate: ${rate}% (${summary.cases.filter(c=>c.passed).length}/${summary.cases.length})**\n\nAvg tokens: ${summary.aggregate.totalInputTokens + summary.aggregate.totalOutputTokens}\nCache hit rate: ${(summary.aggregate.cacheHitRate * 100).toFixed(0)}%\nAvg duration: ${(summary.aggregate.avgDurationMs/1000).toFixed(1)}s`;
            github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });
```

### 4.4 License Gate（license-gate.yml）

```yaml
# .github/workflows/license-gate.yml
name: License Gate

on:
  push:
    branches: [main, "feat/**", "fix/**"]
  pull_request:
    branches: [main]

jobs:
  license-check:
    name: Block GPL / LGPL dependencies
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.2" }

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Install license-checker
        run: bun add -g license-checker

      - name: Generate license report
        run: |
          license-checker --json --out license-report.json --excludePrivatePackages

      - name: Block GPL/LGPL
        run: |
          bun run scripts/check-licenses.ts
        # check-licenses.ts 脚本见下方

      - name: Upload license report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: license-report
          path: license-report.json
```

**`scripts/check-licenses.ts`：**

```ts
#!/usr/bin/env bun
import report from "../license-report.json";

// GPL/LGPL 变种全部拦截（MPL-2.0 例外：web-push 阶段四引入，纯依赖不改源，人工豁免）
const BLOCKED_PATTERNS = [
  /^GPL/i, /^GNU General/i,
  /^LGPL/i, /^GNU Lesser/i,
  /^AGPL/i, /^GNU Affero/i,
  /^EUPL/i,
];

// 人工豁免列表（需在本文件 commit 说明理由）
const ALLOWLIST: Record<string, string> = {
  // "web-push@4.x": "MPL-2.0 — 阶段四引入，不改源，文件级 copyleft 不触发",
};

const violations: string[] = [];

for (const [pkg, info] of Object.entries(report as Record<string, { licenses: string }>)) {
  const lic = info.licenses ?? "";
  if (ALLOWLIST[pkg]) continue;
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(lic)) {
      violations.push(`BLOCKED: ${pkg} (${lic})`);
      break;
    }
  }
}

if (violations.length > 0) {
  console.error("\n[license-gate] FAIL — blocked licenses found:");
  violations.forEach(v => console.error(`  ${v}`));
  console.error("\n请将依赖替换为宽松许可证版本，或在 ALLOWLIST 中添加豁免说明（需代码审查）。");
  process.exit(1);
}

console.log(`[license-gate] PASS — ${Object.keys(report).length} packages checked, 0 violations.`);
```

---

## 5. 可观测 + Commit/Branch 策略

### 5.1 pino 结构化日志（MVP 唯一可观测层）

选型清单已定：MVP 仅 `pino`，`langfuse` 降阶段二，OTel 后置。

**日志工厂（`packages/core/src/logging/logger.ts`）：**

```ts
import pino, { type Logger } from "pino";

/**
 * 根 logger，全进程单例。
 * 本地 dev：pretty print（需安装 pino-pretty）
 * 生产/CI：NDJSON，方便 jq 过滤 + 后续接 Loki/DataDog
 */
export const rootLogger = pino({
  name: "arclight",
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV !== "production"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }
    : {}),
  serializers: {
    err: pino.stdSerializers.err,
    // 脱敏：token/secret 字段永不入日志
    token: () => "[REDACTED]",
    apiKey: () => "[REDACTED]",
    secret: () => "[REDACTED]",
  },
});

/** 创建子 logger，绑定 tenant/session/turn 上下文 */
export function childLogger(ctx: {
  tenantId: string;
  sessionId?: string;
  turnId?: string;
  callId?: string;
  component: string;
}): Logger {
  return rootLogger.child(ctx);
}
```

**统一审计去向（`packages/core/src/logging/audit.ts`）：**

所有安全敏感操作（工具执行、审批决策、沙箱进出、MCP 白名单命中/未命中、凭证代理放行/拒绝）必须经 `auditLog()` 写入：

```ts
// 审计日志走独立 pino 实例，固定写 .arclight/audit/audit-YYYYMMDD.ndjson
// nono 自己的 Merkle JSONL 审计是沙箱侧；这里是内核侧审计
import pino from "pino";
import { join } from "path";

let _auditLogger: pino.Logger | null = null;

export function initAuditLogger(arclightDir: string): void {
  const dest = pino.destination({
    dest: join(arclightDir, `audit/audit-${new Date().toISOString().slice(0, 10)}.ndjson`),
    sync: false,
    mkdir: true,
  });
  _auditLogger = pino({ name: "arclight-audit", level: "info" }, dest);
}

export type AuditEventKind =
  | "tool.exec.requested"
  | "tool.exec.allowed"
  | "tool.exec.denied"
  | "approval.ask"
  | "approval.decision"
  | "sandbox.start"
  | "sandbox.exit"
  | "mcp.tool.whitelist.hit"
  | "mcp.tool.whitelist.miss"
  | "credential.proxy.allowed"
  | "credential.proxy.denied"
  | "session.started"
  | "session.compacted"
  | "auth.loopback.ok"
  | "auth.loopback.fail";

export function auditLog(
  kind: AuditEventKind,
  payload: Record<string, unknown>,
  ctx: { tenantId: string; sessionId?: string; turnId?: string; callId?: string },
): void {
  if (!_auditLogger) return;   // 未初始化（测试环境）静默跳过
  _auditLogger.info({ kind, ...ctx, ...payload });
}
```

**W3C traceparent 透传（跨端 span 关联）：**

```ts
// 在 Hono 中间件注入，从请求头读取或生成
app.use("*", async (c, next) => {
  const traceparent = c.req.header("traceparent") ?? generateTraceparent();
  c.set("traceparent", traceparent);
  // 传入 ToolContext → emit → ArcEvent.meta.traceparent
  // 便于未来接 OTel 时直接关联
  await next();
  c.header("traceparent", traceparent);
});
```

**关键日志点清单（必须打的）：**

| 位置 | 日志级别 | 字段 | 原因 |
|---|---|---|---|
| `arclight serve` 启动 | INFO | port / pid / repoPath | 可见性 |
| `POST /api/commands` 收到 | INFO | commandId / sessionId / agent | 请求追踪 |
| `queryLoop` turn 开始 | INFO | turnId / model / epochAtStart | 循环追踪 |
| AI SDK `streamText` 调用前 | DEBUG | model / messageCount / estimatedTokens | token 监控 |
| 工具调用请求 | INFO（审计） | tool / args preview / riskTier | 安全审计 |
| 审批决策 | INFO（审计） | askId / decision / decidedBy | 合规审计 |
| nono sandbox 启动/退出 | INFO（审计） | runId / exitCode / wallclockMs | 沙箱监控 |
| 压缩触发 | INFO | epochBefore / epochAfter / tokensBefore | 上下文管理 |
| `turn.completed` | INFO | turnId / inputTokens / outputTokens / cacheHitRate / durationMs | 性能监控 |
| `session.error` | ERROR | error / stack（dev only） | 故障排查 |

### 5.2 commit/分支策略

**工具链：biome（格式 + lint，替代 prettier + eslint，Bun 原生快）**

**`biome.json`（项目根）：**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignore": ["node_modules", ".next", "dist", "evals/fixtures/**", "coverage/**"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "warn",
        "noConsoleLog": "warn"          // 推 pino，不裸 console.log
      },
      "security": {
        "noGlobalEval": "error"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "es5"
    }
  },
  "organizeImports": {
    "enabled": true
  }
}
```

**package.json scripts（项目根）：**

```jsonc
{
  "scripts": {
    "lint":       "biome check --diagnostic-level=error .",
    "lint:fix":   "biome check --write .",
    "typecheck":  "tsc --noEmit -p tsconfig.json",
    "test:unit":  "vitest run --config packages/core/vitest.config.ts",
    "test:integration": "vitest run --config packages/core/vitest.integration.config.ts",
    "test":       "bun run test:unit",
    "eval":       "bun run evals/runner/harness.ts",
    "smoke":      "bun run scripts/smoke-test-native.ts",
    "build":      "bun build packages/cli/src/index.ts --outfile dist/arclight --compile --target bun",
    "dev":        "bun --watch packages/core/src/server.ts"
  }
}
```

**分支策略：**

```
main
├─ feat/<short-kebab>       # 功能：合并前必须 CI+eval pass
├─ fix/<issue-or-short>     # bugfix：合并前 CI pass，eval 可选
├─ refactor/<component>     # 重构：CI+typecheck pass
└─ chore/<topic>            # deps/config/docs：CI pass
```

规则：
- **main 只接受 squash merge**（保持线性 history，便于 git bisect 追查 eval 回归）
- **PR 标题格式**：`type(scope): summary`，type ∈ {feat, fix, refactor, chore, test, docs}
- **PR checklist**（`.github/pull_request_template.md`）：
  - [ ] `bun run lint` PASS
  - [ ] `bun run typecheck` PASS
  - [ ] `bun run test:unit` PASS
  - [ ] 涉及工具链路改动：`bun run test:integration` PASS
  - [ ] 涉及 eval 相关改动：`bun run eval` PASS 并附 summary.json diff
  - [ ] 新增依赖：许可证已查验，NOTICE 已更新（Apache-2.0 来源）
  - [ ] 新增 AI API 调用路径：`auditLog()` 已覆盖

**pre-commit hook（lefthook 或直接 bun + husky）：**

```yaml
# lefthook.yml（比 husky 更快，原生 parallel）
pre-commit:
  parallel: true
  commands:
    biome-check:
      glob: "*.{ts,tsx,js,jsx,json}"
      run: biome check --write --no-errors-on-unmatched {staged_files}
    typecheck:
      run: bun run typecheck

commit-msg:
  commands:
    commitlint:
      run: bun run scripts/check-commit-msg.ts {1}
      # 检查格式：type(scope): summary, 50 char summary limit
```

### 5.3 可观测升级路径（不在 MVP，留接口）

```
MVP(P0)：pino NDJSON → .arclight/logs/ 本地文件 + stdout
阶段二：接 langfuse（self-hosted）→ 每 turn usage + span
阶段三：OTel JS SDK（仅手动 span，不用 auto-instrument，Bun 兼容性未知）
阶段五：Prometheus prom-client + Grafana + 告警
```

接口留法：`childLogger(ctx)` 的 `ctx` 结构与 OTel span 属性对齐（`tenantId`=`user.id`，`sessionId`=`session.id`，`traceparent` 已传），未来接 OTel 只需在工厂层加 `tracer.startSpan`，业务代码零改动。

---

## 附录 A：自研量对照（eval harness 覆盖范围确认）

| # | 自研接缝 | 实评行数 | Eval Case 覆盖 |
|---|---|---|---|
| 1 | 主循环 `queryLoop()` | 800-1500 | 所有 case（每条 case 必经主循环） |
| 2 | 工具元数据 + 并发分批 + 超限落盘 | ~100 | case-01~04（文件读写）、case-08（多文件） |
| 3 | MCP 白名单审计 + 凭证代理 | 300-500 | case-13（扩展，MCP tool 调用） |
| 4 | Skill 加载器 + Hooks 分发 | ~150 | 单元测覆盖（eval 不直接测 Skill 加载） |
| 5 | 单级压缩 | ~200 | case-12（扩展，token 接近上限） |
| 6 | MEMORY.md 读写 | ~30 | 单元测覆盖 |
| 7 | 会话表 schema（epoch 乐观锁） | ~150 | 所有集成测（每条 case 建 session） |
| 8 | 事件桥接 + 心跳 + 刷新不丢 | 400-700 | 所有 case（SSE replay 每条都验证） |
| 9 | 认证中间件（loopback token） | ~50 | 所有 case（harness 带 Bearer token） |
| 10 | usage 埋点 + quota | ~100 | 所有 case（metrics 采集） |
| 11 | 权限审批状态机 | 300-500 | case-09（审批 happy/deny path） |
| 12 | 编码 8 接缝（TagExtractor/RepoMap/EditBlockParser/EditGuard/CheckpointTracker/PtyManager/GitService） | 2000-2800 | case-01~10 覆盖主要路径；case-10 专测 checkpoint restore |
| 13 | 前端 ArcTransport + 工具渲染 + 权限 UI | 1500-3000+ | 集成测覆盖 SSE→UIMessage 折叠；组件测用 MSW mock |

---

## 附录 B：第一周执行优先级

```
Day 1-2：
  [ ] bun install + biome + typecheck 通过
  [ ] 跑 smoke-test-native.ts（node-pty / bun:sqlite / drizzle 全部 PASS）
  [ ] drizzle-kit generate + migrate，建 workspaces/sessions/turns/events 五表
  [ ] license-gate.yml 跑通，确认无 GPL/LGPL

Day 3-4：
  [ ] queryLoop.ts 骨架 + 单元测（mock deps，assert turn.started/completed 事件）
  [ ] appendEvent.ts（seq 事务）+ 单元测（并发唯一性）
  [ ] POST /api/commands + GET /api/sessions/:id/events 打通（fake delta，SSE replay 验证）

Day 5：
  [ ] 接 AI SDK 真实 Anthropic（单 provider）
  [ ] 建 ToolRegistry + read_file + bash（走 nono）
  [ ] case-01 eval case fixture 建好，手跑 harness 验证链路

Week 2：
  [ ] 完善 ApprovalService + case-09
  [ ] CheckpointTracker + case-10
  [ ] 凑满 10 条 case，eval harness CI 接入
  [ ] eval.yml push main 触发首次 CI eval pass
```
