import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDb } from "./client";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// 迁移锁（吸收 MISSING-3）：db:migrate 必须单点串行执行，禁止多进程并发迁移。
// O_EXCL 抢锁；持锁进程已死（stale pid）则清锁重试一次。
function acquireLock(lockPath: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* 已被清理 */
        }
      };
    } catch {
      const holder = Number(readFileSync(lockPath, "utf8").trim() || "0");
      const alive =
        holder > 0 &&
        (() => {
          try {
            process.kill(holder, 0);
            return true;
          } catch {
            return false;
          }
        })();
      if (alive) {
        throw new Error(
          `migration lock held by live pid ${holder} (${lockPath}); refusing concurrent migrate`,
        );
      }
      rmSync(lockPath, { force: true }); // stale lock，清掉重试
    }
  }
  throw new Error(`failed to acquire migration lock at ${lockPath}`);
}

/** 幂等迁移：重复执行不报错、不重复建表（drizzle 以 __drizzle_migrations 记账跳过已应用项）。 */
export function runMigrations(arclightDir: string): { dbPath: string } {
  mkdirSync(arclightDir, { recursive: true });
  const dbPath = join(arclightDir, "arclight.sqlite");
  const release = acquireLock(join(arclightDir, "migrate.lock"));
  try {
    const { db, sqlite } = createDb(dbPath);
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    sqlite.close();
    return { dbPath };
  } finally {
    release();
  }
}

// CLI 入口：bun packages/core/src/db/migrate.ts [--repo <path>]
if (import.meta.main) {
  const repoFlag = process.argv.indexOf("--repo");
  const repo = repoFlag >= 0 ? (process.argv[repoFlag + 1] ?? ".") : ".";
  const arclightDir = join(repo, ".arclight");
  if (!existsSync(repo)) {
    console.error(`repo path not found: ${repo}`);
    process.exit(1);
  }
  const { dbPath } = runMigrations(arclightDir);
  console.log(`migrations applied: ${dbPath}`);
}
