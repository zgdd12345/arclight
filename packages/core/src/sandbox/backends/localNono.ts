import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectCapped } from "../collect";
import profile from "../profiles/p0-local.json";
import {
  type ProbeResult,
  type SandboxRunRequest,
  type SandboxRunResult,
  type SandboxService,
  SandboxUnavailableError,
} from "../service";

// local-nono 主路后端（P0 沙箱方案：Landlock/Seatbelt，profile 随代码版本化）。
// 本机无 nono 时由 SandboxRouter 回退 docker-fallback。

const PROFILE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "profiles",
  "p0-local.json",
);

export class LocalNonoSandbox implements SandboxService {
  readonly backend = "local-nono" as const;
  private readonly running = new Map<string, { proc: Bun.Subprocess; killed: boolean }>();

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

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    if (req.signal?.aborted) throw new DOMException("interrupted before spawn", "AbortError");
    const probe = await this.probe();
    if (!probe.available) throw new SandboxUnavailableError(this.backend, probe.detail);

    const timeoutMs = req.timeoutMs ?? profile.limits.wallclockSec * 1000;
    const cap = req.maxOutputBytes ?? profile.limits.stdoutBytes;
    const started = Date.now();

    const proc = Bun.spawn(["nono", "run", "--profile", PROFILE_PATH, "--", ...req.command], {
      cwd: req.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const entry = { proc, killed: false };
    this.running.set(req.runId, entry);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      entry.killed = true;
      proc.kill();
    }, timeoutMs);
    const onAbort = () => {
      entry.killed = true;
      proc.kill(); // nono profile 配 kill_process_tree_on_exit 兜底子树
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const [out, err] = await Promise.all([
        collectCapped(proc.stdout, cap, req.onStdout),
        collectCapped(proc.stderr, cap, req.onStderr),
      ]);
      const exitCode = await proc.exited;
      return {
        runId: req.runId,
        backend: this.backend,
        exitCode: entry.killed ? null : exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      this.running.delete(req.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    const entry = this.running.get(runId);
    if (entry) {
      entry.killed = true;
      entry.proc.kill();
    }
  }
}
