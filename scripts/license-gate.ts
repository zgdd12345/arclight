// license-gate（DEV_PLAN §3.4）：扫描依赖 license，拦截 GPL/LGPL/AGPL/EUPL。
// MPL-2.0 走人工 allowlist（当前空）。读各依赖 package.json 的 license 字段。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = /\b(GPL|LGPL|AGPL|EUPL)\b/i;
const MPL_ALLOWLIST = new Set<string>([]); // MPL-2.0 人工豁免（按需加包名）

const root = join(import.meta.dir, "..");
const violations: { pkg: string; license: string }[] = [];

function scanDir(nmDir: string): void {
  if (!existsSync(nmDir)) return;
  for (const entry of readdirSync(nmDir)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      scanDir(join(nmDir, entry)); // scope
      continue;
    }
    const pkgJson = join(nmDir, entry, "package.json");
    if (!existsSync(pkgJson)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
        name?: string;
        license?: string;
        licenses?: { type: string }[];
      };
      const lic = pkg.license ?? pkg.licenses?.map((l) => l.type).join(",") ?? "";
      const name = pkg.name ?? entry;
      if (typeof lic === "string" && FORBIDDEN.test(lic)) {
        violations.push({ pkg: name, license: lic });
      }
      if (/MPL/i.test(typeof lic === "string" ? lic : "") && !MPL_ALLOWLIST.has(name)) {
        violations.push({ pkg: name, license: `${lic} (MPL 需人工豁免)` });
      }
    } catch {
      /* 无法解析的 package.json 跳过 */
    }
  }
}

// 扫根 + 各 workspace 包的 node_modules
scanDir(join(root, "node_modules"));
for (const p of ["protocol", "core", "client-core", "web", "cli"]) {
  scanDir(join(root, "packages", p, "node_modules"));
}

if (violations.length > 0) {
  console.error(`✗ license-gate: ${violations.length} 个禁用许可证依赖：`);
  for (const v of violations) console.error(`  ${v.pkg} — ${v.license}`);
  process.exit(1);
}
console.log("✓ license-gate: 无 GPL/LGPL/AGPL/EUPL/未豁免 MPL 依赖");
