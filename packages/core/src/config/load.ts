import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

// 配置优先级（DEV_PLAN §1.3）：process.env > .arclight/config.json（repo 级）
// > ~/.config/arclightagent/config.json（用户级）> 内置默认。
// 纪律：ANTHROPIC_API_KEY 及任何 OAuth token 绝不写入 server.json。
// 阶段一单 provider 协议 = Anthropic Messages（D4）；后端可为 Anthropic 官方或任何协议兼容端点。
// D4 补充记账（2026-06-11）：实际部署用智谱 GLM 的 Anthropic 兼容端点（成本考量），
// 检测到 ZHIPU_API_KEY 时自动取 bigmodel 端点 + glm 默认模型。
export const ZHIPU_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic/v1";
export const ZHIPU_DEFAULT_MODEL = "glm-4.6";

export const ConfigSchema = z.object({
  anthropicApiKey: z.string().min(1), // Anthropic 协议端点的 key（官方或智谱）
  baseUrl: z.string().url().optional(), // 缺省 = Anthropic 官方
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(43127),
  model: z.string().default("claude-sonnet-4-5"),
  // 扩展思考（thinking.delta 事件源）：默认开。前端"思考过程"披露区依赖此流；
  // 端点不支持时设 ARCLIGHT_THINKING=0 或 config.json {"thinking": false} 关闭。
  thinking: z.boolean().default(true),
  // 鉴权全局放行开关：仅当 ARCLIGHT_DEV_NO_AUTH === "1" 时为 true（保留精确 "=1" 语义）。
  // 仅限本地测试，切勿用于暴露到不可信网络的部署。默认关闭。
  devNoAuth: z.boolean().default(false),
  // 项目围栏根（绝对路径）：ARCLIGHT_PROJECTS_ROOT 显式指定，否则取 repoPath 的父目录。
  // 在 loadConfig 内据 repoPath 计算默认值，故解析后恒为已定义的绝对路径字符串。
  projectsRoot: z.string().optional(),
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
  if (process.env.ANTHROPIC_API_KEY) {
    env.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  } else if (process.env.ZHIPU_API_KEY) {
    // 智谱 GLM 经 Anthropic 兼容端点（D4 补充）
    env.anthropicApiKey = process.env.ZHIPU_API_KEY;
    env.baseUrl = ZHIPU_ANTHROPIC_BASE_URL;
    env.model = ZHIPU_DEFAULT_MODEL;
  }
  if (process.env.ANTHROPIC_BASE_URL) env.baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (process.env.ARCLIGHT_HOST) env.host = process.env.ARCLIGHT_HOST;
  if (process.env.ARCLIGHT_PORT) env.port = Number(process.env.ARCLIGHT_PORT);
  if (process.env.ARCLIGHT_MODEL) env.model = process.env.ARCLIGHT_MODEL;
  // thinking 开关：精确 "=0" 关闭，其余设置值均视为开启（与 devNoAuth 的 "=1" 语义互补：默认开的开关）。
  if (process.env.ARCLIGHT_THINKING !== undefined) {
    env.thinking = process.env.ARCLIGHT_THINKING !== "0";
  }
  // 鉴权放行：精确 "=1" 语义。设置了该 env 才覆盖 config.json/默认；其余值（含 "0"）均为 false。
  if (process.env.ARCLIGHT_DEV_NO_AUTH !== undefined) {
    env.devNoAuth = process.env.ARCLIGHT_DEV_NO_AUTH === "1";
  }
  // 项目围栏根：env 显式指定则解析为绝对路径，否则默认 = repoPath 的父目录。
  env.projectsRoot = process.env.ARCLIGHT_PROJECTS_ROOT
    ? resolve(process.env.ARCLIGHT_PROJECTS_ROOT)
    : resolve(repoPath, "..");

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
