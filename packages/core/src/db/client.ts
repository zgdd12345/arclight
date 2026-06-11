import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

// 单连接 + WAL（DEV_PLAN §3.1 并发纪律：同 session 单 active turn 保写串行，跨 session 事务隔离兜底）
export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
