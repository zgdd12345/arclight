import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import type { LoopToolContext } from "../../loop/types";
import type { WorkflowResult } from "../../workflow";
import { resolveWorkflowSource, WORKFLOW_NAME_RE } from "../../workflow";
import { type CoreToolContext, ToolExecError } from "../registry";

export const RUN_WORKFLOW_TOOL_NAME = "run_workflow";

// 恰好二选一：name(跑已存 workflow) | script(临场合成内联源码)；saveAs 仅在 script 下命名复用。
const Input = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(WORKFLOW_NAME_RE, "workflow name must match [a-z0-9][a-z0-9-]{0,63}")
      .optional(),
    script: z.string().min(1).optional(),
    saveAs: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => (v.name === undefined) !== (v.script === undefined), {
    message: "provide exactly one of `name` or `script`",
  })
  .refine((v) => v.saveAs === undefined || v.script !== undefined, {
    message: "`saveAs` requires `script`",
  });

// 终态词表对齐 M0：completed | failed | interrupted（无 cancelled）。
const Output = z.object({
  status: z.enum(["completed", "failed", "interrupted"]),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export const runWorkflowTool: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  meta: {
    name: RUN_WORKFLOW_TOOL_NAME,
    description:
      "Run a multi-agent workflow. Provide `script` with inline workflow source to synthesize one on the fly (optionally `saveAs` to persist it for reuse), or `name` to run a saved workflow. Put any timestamps/seeds in `args` — Date.now/Math.random are stubbed inside workflows. Sub-agents run in isolated contexts; their risky tool calls surface their own approval prompts.",
    isReadOnly: false,
    isConcurrencySafe: false,
    executesShellCommands: false, // 自身不执行 shell；子 agent 的 shell 调用各自走黑名单+审批
    mutatesWorkspace: true, // 子 agent 可写工作区 → query-loop 据此打影子 git 检查点
    riskTier: "confirm", // 非 safe → classify 永不 auto-allow（防子 agent 静默自起 workflow，spec §10/§1）
    riskClass: "write",
    timeoutMs: 30 * 60_000, // 编排可长跑；内部各 subagent 另有自身超时
    maxResultSizeBytes: 512 * 1024,
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx): Promise<WorkflowResult> {
    const c = ctx as unknown as CoreToolContext;
    if (!c.workflows) {
      throw new ToolExecError("workflow runner not configured", "INTERNAL", false);
    }
    const { store, launch } = c.workflows;

    // 解析阶段：命名不存在 / 非法名 / 保存失败 → 归一为 VALIDATION（可重试：LLM 改入参后再试）。
    let source: string;
    try {
      if (input.script !== undefined) {
        if (input.saveAs !== undefined) store.save(input.saveAs, input.script);
        source = input.script;
      } else {
        // refine 保证 name/script 恰一个存在；name 必为 slug 且须已存（resolveWorkflowSource 收口）。
        source = resolveWorkflowSource(input.name as string, store);
      }
    } catch (e) {
      throw new ToolExecError(
        e instanceof Error ? e.message : "invalid workflow request",
        "VALIDATION",
        true,
      );
    }

    // 执行阶段：launch 据父会话 ctx 装 WorkflowContext 并 runWorkflow（run-fatal 不被吞，交 registry 壳分类）。
    return launch(source, input.args ?? {}, ctx as unknown as LoopToolContext);
  },
  toModelOutput: (out) =>
    out.status === "completed"
      ? `workflow completed: ${JSON.stringify(out.output ?? null)}`
      : `workflow ${out.status}${out.error ? `: ${out.error}` : ""}`,
};
