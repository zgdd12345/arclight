import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApprovalPolicy } from "./approval/policy";
import { ArtifactStore } from "./artifacts/store";
import { loadConfig } from "./config/load";
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { EventBus } from "./events/bus";
import { makeCallProvider } from "./loop/provider-adapter";
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
import { writeFileTool } from "./tools/builtin/writeFile";
import { makeExecuteTool, ToolRegistry } from "./tools/registry";
import { UsageTracker } from "./usage/tracker";

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
  const sandboxProbe = await sandbox.probe();
  log.info(sandboxProbe, "sandbox backend");
  const registry = new ToolRegistry()
    .register(readFileTool as never)
    .register(writeFileTool as never)
    .register(applyPatchTool as never)
    .register(bashTool as never);
  const audit = new AuditLog(arclightDir);
  const runId = `serve-${process.pid}`;
  const approvals = new ApprovalPolicy(db, bus, {
    audit: (kind, detail, sessionId) =>
      audit.write(runId, { kind, actor: "agent", detail, ...(sessionId ? { sessionId } : {}) }),
  }); // fail-closed：黑名单永拒 + confirm 弹审批
  const runner = new AgentRunner({
    db,
    bus,
    registry,
    callProvider: makeCallProvider({
      apiKey: config.anthropicApiKey,
      model: config.model,
      systemPrompt: CODE_AGENT_SYSTEM_PROMPT,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    }),
    executeTool: makeExecuteTool({ sandbox, artifacts: new ArtifactStore(db, arclightDir) }),
    approvals,
    onInterrupt: (turnId) => approvals.cancelTurn(turnId), // 中断 → 挂起审批转 cancelled
    arclightDir, // 启用 shadow-git 检查点 + /undo /redo
    repoMap: true, // 进 turn 注入 RepoMap 上下文（tree-sitter 不可用自动正则降级）
    usage: new UsageTracker(db, config.baseUrl ? "zhipu" : "anthropic", config.model), // 成本可观测
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
    // projectsRoot 在 loadConfig 内恒被计算，但类型为 optional；exactOptionalPropertyTypes 下条件展开。
    ...(projectsRoot !== undefined ? { projectsRoot } : {}),
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
