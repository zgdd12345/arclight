// Route-group → upstream. M0: every group points at "ts". Flipping a group to
// "py" (a later milestone) is a one-line edit here. Longest-prefix match decides.
export type Upstream = "ts" | "py";
export type RouteTable = Record<string, Upstream>;

export const DEFAULT_TABLE: RouteTable = {
  "/api/health": "ts",
  "/api/config": "ts",
  "/api/projects": "ts",
  "/api/files": "ts",
  "/api/grants": "ts",
  "/api/commands": "ts",
  "/api/sessions": "ts",
};

export function resolveUpstream(path: string, table: RouteTable): Upstream {
  let best = "";
  for (const prefix of Object.keys(table)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (prefix.length > best.length) best = prefix;
    }
  }
  return best ? table[best] : "ts";
}
