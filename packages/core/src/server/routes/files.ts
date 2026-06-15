import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { sessions, workspaces } from "../../db/schema";

// 附件上传（仿 ChatGPT 📎）：multipart 存入会话所属 workspace 的 .arclight/uploads/，
// 返回 repo 相对路径——Agent 经 read_file 读取，不改 submit 协议（text-only）。
// 围栏：文件名消毒 + 落点必须在 uploads 目录内；上限 10MB。

const MAX_BYTES = 10 * 1024 * 1024;

/** 文件名消毒：取末段、剔除路径分隔/控制字符，空则回退 "file"。 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).at(-1) ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 显式剔除控制字符是消毒目标
  const clean = base.replace(/[\u0000-\u001f"*:<>?|]/g, "").trim();
  return clean && clean !== "." && clean !== ".." ? clean : "file";
}

export function createFilesRoute(deps: { db: Db }) {
  const { db } = deps;

  return new Hono().post("/:id/files", async (c) => {
    const sessionId = c.req.param("id");
    const ws = db
      .select({ repoPath: workspaces.repoPath })
      .from(workspaces)
      .innerJoin(sessions, eq(sessions.workspaceId, workspaces.id))
      .where(eq(sessions.id, sessionId))
      .get();
    if (!ws) return c.json({ ok: false, code: "SESSION_NOT_FOUND" }, 404);

    const body = await c.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!(file instanceof File)) {
      return c.json({ ok: false, code: "VALIDATION", message: "缺少 file 字段（multipart）" }, 400);
    }
    if (file.size > MAX_BYTES) {
      return c.json({ ok: false, code: "VALIDATION", message: "文件超过 10MB 上限" }, 413);
    }

    const uploadsDir = resolve(ws.repoPath, ".arclight", "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    const name = sanitizeFilename(file.name);
    // 时间戳前缀防重名覆盖；冲突仍存在则追加随机段
    let fname = `${Date.now()}-${name}`;
    let dest = resolve(uploadsDir, fname);
    if (!dest.startsWith(uploadsDir + sep)) {
      return c.json({ ok: false, code: "VALIDATION", message: "文件名非法" }, 400);
    }
    if (existsSync(dest)) {
      fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;
      dest = resolve(uploadsDir, fname);
    }
    writeFileSync(dest, new Uint8Array(await file.arrayBuffer()));
    return c.json(
      { ok: true, path: join(".arclight", "uploads", fname), name, bytes: file.size },
      201,
    );
  });
}
