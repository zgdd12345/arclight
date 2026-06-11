// Unit 5 检查点恢复集成测：真实 queryLoop + CheckpointTracker + HTTP 全链。
// 覆盖：写操作 pre/post commit、/undo 回滚、/redo 恢复、新写清空 redo、用户 .git 零干扰。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@arclight/protocol";
import { ArtifactStore } from "../packages/core/src/artifacts/store";
import { createDb } from "../packages/core/src/db/client";
import { runMigrations } from "../packages/core/src/db/migrate";
import { EventBus } from "../packages/core/src/events/bus";
import { AgentRunner } from "../packages/core/src/loop/runner";
import type { CallProvider, ProviderResult } from "../packages/core/src/loop/types";
import { SandboxRouter } from "../packages/core/src/sandbox/router";
import { createApp } from "../packages/core/src/server/app";
import { makeExecuteTool, ToolRegistry } from "../packages/core/src/tools/registry";

const TOKEN = "ckpt-it-token-0123456789abcdef0123456789abcdef";

// write_file 风格工具（写入固定内容），按脚本逐 turn 由 provider 触发
function mkWriter(): Tool<unknown, unknown> {
  return {
    meta: {
      name: "put",
      description: "write a file",
      isReadOnly: false,
      isConcurrencySafe: false,
      riskTier: "safe", // 自动放行（聚焦检查点，审批已被 U4 覆盖）
      riskClass: "write",
      timeoutMs: 5000,
      maxResultSizeBytes: 1024,
    },
    inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) } as never,
    outputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) } as never,
    execute: async (input) => {
      const { path, content } = input as { path: string; content: string };
      writeFileSync(join(workTree, path), content);
      return { path };
    },
  } as Tool<unknown, unknown>;
}

let root: string;
let workTree: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let server: ReturnType<typeof Bun.serve>;
let base: string;
let nextContent: string;

function setup() {
  root = mkdtempSync(join(tmpdir(), "arclight-ckpt-it-"));
  workTree = join(root, "repo");
  mkdirSync(workTree, { recursive: true });
  const arclightDir = join(workTree, ".arclight");
  const { dbPath } = runMigrations(arclightDir);
  ({ db, sqlite } = createDb(dbPath));
  db.insert(require("../packages/core/src/db/schema").workspaces)
    .values({ id: "w1", name: "r", repoPath: workTree, arclightDir })
    .run();
  db.insert(require("../packages/core/src/db/schema").sessions)
    .values({ id: "s", workspaceId: "w1" })
    .run();
  const bus = new EventBus();

  // provider：每个 turn 调一次 put 工具写 nextContent，然后收尾
  // biome-ignore lint/correctness/useYield: 纯 return generator（契约要求 async generator）
  const provider: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
    return {
      text: "",
      toolCalls: [
        {
          callId: `c-${Math.random()}`,
          name: "put",
          rawArgs: { path: "f.txt", content: nextContent },
        },
      ],
      finishReason: "tool-calls",
    };
  };
  // 第二轮（工具结果回灌后）收尾
  let calls = 0;
  // biome-ignore lint/correctness/useYield: 纯 return generator（契约要求 async generator）
  const provider2: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
    calls++;
    if (calls % 2 === 1) {
      return {
        text: "",
        toolCalls: [
          { callId: `c${calls}`, name: "put", rawArgs: { path: "f.txt", content: nextContent } },
        ],
        finishReason: "tool-calls",
      };
    }
    return { text: "done", toolCalls: [], finishReason: "stop" };
  };
  void provider;

  const runner = new AgentRunner({
    db,
    bus,
    registry: new ToolRegistry().register(mkWriter()),
    callProvider: provider2,
    executeTool: makeExecuteTool({
      sandbox: new SandboxRouter(),
      artifacts: new ArtifactStore(db, arclightDir),
    }),
    approvals: { check: async () => ({ decision: "allow" }) },
    arclightDir,
  });
  const app = createApp({ repoPath: workTree, arclightDir, db, bus, token: TOKEN, runner });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: app.fetch });
  base = `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  server?.stop(true);
  sqlite?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const read = () =>
  existsSync(join(workTree, "f.txt")) ? readFileSync(join(workTree, "f.txt"), "utf8") : null;

let cmdSeq = 0;
async function submitAndWait(text: string): Promise<void> {
  const commandId = `cmd-${++cmdSeq}`;
  const ack = (await (
    await fetch(`${base}/api/commands`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        k: "submit",
        v: 1,
        commandId,
        sessionId: "s",
        input: { text, agent: "code", baseEpoch: 0 },
      }),
    })
  ).json()) as { ok: boolean; turnId?: string };
  if (!ack.ok) throw new Error(`submit rejected: ${JSON.stringify(ack)}`);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const s = sqlite
      .query<{ status: string }, []>(`SELECT status FROM turns WHERE id='${ack.turnId}'`)
      .get()?.status;
    if (s && ["completed", "failed", "interrupted"].includes(s)) return;
    await Bun.sleep(20);
  }
  throw new Error("turn did not finish");
}

async function edit(content: string) {
  nextContent = content;
  await submitAndWait(`写入 ${content}`);
}

describe("case-10 检查点恢复 + undo/redo 往返", () => {
  beforeEach(setup);

  test("三次编辑 → /undo 回滚 → /redo 恢复", async () => {
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "s" }),
    });
    await edit("v1");
    await edit("v2");
    await edit("v3");
    expect(read()).toBe("v3");

    await submitAndWait("/undo");
    expect(read()).toBe("v2");
    await submitAndWait("/undo");
    expect(read()).toBe("v1");
    await submitAndWait("/redo");
    expect(read()).toBe("v2");
  }, 20000);

  test("/undo 后新写 → redo 栈清空（标准语义）", async () => {
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "s" }),
    });
    await edit("a1");
    await edit("a2");
    await submitAndWait("/undo");
    expect(read()).toBe("a1");
    await edit("a1-branch"); // 新写
    expect(read()).toBe("a1-branch");
    // redo 应无效（栈已清空）
    const before = read();
    await submitAndWait("/redo");
    expect(read()).toBe(before);
  }, 20000);

  test("用户 .git 零干扰：检查点操作不动用户仓 HEAD", async () => {
    const userGit = join(workTree, ".git");
    mkdirSync(userGit, { recursive: true });
    writeFileSync(join(userGit, "HEAD"), "ref: refs/heads/main\n");
    const headBefore = readFileSync(join(userGit, "HEAD"), "utf8");

    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "s" }),
    });
    await edit("x1");
    await edit("x2");
    await submitAndWait("/undo");

    expect(readFileSync(join(userGit, "HEAD"), "utf8")).toBe(headBefore);
    // shadow 仓在 .arclight/checkpoints，非用户 .git
    expect(existsSync(join(workTree, ".arclight", "checkpoints"))).toBe(true);
  }, 20000);

  test("空历史 /undo → 优雅失败消息（turn 仍完成）", async () => {
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "s" }),
    });
    await submitAndWait("/undo"); // 无检查点
    const msg = sqlite
      .query<{ event: string }, []>(
        "SELECT event FROM events WHERE type='message.delta' ORDER BY seq DESC LIMIT 1",
      )
      .get();
    expect(msg).toBeDefined();
    const ev = msg ? (JSON.parse(msg.event) as { delta: string }) : { delta: "" };
    expect(ev.delta).toContain("✗");
  }, 20000);
});
