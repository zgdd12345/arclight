import { type Tool, ToolMetaSchema } from "@arclight/protocol";
import { z } from "zod";
// JsonSchema 自 M0 单一权威来源；schema.ts 绝不本地重声明。
import type { JsonSchema } from "./types";

// 最小 JSON Schema → zod（M1 覆盖 object/string+enum/number/integer/boolean/array）。
export function jsonSchemaToZod(s: JsonSchema): z.ZodType {
  switch (s.type) {
    case "string":
      return s.enum && s.enum.length > 0 ? z.enum(s.enum as [string, ...string[]]) : z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(s.items ? jsonSchemaToZod(s.items) : z.unknown());
    case "object": {
      const required = new Set(s.required ?? []);
      const shape: Record<string, z.ZodType> = {};
      for (const [key, prop] of Object.entries(s.properties ?? {})) {
        const child = jsonSchemaToZod(prop);
        shape[key] = required.has(key) ? child : child.optional();
      }
      return z.object(shape);
    }
    default:
      return z.unknown();
  }
}

// StructuredOutput 工具：目标 schema 放 inputSchema —— makeExecuteTool 对 inputSchema 做 safeParse，
// 不匹配回 retryable VALIDATION 信封（registry.ts:65-69），驱动模型重试。execute 捕获已校验 data。
export function makeStructuredOutputTool(
  schema: z.ZodType,
  onCapture: (data: unknown) => void,
): Tool<unknown, unknown> {
  return {
    meta: ToolMetaSchema.parse({
      name: "StructuredOutput",
      description:
        "Return the final structured result for this task. Call exactly once with a payload matching the schema.",
      isReadOnly: true,
      isConcurrencySafe: true,
      riskTier: "safe",
      riskClass: "read",
      timeoutMs: 5_000,
      maxResultSizeBytes: 65_536,
    }),
    inputSchema: schema as z.ZodType<unknown>,
    outputSchema: z.object({ ok: z.literal(true) }) as z.ZodType<unknown>,
    async execute(input) {
      onCapture(input);
      return { ok: true };
    },
    toModelOutput: () => "Structured output recorded. Send a short closing message and stop.",
  };
}
