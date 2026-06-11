// Unit 4 审批往返集成测：真实 ApprovalPolicy + queryLoop + HTTP 全链。
// 覆盖：批准→执行、拒绝→envelope 回灌、黑名单→不弹审批直接 deny、60s 过期、
// interrupt→cancelled、挂起期间 provider 零调用（不变量）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArcEvent, Tool } from "@arclight/protocol";
import { ApprovalPolicy } from "../packages/core/src/approval/policy";

// 最小 schema stub（实现 loop/executeTool 用到的 safeParse 契约）——避免根 tests 解析 core 的 zod。
type Stub<T> = { safeParse: (v: unknown) => { success: true; data: T } | { success: false } };
const objStub = <T>(required: string[]): Stub<T> => ({
  safeParse: (v: unknown) => {
    if (typeof v === "object" && v !== null && required.every((k) => k in v)) {
      return { success: true, data: v as T };
    }
    return { success: false };
  },
});

import { createDb } from "../packages/core/src/db/client";
import { runMigrations } from "../packages/core/src/db/migrate";
import { EventBus } from "../packages/core/src/events/bus";
import { AgentRunner } from "../packages/core/src/loop/runner";
import type { CallProvider, ProviderResult } from "../packages/core/src/loop/types";
import { createApp } from "../packages/core/src/server/app";
import { ToolRegistry } from "../packages/core/src/tools/registry";

const TOKEN = "approval-it-token-0123456789abcdef0123456789abcdef";

// 受控工具：confirm+write，execute 计数
function mkWriteTool(): Tool<unknown, unknown> {
  return {
    meta: {
      name: "do_write",
      description: "",
      isReadOnly: false,
      isConcurrencySafe: false,
      riskTier: "confirm",
      riskClass: "write",
      timeoutMs: 5000,
      maxResultSizeBytes: 1024,
    },
    inputSchema: objStub<{ path: string }>(["path"]) as never,
    outputSchema: objStub<unknown>([]) as never,
    execute: async () => {
      execCount++;
      return { ok: true };
    },
  } as Tool<unknown, unknown>;
}

// bash 工具（供黑名单测试）：execute 永不该被调用
function mkBashTool(): Tool<unknown, unknown> {
  return {
    meta: {
      name: "bash",
      description: "",
      isReadOnly: false,
      isConcurrencySafe: false,
      riskTier: "confirm",
      riskClass: "write",
      timeoutMs: 5000,
      maxResultSizeBytes: 1024,
    },
    inputSchema: objStub<{ command: string }>(["command"]) as never,
    outputSchema: objStub<unknown>([]) as never,
    execute: async () => {
      execCount++;
      return { ok: true };
    },
  } as Tool<unknown, unknown>;
}

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let server: ReturnType<typeof Bun.serve>;
let base: string;
let execCount: number;
let providerCalls: number;

function setup(opts: {
  tool: Tool<unknown, unknown>;
  toolCall: { callId: string; name: string; rawArgs: unknown };
  ttlMs?: number;
}) {
  dir = mkdtempSync(join(tmpdir(), "arclight-appr-it-"));
  const arclightDir = join(dir, ".arclight");
  const { dbPath } = runMigrations(arclightDir);
  ({ db, sqlite } = createDb(dbPath));
  const bus = new EventBus();
  execCount = 0;
  providerCalls = 0;

  // biome-ignore lint/correctness/useYield: 纯 return generator（无流式 part），契约要求 async generator
  const provider: CallProvider = async function* (): AsyncGenerator<never, ProviderResult> {
    providerCalls++;
    if (providerCalls === 1) {
      return { text: "", toolCalls: [opts.toolCall], finishReason: "tool-calls" };
    }
    return { text: "done", toolCalls: [], finishReason: "stop" };
  };

  const registry = new ToolRegistry().register(opts.tool);
  const approvals = new ApprovalPolicy(db, bus, { ttlMs: opts.ttlMs ?? 60_000, pollMs: 20 });
  const runner = new AgentRunner({
    db,
    bus,
    registry,
    callProvider: provider,
    executeTool: async (tool, rawArgs) => {
      const parsed = tool.inputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          ok: false,
          envelope: {
            status: "error",
            tool: tool.meta.name,
            error_class: "VALIDATION",
            user_message: "bad",
            retry_allowed: true,
          },
        };
      }
      await tool.execute(parsed.data, {} as never);
      return { ok: true, preview: "ok" };
    },
    approvals,
    onInterrupt: (turnId) => approvals.cancelTurn(turnId),
  });
  const app = createApp({ repoPath: dir, arclightDir, db, bus, token: TOKEN, runner, approvals });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: app.fetch });
  base = `http://127.0.0.1:${server.port}`;
  return { approvals };
}

afterEach(() => {
  server?.stop(true);
  sqlite?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function createSessionAndSubmit(): Promise<string> {
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ id: "s" }),
  });
  const ack = (await (
    await fetch(`${base}/api/commands`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        k: "submit",
        v: 1,
        commandId: "cmd1",
        sessionId: "s",
        input: { text: "go", agent: "code", baseEpoch: 0 },
      }),
    })
  ).json()) as { turnId: string };
  return ack.turnId;
}

/** 轮询 events 表拿 permission.ask 的 askId */
function waitForAsk(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const row = sqlite
        .query<{ event: string }, []>(
          "SELECT event FROM events WHERE type = 'permission.ask' LIMIT 1",
        )
        .get();
      if (row) return resolve((JSON.parse(row.event) as { askId: string }).askId);
      if (Date.now() - started > timeoutMs) return reject(new Error("no permission.ask"));
      setTimeout(tick, 15);
    };
    tick();
  });
}

function turnStatus(turnId: string): string {
  return (
    sqlite.query<{ status: string }, []>(`SELECT status FROM turns WHERE id = '${turnId}'`).get()
      ?.status ?? "missing"
  );
}
function toolOutputEvent(): Extract<ArcEvent, { t: "tool.output" }> | null {
  const row = sqlite
    .query<{ event: string }, []>("SELECT event FROM events WHERE type = 'tool.output' LIMIT 1")
    .get();
  return row ? (JSON.parse(row.event) as Extract<ArcEvent, { t: "tool.output" }>) : null;
}
async function waitTurnDone(turnId: string, timeoutMs = 3000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = turnStatus(turnId);
    if (["completed", "failed", "interrupted"].includes(s)) return s;
    await Bun.sleep(20);
  }
  return turnStatus(turnId);
}

async function approve(askId: string, decision: "allow" | "deny") {
  return fetch(`${base}/api/commands`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ k: "approve", v: 1, commandId: `a-${askId}`, askId, decision }),
  });
}

describe("审批往返：批准链路", () => {
  test("confirm 工具挂起 permission.ask → approve allow → 执行 → turn 完成", async () => {
    setup({
      tool: mkWriteTool(),
      toolCall: { callId: "c1", name: "do_write", rawArgs: { path: "a.ts" } },
    });
    const turnId = await createSessionAndSubmit();
    const askId = await waitForAsk();

    // 挂起期间：turn=awaiting_approval，provider 只被调用过一次（不变量：挂起不占 provider）
    expect(turnStatus(turnId)).toBe("awaiting_approval");
    expect(providerCalls).toBe(1);

    await approve(askId, "allow");
    expect(await waitTurnDone(turnId)).toBe("completed");
    expect(execCount).toBe(1);
    expect(toolOutputEvent()?.status).toBe("ok");
  }, 10000);
});

describe("审批往返：拒绝链路", () => {
  test("approve deny → 工具不执行 → APPROVAL_DENIED envelope 回灌 → turn 完成", async () => {
    setup({
      tool: mkWriteTool(),
      toolCall: { callId: "c1", name: "do_write", rawArgs: { path: "a.ts" } },
    });
    const turnId = await createSessionAndSubmit();
    const askId = await waitForAsk();
    await approve(askId, "deny");
    expect(await waitTurnDone(turnId)).toBe("completed");
    expect(execCount).toBe(0);
    const out = toolOutputEvent();
    expect(out?.status).toBe("error");
    expect(out?.error?.error_class).toBe("APPROVAL_DENIED");
  }, 10000);
});

describe("黑名单：不弹审批直接拒绝（case-09 ssh 链路）", () => {
  test("bash ssh → 无 permission.ask → PERMISSION_DENIED → 工具不执行", async () => {
    setup({
      tool: mkBashTool(),
      toolCall: { callId: "c1", name: "bash", rawArgs: { command: "ssh user@host" } },
    });
    const turnId = await createSessionAndSubmit();
    expect(await waitTurnDone(turnId)).toBe("completed");
    // 黑名单命中：从不发 permission.ask
    const ask = sqlite.query("SELECT 1 FROM events WHERE type = 'permission.ask'").get();
    expect(ask).toBeNull();
    expect(execCount).toBe(0);
    expect(toolOutputEvent()?.error?.error_class).toBe("PERMISSION_DENIED");
  }, 10000);
});

describe("60s 过期：内核权威", () => {
  test("不决议 → TTL 到 → APPROVAL_EXPIRED → 工具不执行", async () => {
    setup({
      tool: mkWriteTool(),
      toolCall: { callId: "c1", name: "do_write", rawArgs: { path: "a.ts" } },
      ttlMs: 60, // 压缩 TTL 加速测试
    });
    const turnId = await createSessionAndSubmit();
    await waitForAsk();
    expect(await waitTurnDone(turnId)).toBe("completed");
    expect(execCount).toBe(0);
    expect(toolOutputEvent()?.error?.error_class).toBe("APPROVAL_EXPIRED");
  }, 10000);
});

describe("中断：挂起审批转 cancelled", () => {
  test("挂起期间 interrupt → 审批 cancelled → 工具不执行 → turn interrupted", async () => {
    const { approvals } = setup({
      tool: mkWriteTool(),
      toolCall: { callId: "c1", name: "do_write", rawArgs: { path: "a.ts" } },
    });
    const turnId = await createSessionAndSubmit();
    const askId = await waitForAsk();
    await fetch(`${base}/api/commands`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ k: "interrupt", v: 1, commandId: "i1", turnId, reason: "user" }),
    });
    const final = await waitTurnDone(turnId);
    expect(approvals.decide(askId, "allow")).toBe("cancelled"); // 终态不可逆
    expect(execCount).toBe(0);
    expect(final).toBe("interrupted");
  }, 10000);
});
