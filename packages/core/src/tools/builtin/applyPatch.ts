import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import { applyEdit } from "../../coding/edit/apply";
import { parseEditBlocks } from "../../coding/edit/parser";
import { type CoreToolContext, ToolExecError } from "../registry";
import { resolveInWorkspace } from "./readFile";

// SEARCH/REPLACE 编辑工具（阶梯 1-3，无 fuzzy——S2 opt-in 随 U5）。
// 失败抛 VALIDATION + did-you-mean，retry_allowed=true 喂反射，绝不静默乱改。

const Input = z.object({
  patch: z
    .string()
    .min(1)
    .describe(
      "One or more SEARCH/REPLACE blocks. Format per block: file path on its own line, then <<<<<<< SEARCH, original lines, =======, replacement lines, >>>>>>> REPLACE",
    ),
});
const Output = z.object({
  applied: z.array(z.object({ filePath: z.string(), created: z.boolean() })),
});

export const applyPatchTool: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  meta: {
    name: "apply_patch",
    description:
      "Edit workspace files with SEARCH/REPLACE blocks. SEARCH must match the file content exactly (whitespace-flexible and ... elision supported).",
    isReadOnly: false,
    isConcurrencySafe: false,
    riskTier: "confirm",
    riskClass: "write",
    timeoutMs: 15_000,
    maxResultSizeBytes: 16 * 1024,
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx) {
    const { cwd } = ctx as unknown as CoreToolContext;
    const parsed = parseEditBlocks(input.patch);
    if (!parsed.ok)
      throw new ToolExecError(`patch parse failed: ${parsed.reason}`, "VALIDATION", true);

    // 全有或全无：先在内存中全部应用成功，再统一落盘（防半套编辑）
    const staged = new Map<string, { content: string; created: boolean }>();
    for (const block of parsed.blocks) {
      const abs = resolveInWorkspace(cwd, block.filePath);
      const existing =
        staged.get(abs)?.content ?? (existsSync(abs) ? readFileSync(abs, "utf8") : "");
      const created = !existsSync(abs) && !staged.has(abs);
      if (created && block.search.trim() !== "") {
        throw new ToolExecError(
          `file not found: ${block.filePath} (use empty SEARCH to create a new file)`,
          "VALIDATION",
          true,
        );
      }
      const r = applyEdit(existing, block.search, block.replace);
      if (!r.ok) {
        const hint = r.didYouMean ? `\nDid you mean to match:\n${r.didYouMean}` : "";
        throw new ToolExecError(
          `SEARCH not found in ${block.filePath}: ${r.reason}${hint}`,
          "VALIDATION",
          true,
        );
      }
      staged.set(abs, { content: r.content, created });
    }
    const applied: { filePath: string; created: boolean }[] = [];
    for (const [abs, { content, created }] of staged) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      applied.push({ filePath: abs, created });
    }
    return { applied };
  },
  toModelOutput: (out) =>
    out.applied.map((a) => `${a.created ? "created" : "edited"} ${a.filePath}`).join("\n"),
};
