import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../../db/client";
import { runMigrations } from "../../../db/migrate";
import { sessions, workspaces } from "../../../db/schema";
import { CheckpointTracker } from "../tracker";
import { UndoRedoController } from "../undo-redo";

let root: string;
let workTree: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let tracker: CheckpointTracker;
let ctl: UndoRedoController;

const read = (f: string) =>
  existsSync(join(workTree, f)) ? readFileSync(join(workTree, f), "utf8") : null;
const write = (f: string, v: string) => writeFileSync(join(workTree, f), v);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arclight-ur-"));
  workTree = join(root, "repo");
  const arclightDir = join(workTree, ".arclight");
  mkdirSync(workTree, { recursive: true });
  const { dbPath } = runMigrations(arclightDir);
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces).values({ id: "w1", name: "r", repoPath: workTree, arclightDir }).run();
  db.insert(sessions).values({ id: "s1", workspaceId: "w1" }).run();
  tracker = new CheckpointTracker(db, arclightDir, "w1", "s1", workTree);
  ctl = new UndoRedoController(tracker);
});
afterEach(() => {
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

/** 模拟一次"写操作"：pre-edit（首次记基线）→ 改文件 → post-edit（记可导航点）。
 *  与 runner 真实 checkpoint 钩子一致。 */
async function edit(value: string) {
  const pre = await tracker.commit("pre-edit:put");
  if (!ctl.hasBaseline()) ctl.record(pre.ref);
  write("f.txt", value);
  const post = await tracker.commit("post-edit:put");
  ctl.record(post.ref);
}

describe("undo/redo 游标", () => {
  test("三次编辑 → undo 回退 → redo 恢复", async () => {
    await edit("v1");
    await edit("v2");
    await edit("v3");
    expect(read("f.txt")).toBe("v3");

    expect((await ctl.undo()).ok).toBe(true);
    expect(read("f.txt")).toBe("v2");
    expect((await ctl.undo()).ok).toBe(true);
    expect(read("f.txt")).toBe("v1");

    expect((await ctl.redo()).ok).toBe(true);
    expect(read("f.txt")).toBe("v2");
    expect((await ctl.redo()).ok).toBe(true);
    expect(read("f.txt")).toBe("v3");
  });

  test("连续 undo 到底（含基线 empty）→ 再 undo 报错（earliest）", async () => {
    await edit("v1");
    await edit("v2");
    expect((await ctl.undo()).ok).toBe(true); // v1
    expect((await ctl.undo()).ok).toBe(true); // 基线（空）
    expect(read("f.txt")).toBeNull();
    const r = await ctl.undo();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("earliest");
  });

  test("已在最新 → redo 报错", async () => {
    await edit("v1");
    const r = await ctl.redo();
    expect(r.ok).toBe(false);
  });

  test("undo 后新写操作 → 清空 redo 栈（标准语义）", async () => {
    await edit("v1");
    await edit("v2");
    await edit("v3");
    await ctl.undo(); // v2
    await ctl.undo(); // v1
    expect(read("f.txt")).toBe("v1");

    // 在 v1 处发生新写 → redo 历史（v2/v3）作废
    await edit("v1-branch");
    expect(read("f.txt")).toBe("v1-branch");

    const r = await ctl.redo();
    expect(r.ok).toBe(false); // redo 栈已清空，无 v2/v3 可恢复
    if (!r.ok) expect(r.reason).toContain("latest");
  });

  test("空检查点 → undo/redo 优雅报错", async () => {
    expect((await ctl.undo()).ok).toBe(false);
    expect((await ctl.redo()).ok).toBe(false);
  });

  test("服务重启：新控制器从持久化行重建 → undo/redo 仍可用（hydration）", async () => {
    // 第一个控制器（beforeEach 的 ctl）模拟运行时三次编辑：baseline + 每个 post-edit 入栈、落库
    await edit("v1");
    await edit("v2");
    await edit("v3");
    expect(read("f.txt")).toBe("v3");

    // 进程重启：内存栈丢失，全新控制器只能从 checkpoints 行 hydrate（同一 tracker/DB）
    const fresh = new UndoRedoController(tracker);
    expect(fresh.hasBaseline()).toBe(true); // 不再误报"无检查点"

    const r1 = await fresh.undo();
    expect(r1.ok).toBe(true);
    expect(read("f.txt")).toBe("v2");
    const r2 = await fresh.undo();
    expect(r2.ok).toBe(true);
    expect(read("f.txt")).toBe("v1");
    const r3 = await fresh.undo(); // 回到基线（首次编辑前，空）
    expect(r3.ok).toBe(true);
    expect(read("f.txt")).toBeNull();

    // redo 链路同样从重建栈可用
    expect((await fresh.redo()).ok).toBe(true);
    expect(read("f.txt")).toBe("v1");
    expect((await fresh.redo()).ok).toBe(true);
    expect(read("f.txt")).toBe("v2");
  });
});
