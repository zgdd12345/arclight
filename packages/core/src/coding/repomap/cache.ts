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
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS tag_cache (rel_path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, tags TEXT NOT NULL)",
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
      .query<{ mtime_ms: number; tags: string }, [string]>(
        "SELECT mtime_ms, tags FROM tag_cache WHERE rel_path = ?",
      )
      .get(relPath);
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
      .query("INSERT OR REPLACE INTO tag_cache (rel_path, mtime_ms, tags) VALUES (?, ?, ?)")
      .run(relPath, mtime, JSON.stringify(tags));
  }

  close(): void {
    this.db.close();
  }
}
