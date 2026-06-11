// bun:test（依赖 bun:sqlite，故不走 vitest；由 `bun run test:core` 执行）

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrate";

const DOMAIN_TABLES = [
  "workspaces",
  "sessions",
  "turns",
  "messages",
  "events",
  "tool_calls",
  "artifacts",
  "approvals",
  "checkpoints",
  "usage",
  "secrets_metadata",
] as const;

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function listTables(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all();
  db.close();
  return rows.map((r) => r.name);
}

describe("runMigrations", () => {
  test("creates all 11 domain tables", () => {
    dir = mkdtempSync(join(tmpdir(), "arclight-migrate-"));
    const { dbPath } = runMigrations(join(dir, ".arclight"));
    const tables = listTables(dbPath);
    for (const t of DOMAIN_TABLES) expect(tables).toContain(t);
  });

  test("is idempotent — second run neither throws nor duplicates", () => {
    dir = mkdtempSync(join(tmpdir(), "arclight-migrate-"));
    const arclightDir = join(dir, ".arclight");
    runMigrations(arclightDir);
    const first = listTables(join(arclightDir, "arclight.sqlite")).sort();
    expect(() => runMigrations(arclightDir)).not.toThrow();
    const second = listTables(join(arclightDir, "arclight.sqlite")).sort();
    expect(second).toEqual(first);
  });

  test("releases the migration lock after completion", () => {
    dir = mkdtempSync(join(tmpdir(), "arclight-migrate-"));
    const arclightDir = join(dir, ".arclight");
    runMigrations(arclightDir);
    expect(existsSync(join(arclightDir, "migrate.lock"))).toBe(false);
  });

  test("refuses to run while a live process holds the lock", () => {
    dir = mkdtempSync(join(tmpdir(), "arclight-migrate-"));
    const arclightDir = join(dir, ".arclight");
    runMigrations(arclightDir); // 先建目录
    writeFileSync(join(arclightDir, "migrate.lock"), String(process.pid)); // 活 pid（本进程）
    expect(() => runMigrations(arclightDir)).toThrow(/migration lock held by live pid/);
  });

  test("clears a stale lock (dead pid) and proceeds", () => {
    dir = mkdtempSync(join(tmpdir(), "arclight-migrate-"));
    const arclightDir = join(dir, ".arclight");
    runMigrations(arclightDir);
    writeFileSync(join(arclightDir, "migrate.lock"), "999999999"); // 不存在的 pid
    expect(() => runMigrations(arclightDir)).not.toThrow();
    expect(existsSync(join(arclightDir, "migrate.lock"))).toBe(false);
  });

  test("events table enforces (session_id, seq) uniqueness — seq 不变式兜底", () => {
    dir = mkdtempSync(join(tmpdir(), "arclight-migrate-"));
    const { dbPath } = runMigrations(join(dir, ".arclight"));
    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(
      "INSERT INTO workspaces (id, name, repo_path, arclight_dir) VALUES ('w1','t','/r','/r/.arclight')",
    );
    db.exec("INSERT INTO sessions (id, workspace_id) VALUES ('s1','w1')");
    const ins = (id: string, seq: number) =>
      db.exec(
        `INSERT INTO events (id, session_id, seq, type, event) VALUES ('${id}','s1',${seq},'turn.started','{}')`,
      );
    ins("e1", 1);
    expect(() => ins("e2", 1)).toThrow(); // 同 session 重复 seq 必须被唯一约束拒绝
    db.close();
  });
});
