import { describe, expect, test } from "bun:test";
import { ResumePlanner } from "../resume";
import type { JournalRow } from "../types";

const row = (
  seq: number,
  specHash: string,
  status: JournalRow["status"],
  result: unknown,
): JournalRow => ({
  seq,
  specHash,
  status,
  resultJson: result,
});

describe("ResumePlanner 前缀重放", () => {
  test("全部规格未变 → 逐调用命中，回灌 prior 结果", () => {
    const p = new ResumePlanner([row(0, "h0", "completed", "r0"), row(1, "h1", "completed", "r1")]);
    expect(p.consult(0, "h0")).toEqual({ hit: true, result: "r0" });
    expect(p.consult(1, "h1")).toEqual({ hit: true, result: "r1" });
    expect(p.cacheHits).toBe(2);
  });

  test("中段 specHash 变更 → 该调用起整条尾部失效（即便其后规格未变）", () => {
    const p = new ResumePlanner([
      row(0, "h0", "completed", "r0"),
      row(1, "h1", "completed", "r1"),
      row(2, "h2", "completed", "r2"),
    ]);
    expect(p.consult(0, "h0").hit).toBe(true);
    expect(p.consult(1, "CHANGED").hit).toBe(false); // 变更点
    expect(p.consult(2, "h2").hit).toBe(false); // 尾部失效
    expect(p.cacheHits).toBe(1);
  });

  test("prior 该 seq 非 completed（failed/缺失） → 未命中且尾部失效", () => {
    const p = new ResumePlanner([row(0, "h0", "failed", null)]);
    expect(p.consult(0, "h0").hit).toBe(false);
    expect(p.consult(1, "h1").hit).toBe(false);
    expect(p.cacheHits).toBe(0);
  });

  test("空 journal（全新 run） → 一律未命中", () => {
    const p = new ResumePlanner([]);
    expect(p.consult(0, "h0").hit).toBe(false);
    expect(p.cacheHits).toBe(0);
  });
});
