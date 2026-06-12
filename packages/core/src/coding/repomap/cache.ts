import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tag } from "./types";

// mtime 缓存（bun:sqlite）：文件 mtime 未变则跳过重新解析（aider diskcache 思路）。
// 缓存目录 .arclight/cache/repomap/tags.sqlite。
export class TagCache {
  private readonly db: Database;

  constructor(arclightDir: string) {
    const dir = join(arclightDir, "cache", "repomap");
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "tags.sqlite"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    // 主键 (repo_root, rel_path)：多个项目共享同一 .arclight 时，
    // 相同相对路径（如各自的 src/index.ts）不再串号串符号表。
    // 这是可重建的临时缓存表，旧 schema（仅 rel_path 主键）直接 DROP 重建——丢失仅触发重新提取，不迁移用户数据。
    const cols = this.db.query<{ name: string }, []>("PRAGMA table_info(tag_cache)").all();
    if (cols.length > 0 && !cols.some((c) => c.name === "repo_root")) {
      this.db.exec("DROP TABLE tag_cache");
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS tag_cache (repo_root TEXT NOT NULL, rel_path TEXT NOT NULL, mtime_ms INTEGER NOT NULL, tags TEXT NOT NULL, PRIMARY KEY (repo_root, rel_path))",
    );
  }

  /** 返回缓存的 tags（若 mtime 命中），否则 null */
  get(repoRoot: string, relPath: string): Tag[] | null {
    let mtime: number;
    try {
      mtime = statSync(join(repoRoot, relPath)).mtimeMs;
    } catch {
      return null;
    }
    const row = this.db
      .query<{ mtime_ms: number; tags: string }, [string, string]>(
        "SELECT mtime_ms, tags FROM tag_cache WHERE repo_root = ? AND rel_path = ?",
      )
      .get(repoRoot, relPath);
    if (!row || row.mtime_ms !== mtime) return null;
    try {
      return JSON.parse(row.tags) as Tag[];
    } catch {
      return null;
    }
  }

  put(repoRoot: string, relPath: string, tags: Tag[]): void {
    let mtime: number;
    try {
      mtime = statSync(join(repoRoot, relPath)).mtimeMs;
    } catch {
      return;
    }
    this.db
      .query(
        "INSERT OR REPLACE INTO tag_cache (repo_root, rel_path, mtime_ms, tags) VALUES (?, ?, ?, ?)",
      )
      .run(repoRoot, relPath, mtime, JSON.stringify(tags));
  }

  close(): void {
    this.db.close();
  }
}
