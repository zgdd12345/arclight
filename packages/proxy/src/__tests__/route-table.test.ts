import { describe, expect, test } from "bun:test";
import { type RouteTable, resolveUpstream } from "../route-table";

const table: RouteTable = {
  "/api/health": "ts",
  "/api/sessions": "ts",
};

describe("resolveUpstream", () => {
  test("longest-prefix match wins", () => {
    expect(resolveUpstream("/api/health", table)).toBe("ts");
    expect(resolveUpstream("/api/sessions/abc/events", table)).toBe("ts");
  });
  test("unknown path defaults to ts", () => {
    expect(resolveUpstream("/api/unknown", table)).toBe("ts");
  });
  test("a group flipped to py routes to py", () => {
    expect(resolveUpstream("/api/health", { "/api/health": "py" })).toBe("py");
  });
});
