// Route-group → upstream. Values are either a plain Upstream (all methods) or a
// per-method map with a required `default`. Longest-prefix match decides the
// group; method then selects within a method-map. Flipping a group/method is a
// one-line edit here.
export type Upstream = "ts" | "py";
export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type MethodUpstream = Partial<Record<Method, Upstream>> & { default: Upstream };
export type RouteTable = Record<string, Upstream | MethodUpstream>;

export const DEFAULT_TABLE: RouteTable = {
  "/health": "py",
  "/api/projects": { GET: "py", default: "ts" },
  "/api/config": "ts",
  "/api/files": "ts",
  "/api/grants": "ts",
  "/api/commands": "ts",
  "/api/sessions": "ts",
  "/api/memories": "ts",
};

function isMethodUpstream(v: Upstream | MethodUpstream): v is MethodUpstream {
  return typeof v === "object" && v !== null && "default" in v;
}

export function resolveUpstream(path: string, table: RouteTable, method = "GET"): Upstream {
  let best = "";
  for (const prefix of Object.keys(table)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (prefix.length > best.length) best = prefix;
    }
  }
  if (!best) return "ts";
  const v = table[best];
  if (isMethodUpstream(v)) {
    return v[method as Method] ?? v.default;
  }
  return v;
}
