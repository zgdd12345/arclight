import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApprovalPolicy } from "./approval/policy";
import { ArtifactStore } from "./artifacts/store";
import { loadConfig } from "./config/load";
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { EventBus } from "./events/bus";
import { ProviderManager } from "./loop/provider-manager";
import { SharedRateLimiter } from "./loop/rate-limiter";
import { AgentRunner } from "./loop/runner";
import { CODE_AGENT_SYSTEM_PROMPT } from "./loop/system-prompt";
import { AuditLog } from "./observability/audit";
import { createLogger } from "./observability/logger";
import { SandboxRouter } from "./sandbox/router";
import { createApp } from "./server/app";
import { removeServerJson, writeServerJson } from "./server/serverJson";
import { applyPatchTool } from "./tools/builtin/applyPatch";
import { bashTool } from "./tools/builtin/bash";
import { readFileTool } from "./tools/builtin/readFile";
import { runWorkflowTool } from "./tools/builtin/runWorkflow";
import { writeFileTool } from "./tools/builtin/writeFile";
import { makeExecuteTool, ToolRegistry } from "./tools/registry";
import { UsageTracker } from "./usage/tracker";
import { createWorkflowRunner, WorkflowJournalService, WorkflowStore, TemplateStore } from "./workflow";

// arclight serve --repo <path>：迁移锁 → migrate → db/bus → Hono(C1/C2) → server.json 0600

function parseArgs(argv: string[]): { repo: string } {
  const i = argv.indexOf("--repo");
  return { repo: resolve(i >= 0 ? (argv[i + 1] ?? ".") : ".") };
}

export async function serve(argv: string[] = process.argv.slice(2)): Promise<void> {
  const log = createLogger({ dev: process.env.NODE_ENV !== "production" });
  const { repo } = parseArgs(argv);
  const config = loadConfig(repo); // 缺 anthropicApiKey 在此即失败
  const arclightDir = resolve(repo, ".arclight");
  mkdirSync(arclightDir, { recursive: true });

  const { dbPath } = runMigrations(arclightDir); // 内含迁移锁，单点串行
  log.info({ dbPath }, "migrations applied");

  const { db, sqlite } = createDb(dbPath);
  const bus = new EventBus();
  const token = randomBytes(32).toString("hex");

  // 真实流水线：单 provider（Anthropic，D4）+ 4 内置工具 + 沙箱路由 + spill
  const sandbox = new SandboxRouter();
  // provider 共享限流：进程单例，跨所有 session / subagent 共用（spec §6 真并行前提）。
  const sharedRateLimiter = new SharedRateLimiter({ maxConcurrent: 8 });
  const sandboxProbe = await sandbox.probe();
  log.info(sandboxProbe, "sandbox backend");
  const registry = new ToolRegistry()
    .register(readFileTool as never)
    .register(writeFileTool as never)
    .register(applyPatchTool as never)
    .register(bashTool as never)
    .register(runWorkflowTool as never); // M6：主 agent 临场合成入口
  const audit = new AuditLog(arclightDir);
  const runId = `serve-${process.pid}`;
  const approvals = new ApprovalPolicy(db, bus, {
    audit: (kind, detail, sessionId) =>
      audit.write(runId, { kind, actor: "agent", detail, ...(sessionId ? { sessionId } : {}) }),
  }); // fail-closed：黑名单永拒 + confirm 弹审批
  // ProviderManager：runner 持稳定委托，/api/config PATCH 热切换 model/thinking
  const providerManager = new ProviderManager(
    {
      apiKey: config.anthropicApiKey,
      model: config.model,
      systemPrompt: CODE_AGENT_SYSTEM_PROMPT,
      thinking: config.thinking,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    },
    arclightDir,
    sharedRateLimiter,
  );
  // ── M6 workflow 生产接线 ──
  const workflowStore = new WorkflowStore(arclightDir);
  const templateStore = new TemplateStore(arclightDir);
  const workflowJournal = new WorkflowJournalService(db);
  // 子 agent 的工具执行壳：不注入 workflows（杜绝子 agent 经工具层自起 workflow，spec §1/§10）。
  const subagentExecuteTool = makeExecuteTool({
    sandbox,
    artifacts: new ArtifactStore(db, arclightDir),
  });
  // per-call 启动接缝（createWorkflowRunner，workflow/launch.ts）：tool 注入与 HTTP route 共用同一 WorkflowContext 装配。
  const launchWorkflow = createWorkflowRunner({
    db,
    bus,
    callProvider: providerManager.callProvider,
    registry,
    approvals,
    executeTool: subagentExecuteTool,
    store: workflowStore,
    journal: workflowJournal,
  });

  const runner = new AgentRunner({
    db,
    bus,
    registry,
    callProvider: providerManager.callProvider,
    executeTool: makeExecuteTool({
      sandbox,
      artifacts: new ArtifactStore(db, arclightDir),
      workflows: { store: workflowStore, launch: launchWorkflow }, // M6 注入接缝
    }),
    approvals,
    onInterrupt: (turnId) => approvals.cancelTurn(turnId), // 中断 → 挂起审批转 cancelled
    arclightDir, // 启用 shadow-git 检查点 + /undo /redo
    repoMap: true, // 进 turn 注入 RepoMap 上下文（tree-sitter 不可用自动正则降级）
    // 成本可观测：model 传 thunk 取当前值，PATCH /api/config 热切换后记账随之更新
    usage: new UsageTracker(db, config.baseUrl ? "zhipu" : "anthropic", () =>
      providerManager.currentModel(),
    ),
  });

  // devNoAuth / projectsRoot 由 config/load.ts 统一解析（env 优先级 + 校验 + config.json 分层）。
  const { devNoAuth, projectsRoot } = config;
  if (devNoAuth) {
    log.warn(
      "⚠ ARCLIGHT_DEV_NO_AUTH=1：bearer 鉴权已全局放行，任意/空 token 均可访问 /api/*。仅限本地测试，切勿用于暴露到不可信网络的部署。",
    );
  }
  const app = createApp({
    repoPath: repo,
    arclightDir,
    db,
    bus,
    token,
    runner,
    approvals,
    devNoAuth,
    providerManager,
    // projectsRoot 在 loadConfig 内恒被计算，但类型为 optional；exactOptionalPropertyTypes 下条件展开。
    ...(projectsRoot !== undefined ? { projectsRoot } : {}),
    workflowRunner: launchWorkflow,
    workflowStore,
    templateStore,
  });
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0, // SSE 长连接不掐
    fetch: app.fetch,
  });

  writeServerJson(arclightDir, {
    pid: process.pid,
    port: config.port,
    origin: `http://${config.host}:${config.port}`,
    token,
    workspaceId: "local", // 首个 session 创建时落 workspaces 表
    repoPath: repo,
  });
  log.info({ origin: `http://${config.host}:${config.port}`, repo }, "arclight core listening");
  void runner.warmup(repo); // 后台预热 RepoMap 冷路径（tokenizer/tree-sitter/tag 缓存），消首 turn 空窗

  const shutdown = () => {
    removeServerJson(arclightDir);
    server.stop();
    runner.dispose(); // 释放跨 turn 持有的 RepoMap SQLite 句柄
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  serve().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
