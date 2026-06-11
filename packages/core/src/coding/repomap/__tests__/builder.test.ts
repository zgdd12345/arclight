import { describe, expect, test } from "bun:test";
import { rankTags } from "../builder";
import { extractViaRegex } from "../tag-extractor";
import type { Tag } from "../types";

const def = (relPath: string, name: string, line = 0): Tag => ({
  relPath,
  name,
  kind: "def",
  line,
});
const ref = (relPath: string, name: string, line = 0): Tag => ({
  relPath,
  name,
  kind: "ref",
  line,
});

describe("rankTags pagerank（权重对齐 aider）", () => {
  test("被引用更多的定义排名更高", () => {
    const tags: Tag[] = [
      def("util.ts", "helper"),
      ref("a.ts", "helper"),
      ref("b.ts", "helper"),
      ref("c.ts", "helper"),
      def("lonely.ts", "unused"),
    ];
    const ranked = rankTags(tags);
    const util = ranked.find((e) => e.relPath === "util.ts");
    const lonely = ranked.find((e) => e.relPath === "lonely.ts");
    expect(util).toBeDefined();
    expect(util?.rank ?? 0).toBeGreaterThan(lonely?.rank ?? 0);
  });

  test("同图内：chat 文件引用的定义排名高于非 chat 引用的定义（×50 + personalization）", () => {
    // chatDef 被 chat.ts 引用；plainDef 被 plain.ts 引用——chat 引用应让 chatDef 胜出
    const tags: Tag[] = [
      def("chatDef.ts", "alpha"),
      ref("chat.ts", "alpha"),
      def("plainDef.ts", "beta"),
      ref("plain.ts", "beta"),
    ];
    const ranked = rankTags(tags, { chatFiles: new Set(["chat.ts"]) });
    const chatDef = ranked.find((e) => e.relPath === "chatDef.ts")?.rank ?? 0;
    const plainDef = ranked.find((e) => e.relPath === "plainDef.ts")?.rank ?? 0;
    expect(chatDef).toBeGreaterThan(plainDef);
  });

  test("mentioned 标识符获 ×10 提升", () => {
    const tags: Tag[] = [
      def("x.ts", "alpha"),
      ref("u.ts", "alpha"),
      def("y.ts", "beta"),
      ref("u.ts", "beta"),
    ];
    const plain = rankTags(tags);
    const mentioned = rankTags(tags, { mentionedIdents: new Set(["alpha"]) });
    const alphaPlain = plain.find((e) => e.relPath === "x.ts")?.rank ?? 0;
    const alphaMentioned = mentioned.find((e) => e.relPath === "x.ts")?.rank ?? 0;
    expect(alphaMentioned).toBeGreaterThan(alphaPlain);
  });

  test("私有名（_ 前缀）权重 ×0.1 降权", () => {
    const tags: Tag[] = [
      def("p.ts", "_privateHelper"),
      ref("a.ts", "_privateHelper"),
      def("q.ts", "publicHelper"),
      ref("a.ts", "publicHelper"),
    ];
    const ranked = rankTags(tags);
    const priv = ranked.find((e) => e.relPath === "p.ts")?.rank ?? 0;
    const pub = ranked.find((e) => e.relPath === "q.ts")?.rank ?? 0;
    expect(pub).toBeGreaterThan(priv);
  });

  test("空 tags → 空结果", () => {
    expect(rankTags([])).toEqual([]);
  });
});

describe("extractViaRegex（R2 降级路径）", () => {
  test("抽取 function/class/const 定义", () => {
    const src = [
      "export function verifyToken(token) {",
      "  return decode(token);",
      "}",
      "class AuthService {}",
      "const handler = async () => {};",
    ].join("\n");
    const tags = extractViaRegex(src, "auth.ts");
    const defs = tags.filter((t) => t.kind === "def").map((t) => t.name);
    expect(defs).toContain("verifyToken");
    expect(defs).toContain("AuthService");
    expect(defs).toContain("handler");
  });

  test("关键字不被当标识符", () => {
    const tags = extractViaRegex("return true; const x = if;", "x.ts");
    expect(tags.every((t) => t.name !== "return" && t.name !== "if" && t.name !== "true")).toBe(
      true,
    );
  });
});
