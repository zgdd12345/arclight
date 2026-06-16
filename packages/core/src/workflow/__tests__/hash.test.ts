import { describe, expect, test } from "bun:test";
import { argsHash, canonicalJson, scriptHash, specHash } from "../hash";

describe("workflow 指纹：确定性 + 键序无关", () => {
  test("specHash 与顶层键序无关", () => {
    expect(specHash({ a: 1, b: 2 })).toBe(specHash({ b: 2, a: 1 }));
  });
  test("specHash 对嵌套对象/数组内对象键序也稳定", () => {
    expect(specHash({ x: { p: 1, q: 2 }, y: [{ m: 1, n: 2 }] })).toBe(
      specHash({ y: [{ n: 2, m: 1 }], x: { q: 2, p: 1 } }),
    );
  });
  test("数组元素顺序仍敏感（语义有序）", () => {
    expect(specHash([1, 2, 3])).not.toBe(specHash([3, 2, 1]));
  });
  test("不同规格 → 不同哈希", () => {
    expect(specHash({ prompt: "a" })).not.toBe(specHash({ prompt: "b" }));
  });
  test("scriptHash/argsHash 同源稳定、异源不同", () => {
    expect(scriptHash("agent('x')")).toBe(scriptHash("agent('x')"));
    expect(scriptHash("agent('x')")).not.toBe(scriptHash("agent('y')"));
    expect(argsHash({ seed: 1 })).toBe(argsHash({ seed: 1 }));
    expect(argsHash({ seed: 1 })).not.toBe(argsHash({ seed: 2 }));
  });
  test("canonicalJson 输出可被 JSON.parse 还原", () => {
    expect(JSON.parse(canonicalJson({ b: [3, 2], a: "x" }))).toEqual({ a: "x", b: [3, 2] });
  });
});
