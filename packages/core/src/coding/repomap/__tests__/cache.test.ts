// TagCache 缓存键测试。安全核心：主键 (repo_root, rel_path)——
// 多项目共享同一 .arclight 时，相同相对路径不得串号（A 项目的符号不能喂给 B 项目）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TagCache } from "../cache";
import type { Tag } from "../types";

const tag = (relPath: string, name: string): Tag => ({ relPath, name, kind: "def", line: 0 });

describe("TagCache 按 repoRoot 隔离", () => {
  let arclightDir: string;
  let repoA: string;
  let repoB: string;
  let cache: TagCache;

  beforeEach(() => {
    arclightDir = mkdtempSync(join(tmpdir(), "arclight-tagcache-"));
    repoA = mkdtempSync(join(tmpdir(), "arclight-repoA-"));
    repoB = mkdtempSync(join(tmpdir(), "arclight-repoB-"));
    // 两个项目各有同名相对路径 src/index.ts，但内容/符号不同
    mkdirSync(join(repoA, "src"));
    mkdirSync(join(repoB, "src"));
    writeFileSync(join(repoA, "src/index.ts"), "export const fromA = 1;\n");
    writeFileSync(join(repoB, "src/index.ts"), "export const fromB = 2;\n");
    cache = new TagCache(arclightDir);
  });
  afterEach(() => {
    cache.close();
    for (const d of [arclightDir, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  });

  test("相同 rel_path、不同 repoRoot 的缓存互不污染", () => {
    const rel = "src/index.ts";
    cache.put(repoA, rel, [tag(rel, "fromA")]);
    cache.put(repoB, rel, [tag(rel, "fromB")]);

    const a = cache.get(repoA, rel);
    const b = cache.get(repoB, rel);
    expect(a?.map((t) => t.name)).toEqual(["fromA"]);
    expect(b?.map((t) => t.name)).toEqual(["fromB"]);
  });

  test("未为某 repoRoot 写入则 get 返回 null（不借用另一项目的条目）", () => {
    const rel = "src/index.ts";
    cache.put(repoA, rel, [tag(rel, "fromA")]);
    expect(cache.get(repoB, rel)).toBeNull();
  });
});
