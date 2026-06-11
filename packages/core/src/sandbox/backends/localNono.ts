import {
  type ProbeResult,
  type SandboxRunRequest,
  type SandboxRunResult,
  type SandboxService,
  SandboxUnavailableError,
} from "../service";

// local-nono 主路后端。slice0 仅 probe（DEV_PLAN slice0 WBS）；run 在 slice2 实装
// （nono run --profile p0-local -- <cmd>）。nono 不可用 → 上层回退 docker-fallback。

export class LocalNonoSandbox implements SandboxService {
  readonly backend = "local-nono" as const;

  async probe(): Promise<ProbeResult> {
    const bin = Bun.which("nono");
    if (!bin) {
      return {
        backend: this.backend,
        available: false,
        detail: "nono binary not found (install: brew install nono / see P0 沙箱方案)",
      };
    }
    try {
      const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;
      return code === 0
        ? { backend: this.backend, available: true, detail: out || "nono present" }
        : { backend: this.backend, available: false, detail: `nono --version exit ${code}` };
    } catch (e) {
      return {
        backend: this.backend,
        available: false,
        detail: e instanceof Error ? e.message : "nono probe failed",
      };
    }
  }

  async run(_req: SandboxRunRequest): Promise<SandboxRunResult> {
    // slice2 实装：nono run --profile p0-local；当前一律走 docker-fallback
    throw new SandboxUnavailableError(this.backend, "local-nono run lands in slice2 (Unit 3)");
  }

  async cancel(_runId: string): Promise<void> {
    /* slice2 实装（nono kill_process_tree_on_exit） */
  }
}
