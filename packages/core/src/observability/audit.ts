import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// 独立审计日志（DEV_PLAN §3.4）：写 .arclight/audit/<run_id>.jsonl，覆盖安全敏感事件。
// 与 pino 分离——审计是合规留痕，不随日志级别丢弃，绝不含明文凭证。

export type AuditEventKind =
  | "session.created"
  | "turn.started"
  | "tool.requested"
  | "tool.executed"
  | "tool.denied"
  | "approval.asked"
  | "approval.decided"
  | "approval.expired"
  | "sandbox.run"
  | "sandbox.denied"
  | "blacklist.hit"
  | "checkpoint.created"
  | "checkpoint.restored"
  | "config.loaded";

export type AuditEntry = {
  ts: number;
  kind: AuditEventKind;
  sessionId?: string;
  turnId?: string;
  actor: "user" | "agent" | "system";
  detail: Record<string, unknown>; // 绝不含明文凭证（调用方负责）
};

export class AuditLog {
  private readonly dir: string;
  constructor(arclightDir: string) {
    this.dir = join(arclightDir, "audit");
    mkdirSync(this.dir, { recursive: true });
  }

  write(runId: string, entry: Omit<AuditEntry, "ts">): void {
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
    try {
      appendFileSync(join(this.dir, `${runId}.jsonl`), line);
    } catch {
      // 审计写失败不阻断主流程（但应被监控；阶段一容忍）
    }
  }
}
