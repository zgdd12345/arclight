import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkflowSource, WorkflowStore } from "../index";

const dirs: string[] = [];
function freshStore(): WorkflowStore {
  const d = mkdtempSync(join(tmpdir(), "wf-idx-"));
  dirs.push(d);
  return new WorkflowStore(d);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveWorkflowSource：命名 vs 临场合成判定（spec §1, §3）", () => {
  test("slug 形且已存 → 载入命名源码", () => {
    const store = freshStore();
    store.save("gate-circuit", "await agent('q');");
    expect(resolveWorkflowSource("gate-circuit", store)).toBe("await agent('q');");
  });

  test("含语法符号的内联脚本 → 原样作临场合成源码", () => {
    const store = freshStore();
    const inline = "phase('x');\nconst r = await agent('hi');\nreturn r;";
    expect(resolveWorkflowSource(inline, store)).toBe(inline);
  });

  test("slug 形但未存 → 抛错（不把裸标识符当脚本跑，安全优先）", () => {
    const store = freshStore();
    expect(() => resolveWorkflowSource("missing-flow", store)).toThrow(/no such named workflow/);
  });
});
