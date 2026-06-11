import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pino } from "pino";
import { loadConfig } from "./config/load";
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { EventBus } from "./events/bus";
import { createApp } from "./server/app";
import { removeServerJson, writeServerJson } from "./server/serverJson";

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
  const app = createApp({ repoPath: repo, arclightDir, db, bus, token });
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
