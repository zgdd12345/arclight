import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../../db/client";
import { runMigrations } from "../../../db/migrate";
import { sessions, workspaces } from "../../../db/schema";
import { CheckpointTracker } from "../tracker";

let root: string;
let workTree: string;
let arclightDir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arclight-ckpt-"));
  workTree = join(root, "repo");
  arclightDir = join(workTree, ".arclight");
  mkdirSync(workTree, { recursive: true });
  const { dbPath } = runMigrations(arclightDir);
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces).values({ id: "w1", name: "r", repoPath: workTree, arclightDir }).run();
  db.insert(sessions).values({ id: "s1", workspaceId: "w1" }).run();
});
afterEach(() => {
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

function mkTracker() {
  return new CheckpointTracker(db, arclightDir, "w1", "s1", workTree);
}

describe("CheckpointTracker shadow-git", () => {
  test("commit 捕获文件变更，restore 回滚到指定 sha", async () => {
    const t = mkTracker();
    writeFileSync(join(workTree, "a.txt"), "v1");
    const c1 = await t.commit("pre-edit");
    writeFileSync(join(workTree, "a.txt"), "v2");
    const c2 = await t.commit("post-edit");
    expect(c2.changedFiles).toContain("a.txt");

    await t.restore(c1.ref);
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("v1");
    await t.restore(c2.ref);
    expect(readFileSync(join(workTree, "a.txt"), "utf8")).toBe("v2");
  });

  test("restore 删除 commit 之后新建的文件（reset --hard 语义）", async () => {
    const t = mkTracker();
    writeFileSync(join(workTree, "keep.txt"), "x");
    const c1 = await t.commit("c1");
    writeFileSync(join(workTree, "new.txt"), "y");
    await t.commit("c2");
    await t.restore(c1.ref);
    expect(existsSync(join(workTree, "new.txt"))).toBe(false);
    expect(existsSync(join(workTree, "keep.txt"))).toBe(true);
  });

  test("shadow 仓位于 .arclight/checkpoints，零干扰用户 .git", async () => {
    // 用户在工作区有自己的 .git（带一个提交）
    const userGit = join(workTree, ".git");
    mkdirSync(userGit, { recursive: true });
    writeFileSync(join(userGit, "HEAD"), "ref: refs/heads/main\n");
    const userHeadBefore = readFileSync(join(userGit, "HEAD"), "utf8");

    const t = mkTracker();
    writeFileSync(join(workTree, "f.txt"), "1");
    const c1 = await t.commit("c1");
    writeFileSync(join(workTree, "f.txt"), "2");
    await t.commit("c2");
    await t.restore(c1.ref);

    // 用户 .git 的 HEAD 文件未被 shadow 操作改动
    expect(readFileSync(join(userGit, "HEAD"), "utf8")).toBe(userHeadBefore);
    expect(t.shadowGitDir).toContain(".arclight/checkpoints");
    expect(existsSync(join(t.shadowGitDir, "HEAD"))).toBe(true);
  });

  test("checkpoints 表落库，list 有序", async () => {
    const t = mkTracker();
    writeFileSync(join(workTree, "a"), "1");
    await t.commit("first");
    writeFileSync(join(workTree, "a"), "2");
    await t.commit("second");
    const list = t.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.label).toBe("first");
    expect(list[1]?.label).toBe("second");
    expect(t.latest()?.label).toBe("second");
  });

  test("空变更也能 commit（--allow-empty 留点位）", async () => {
    const t = mkTracker();
    const c = await t.commit("empty");
    expect(c.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  test("latest() 返回最新行（等价 list().at(-1)），空表返回 null", async () => {
    const t = mkTracker();
    expect(t.latest()).toBeNull();
    writeFileSync(join(workTree, "a"), "1");
    await t.commit("c1");
    writeFileSync(join(workTree, "a"), "2");
    await t.commit("c2");
    writeFileSync(join(workTree, "a"), "3");
    const c3 = await t.commit("c3");
    const latest = t.latest();
    expect(latest?.label).toBe("c3");
    expect(latest?.ref).toBe(c3.ref);
    // 与全表 list 的末行一致（dedicated ORDER BY rowid DESC LIMIT 1 不改变语义）
    expect(latest?.id).toBe(t.list().at(-1)?.id);
  });
});
