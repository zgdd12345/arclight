import { describe, expect, test } from "bun:test";
import { guardEditBlocks } from "../guard";
import type { EditBlock } from "../parser";

const b = (search: string, replace: string): EditBlock => ({ filePath: "f.ts", search, replace });

describe("EditGuard", () => {
  test("配对省略号通过", () => {
    expect(guardEditBlocks([b("a\n...\nz", "A\n...\nZ")])).toEqual([]);
  });

  test("省略号未配对 → 违规", () => {
    const v = guardEditBlocks([b("a\n...\nz", "A\nZ")]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain("unpaired ellipsis");
  });

  test("REPLACE 含截断占位注释 → 违规（防偷懒省略丢代码）", () => {
    for (const hint of [
      "// ... rest of file",
      "# ... remaining code",
      "  // rest of the function",
      "// existing code here",
    ]) {
      const v = guardEditBlocks([b("foo", `bar\n${hint}\nbaz`)]);
      expect(v.length, hint).toBeGreaterThanOrEqual(1);
      expect(v.some((x) => x.reason.includes("truncation"))).toBe(true);
    }
  });

  test("正常编辑无违规", () => {
    expect(guardEditBlocks([b("const x = 1;", "const x = 2;")])).toEqual([]);
  });

  test("多块各自判定，违规带块号", () => {
    const v = guardEditBlocks([
      b("ok", "fine"),
      b("a\n...\nb", "A"), // 块 1 未配对
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.block).toBe(1);
  });
});
