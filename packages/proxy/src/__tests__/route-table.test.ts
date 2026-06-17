import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE, type RouteTable, resolveUpstream } from "../route-table";

const table: RouteTable = {
  "/health": "py",
  "/api/sessions": "ts",
};

describe("resolveUpstream", () => {
  test("longest-prefix match wins", () => {
    expect(resolveUpstream("/health", table)).toBe("py");
    expect(resolveUpstream("/api/sessions/abc/events", table)).toBe("ts");
  });
  test("unknown path defaults to ts", () => {
    expect(resolveUpstream("/api/unknown", table)).toBe("ts");
  });
  test("a sibling path does not false-match a shorter prefix", () => {
    // "/healthcheck" must NOT match the "/health" group
    expect(resolveUpstream("/healthcheck", { "/health": "py" })).toBe("ts");
  });
});

describe("DEFAULT_TABLE", () => {
  test("health group is /health and routes to py", () => {
    expect(DEFAULT_TABLE["/health"]).toBe("py");
    expect(DEFAULT_TABLE["/api/health"]).toBeUndefined();
  });
  test("all /api/* groups still route to ts", () => {
    for (const [prefix, up] of Object.entries(DEFAULT_TABLE)) {
      if (prefix.startsWith("/api/")) expect(up).toBe("ts");
    }
  });
});
