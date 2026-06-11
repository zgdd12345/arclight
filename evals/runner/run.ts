// Golden eval harness（DEV_PLAN §3.2，slice2 初版：case-01 + 确定性 judge）。
// 每条 case 走真实 HTTP/SSE/tool 链路（in-process Bun.serve，非薄接缝）。
// 模式：默认真实 provider（需 ANTHROPIC_API_KEY）；ARCLIGHT_EVAL_MOCK=1 用脚本化 provider
// 验证除 LLM 外的全链（CI 冒烟用；golden 红线判定必须真实模式）。
// 后续（U7）：10 case 全集、LLM soft judge、tokens/cost metrics、eval.yml 接线。
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../packages/core/src/artifacts/store";
import { createDb } from "../../packages/core/src/db/client";
import { runMigrations } from "../../packages/core/src/db/migrate";
import { EventBus } from "../../packages/core/src/events/bus";
import { makeCallProvider } from "../../packages/core/src/loop/provider-adapter";
import { AgentRunner } from "../../packages/core/src/loop/runner";
import { CODE_AGENT_SYSTEM_PROMPT } from "../../packages/core/src/loop/system-prompt";
import type { CallProvider } from "../../packages/core/src/loop/types";
import { SandboxRouter } from "../../packages/core/src/sandbox/router";
import { createApp } from "../../packages/core/src/server/app";
import { applyPatchTool } from "../../packages/core/src/tools/builtin/applyPatch";
import { bashTool } from "../../packages/core/src/tools/builtin/bash";
import { readFileTool } from "../../packages/core/src/tools/builtin/readFile";
import { writeFileTool } from "../../packages/core/src/tools/builtin/writeFile";
import { makeExecuteTool, ToolRegistry } from "../../packages/core/src/tools/registry";

type Judge =
  | { kind: "file-contains"; path: string; text: string }
  | { kind: "ts-parses"; path: string };
type EvalCase = {
  id: string;
  fixture: string;
  instruction: string;
  timeoutMs: number;
  judges: Judge[];
};

const ROOT = join(import.meta.dir, "..");
const TOKEN = "eval-harness-token-0123456789abcdef0123456789abcdef";

function runJudges(
  workdir: string,
  judges: Judge[],
): { name: string; pass: boolean; detail: string }[] {
  return judges.map((j) => {
    const abs = join(workdir, j.path);
    if (!existsSync(abs)) {
      return { name: `${j.kind}:${j.path}`, pass: false, detail: "file missing" };
    }
    const content = readFileSync(abs, "utf8");
    if (j.kind === "file-contains") {
      const pass = content.includes(j.text);
      return { name: `file-contains:"${j.text}"`, pass, detail: pass ? "ok" : "not found" };
    }
    try {
      new Bun.Transpiler({ loader: "ts" }).transformSync(content);
      return { name: `ts-parses:${j.path}`, pass: true, detail: "ok" };
    } catch (e) {
      return {
        name: `ts-parses:${j.path}`,
        pass: false,
        detail: e instanceof Error ? e.message.slice(0, 120) : "parse error",
      };
    }
  });
}

/** mock provider：read → apply_patch → 收尾（验证除 LLM 外全链） */
function mockProviderFor(caseId: string): CallProvider {
  if (caseId !== "case-01-add-function") throw new Error(`no mock script for ${caseId}`);
  const patch = [
    "src/math.ts",
    "<<<<<<< SEARCH",
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "=======",
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export function multiply(a: number, b: number): number {",
    "  return a * b;",
    "}",
    ">>>>>>> REPLACE",
  ].join("\n");
  let round = 0;
  return async function* (_messages, _tools, _signal) {
    round++;
    if (round === 1) {
      return {
        text: "先读文件。",
        toolCalls: [{ callId: "m1", name: "read_file", rawArgs: { path: "src/math.ts" } }],
        finishReason: "tool-calls" as const,
      };
    }
    if (round === 2) {
      return {
        text: "应用编辑。",
        toolCalls: [{ callId: "m2", name: "apply_patch", rawArgs: { patch } }],
        finishReason: "tool-calls" as const,
      };
    }
    yield { type: "text-delta", text: "已添加 multiply 并保留 add。" };
    return { text: "已添加 multiply 并保留 add。", toolCalls: [], finishReason: "stop" as const };
  };
}

async function runCase(c: EvalCase, mock: boolean): Promise<boolean> {
  const workdir = mkdtempSync(join(tmpdir(), `arclight-eval-${c.id}-`));
  cpSync(join(ROOT, "fixtures", c.fixture), workdir, { recursive: true });
  const arclightDir = join(workdir, ".arclight");
  const { dbPath } = runMigrations(arclightDir);
  const { db, sqlite } = createDb(dbPath);
  const bus = new EventBus();
  const registry = new ToolRegistry()
    .register(readFileTool as never)
    .register(writeFileTool as never)
    .register(applyPatchTool as never)
    .register(bashTool as never);
  const callProvider = mock
    ? mockProviderFor(c.id)
    : makeCallProvider({
        apiKey: process.env.ANTHROPIC_API_KEY ?? "",
        model: process.env.ARCLIGHT_MODEL ?? "claude-sonnet-4-5",
        systemPrompt: CODE_AGENT_SYSTEM_PROMPT,
      });
  const runner = new AgentRunner({
    db,
    bus,
    registry,
    callProvider,
    executeTool: makeExecuteTool({
      sandbox: new SandboxRouter(),
      artifacts: new ArtifactStore(db, arclightDir),
    }),
    approvals: { check: async () => ({ decision: "allow" }) },
  });
  const app = createApp({ repoPath: workdir, arclightDir, db, bus, token: TOKEN, runner });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: app.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  const started = Date.now();
  try {
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "eval" }),
    });
    const ack = (await (
      await fetch(`${base}/api/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          k: "submit",
          v: 1,
          commandId: "eval-cmd",
          sessionId: "eval",
          input: { text: c.instruction, agent: "code", baseEpoch: 0 },
        }),
      })
    ).json()) as { ok: boolean; turnId?: string };
    if (!ack.ok) throw new Error(`submit rejected: ${JSON.stringify(ack)}`);

    // 轮询 turn 终态（SSE 链路已被集成测覆盖；harness 用最简等待）
    const deadline = Date.now() + c.timeoutMs;
    let status = "running";
    while (Date.now() < deadline) {
      const row = sqlite
        .query<{ status: string }, []>(`SELECT status FROM turns WHERE id = '${ack.turnId}'`)
        .get();
      status = row?.status ?? "missing";
      if (["completed", "failed", "interrupted"].includes(status)) break;
      await Bun.sleep(200);
    }
    const durationMs = Date.now() - started;
    const judges = runJudges(workdir, c.judges);
    const pass = status === "completed" && judges.every((j) => j.pass);
    console.log(`\n=== ${c.id} ${mock ? "[MOCK]" : "[REAL]"} ===`);
    console.log(`turn: ${status} · ${durationMs}ms`);
    for (const j of judges) console.log(`  ${j.pass ? "✓" : "✗"} ${j.name} — ${j.detail}`);
    console.log(pass ? "PASS" : "FAIL");
    return pass;
  } finally {
    server.stop(true);
    sqlite.close();
    rmSync(workdir, { recursive: true, force: true });
  }
}

// ── 入口 ──
const mock = process.env.ARCLIGHT_EVAL_MOCK === "1";
if (!mock && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    "SKIPPED: ANTHROPIC_API_KEY 缺失。真实 golden eval 需有效 key；机制验证用 ARCLIGHT_EVAL_MOCK=1。",
  );
  process.exit(2);
}
const caseDirs = readdirSync(join(ROOT, "cases"));
const filter = process.argv[2];
let allPass = true;
for (const dir of caseDirs) {
  if (filter && !dir.includes(filter)) continue;
  const c = JSON.parse(readFileSync(join(ROOT, "cases", dir, "case.json"), "utf8")) as EvalCase;
  if (!(await runCase(c, mock))) allPass = false;
}
process.exit(allPass ? 0 : 1);
