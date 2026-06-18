import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE, type RouteTable, resolveUpstream } from "../route-table";

describe("resolveUpstream — plain + prefix entries", () => {
  const table: RouteTable = { "/health": "py", "/api/sessions": "ts" };
  test("exact + subpath match", () => {
    expect(resolveUpstream("/health", table, "GET")).toBe("py");
    expect(resolveUpstream("/api/sessions/abc/events", table, "GET")).toBe("ts");
  });
  test("unknown path defaults to ts", () => {
    expect(resolveUpstream("/api/unknown", table, "GET")).toBe("ts");
  });
  test("sibling does not false-match", () => {
    expect(resolveUpstream("/healthcheck", { "/health": "py" }, "GET")).toBe("ts");
  });
  test("plain entry ignores method", () => {
    expect(resolveUpstream("/health", { "/health": "py" }, "POST")).toBe("py");
  });
});

describe("resolveUpstream — exact-match channel", () => {
  const table: RouteTable = {
    "=/api/projects": { GET: "py", default: "ts" },
    "/api/projects": { PATCH: "py", DELETE: "py", default: "ts" },
  };
  test("exact path uses the = entry (wins over the prefix entry)", () => {
    expect(resolveUpstream("/api/projects", table, "GET")).toBe("py");
    expect(resolveUpstream("/api/projects", table, "POST")).toBe("ts");
  });
  test("trailing slash on the exact path still resolves to the exact entry", () => {
    expect(resolveUpstream("/api/projects/", table, "GET")).toBe("py");
    expect(resolveUpstream("/api/projects/", table, "POST")).toBe("ts");
  });
  test("subpaths use the prefix entry, NOT the exact entry", () => {
    expect(resolveUpstream("/api/projects/ws1", table, "PATCH")).toBe("py");
    expect(resolveUpstream("/api/projects/ws1", table, "DELETE")).toBe("py");
    // the M3 sessions read must stay ts (regression: slice 2 sent this to py)
    expect(resolveUpstream("/api/projects/ws1/sessions", table, "GET")).toBe("ts");
    // a subpath POST/unknown method falls to the prefix default
    expect(resolveUpstream("/api/projects/ws1", table, "POST")).toBe("ts");
  });
});

describe("DEFAULT_TABLE", () => {
  test("GET /api/projects → py (slice 2 preserved); POST → ts (stays TS this slice)", () => {
    expect(resolveUpstream("/api/projects", DEFAULT_TABLE, "GET")).toBe("py");
    expect(resolveUpstream("/api/projects", DEFAULT_TABLE, "POST")).toBe("ts");
  });
  test("PATCH/DELETE /api/projects/:id → py; GET :id/sessions → ts", () => {
    expect(resolveUpstream("/api/projects/ws1", DEFAULT_TABLE, "PATCH")).toBe("py");
    expect(resolveUpstream("/api/projects/ws1", DEFAULT_TABLE, "DELETE")).toBe("py");
    expect(resolveUpstream("/api/projects/ws1/sessions", DEFAULT_TABLE, "GET")).toBe("ts");
  });
  test("health → py; other /api/* → ts", () => {
    expect(resolveUpstream("/health", DEFAULT_TABLE, "GET")).toBe("py");
    expect(resolveUpstream("/api/sessions", DEFAULT_TABLE, "GET")).toBe("ts");
    expect(resolveUpstream("/api/config", DEFAULT_TABLE, "GET")).toBe("ts");
  });
  test("whole /api/memories group → py (all methods + subpaths)", () => {
    expect(resolveUpstream("/api/memories", DEFAULT_TABLE, "GET")).toBe("py");
    expect(resolveUpstream("/api/memories", DEFAULT_TABLE, "POST")).toBe("py");
    expect(resolveUpstream("/api/memories/m1", DEFAULT_TABLE, "PATCH")).toBe("py");
    expect(resolveUpstream("/api/memories/m1", DEFAULT_TABLE, "DELETE")).toBe("py");
  });
});
