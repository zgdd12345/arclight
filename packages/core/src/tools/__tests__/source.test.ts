// packages/core/src/tools/__tests__/source.test.ts
import { describe, expect, test } from "bun:test";
import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import {
  BuiltinSource,
  collectFragments,
  composeSources,
  FakeSource,
  type PromptFragment,
  type SessionCtx,
  type ToolSource,
} from "../source";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTool(name: string, description = `${name} tool`): Tool<unknown, unknown> {
  return {
    meta: {
      name,
      description,
      isReadOnly: true,
      isConcurrencySafe: true,
      executesShellCommands: false,
      mutatesWorkspace: false,
      riskTier: "safe",
      riskClass: "read",
      timeoutMs: 5_000,
      maxResultSizeBytes: 1024,
    },
    inputSchema: z.object({}),
    outputSchema: z.any(),
    execute: async () => ({}),
  } as Tool<unknown, unknown>;
}

function makeCtx(overrides: Partial<SessionCtx> = {}): SessionCtx {
  return {
    sessionId: "sess-test",
    cwd: "/workspace",
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ─── ToolSource interface contract ───────────────────────────────────────────

describe("ToolSource interface", () => {
  test("FakeSource satisfies ToolSource structurally", () => {
    const src: ToolSource = new FakeSource();
    expect(typeof src.id).toBe("string");
    expect(typeof src.list).toBe("function");
  });

  test("BuiltinSource satisfies ToolSource structurally", () => {
    const src: ToolSource = new BuiltinSource([]);
    expect(typeof src.id).toBe("string");
    expect(typeof src.list).toBe("function");
  });
});

// ─── FakeSource ──────────────────────────────────────────────────────────────

describe("FakeSource", () => {
  test("default id is 'fake'", () => {
    expect(new FakeSource().id).toBe("fake");
  });

  test("custom id is preserved", () => {
    expect(new FakeSource({ id: "mcp:my-server" }).id).toBe("mcp:my-server");
  });

  test("list() returns empty array by default", async () => {
    const tools = await new FakeSource().list(makeCtx());
    expect(tools).toEqual([]);
  });

  test("list() returns injected tools", async () => {
    const tool = makeTool("echo");
    const src = new FakeSource({ tools: [tool] });
    const result = await src.list(makeCtx());
    expect(result).toHaveLength(1);
    expect(result[0]?.meta.name).toBe("echo");
  });

  test("list() returns a copy — external mutation does not affect source", async () => {
    const tool = makeTool("echo");
    const src = new FakeSource({ tools: [tool] });
    const a = await src.list(makeCtx());
    const b = await src.list(makeCtx());
    expect(a).not.toBe(b); // different array instances
    expect(a).toEqual(b);
  });

  test("contribute() returns undefined when no fragment configured", () => {
    expect(new FakeSource().contribute(makeCtx())).toBeUndefined();
  });

  test("contribute() returns injected PromptFragment", () => {
    const frag: PromptFragment = { content: "# Skills\n- foo\n- bar", tag: "skills-list" };
    const src = new FakeSource({ fragment: frag });
    expect(src.contribute(makeCtx())).toEqual(frag);
  });

  test("dispose() is callable and increments disposeCount", async () => {
    const src = new FakeSource();
    expect(src.disposeCount).toBe(0);
    await src.dispose();
    await src.dispose();
    expect(src.disposeCount).toBe(2);
  });

  test("FakeSource with no options uses safe defaults", async () => {
    const src = new FakeSource({});
    expect(src.id).toBe("fake");
    expect(await src.list(makeCtx())).toEqual([]);
    expect(src.contribute(makeCtx())).toBeUndefined();
  });
});

// ─── BuiltinSource ───────────────────────────────────────────────────────────

describe("BuiltinSource", () => {
  test("id is always 'builtin'", () => {
    expect(new BuiltinSource([]).id).toBe("builtin");
  });

  test("list() returns all provided tools in order", async () => {
    const tools = [makeTool("read_file"), makeTool("write_file"), makeTool("bash")];
    const src = new BuiltinSource(tools);
    const result = await src.list(makeCtx());
    expect(result.map((t) => t.meta.name)).toEqual(["read_file", "write_file", "bash"]);
  });

  test("list() with empty tools returns empty array", async () => {
    expect(await new BuiltinSource([]).list(makeCtx())).toEqual([]);
  });

  test("contribute property is absent (no system-prompt injection for builtins)", () => {
    // Access via ToolSource interface (where contribute is optional) to satisfy tsc
    const src: ToolSource = new BuiltinSource([]);
    // BuiltinSource intentionally omits contribute — collectFragments skips it
    expect(src.contribute).toBeUndefined();
  });

  test("list() returns a copy — mutation of result does not affect source", async () => {
    const tool = makeTool("read_file");
    const src = new BuiltinSource([tool]);
    const a = await src.list(makeCtx());
    const b = await src.list(makeCtx());
    expect(a).not.toBe(b);
  });
});

// ─── composeSources ──────────────────────────────────────────────────────────

describe("composeSources", () => {
  test("empty sources → empty ToolRegistry", async () => {
    const reg = await composeSources([], makeCtx());
    expect(reg.schemas()).toHaveLength(0);
  });

  test("single FakeSource → tools registered", async () => {
    const src = new FakeSource({ tools: [makeTool("bash"), makeTool("read_file")] });
    const reg = await composeSources([src], makeCtx());
    const names = reg.schemas().map((s) => s.name);
    expect(names).toEqual(["bash", "read_file"]);
  });

  test("multiple sources → tools merged, all accessible via registry.get()", async () => {
    const src1 = new FakeSource({ id: "a", tools: [makeTool("tool_a")] });
    const src2 = new FakeSource({ id: "b", tools: [makeTool("tool_b")] });
    const reg = await composeSources([src1, src2], makeCtx());
    expect(reg.get("tool_a")?.meta.name).toBe("tool_a");
    expect(reg.get("tool_b")?.meta.name).toBe("tool_b");
    expect(reg.schemas()).toHaveLength(2);
  });

  test("duplicate tool name — later source wins (last-write semantics)", async () => {
    const toolA = makeTool("shared", "from-A");
    const toolB = makeTool("shared", "from-B");
    const src1 = new FakeSource({ id: "a", tools: [toolA] });
    const src2 = new FakeSource({ id: "b", tools: [toolB] });
    const reg = await composeSources([src1, src2], makeCtx());
    expect(reg.schemas()).toHaveLength(1);
    expect(reg.schemas()[0]?.description).toBe("from-B");
  });

  test("registry.get() returns undefined for unknown tool", async () => {
    const reg = await composeSources([new FakeSource()], makeCtx());
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  test("BuiltinSource composes correctly alongside FakeSource", async () => {
    const builtin = new BuiltinSource([makeTool("read_file")]);
    const extra = new FakeSource({ tools: [makeTool("my_tool")] });
    const reg = await composeSources([builtin, extra], makeCtx());
    expect(reg.schemas().map((s) => s.name)).toContain("read_file");
    expect(reg.schemas().map((s) => s.name)).toContain("my_tool");
  });

  test("list() is awaited per source — async resolution works", async () => {
    let resolved = false;
    const asyncSource: ToolSource = {
      id: "async",
      async list(_ctx) {
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
        return [makeTool("async_tool")];
      },
    };
    const reg = await composeSources([asyncSource], makeCtx());
    expect(resolved).toBe(true);
    expect(reg.get("async_tool")).toBeDefined();
  });
});

// ─── dispose wiring (Fix 1 verification) ─────────────────────────────────────
// Verifies the runner.dispose() loop pattern: `for (const s of sources) void s.dispose?.()`.
// Avoids wiring a full AgentRunner (requires db/bus/registry/callProvider) by testing
// the same dispose-loop pattern that runner.dispose() executes.

describe("source dispose wiring", () => {
  test("dispose loop increments disposeCount on each FakeSource", async () => {
    const src1 = new FakeSource({ id: "a" });
    const src2 = new FakeSource({ id: "b" });
    const sources: ToolSource[] = [src1, src2];
    // Replicates runner.dispose(): `for (const s of this.deps.sources ?? []) void s.dispose?.();`
    // We await here to ensure all Promises settle before asserting.
    await Promise.all(sources.map((s) => s.dispose?.()));
    expect(src1.disposeCount).toBe(1);
    expect(src2.disposeCount).toBe(1);
  });

  test("dispose loop is safe on sources without dispose() — optional chaining no-ops", async () => {
    const src: ToolSource = { id: "no-dispose", list: async () => [] };
    // Must not throw even though dispose is absent
    await src.dispose?.();
    // reaching here is the assertion
    expect(src.dispose).toBeUndefined();
  });

  test("dispose loop with mixed sources — only disposable sources increment", async () => {
    const disposable = new FakeSource({ id: "disposable" });
    const nonDisposable: ToolSource = { id: "no-dispose", list: async () => [] };
    const sources: ToolSource[] = [disposable, nonDisposable];
    await Promise.all(sources.map((s) => s.dispose?.()));
    expect(disposable.disposeCount).toBe(1);
  });
});

// ─── collectFragments ─────────────────────────────────────────────────────────

describe("collectFragments", () => {
  test("empty sources → empty array", () => {
    expect(collectFragments([], makeCtx())).toEqual([]);
  });

  test("source without contribute property → no fragment emitted", () => {
    const src = new BuiltinSource([]);
    expect(collectFragments([src], makeCtx())).toHaveLength(0);
  });

  test("FakeSource returning undefined contribute → skipped", () => {
    const src = new FakeSource(); // no fragment configured
    expect(collectFragments([src], makeCtx())).toHaveLength(0);
  });

  test("FakeSource with fragment → fragment collected", () => {
    const frag: PromptFragment = { content: "Available skills: foo, bar", tag: "skills-list" };
    const src = new FakeSource({ fragment: frag });
    const frags = collectFragments([src], makeCtx());
    expect(frags).toHaveLength(1);
    expect(frags[0]).toEqual(frag);
  });

  test("mixed sources → only non-undefined fragments collected, in source order", () => {
    const src1 = new FakeSource({ fragment: { content: "fragment-A" } });
    const src2 = new BuiltinSource([]); // no contribute
    const src3 = new FakeSource({ fragment: { content: "fragment-C", tag: "C" } });
    const src4 = new FakeSource(); // contribute returns undefined
    const frags = collectFragments([src1, src2, src3, src4], makeCtx());
    expect(frags.map((f) => f.content)).toEqual(["fragment-A", "fragment-C"]);
  });

  test("PromptFragment tag field is optional — fragment without tag is accepted", () => {
    const frag: PromptFragment = { content: "no tag fragment" };
    const src = new FakeSource({ fragment: frag });
    const frags = collectFragments([src], makeCtx());
    expect(frags[0]?.tag).toBeUndefined();
    expect(frags[0]?.content).toBe("no tag fragment");
  });

  test("SessionCtx is passed through to contribute()", () => {
    const receivedCtxs: SessionCtx[] = [];
    const src: ToolSource = {
      id: "spy",
      list: async () => [],
      contribute(ctx) {
        receivedCtxs.push(ctx);
        return undefined;
      },
    };
    const ctx = makeCtx({ sessionId: "sess-abc" });
    collectFragments([src], ctx);
    expect(receivedCtxs[0]?.sessionId).toBe("sess-abc");
  });
});
