import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import type { CoreToolContext } from "../registry";
import { resolveInWorkspace } from "./readFile";

const Input = z.object({ path: z.string().min(1), content: z.string() });
const Output = z.object({ path: z.string(), bytesWritten: z.number() });

export const writeFileTool: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  meta: {
    name: "write_file",
    description:
      "Create or overwrite a text file in the workspace. Prefer apply_patch for editing existing files.",
    isReadOnly: false,
    isConcurrencySafe: false,
    riskTier: "confirm",
    riskClass: "write",
    timeoutMs: 10_000,
    maxResultSizeBytes: 4 * 1024,
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx) {
    const { cwd } = ctx as unknown as CoreToolContext;
    const abs = resolveInWorkspace(cwd, input.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, input.content, "utf8");
    return { path: input.path, bytesWritten: Buffer.byteLength(input.content, "utf8") };
  },
  toModelOutput: (out) => `wrote ${out.bytesWritten} bytes to ${out.path}`,
};
