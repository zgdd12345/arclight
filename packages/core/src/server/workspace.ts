import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { workspaces } from "../db/schema";

/** 默认工作区兜底：按 repoPath 查现有 workspace 行，缺则插入并返回新 id。
 *  会话（含工作流临时会话）的 workspaceId 是非空 FK，须挂到存在的 workspace 行。 */
export function ensureWorkspace(db: Db, repoPath: string, arclightDir: string): string {
  const existing = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.repoPath, repoPath))
    .get();
  if (existing) return existing.id;
  const id = randomUUID();
  db.insert(workspaces)
    .values({ id, name: repoPath.split("/").at(-1) ?? "repo", repoPath, arclightDir })
    .run();
  return id;
}
