// ApprovalPolicy 本会话工具白名单（scope=session）：批准并记住后，同工具的 confirm 档
// 自动放行；黑名单永远先拦，session 白名单不能让危险命令逃逸。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@arclight/protocol";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { approvals as approvalsTbl, sessions, turns, workspaces } from "../../db/schema";
import { EventBus } from "../../events/bus";
import type { LoopToolContext } from "../../loop/types";
import { ApprovalPolicy } from "../policy";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "arclight-pol-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  const { db, sqlite } = createDb(dbPath);
  db.insert(workspaces)
    .values({ id: "w1", name: "t", repoPath: "/r", arclightDir: "/r/.arclight" })
    .run();
  db.insert(sessions).values({ id: "s1", workspaceId: "w1" }).run();
  db.insert(turns)
    .values({ id: "t1", sessionId: "s1", commandId: "c1", status: "running", input: {} })
    .run();
  const policy = new ApprovalPolicy(db, new EventBus(), { pollMs: 5 });
  return { dir, db, sqlite, policy };
}

const bashTool: Tool<unknown, unknown> = {
  meta: {
    name: "bash",
    description: "",
    isReadOnly: false,
    isConcurrencySafe: false,
    executesShellCommands: true,
    mutatesWorkspace: true,
    riskTier: "confirm",
    riskClass: "write",
    timeoutMs: 1000,
    maxResultSizeBytes: 1024,
  },
  inputSchema: z.object({ command: z.string() }),
  outputSchema: z.any(),
  execute: async () => ({}),
};

// 高危工具（admin_only → risk=high）。配 dangerFullAccess 才走 ask 路径（否则 classify 直接 deny）。
const adminTool: Tool<unknown, unknown> = {
  meta: {
    name: "admin_tool",
    description: "",
    isReadOnly: false,
    isConcurrencySafe: false,
    executesShellCommands: false,
    mutatesWorkspace: true,
    riskTier: "admin_only",
    riskClass: "irreversible",
    timeoutMs: 1000,
    maxResultSizeBytes: 1024,
  },
  inputSchema: z.object({ command: z.string() }),
  outputSchema: z.any(),
  execute: async () => ({}),
};

function ctx(callId: string): LoopToolContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    callId,
    cwd: "/r",
    signal: new AbortController().signal,
    emitProgress: () => {},
  };
}

/** 驱动一次 check()：取出落库的 pending askId，以给定 scope 批准，返回 check 的决议。 */
async function checkAndApprove(
  policy: ApprovalPolicy,
  db: ReturnType<typeof setup>["db"],
  callId: string,
  scope: "once" | "session",
  tool: Tool<unknown, unknown> = bashTool,
) {
  const p = policy.check(tool, { command: "echo hi" }, ctx(callId));
  // 轮询等 permission.ask 落库（check 内异步 emit 后挂起）
  let askId = "";
  for (let i = 0; i < 50 && !askId; i++) {
    const row = db
      .select({ id: approvalsTbl.id })
      .from(approvalsTbl)
      .where(eq(approvalsTbl.status, "pending"))
      .get();
    if (row) askId = row.id;
    else await new Promise((r) => setTimeout(r, 2));
  }
  policy.decide(askId, "allow", scope);
  return p;
}

describe("ApprovalPolicy session 白名单（scope=session）", () => {
  test("本会话允许后，同工具后续调用自动放行（不再弹 ask）", async () => {
    const { dir, db, sqlite, policy } = setup();
    try {
      // 第 1 次：scope=session 批准并记住
      const first = await checkAndApprove(policy, db, "tc1", "session");
      expect(first.decision).toBe("allow");

      // 第 2 次：同工具直接 auto-allow，不应再落新的 pending 行
      const before = db.select({ id: approvalsTbl.id }).from(approvalsTbl).all().length;
      const second = await policy.check(bashTool, { command: "echo again" }, ctx("tc2"));
      const after = db.select({ id: approvalsTbl.id }).from(approvalsTbl).all().length;
      expect(second.decision).toBe("allow");
      expect(after).toBe(before); // 无新 ask 落库 = 没弹审批
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scope=once 不记住：同工具下次仍弹审批", async () => {
    const { dir, db, sqlite, policy } = setup();
    try {
      const first = await checkAndApprove(policy, db, "tc1", "once");
      expect(first.decision).toBe("allow");
      const before = db.select({ id: approvalsTbl.id }).from(approvalsTbl).all().length;
      // 第 2 次走 ask（不会自动放行）；用 session 批准收尾以便 await 返回
      const second = await checkAndApprove(policy, db, "tc2", "once");
      const after = db.select({ id: approvalsTbl.id }).from(approvalsTbl).all().length;
      expect(second.decision).toBe("allow");
      expect(after).toBe(before + 1); // 新增了一条 ask = 又弹了
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("黑名单永远先拦：本会话允许 bash 后，sudo 命令仍被拒（不经白名单）", async () => {
    const { dir, db, sqlite, policy } = setup();
    try {
      await checkAndApprove(policy, db, "tc1", "session"); // 记住 bash
      const blocked = await policy.check(bashTool, { command: "sudo rm -rf /" }, ctx("tc2"));
      expect(blocked.decision).toBe("deny"); // classify 内黑名单先判，白名单管不到
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("高危（risk=high）scope=session 不被记住：同工具下次仍弹审批（防客户端伪造 scope 提权）", async () => {
    const { dir, db, sqlite } = setup();
    // dangerFullAccess 让 admin_only 走 ask 路径（risk=high），从而能测「记住」是否被服务端拒收
    const policy = new ApprovalPolicy(db, new EventBus(), { pollMs: 5, dangerFullAccess: true });
    try {
      // 第 1 次：高危 ask，客户端伪造 scope=session 批准——本次「允许这一发」生效，但绝不记住
      const first = await checkAndApprove(policy, db, "tc1", "session", adminTool);
      expect(first.decision).toBe("allow");

      // 第 2 次：同高危工具应仍弹新 ask（未被自动放行）→ 新增一条 pending 行
      const before = db.select({ id: approvalsTbl.id }).from(approvalsTbl).all().length;
      const second = await checkAndApprove(policy, db, "tc2", "once", adminTool);
      const after = db.select({ id: approvalsTbl.id }).from(approvalsTbl).all().length;
      expect(second.decision).toBe("allow");
      expect(after).toBe(before + 1); // 又弹了审批 = 高危没被本会话记住
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
