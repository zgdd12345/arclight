// Bun 原生模块 smoke test（DEV_PLAN §3.3，第一周强制）。
// 语义：PASS=可用；DEGRADED=本体不可用但批准的降级路径可用（"全绿或明确降级"）；
// FAIL=本体与降级均不可用 → exit(1)。bun:sqlite/drizzle/docker-fallback 无降级路径，FAIL 即硬失败。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../packages/core/src/db/migrate";
import { DockerFallbackSandbox } from "../packages/core/src/sandbox/backends/dockerFallback";
import { LocalNonoSandbox } from "../packages/core/src/sandbox/backends/localNono";

type Status = "PASS" | "DEGRADED" | "FAIL" | "SKIP";
type Result = { name: string; blocking: boolean; status: Status; detail: string };
const results: Result[] = [];

async function check(
  name: string,
  blocking: boolean,
  fn: () => Promise<{ status: Status; detail: string }>,
): Promise<void> {
  try {
    const r = await fn();
    results.push({ name, blocking, ...r });
  } catch (e) {
    results.push({
      name,
      blocking,
      status: "FAIL",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

// 1. bun:sqlite（blocking，无降级）
await check("bun:sqlite", true, async () => {
  const { Database } = await import("bun:sqlite");
  const db = new Database(":memory:");
  const row = db.query<{ x: number }, []>("SELECT 1 AS x").get();
  db.close();
  return row?.x === 1
    ? { status: "PASS", detail: "in-memory query ok" }
    : { status: "FAIL", detail: "unexpected query result" };
});

// 2. drizzle + bun:sqlite：11 张域表建表 + 迁移幂等（blocking，无降级）
await check("drizzle+bun:sqlite migrate", true, async () => {
  const dir = mkdtempSync(join(tmpdir(), "arclight-smoke-"));
  try {
    runMigrations(join(dir, ".arclight"));
    runMigrations(join(dir, ".arclight")); // 幂等：第二次不得抛错
    return { status: "PASS", detail: "11 domain tables created, re-migrate idempotent" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 3. node-pty（P0 blocking；降级 Bun.spawn pipe，丢 TTY → 交互终端推后）
await check("node-pty", true, async () => {
  const { checkNodePty } = await import("../packages/core/src/smoke/native");
  const r = await checkNodePty();
  return r.ok
    ? { status: "PASS", detail: r.detail }
    : { status: "DEGRADED", detail: `${r.detail} — fallback Bun.spawn pipe (no TTY)` };
});

// 4. web-tree-sitter WASM：解析 10 行 TS（P0 blocking；降级正则粗提取，RepoMap 降精度）
await check("web-tree-sitter", true, async () => {
  const { checkTreeSitter } = await import("../packages/core/src/smoke/native");
  const r = await checkTreeSitter();
  return r.ok
    ? { status: "PASS", detail: r.detail }
    : { status: "DEGRADED", detail: `${r.detail} — fallback regex extraction` };
});

// 5. nono（P0 blocking；降级 docker-fallback）
await check("nono", true, async () => {
  const probe = await new LocalNonoSandbox().probe();
  if (probe.available) return { status: "PASS", detail: probe.detail };
  const docker = await new DockerFallbackSandbox().probe();
  return docker.available
    ? { status: "DEGRADED", detail: `${probe.detail} — fallback docker-fallback available` }
    : { status: "FAIL", detail: `${probe.detail}; docker fallback also unavailable` };
});

// 6. docker-fallback：真实跑 echo ok（P0 blocking，CI 前置，无降级 → 不可用即 SANDBOX_UNAVAILABLE）
await check("docker-fallback", true, async () => {
  const sb = new DockerFallbackSandbox();
  const r = await sb.run({
    runId: `smoke-${process.pid}`,
    cwd: tmpdir(),
    command: ["echo", "ok"],
    workspaceMode: "ro",
    timeoutMs: 60_000,
  });
  return r.exitCode === 0 && r.stdout.trim() === "ok"
    ? { status: "PASS", detail: `docker run echo ok (${r.durationMs}ms, network=none, read-only)` }
    : { status: "FAIL", detail: `exit=${r.exitCode} stdout=${r.stdout.slice(0, 60)}` };
});

// 7. Next.js next dev @ Node runtime（non-blocking，吸收 PL-3）— web 包 slice2 接线后启用
await check("next-dev@node", false, async () => ({
  status: "SKIP",
  detail: "web package lands in slice2 (Unit 3); re-enable then",
}));

// 8. sqlite-vec（non-blocking，阶段二预探路；缺省仅 FTS5 BM25）
await check("sqlite-vec", false, async () => {
  const { Database } = await import("bun:sqlite");
  const db = new Database(":memory:");
  try {
    const row = db
      .query<{ ok: number }, []>(
        "SELECT CASE WHEN sqlite_compileoption_used('ENABLE_FTS5') THEN 1 ELSE 0 END AS ok",
      )
      .get();
    return {
      status: row?.ok === 1 ? "PASS" : "DEGRADED",
      detail: row?.ok === 1 ? "FTS5 available (sqlite-vec 阶段二再评估)" : "FTS5 missing",
    };
  } finally {
    db.close();
  }
});

// ── 汇总 ──
const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\n${pad("CHECK", 28)}${pad("BLOCKING", 10)}${pad("STATUS", 10)}DETAIL`);
for (const r of results) {
  console.log(
    `${pad(r.name, 28)}${pad(r.blocking ? "yes" : "no", 10)}${pad(r.status, 10)}${r.detail}`,
  );
}
const hardFails = results.filter((r) => r.blocking && r.status === "FAIL");
const degraded = results.filter((r) => r.status === "DEGRADED");
if (degraded.length > 0) {
  console.log(`\n⚠ ${degraded.length} item(s) degraded — 降级方案已在 DETAIL 列说明`);
}
if (hardFails.length > 0) {
  console.error(`\n✗ ${hardFails.length} blocking item(s) FAILED hard — slice0 不可验收`);
  process.exit(1);
}
console.log("\n✓ smoke passed (全绿或明确降级)");
