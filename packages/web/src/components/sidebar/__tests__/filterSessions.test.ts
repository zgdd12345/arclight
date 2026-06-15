import { describe, expect, it } from "vitest";
import { filterSessions } from "../ProjectSidebar";

const S = (id: string, title: string | null) => ({ id, title });

describe("filterSessions", () => {
  const list = [
    S("aaaa1111", "重构登录流程"),
    S("bbbb2222", "Fix CORS bug"),
    S("cccc3333", null), // 无标题 → 回退 "会话 cccc3333"
  ];

  it("空查询返回原列表", () => {
    expect(filterSessions(list, "")).toBe(list);
    expect(filterSessions(list, "   ")).toBe(list);
  });

  it("按标题不区分大小写匹配", () => {
    expect(filterSessions(list, "登录").map((s) => s.id)).toEqual(["aaaa1111"]);
    expect(filterSessions(list, "cors").map((s) => s.id)).toEqual(["bbbb2222"]);
    expect(filterSessions(list, "CORS").map((s) => s.id)).toEqual(["bbbb2222"]);
  });

  it("null 标题按回退名 '会话 <id前8>' 匹配", () => {
    expect(filterSessions(list, "cccc3333").map((s) => s.id)).toEqual(["cccc3333"]);
    expect(filterSessions(list, "会话").map((s) => s.id)).toEqual(["cccc3333"]);
  });

  it("无匹配返回空数组", () => {
    expect(filterSessions(list, "zzzzz")).toEqual([]);
  });
});
