import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pino } from "pino";
import { ApprovalPolicy } from "./approval/policy";
import { ArtifactStore } from "./artifacts/store";
import { loadConfig } from "./config/load";
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { EventBus } from "./events/bus";
import { makeCallProvider } from "./loop/provider-adapter";
import { AgentRunner } from "./loop/runner";
import { CODE_AGENT_SYSTEM_PROMPT } from "./loop/system-prompt";
import { SandboxRouter } from "./sandbox/router";
import { createApp } from "./server/app";
import { removeServerJson, writeServerJson } from "./server/serverJson";
import { applyPatchTool } from "./tools/builtin/applyPatch";
import { bashTool } from "./tools/builtin/bash";
import { readFileTool } from "./tools/builtin/readFile";
import { writeFileTool } from "./tools/builtin/writeFile";
import { makeExecuteTool, ToolRegistry } from "./tools/registry";

// arclight serve --repo <path>：迁移锁 → migrate → db/bus → Hono(C1/C2) → server.json 0600

function parseArgs(argv: string[]): { repo: string } {
  const i = argv.indexOf("--repo");
  return { repo: resolve(i >= 0 ? (argv[i + 1] ?? ".") : ".") };
}

export async function serve(argv: string[] = process.argv.slice(2)): Promise<void> {
  const log = pino({
    redact: { paths: ["token", "apiKey", "anthropicApiKey", "*.token", "*.apiKey"] },
  });
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
  const approvals = new ApprovalPolicy(db, bus); // fail-closed：黑名单永拒 + confirm 弹审批
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
  });

  const app = createApp({ repoPath: repo, arclightDir, db, bus, token, runner, approvals });
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

  const shutdown = () => {
    removeServerJson(arclightDir);
    server.stop();
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
