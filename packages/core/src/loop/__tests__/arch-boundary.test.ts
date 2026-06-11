// 架构守护：provider-adapter.ts 是全仓唯一 import "ai" 的文件（DEV_PLAN §2.1 关键坑②）。
// 以源码扫描实现（dependency-cruiser 同效，零额外依赖——与计划工具差异已记账）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOTS = ["packages/core/src", "packages/client-core/src", "packages/protocol/src"];
const ALLOWED = "packages/core/src/loop/provider-adapter.ts";
const IMPORT_AI_RE = /from\s+["'](ai|@ai-sdk\/[^"']+)["']|import\s*\(\s*["'](ai|@ai-sdk\/)/;

async function listTsFiles(root: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.ts");
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: root })) files.push(join(root, f));
  return files;
}

describe("架构边界", () => {
  test('唯一 import "ai" / "@ai-sdk/*" 的文件是 provider-adapter.ts', async () => {
    const offenders: string[] = [];
    for (const root of SRC_ROOTS) {
      for (const file of await listTsFiles(root)) {
        if (file.endsWith(".test.ts")) continue;
        if (IMPORT_AI_RE.test(readFileSync(file, "utf8")) && file !== ALLOWED) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("client-core 不 import core；core 不 import 端包（单向依赖纪律）", async () => {
    const offenders: string[] = [];
    for (const file of await listTsFiles("packages/client-core/src")) {
      if (/from\s+["']@arclight\/core["']/.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    for (const file of await listTsFiles("packages/core/src")) {
      if (/from\s+["']@arclight\/(client-core|web|cli)["']/.test(readFileSync(file, "utf8"))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
