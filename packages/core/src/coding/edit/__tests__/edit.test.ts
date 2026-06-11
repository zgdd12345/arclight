import { describe, expect, test } from "bun:test";
import { applyEdit, findSimilarLines } from "../apply";
import { parseEditBlocks } from "../parser";

const block = (file: string, search: string, replace: string) =>
  `${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

describe("parseEditBlocks", () => {
  test("解析标准块（文件名在前一行）", () => {
    const r = parseEditBlocks(block("src/a.ts", "old line", "new line"));
    expect(r).toEqual({
      ok: true,
      blocks: [{ filePath: "src/a.ts", search: "old line", replace: "new line" }],
    });
  });

  test("marker 5-9 字符容错 + fence 包裹", () => {
    const text = "src/a.ts\n```ts\n<<<<<<<<< SEARCH\nx\n=========\ny\n>>>>>>>>> REPLACE\n```\n";
    const r = parseEditBlocks(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.blocks[0]?.filePath).toBe("src/a.ts");
  });

  test("多块共享前一文件名（连续块省略文件名）", () => {
    const text = `${block("src/a.ts", "one", "1")}\n<<<<<<< SEARCH\ntwo\n=======\n2\n>>>>>>> REPLACE\n`;
    const r = parseEditBlocks(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.blocks).toHaveLength(2);
      expect(r.blocks[1]?.filePath).toBe("src/a.ts");
    }
  });

  test("缺 divider / 缺 REPLACE 收口 → 报错不猜", () => {
    expect(parseEditBlocks("a.ts\n<<<<<<< SEARCH\nx\n>>>>>>> REPLACE\n").ok).toBe(false);
    expect(parseEditBlocks("a.ts\n<<<<<<< SEARCH\nx\n=======\ny\n").ok).toBe(false);
  });

  test("无块 → 报错", () => {
    expect(parseEditBlocks("just prose").ok).toBe(false);
  });
});

describe("applyEdit 阶梯①：逐字完美", () => {
  test("精确替换首个匹配", () => {
    const r = applyEdit("aaa\nbbb\nccc\n", "bbb", "BBB");
    expect(r).toEqual({ ok: true, content: "aaa\nBBB\nccc\n" });
  });

  test("空 SEARCH 对空文件 = 创建", () => {
    const r = applyEdit("", "", "new content\n");
    expect(r).toEqual({ ok: true, content: "new content\n" });
  });
});

describe("applyEdit 阶梯②：前导空白容忍", () => {
  test("统一缩进偏移可匹配，替换段补回偏移", () => {
    const content = "function f() {\n    if (x) {\n        return 1;\n    }\n}\n";
    const r = applyEdit(content, "if (x) {\n    return 1;\n}", "if (x) {\n    return 2;\n}");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("        return 2;");
  });

  test("偏移不一致 → 不误匹配", () => {
    const content = "  aaa\n      bbb\n";
    const r = applyEdit(content, "aaa\nbbb", "xxx\nyyy");
    expect(r.ok).toBe(false);
  });
});

describe("applyEdit 阶梯③：省略号分段", () => {
  test("配对 ... 分段替换", () => {
    const content = "head\nalpha\nmiddle stuff\nomega\ntail\n";
    const search = "alpha\n...\nomega\n";
    const replace = "ALPHA\n...\nOMEGA\n";
    const r = applyEdit(content, search, replace);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("head\nALPHA\nmiddle stuff\nOMEGA\ntail\n");
  });

  test("未配对 ... → 明确报错（EditGuard 语义）", () => {
    const r = applyEdit("a\nb\nc\n", "a\n...\nc\n", "A\nC\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unpaired");
  });

  test("分段不唯一 → 拒绝（防误改）", () => {
    const content = "x\nsame\ny\nsame\nz\n";
    const r = applyEdit(content, "same\n...\nz\n", "SAME\n...\nz\n");
    expect(r.ok).toBe(false);
  });
});

describe("失败路径：did-you-mean（0.6 阈值）", () => {
  test("近似内容给出建议片段", () => {
    const content = "function verifyToken(token) {\n  if (payload.exp < Date.now()) {\n  }\n}\n";
    const r = applyEdit(content, "if (payload.expires < Date.now()) {", "CHANGED");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.didYouMean).toContain("payload.exp");
  });

  test("毫不相关内容无建议", () => {
    expect(findSimilarLines("totally unrelated zebra", "alpha\nbeta\n")).toBeNull();
  });
});
