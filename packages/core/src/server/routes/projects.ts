import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../../db/client";
import { sessions, workspaces } from "../../db/schema";

// 项目（= workspace）管理。安全围栏：所有项目目录必须位于 projectsRoot 之内
// （默认 = --repo 的父目录）。浏览器只能在根下选/建子目录，开不了任意宿主路径。

/** 把用户给的项目名/相对路径解析为根内绝对路径；越界（../、绝对、符号链接逃逸）返回 null。 */
export function resolveProjectPath(projectsRoot: string, name: string): string | null {
  if (!name || name.includes("\0")) return null;
  const root = resolve(projectsRoot);
  const abs = resolve(root, name);
  // 词法围栏：必须严格在根内（根自身也不允许直接作项目，避免把整个根树暴露）。防御纵深，保留。
  if (abs === root || !abs.startsWith(root + sep)) return null;
  // 符号链接逃逸防护：词法检查只看字符串，挡不住 escape -> /etc 这类软链。
  // 解析真实路径，确认其仍落在根的真实路径之内。
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    // 根尚不存在：其下不可能有任何已存在的软链，词法围栏已足够。
    return abs;
  }
  // abs 可能尚不存在（新建项目目录）。沿父链上溯到最深的已存在祖先再 realpath，
  // 这样既能挡住中间组件是软链的情况，也兼容创建新目录。
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return null; // 上溯到文件系统根仍不存在，保守拒绝
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    return null;
  }
  // 真实祖先必须是根本身或在根内；否则即为软链逃逸
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) return null;
  return abs;
}

function listAvailableDirs(projectsRoot: string, registered: Set<string>): { name: string }[] {
  const root = resolve(projectsRoot);
  let entries: Dirent[];
  try {
    // withFileTypes：一次 readdir 拿到 dirent，免去每个条目额外的 stat 系统调用。
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string }[] = [];
  for (const dirent of entries) {
    const name = dirent.name;
    if (name.startsWith(".")) continue; // 跳过隐藏目录（.git/.arclight 等）
    // 跳过符号链接：软链可能指向根外，列出即可被注册成越界 workspace。用 lstat 语义（dirent 不跟随软链）。
    if (dirent.isSymbolicLink()) continue;
    if (!dirent.isDirectory()) continue;
    const abs = resolve(root, name);
    if (registered.has(abs)) continue;
    out.push({ name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function createProjectsRoute(deps: { db: Db; projectsRoot: string; arclightDir: string }) {
  const { db, projectsRoot, arclightDir } = deps;

  return (
    new Hono()
      // 列已注册项目 + 根下尚未注册的子目录
      .get("/", (c) => {
        const registered = db
          .select({ id: workspaces.id, name: workspaces.name, repoPath: workspaces.repoPath })
          .from(workspaces)
          .all();
        const regPaths = new Set(registered.map((w) => resolve(w.repoPath)));
        return c.json({
          ok: true,
          projectsRoot: resolve(projectsRoot),
          projects: registered.map((w) => ({
            workspaceId: w.id,
            name: w.name,
            repoPath: w.repoPath,
          })),
          available: listAvailableDirs(projectsRoot, regPaths),
        });
      })
      // 新建/注册项目：body { name }。根下子目录，不存在则创建。
      .post("/", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { name?: string };
        const name = (body.name ?? "").trim();
        const abs = resolveProjectPath(projectsRoot, name);
        if (!abs) {
          return c.json({ ok: false, code: "VALIDATION", message: "项目路径越界或非法" }, 400);
        }
        const existing = db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.repoPath, abs))
          .get();
        if (existing) {
          return c.json({ ok: true, workspaceId: existing.id, repoPath: abs, name: basename(abs) });
        }
        if (!existsSync(abs)) mkdirSync(abs, { recursive: true }); // 允许新建空项目文件夹
        const id = randomUUID();
        db.insert(workspaces)
          .values({ id, name: basename(abs), repoPath: abs, arclightDir })
          .run();
        return c.json({ ok: true, workspaceId: id, repoPath: abs, name: basename(abs) }, 201);
      })
      // 某项目下的会话历史（恢复用）
      .get("/:workspaceId/sessions", (c) => {
        const wsId = c.req.param("workspaceId");
        const rows = db
          .select({
            id: sessions.id,
            title: sessions.title,
            status: sessions.status,
            lastEventSeq: sessions.lastEventSeq,
            updatedAt: sessions.updatedAt,
            createdAt: sessions.createdAt,
          })
          .from(sessions)
          .where(eq(sessions.workspaceId, wsId))
          .orderBy(desc(sessions.updatedAt))
          .all();
        return c.json({
          ok: true,
          sessions: rows.map((r) => ({
            id: r.id,
            title: r.title,
            status: r.status,
            lastEventSeq: r.lastEventSeq,
            updatedAt: r.updatedAt?.getTime() ?? 0,
            createdAt: r.createdAt?.getTime() ?? 0,
          })),
        });
      })
  );
}
