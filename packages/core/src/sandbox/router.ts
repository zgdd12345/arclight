import { DockerFallbackSandbox } from "./backends/dockerFallback";
import { LocalNonoSandbox } from "./backends/localNono";
import {
  type ProbeResult,
  type SandboxRunRequest,
  type SandboxRunResult,
  type SandboxService,
  SandboxUnavailableError,
} from "./service";

// 三级回退路由（D5 / P0 沙箱方案）：local-nono → docker-fallback → 拒绝 SANDBOX_UNAVAILABLE。
// probe 结果缓存（进程生命周期内后端可用性视为稳定；TTL 进阶段二）。

export class SandboxRouter implements SandboxService {
  readonly backend = "local-nono" as const; // 名义主路；实际后端见 active()
  private readonly nono = new LocalNonoSandbox();
  private readonly docker = new DockerFallbackSandbox();
  private cached: SandboxService | null = null;

  async active(): Promise<SandboxService> {
    if (this.cached) return this.cached;
    if ((await this.nono.probe()).available) {
      this.cached = this.nono;
    } else if ((await this.docker.probe()).available) {
      this.cached = this.docker;
    } else {
      throw new SandboxUnavailableError(
        "docker-fallback",
        "no sandbox backend available (nono missing, docker unreachable) — refusing to run bare",
      );
    }
    return this.cached;
  }

  async probe(): Promise<ProbeResult> {
    try {
      return await (await this.active()).probe();
    } catch (e) {
      return {
        backend: "docker-fallback",
        available: false,
        detail: e instanceof Error ? e.message : "no backend",
      };
    }
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    return (await this.active()).run(req);
  }

  async cancel(runId: string): Promise<void> {
    if (this.cached) await this.cached.cancel(runId);
  }
}
