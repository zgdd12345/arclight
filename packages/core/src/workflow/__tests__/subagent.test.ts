import { describe, expect, test } from "bun:test";
import type { Tool } from "@arclight/protocol";
import type { ProviderToolSchema, ToolRegistryLike } from "../../loop/types";
import { RestrictedToolRegistry, runSubagent } from "../subagent";
import { makeCtx, scriptedProvider } from "./fixtures";

describe("runSubagent (nested queryLoop)", () => {
  test("returns the final assistant text as value on completion", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "the answer", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "compute" }, makeCtx({ provider }));
    expect(res).toEqual({ ok: true, value: "the answer" });
  });

  test("context isolation: child sees only its own system + user messages", async () => {
    const { provider, calls } = scriptedProvider([
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    await runSubagent({ prompt: "do the thing", label: "planner" }, makeCtx({ provider }));
    expect(calls).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const msgs = calls[0]!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]).toMatchObject({ role: "user", content: "do the thing" });
    // 子不见父历史/身份：消息内不出现父 session/turn 标识（parentSessionId="parent-s" / parentTurnId="parent-t"）。
    // 注：角色提示里含 "parent conversation" 字样，故须按标识符（parent-s/parent-t）精确匹配，不能裸搜 "parent"。
    expect(msgs.some((m) => "content" in m && /parent-[st]/.test(m.content))).toBe(false);
  });

  test("parent interrupt cascades to the child (returns interrupted)", async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, calls } = scriptedProvider([
      { result: { text: "should not run", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent({ prompt: "x" }, makeCtx({ provider, signal: ac.signal }));
    expect(res).toEqual({ ok: false, status: "interrupted" });
    expect(calls).toHaveLength(0); // 预中断 → queryLoop 起步即返回 interrupted，provider 不被调用
  });

  // provider 返回 finishReason:"error"（non-retryable）+ makeCtx maxRetries:0 → queryLoop 返回 {status:"failed"}。
  test("returns {ok:false, status:'failed'} when provider yields a non-retryable error", async () => {
    const { provider } = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [],
          finishReason: "error",
          retryable: false,
          errorMessage: "upstream model error",
        },
      },
    ]);
    // makeCtx sets maxRetries:0; non-retryable error → failed branch in query-loop.ts:97-116
    const res = await runSubagent({ prompt: "fail please" }, makeCtx({ provider }));
    expect(res).toEqual({ ok: false, status: "failed" });
  });
});

// ── RestrictedToolRegistry unit tests (allowlist is security-critical) ─────────
function makeFakeTool(name: string): Tool<unknown, unknown> {
  return {
    meta: {
      name,
      description: `fake tool ${name}`,
      isReadOnly: true,
      isConcurrencySafe: true,
      riskTier: "safe",
      riskClass: "read-only",
    },
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true as const, preview: "ok" }),
  } as unknown as Tool<unknown, unknown>;
}

function makeFakeRegistry(names: string[]): ToolRegistryLike {
  const tools = Object.fromEntries(names.map((n) => [n, makeFakeTool(n)]));
  return {
    schemas(): ProviderToolSchema[] {
      return names.map((n) => ({
        name: n,
        description: `fake tool ${n}`,
        inputSchema: { type: "object" as const, properties: {} },
      }));
    },
    get(name: string): Tool<unknown, unknown> | undefined {
      return tools[name];
    },
  };
}

describe("RestrictedToolRegistry (allowlist — security-critical)", () => {
  const base = makeFakeRegistry(["read_file", "write_file", "bash"]);
  const extra = makeFakeTool("StructuredOutput");

  test("disallowed tool: get() returns undefined and absent from schemas()", () => {
    const reg = new RestrictedToolRegistry(base, ["read_file"], []);
    expect(reg.get("write_file")).toBeUndefined();
    expect(reg.get("bash")).toBeUndefined();
    expect(reg.schemas().map((s) => s.name)).not.toContain("write_file");
    expect(reg.schemas().map((s) => s.name)).not.toContain("bash");
  });

  test("allowed tool: get() returns the tool and it appears in schemas()", () => {
    const reg = new RestrictedToolRegistry(base, ["read_file"], []);
    expect(reg.get("read_file")).toBeDefined();
    expect(reg.schemas().map((s) => s.name)).toContain("read_file");
  });

  test("injected extra tool: present in both get() and schemas()", () => {
    const reg = new RestrictedToolRegistry(base, ["read_file"], [extra]);
    expect(reg.get("StructuredOutput")).toBeDefined();
    expect(reg.schemas().map((s) => s.name)).toContain("StructuredOutput");
  });

  test("injected extra tool is accessible even when not in the base allow set", () => {
    // extra tools bypass the allowlist — they are always injected
    const reg = new RestrictedToolRegistry(base, [], [extra]);
    expect(reg.get("StructuredOutput")).toBeDefined();
    // base tools are still blocked
    expect(reg.get("read_file")).toBeUndefined();
  });
});
