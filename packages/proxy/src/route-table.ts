// Route-group → upstream. Values are either a plain Upstream (all methods) or a
// per-method map with a required `default`. A key prefixed with "=" is an
// EXACT-path match (the "=" is stripped; the remainder must equal the request
// path exactly) and wins over every prefix entry — this lets an exact path and
// its subpaths route differently (e.g. GET /api/projects → py, but
// GET /api/projects/:id/sessions → ts). Non-"=" keys are longest-prefix.
// Flipping a group/method/exact-path is a one-line edit here.
export type Upstream = "ts" | "py";
export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type MethodUpstream = Partial<Record<Method, Upstream>> & { default: Upstream };
export type RouteTable = Record<string, Upstream | MethodUpstream>;

export const DEFAULT_TABLE: RouteTable = {
  "/health": "py",
  // Exact path: GET → py (slice 2). POST (create) stays TS this slice — it
  // co-migrates with sessions.ts ensureWorkspace() in M3 (second INSERT writer).
  "=/api/projects": { GET: "py", default: "ts" },
  // Subpaths: PATCH/DELETE /:id → py (slice 3). GET /:id/sessions reads the M3
  // sessions table → stays ts (also fixes the latent slice-2 mis-route).
  "/api/projects": { PATCH: "py", DELETE: "py", default: "ts" },
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

function pick(v: Upstream | MethodUpstream, method: string): Upstream {
  if (isMethodUpstream(v)) return v[method as Method] ?? v.default;
  return v;
}

export function resolveUpstream(path: string, table: RouteTable, method = "GET"): Upstream {
  // Normalize a single trailing slash (except root "/") so "/api/projects/"
  // resolves identically to "/api/projects" — otherwise a trailing slash skips
  // the exact-match channel and falls to the prefix default, silently re-routing
  // a migrated exact path back to TS.
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  // Exact-match entries (keyed "=<path>") win over prefix entries.
  const exact = table[`=${path}`];
  if (exact !== undefined) return pick(exact, method);
  // Longest-prefix among the non-exact keys.
  let best = "";
  for (const key of Object.keys(table)) {
    if (key.startsWith("=")) continue;
    if (path === key || path.startsWith(`${key}/`)) {
      if (key.length > best.length) best = key;
    }
  }
  if (!best) return "ts";
  return pick(table[best], method);
}
