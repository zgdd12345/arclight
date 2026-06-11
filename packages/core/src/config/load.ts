import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// 配置优先级（DEV_PLAN §1.3）：process.env > .arclight/config.json（repo 级）
// > ~/.config/arclightagent/config.json（用户级）> 内置默认。
// 纪律：ANTHROPIC_API_KEY 及任何 OAuth token 绝不写入 server.json。
export const ConfigSchema = z.object({
  anthropicApiKey: z.string().min(1),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(43127),
  model: z.string().default("claude-sonnet-4-5"), // 阶段一单 provider（D4），按选型清单 claude-sonnet-4-x
});
export type ArclightConfig = z.infer<typeof ConfigSchema>;

function readJsonIfExists(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`invalid JSON in config file: ${path}`);
  }
}

export function loadConfig(repoPath: string): ArclightConfig {
  const userFile = readJsonIfExists(join(homedir(), ".config", "arclightagent", "config.json"));
  const repoFile = readJsonIfExists(join(repoPath, ".arclight", "config.json"));
  const env: Record<string, unknown> = {};
  if (process.env.ANTHROPIC_API_KEY) env.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.ARCLIGHT_HOST) env.host = process.env.ARCLIGHT_HOST;
  if (process.env.ARCLIGHT_PORT) env.port = Number(process.env.ARCLIGHT_PORT);
  if (process.env.ARCLIGHT_MODEL) env.model = process.env.ARCLIGHT_MODEL;

  const merged = { ...userFile, ...repoFile, ...env };
  const r = ConfigSchema.safeParse(merged);
  if (!r.success) {
    const missing = r.error.issues.map((i) => i.path.join(".")).join(", ");
    // 缺 anthropicApiKey 启动即失败并打印缺失字段（DEV_PLAN §1.3）
    throw new Error(
      `arclight config invalid — missing/invalid fields: ${missing}. ` +
        `Set ANTHROPIC_API_KEY env or add it to .arclight/config.json / ~/.config/arclightagent/config.json`,
    );
  }
  return r.data;
}
