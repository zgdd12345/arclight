import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_NAME_RE, WorkflowStore } from "../store";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wf-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("WorkflowStore：命名 workflow 加载/保存（spec §3 store.ts, §14）", () => {
  test("save 后 load 拿回同一源码 + 稳定 scriptHash", () => {
    const store = new WorkflowStore(freshDir());
    const src = "phase('plan'); const r = await agent('hi'); return r;";
    const saved = store.save("my-flow", src);
    const loaded = store.load("my-flow");
    expect(loaded.name).toBe("my-flow");
    expect(loaded.source).toBe(src);
    expect(loaded.scriptHash).toBe(saved.scriptHash);
    expect(loaded.scriptHash).toBe(WorkflowStore.hashScript(src));
    expect(loaded.scriptHash).toHaveLength(64); // sha256 hex 全长，防 resume 碰撞误命中
  });

  test("list 去 .workflow.js 后缀并排序；目录不存在返回 []", () => {
    const store = new WorkflowStore(freshDir());
    expect(store.list()).toEqual([]); // workflows/ 子目录尚未创建
    store.save("zeta", "return 1;");
    store.save("alpha", "return 2;");
    expect(store.list()).toEqual(["alpha", "zeta"]);
  });

  test("§11 量子消费者：gate-circuit.workflow.js 落盘即可被 list/load", () => {
    const dir = freshDir();
    const wfDir = join(dir, "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "gate-circuit.workflow.js"), "await agent('build circuit');", "utf8");
    const store = new WorkflowStore(dir);
    expect(store.list()).toContain("gate-circuit");
    expect(store.load("gate-circuit").source).toContain("build circuit");
  });

  test("has：存在性探测，非法名直接 false 不抛", () => {
    const store = new WorkflowStore(freshDir());
    expect(store.has("missing")).toBe(false);
    expect(store.has("../etc/passwd")).toBe(false);
    store.save("present", "return 0;");
    expect(store.has("present")).toBe(true);
  });

  test("安全：路径穿越/非法名一律拒绝（spec §10）", () => {
    const store = new WorkflowStore(freshDir());
    for (const bad of ["../x", "a/b", ".", "..", "Foo", "with space", "", "x".repeat(65)]) {
      expect(() => store.save(bad, "x")).toThrow(/invalid workflow name/);
      expect(() => store.load(bad)).toThrow(/invalid workflow name/);
    }
    expect(WORKFLOW_NAME_RE.test("gate-circuit")).toBe(true);
    expect(WORKFLOW_NAME_RE.test("v2")).toBe(true);
  });

  test("load 合法但不存在的名 → 抛 no such workflow", () => {
    const store = new WorkflowStore(freshDir());
    expect(() => store.load("nope")).toThrow(/no such workflow/);
  });

  test("save 空源码被拒", () => {
    const store = new WorkflowStore(freshDir());
    expect(() => store.save("ok", "")).toThrow(/non-empty/);
  });
});
