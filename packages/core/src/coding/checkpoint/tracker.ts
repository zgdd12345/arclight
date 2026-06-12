import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { checkpoints } from "../../db/schema";
import { git, gitOrThrow, shadowGitDirExists, withNestedGitDisabled } from "./git-operations";

// CheckpointTracker：每次写操作前后在 shadow 仓 commit，落 checkpoints 表。
// /undo 二分定位 sha → reset --hard（O(log n)）；/redo 游标前移；新写清空 redo 栈。

export type CheckpointRow = {
  id: string;
  ref: string;
  label: string | null;
  changedFiles: string[] | null;
  createdAt: Date;
};

export class CheckpointTracker {
  private readonly gitDir: string;
  private readonly _workspaceId: string;

  constructor(
    private readonly db: Db,
    arclightDir: string,
    workspaceId: string,
    private readonly sessionId: string,
    private readonly workTree: string,
  ) {
    this._workspaceId = workspaceId;
    const hash = createHash("sha256").update(workTree).digest("hex").slice(0, 16);
    this.gitDir = join(arclightDir, "checkpoints", `${hash}.git`);
  }

  /** 惰性初始化 shadow 仓（bare-ish：独立 git-dir，work-tree 指真实工作区） */
  async ensureInit(): Promise<void> {
    if (shadowGitDirExists(this.gitDir)) return;
    mkdirSync(this.gitDir, { recursive: true });
    await gitOrThrow(this.gitDir, this.workTree, ["init", "-q"]);
    await gitOrThrow(this.gitDir, this.workTree, ["config", "user.email", "arclight@local"]);
    await gitOrThrow(this.gitDir, this.workTree, ["config", "user.name", "arclight"]);
    // 排除运行时目录与 volatile 文件（绝不快照 .arclight：含 live sqlite-wal/-shm）
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(
      join(this.gitDir, "info", "exclude"),
      [".arclight/", "node_modules/", "*.sqlite", "*.sqlite-shm", "*.sqlite-wal", ""].join("\n"),
    );
  }

  /** 创建检查点（pre/post-edit）。返回 sha；无变化也 --allow-empty 留点位。 */
  async commit(
    label: string,
    turnId?: string,
  ): Promise<{ id: string; ref: string; changedFiles: string[] }> {
    await this.ensureInit();
    const { sha, changedFiles } = await withNestedGitDisabled(this.workTree, async () => {
      await gitOrThrow(this.gitDir, this.workTree, ["add", "-A"]);
      // 取本次相对上一次的变更文件（staged）
      const diff = await git(this.gitDir, this.workTree, ["diff", "--cached", "--name-only"]);
      const files = diff.stdout ? diff.stdout.split("\n").filter(Boolean) : [];
      const sha = await gitOrThrow(this.gitDir, this.workTree, [
        "commit",
        "--allow-empty",
        "--no-verify",
        "-q",
        "-m",
        label,
      ]).then(() => gitOrThrow(this.gitDir, this.workTree, ["rev-parse", "HEAD"]));
      return { sha, changedFiles: files };
    });

    const id = randomUUID(); // 行唯一；同 sha 可在 undo 分支后重复出现，故不由 sha 派生
    this.db
      .insert(checkpoints)
      .values({
        id,
        workspaceId: this._workspaceId,
        sessionId: this.sessionId,
        turnId: turnId ?? null,
        backend: "shadow-git",
        ref: sha,
        label,
        changedFiles,
      })
      .run();
    return { id, ref: sha, changedFiles };
  }

  /** 恢复工作区到指定 sha（reset --hard）。零干扰用户 .git（work-tree 隔离）。 */
  async restore(sha: string): Promise<void> {
    await this.ensureInit();
    await withNestedGitDisabled(this.workTree, async () => {
      await gitOrThrow(this.gitDir, this.workTree, ["reset", "--hard", "-q", sha]);
    });
  }

  /** 本 session 检查点有序列表（旧→新）。按 rowid（插入顺序，单调）排序——
   *  createdAt 毫秒可能在同一 turn 内碰撞，id 是 hash 不单调，故用 rowid 兜底。 */
  list(): CheckpointRow[] {
    return this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, this.sessionId))
      .orderBy(sql`rowid`)
      .all()
      .map((r) => ({
        id: r.id,
        ref: r.ref,
        label: r.label,
        changedFiles: r.changedFiles,
        createdAt: r.createdAt,
      }));
  }

  /** 本 session 最新检查点（ORDER BY rowid DESC LIMIT 1）——避免 list() 全表反序列化。 */
  latest(): CheckpointRow | null {
    const r = this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, this.sessionId))
      .orderBy(sql`rowid DESC`)
      .limit(1)
      .get();
    if (!r) return null;
    return {
      id: r.id,
      ref: r.ref,
      label: r.label,
      changedFiles: r.changedFiles,
      createdAt: r.createdAt,
    };
  }

  get shadowGitDir(): string {
    return this.gitDir;
  }
}
