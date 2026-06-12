import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import { type CoreToolContext, ToolExecError } from "../registry";

export function resolveInWorkspace(cwd: string, path: string): string {
  const abs = resolve(cwd, path);
  if (abs !== cwd && !abs.startsWith(cwd + sep)) {
    throw new ToolExecError(`path escapes workspace: ${path}`, "PERMISSION_DENIED");
  }
  return abs;
}

const Input = z.object({ path: z.string().min(1) });
const Output = z.object({ path: z.string(), content: z.string() });

export const readFileTool: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  meta: {
    name: "read_file",
    description: "Read a text file from the workspace. Path is relative to the workspace root.",
    isReadOnly: true,
    isConcurrencySafe: true,
    executesShellCommands: false,
    mutatesWorkspace: false, // 纯读，不打检查点
    riskTier: "safe",
    riskClass: "read",
    timeoutMs: 10_000,
    maxResultSizeBytes: 512 * 1024,
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx) {
    const { cwd } = ctx as unknown as CoreToolContext;
    const abs = resolveInWorkspace(cwd, input.path);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      throw new ToolExecError(`file not found or unreadable: ${input.path}`, "EXEC_FAILED", true);
    }
    return { path: input.path, content };
  },
  toModelOutput: (out) => out.content,
};
