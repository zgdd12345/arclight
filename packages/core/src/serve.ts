import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pino } from "pino";
import { loadConfig } from "./config/load";
import { runMigrations } from "./db/migrate";
import { createApp } from "./server/app";
import { removeServerJson, writeServerJson } from "./server/serverJson";

// arclight serve --repo <path>（slice0：迁移锁 → migrate → Hono /health → server.json 0600）
// slice1+ 在此编排 SSE / runner / sandbox。

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

  const app = createApp({ repoPath: repo });
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });

  const token = randomBytes(32).toString("hex");
  const origin = `http://${config.host}:${config.port}`;
  writeServerJson(arclightDir, {
    pid: process.pid,
    port: config.port,
    origin,
    token,
    workspaceId: "local", // slice1 起从 workspaces 表分配
    repoPath: repo,
  });
  log.info({ origin, repo }, "arclight core listening");

  const shutdown = () => {
    removeServerJson(arclightDir);
    server.stop();
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
