import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZHIPU_ANTHROPIC_BASE_URL } from "../config/load";
import { makeCallProvider, type ProviderProfile } from "./provider-adapter";
import type { CallProvider } from "./types";

// ProviderManager —— 供应商/模型运行时管理（仿 ChatGPT 模型切换）。
// runner 持有的 callProvider 是本管理器的稳定委托；update() 重建底层 provider，
// 下一次 provider 调用即生效（不打断进行中的 turn）。model/thinking 持久化到
// repo 级 .arclight/config.json（loadConfig 优先级中 env > repoFile，故 env 显式
// 指定 ARCLIGHT_MODEL 时重启后以 env 为准——运行时切换仍即时生效）。

const SWITCHABLE_KEYS = ["model", "thinking"] as const;
export type ProviderPatch = { model?: string; thinking?: boolean };

export type ProviderInfo = {
  provider: "zhipu" | "anthropic" | "custom";
  baseUrl: string | null; // 展示用；null = Anthropic 官方
  model: string;
  thinking: boolean;
  availableModels: string[];
};

function providerKind(baseUrl: string | undefined): ProviderInfo["provider"] {
  if (baseUrl === undefined) return "anthropic";
  if (baseUrl === ZHIPU_ANTHROPIC_BASE_URL) return "zhipu";
  return "custom";
}

// 各端点的常见可选模型（展示候选，非白名单——PATCH 接受任意非空 model）。
const ZHIPU_MODELS = [
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "glm-4.7",
  "glm-4.6",
  "glm-4.5",
  "glm-4.5-air",
  "glm-4.5-flash",
];
const ANTHROPIC_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];

export class ProviderManager {
  private profile: ProviderProfile;
  private provider: CallProvider;
  /** runner 持有的稳定委托：每次调用取当前 provider，热切换即时生效 */
  readonly callProvider: CallProvider;

  constructor(
    profile: ProviderProfile,
    private readonly arclightDir: string,
  ) {
    this.profile = profile;
    this.provider = makeCallProvider(profile);
    this.callProvider = (messages, tools, signal) => this.provider(messages, tools, signal);
  }

  current(): ProviderInfo {
    const kind = providerKind(this.profile.baseUrl);
    const candidates =
      kind === "zhipu" ? ZHIPU_MODELS : kind === "anthropic" ? ANTHROPIC_MODELS : [];
    const availableModels = candidates.includes(this.profile.model)
      ? candidates
      : [this.profile.model, ...candidates];
    return {
      provider: kind,
      baseUrl: this.profile.baseUrl ?? null,
      model: this.profile.model,
      thinking: this.profile.thinking === true,
      availableModels,
    };
  }

  /** 仅取当前 model（热路径：usage 每次 record 都调，避免 current() 的 ProviderInfo 对象
   *  与 availableModels 数组分配）。 */
  currentModel(): string {
    return this.profile.model;
  }

  /** 运行时切换 model/thinking。运行时切换是真相（重建 provider，下次调用即生效）；
   *  持久化是 best-effort——写盘失败绝不让 update 抛错（否则 PATCH 返回 500 但内存已切换，
   *  客户端误判失败）。返回切换后信息。 */
  update(patch: ProviderPatch): ProviderInfo {
    this.profile = {
      ...this.profile,
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
    };
    this.provider = makeCallProvider(this.profile);
    this.persist(patch); // 内部吞写盘错误，不抛
    return this.current();
  }

  private persist(patch: ProviderPatch): void {
    const path = join(this.arclightDir, "config.json");
    try {
      let existing: Record<string, unknown> = {};
      if (existsSync(path)) {
        try {
          existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        } catch {
          // 损坏的 config.json：不覆盖用户文件，放弃持久化（运行时切换仍生效）
          return;
        }
      }
      for (const k of SWITCHABLE_KEYS) {
        if (patch[k] !== undefined) existing[k] = patch[k];
      }
      // 原子写：先写临时文件再 rename，避免写到一半被 kill 留下损坏 config.json（下次启动 loadConfig 抛错）。
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`);
      renameSync(tmp, path);
    } catch {
      // 持久化失败（磁盘满/权限）：运行时切换已生效，仅本次不落盘——绝不上抛
    }
  }
}
