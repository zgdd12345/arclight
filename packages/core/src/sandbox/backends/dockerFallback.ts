import profile from "../profiles/p0-local.json";
import {
  type ProbeResult,
  type SandboxRunRequest,
  type SandboxRunResult,
  type SandboxService,
  SandboxUnavailableError,
} from "../service";

// docker-fallback（D5：阶段一实装，CI 前置硬依赖）。
// 等价约束（P0 沙箱方案降级阶梯）：--network none + 只读 rootfs + 仅工作区可写 + cap-drop + pids/内存上限。

const DEFAULTS = {
  timeoutMs: profile.limits.wallclockSec * 1000,
  maxOutputBytes: profile.limits.stdoutBytes,
  image: profile.docker.image,
};

async function collectCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  onChunk?: (chunk: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  for await (const chunk of stream) {
    const s = decoder.decode(chunk, { stream: true });
    onChunk?.(s);
    if (text.length < cap) {
      text += s.slice(0, cap - text.length);
    } else {
      truncated = true; // 继续消费流防 backpressure 卡死，只是不再累积
    }
  }
  if (text.length >= cap) truncated = true;
  return { text, truncated };
}

export class DockerFallbackSandbox implements SandboxService {
  readonly backend = "docker-fallback" as const;
  private readonly running = new Map<string, { proc: Bun.Subprocess; killed: boolean }>();

  async probe(): Promise<ProbeResult> {
    try {
      const proc = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;
      return code === 0
        ? { backend: this.backend, available: true, detail: `docker server ${out}` }
        : { backend: this.backend, available: false, detail: "docker daemon unreachable" };
    } catch (e) {
      return {
        backend: this.backend,
        available: false,
        detail: e instanceof Error ? e.message : "docker binary not found",
      };
    }
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    const probe = await this.probe();
    if (!probe.available) throw new SandboxUnavailableError(this.backend, probe.detail);

    const timeoutMs = req.timeoutMs ?? DEFAULTS.timeoutMs;
    const cap = req.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
    const mode = req.workspaceMode ?? "rw";
    const started = Date.now();

    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(profile.limits.maxPids),
      "--memory",
      "1g",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "-v",
      `${req.cwd}:/workspace:${mode}`,
      "-w",
      "/workspace",
      // denyRawEnv：环境变量白名单注入（P0 inject=[]，即零注入）
      ...Object.entries(req.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      DEFAULTS.image,
      ...req.command,
    ];

    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
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
      proc.kill();
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
