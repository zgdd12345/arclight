import { chmodSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// server.json：仅进程发现信息（pid/port/origin/token/workspaceId/repoPath），
// 绝不写入 provider key / OAuth token。chmod 0600 + 读取时 owner 校验。
export const ServerJsonSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  origin: z.string().url(),
  token: z.string().min(32), // loopback bearer
  workspaceId: z.string(),
  repoPath: z.string(),
});
export type ServerJson = z.infer<typeof ServerJsonSchema>;

export function serverJsonPath(arclightDir: string): string {
  return join(arclightDir, "server.json");
}

export function writeServerJson(arclightDir: string, info: ServerJson): string {
  const path = serverJsonPath(arclightDir);
  writeFileSync(path, JSON.stringify(info, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // 文件已存在时 mode 选项不生效，显式收口
  return path;
}

export function readServerJson(arclightDir: string): ServerJson {
  const path = serverJsonPath(arclightDir);
  const st = statSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid !== -1 && st.uid !== uid) {
    throw new Error(`server.json owner mismatch (owner uid ${st.uid}, process uid ${uid})`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`server.json permissions too open (expected 0600): ${path}`);
  }
  return ServerJsonSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function removeServerJson(arclightDir: string): void {
  try {
    unlinkSync(serverJsonPath(arclightDir));
  } catch {
    /* 不存在即目标态 */
  }
}
