import { describe, expect, test } from "bun:test";
import { extractViaRegex, selectExtractResult } from "../tag-extractor";
import type { Tag } from "../types";

// ────────────────────────────────────────────────────────────────────────────
// selectExtractResult — 回归：空数组不应屏蔽 regex 降级
// ────────────────────────────────────────────────────────────────────────────
describe("selectExtractResult（AST/regex 选择逻辑）", () => {
  // 有真实 def 标识符的源码，regex 能提取到，用于充当降级返回值
  const srcWithSymbol = "export function realSymbol() { return 1; }";
  const makeRegexFallback = () => () => extractViaRegex(srcWithSymbol, "a.ts");

  test("AST 为 null 时触发 regex 降级（parser 初始化失败路径）", () => {
    const result = selectExtractResult(null, makeRegexFallback());
    expect(result.some((t) => t.name === "realSymbol")).toBe(true);
  });

  test("【回归】AST 返回空数组时也触发 regex 降级（纯注释/walker 未覆盖语法场景）", () => {
    // 修复前：[] 为 truthy，if (viaAst) 成立，regex 被跳过，标识符丢失
    // 修复后：viaAst.length === 0 视为失败，正确降级
    const fallbackCalled = { yes: false };
    const result = selectExtractResult([], () => {
      fallbackCalled.yes = true;
      return extractViaRegex(srcWithSymbol, "a.ts");
    });
    expect(fallbackCalled.yes).toBe(true); // 降级必须发生
    expect(result.some((t) => t.name === "realSymbol")).toBe(true); // regex 结果正确返回
  });

  test("AST 返回非空数组时直接返回 AST 结果，不调用 regex", () => {
    const astTag: Tag = { relPath: "a.ts", name: "astSymbol", kind: "def", line: 0 };
    const fallbackCalled = { yes: false };
    const result = selectExtractResult([astTag], () => {
      fallbackCalled.yes = true;
      return extractViaRegex(srcWithSymbol, "a.ts");
    });
    expect(fallbackCalled.yes).toBe(false); // regex 不应被调用
    expect(result).toEqual([astTag]); // 严格返回 AST 结果
    // 确认 regex 的 realSymbol 没有混入
    expect(result.some((t) => t.name === "realSymbol")).toBe(false);
  });

  test("AST 返回多个 tag 时全量保留，不截断", () => {
    const astTags: Tag[] = [
      { relPath: "b.ts", name: "Alpha", kind: "def", line: 0 },
      { relPath: "b.ts", name: "Beta", kind: "ref", line: 1 },
      { relPath: "b.ts", name: "Gamma", kind: "def", line: 2 },
    ];
    const result = selectExtractResult(astTags, () => []);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractViaRegex + selectExtractResult 联合场景：模拟 AST 空走真实影响
// ────────────────────────────────────────────────────────────────────────────
describe("AST 空走 → regex 降级联合场景", () => {
  test("注释行文件：AST 若空走，regex 至少抽出标识符引用", () => {
    // 纯注释文件对 tree-sitter 简化 walker 可能产生空 tags
    // 这里用 extractViaRegex 验证降级路径的输出行为
    const commentSrc = [
      "// 这是一个纯注释文件",
      "// TODO: implement FooService",
      "// see: https://example.com/BarHelper",
    ].join("\n");

    // regex 会从注释中抽出引用（非 keyword 标识符）
    const regexTags = extractViaRegex(commentSrc, "comment-only.ts");
    // 确认 regex 路径有产出（FooService / BarHelper 等）
    // 即使 AST 空走，regex 降级不会白费
    const names = regexTags.map((t) => t.name);
    expect(names).toContain("FooService");

    // 模拟 AST 空走：selectExtractResult([], fallback) 应返回 regex 结果
    const result = selectExtractResult([], () => regexTags);
    expect(result).toBe(regexTags); // 同一对象，无拷贝
    expect(result.some((t) => t.name === "FooService")).toBe(true);
  });

  test("普通 TS 文件：AST 有结果时 regex 不应覆盖 AST 结果", () => {
    const tsSrc = "export class UserRepository { find() {} }";
    const regexTags = extractViaRegex(tsSrc, "repo.ts");
    const astTags: Tag[] = [{ relPath: "repo.ts", name: "UserRepository", kind: "def", line: 0 }];
    // AST 非空 → 返回 AST，regex 结果被丢弃
    const result = selectExtractResult(astTags, () => regexTags);
    expect(result).toEqual(astTags);
    expect(result).not.toBe(regexTags);
  });
});
