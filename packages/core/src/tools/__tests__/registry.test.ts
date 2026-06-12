// makeExecuteTool / withTimeout 不变量：超时·取消胜出后，迟到的工具 promise 拒绝不得逃逸成
// process 级 unhandledRejection（崩 Bun）。withTimeout 未导出，故经 makeExecuteTool 行为面测。
import { describe, expect, test } from "bun:test";
import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import type { LoopToolContext } from "../../loop/types";
import { makeExecuteTool } from "../registry";

function makeCtx(signal: AbortSignal): LoopToolContext {
  return {
    sessionId: "s",
    turnId: "t",
    callId: "c",
    cwd: "/tmp",
    signal,
    emitProgress: () => {},
  };
}

/** 永挂的工具：execute 返回的 promise 由外部 rejectLate 触发拒绝（模拟超时/取消后才返回） */
function makeHangingTool(timeoutMs: number): {
  tool: Tool<unknown, unknown>;
  rejectLate: (e: unknown) => void;
} {
  let rejectLate!: (e: unknown) => void;
  const tool = {
    meta: {
      name: "hang",
      description: "",
      isReadOnly: true,
      isConcurrencySafe: true,
      executesShellCommands: false,
      mutatesWorkspace: false,
      riskTier: "safe",
      riskClass: "read",
      timeoutMs,
      maxResultSizeBytes: 1024,
    },
    inputSchema: z.object({}),
    outputSchema: z.any(),
    execute: () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      }),
  } as Tool<unknown, unknown>;
  // 包一层闭包：execute 的 Promise executor 在 withTimeout 内才运行，rejectLate 此时尚未赋值，
  // 直接返回其值会捕获到 undefined——故返回闭包，调用时再读取已赋值的绑定。
  return { tool, rejectLate: (e: unknown) => rejectLate(e) };
}

describe("BUG B：withTimeout 竞速失败方迟到拒绝不致 unhandledRejection", () => {
  test("超时胜出后工具 promise 迟到 reject → 返回值仍是 TIMEOUT，且无 unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const execute = makeExecuteTool({ sandbox: {} as never });
      const { tool, rejectLate } = makeHangingTool(5);
      const out = await execute(tool, {}, makeCtx(new AbortController().signal));
      // 竞速结果不受兜底 catch 影响：超时胜出 → TIMEOUT envelope
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.envelope.error_class).toBe("TIMEOUT");
      // 此刻工具 promise 仍在飞——触发迟到拒绝，给事件循环一拍让潜在 unhandledRejection 浮现
      rejectLate(new Error("late boom after timeout"));
      await new Promise((r) => setTimeout(r, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("取消胜出后工具 promise 迟到 reject → 返回值仍是 CANCELLED，且无 unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const execute = makeExecuteTool({ sandbox: {} as never });
      const { tool, rejectLate } = makeHangingTool(10_000); // 超时不会先触发，由 abort 胜出
      const ac = new AbortController();
      const ctx = makeCtx(ac.signal);
      const p = execute(tool, {}, ctx);
      ac.abort(); // 取消胜出竞速
      const out = await p;
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.envelope.error_class).toBe("CANCELLED");
      rejectLate(new Error("late boom after cancel"));
      await new Promise((r) => setTimeout(r, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
