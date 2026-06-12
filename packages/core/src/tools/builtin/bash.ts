import { randomUUID } from "node:crypto";
import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import { SandboxUnavailableError } from "../../sandbox/service";
import { type CoreToolContext, ToolExecError } from "../registry";

// bash：一律经 SandboxService（nono→docker 回退），绝不裸跑（P0 红线）。
// stdout/stderr 经 ctx.emitProgress 旁路成 tool.progress 帧。

const Input = z.object({
  command: z.string().min(1).describe("Shell command to run in the sandboxed workspace"),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});
const Output = z.object({
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  backend: z.string(),
});

export const bashTool: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  meta: {
    name: "bash",
    description:
      "Run a shell command inside the sandbox (workspace mounted at /workspace, no network). Output is truncated beyond 512KB.",
    isReadOnly: false,
    isConcurrencySafe: false,
    executesShellCommands: true, // 审批 preset 据此套用 shell 黑名单+风险升级（非按 name 特判）
    mutatesWorkspace: true, // 命令可能写文件 → 打检查点（静态无从判定，一律视为会写）
    riskTier: "confirm",
    riskClass: "write",
    timeoutMs: 130_000, // 外层壳超时 > 沙箱 wallclock
    maxResultSizeBytes: 512 * 1024,
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx) {
    const core = ctx as unknown as CoreToolContext;
    try {
      const r = await core.sandbox.run({
        runId: `bash-${randomUUID()}`,
        cwd: core.cwd,
        command: ["/bin/sh", "-c", input.command],
        workspaceMode: "rw",
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        signal: core.signal,
        onStdout: (chunk) => core.emitProgress(chunk, "stdout"),
        onStderr: (chunk) => core.emitProgress(chunk, "stderr"),
      });
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        backend: r.backend,
      };
    } catch (e) {
      if (e instanceof SandboxUnavailableError) {
        throw new ToolExecError(e.message, "SANDBOX_UNAVAILABLE", false);
      }
      throw e;
    }
  },
  toModelOutput: (out) => {
    const parts = [
      `exit=${out.exitCode ?? "killed"}${out.timedOut ? " (timeout)" : ""} [${out.backend}]`,
    ];
    if (out.stdout) parts.push(`stdout:\n${out.stdout}`);
    if (out.stderr) parts.push(`stderr:\n${out.stderr}`);
    return parts.join("\n");
  },
};
