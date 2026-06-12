import { makeToolError, type Tool, type ToolErrorEnvelope } from "@arclight/protocol";
import { type ArtifactStore, PREVIEW_BYTES, SPILL_THRESHOLD_BYTES } from "../artifacts/store";
import type {
  ExecutedToolResult,
  LoopDeps,
  LoopToolContext,
  ProviderToolSchema,
} from "../loop/types";
import type { SandboxService } from "../sandbox/service";

// ToolRegistry：元数据注册 + schemas 投影（绝不带 execute——工具执行 0% 交 AI SDK）。
// makeExecuteTool：单工具执行壳——zod 校验 / 超时 / 取消 / 输出投影（>32KB spill），永不 throw。

/** 工具执行上下文：LoopToolContext + 注入件（sandbox 等）。
 * 注：protocol ToolContext 的完整对齐（capability/emit 全量）随 U4 审批接线落地。 */
export type CoreToolContext = LoopToolContext & { sandbox: SandboxService };

/** 工具抛出此错误可控制 envelope 分类与重试性；其他异常一律 EXEC_FAILED */
export class ToolExecError extends Error {
  constructor(
    message: string,
    readonly cls: ToolErrorEnvelope["error_class"] = "EXEC_FAILED",
    readonly retryable = false,
  ) {
    super(message);
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  register(tool: Tool<unknown, unknown>): this {
    this.tools.set(tool.meta.name, tool);
    return this;
  }

  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  schemas(): ProviderToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.meta.name,
      description: t.meta.description,
      inputSchema: t.inputSchema,
    }));
  }
}

export function makeExecuteTool(deps: {
  sandbox: SandboxService;
  artifacts?: ArtifactStore;
}): LoopDeps["executeTool"] {
  return async (tool, rawArgs, ctx): Promise<ExecutedToolResult["output"]> => {
    const fail = (
      cls: ToolErrorEnvelope["error_class"],
      msg: string,
      retry: boolean,
    ): ExecutedToolResult["output"] => ({
      ok: false,
      envelope: makeToolError(tool.meta.name, cls, msg, retry),
    });

    // zod 校验：失败走 envelope 回灌（VALIDATION 不 throw）
    const parsed = tool.inputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return fail("VALIDATION", `invalid arguments: ${issues}`, true);
    }

    const coreCtx: CoreToolContext = { ...ctx, sandbox: deps.sandbox };
    try {
      const out = await withTimeout(
        // 核心工具按 CoreToolContext 实现；protocol ToolContext 全量对齐随 U4
        tool.execute(parsed.data, coreCtx as never),
        tool.meta.timeoutMs,
        ctx.signal,
      );
      const text = tool.toModelOutput ? tool.toModelOutput(out) : JSON.stringify(out);
      // 输出投影：>32KB 落 artifacts，模型只见 preview + spillRef
      if (Buffer.byteLength(text, "utf8") > SPILL_THRESHOLD_BYTES && deps.artifacts) {
        const saved = deps.artifacts.save({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          toolCallId: ctx.callId,
          kind: "tool-output",
          content: text,
        });
        return { ok: true, preview: saved.preview, spillRef: saved.spillRef };
      }
      return { ok: true, preview: text.slice(0, PREVIEW_BYTES) };
    } catch (e) {
      if (ctx.signal.aborted) return fail("CANCELLED", "interrupted", false);
      if (e instanceof TimeoutError) {
        return fail("TIMEOUT", `tool timed out after ${tool.meta.timeoutMs}ms`, true);
      }
      if (e instanceof ToolExecError) return fail(e.cls, e.message, e.retryable);
      // 任意异常：消息可外发，stack 绝不外泄（5 键收口）
      return fail("EXEC_FAILED", e instanceof Error ? e.message : "tool execution failed", false);
    }
  };
}

class TimeoutError extends Error {}

async function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError()), ms);
        onAbort = () => reject(new ToolExecError("interrupted", "CANCELLED"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // 竞速失败方善后：timeout/abort 胜出后 p 仍在飞，稍后若 reject 则无人接 → process 级
    // unhandledRejection（崩 Bun）。挂个空 catch 兜底——race 结果此刻已定，不影响返回值；
    // p 若已是胜出方（resolve/reject 均已被 await 消费），再挂 catch 亦无害。
    void Promise.resolve(p).catch(() => {});
  }
}
