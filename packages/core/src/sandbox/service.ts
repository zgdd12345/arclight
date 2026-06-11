// SandboxService（P0 沙箱方案 + 工具契约 §C）。纪律：bash 一律经沙箱，绝不裸跑。
// 三级回退：local-nono（主路）→ docker-fallback（阶段一实装，CI 用它）→ opt-in 远程（阶段二 stub）
// → 全部不可用返回 SANDBOX_UNAVAILABLE。

export type SandboxBackendId =
  | "local-nono"
  | "docker-fallback"
  | "remote-vercel"
  | "remote-e2b"
  | "browser-pyodide";

export type ProbeResult = {
  backend: SandboxBackendId;
  available: boolean;
  detail: string; // 版本号或不可用原因（人话，可进日志）
};

export type SandboxRunRequest = {
  runId: string;
  /** 宿主机工作区绝对路径；在沙箱内映射为 /workspace */
  cwd: string;
  command: string[]; // argv 形式，不经 shell 拼接
  env?: Record<string, string>;
  workspaceMode?: "ro" | "rw";
  timeoutMs?: number; // 默认取 profile wallclock
  maxOutputBytes?: number; // 默认取 profile stdoutBytes，超限截断
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void; // slice2 起接 tool.progress 合批
  onStderr?: (chunk: string) => void;
};

export type SandboxRunResult = {
  runId: string;
  backend: SandboxBackendId;
  exitCode: number | null; // null = 被杀（超时/取消）
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
};

/** 沙箱不可用/拒绝执行的标准错误：上层（工具层）转 5 键 envelope */
export class SandboxUnavailableError extends Error {
  readonly errorClass = "SANDBOX_UNAVAILABLE" as const;
  constructor(
    readonly backend: SandboxBackendId,
    detail: string,
  ) {
    super(`sandbox backend ${backend} unavailable: ${detail}`);
  }
}

export interface SandboxService {
  readonly backend: SandboxBackendId;
  probe(): Promise<ProbeResult>;
  run(req: SandboxRunRequest): Promise<SandboxRunResult>;
  cancel(runId: string): Promise<void>;
}
