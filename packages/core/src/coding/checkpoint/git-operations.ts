import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

// shadow-git 底层 git 调用（借 cline CheckpointTracker 机制，剥 VSCode；Apache-2.0 归因见 NOTICE）。
// 隔离纪律：独立 GIT_DIR（.arclight/checkpoints/<hash>.git）+ --work-tree 指真实工作区，
// 零干扰用户 .git。commit 用 --allow-empty --no-verify，gpgSign 关。

export type GitExecResult = { code: number; stdout: string; stderr: string };

export async function git(
  gitDir: string,
  workTree: string,
  args: string[],
): Promise<GitExecResult> {
  const proc = Bun.spawn(
    [
      "git",
      `--git-dir=${gitDir}`,
      `--work-tree=${workTree}`,
      "-c",
      "core.autocrlf=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "gc.auto=0",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function gitOrThrow(
  gitDir: string,
  workTree: string,
  args: string[],
): Promise<string> {
  const r = await git(gitDir, workTree, args);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

// 嵌套 .git 临时禁用（cline 机制）：shadow add -A 时，工作区内嵌套 git 仓会被当 gitlink
// 不递归快照其文件。改名 .git→.git_disabled 让 shadow 仓看见文件；finally + 3 次重试复原。
// 注：跳过工作区顶层 .git（那是用户仓库，git 本就不把同名 GIT_DIR 之外的 .git 加入索引）。
export async function withNestedGitDisabled<T>(workTree: string, fn: () => Promise<T>): Promise<T> {
  const nested = findNestedGitDirs(workTree);
  const renamed: { from: string; to: string }[] = [];
  for (const dir of nested) {
    const to = `${dir}_disabled`;
    try {
      renameSync(dir, to);
      renamed.push({ from: dir, to });
    } catch {
      // 改名失败（占用等）：跳过该嵌套仓，不阻断快照
    }
  }
  try {
    return await fn();
  } finally {
    for (const { from, to } of renamed) {
      let restored = false;
      for (let i = 0; i < 3 && !restored; i++) {
        try {
          renameSync(to, from);
          restored = true;
        } catch {
          await Bun.sleep(20 * (i + 1));
        }
      }
      // 复原仍失败：宁可留 .git_disabled 让用户察觉，也不丢数据（不静默吞）
    }
  }
}

// 找工作区内的嵌套 .git（排除顶层），最大深度有限，跳过常见大目录。
function findNestedGitDirs(workTree: string): string[] {
  const out: string[] = [];
  const SKIP = new Set(["node_modules", ".arclight", "dist", "build", ".next", "target"]);
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.name === ".git") {
        if (full !== join(workTree, ".git")) out.push(full); // 排除顶层
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(workTree, 0);
  return out;
}

export function shadowGitDirExists(gitDir: string): boolean {
  return existsSync(join(gitDir, "HEAD"));
}
