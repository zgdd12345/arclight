// killWithEscalation：先发 SIGTERM，2 秒后如进程仍在则升级 SIGKILL。
// 防止忽略 SIGTERM 的进程令 collectCapped for-await 永久阻塞（timeout 实际失效）。
// grace period 后清理定时器，避免 stray timer 泄漏。
export function killWithEscalation(proc: Bun.Subprocess): void {
  proc.kill(); // SIGTERM
  const escalate = setTimeout(() => proc.kill(9 /* SIGKILL */), 2000);
  // 进程退出（任何原因）后取消升级定时器
  proc.exited.finally(() => clearTimeout(escalate));
}
