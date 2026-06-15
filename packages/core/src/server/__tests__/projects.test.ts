// 项目路由 + 路径围栏。安全核心：POST /api/projects 只能在 projectsRoot 内建项目，
// ../、绝对路径、根自身一律拒。GET 列已注册 + 可用子目录。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { EventBus } from "../../events/bus";
import { createApp } from "../app";
import { resolveProjectPath } from "../routes/projects";

describe("resolveProjectPath 围栏", () => {
  const root = "/srv/projects";
  test("根下子目录放行", () => {
    expect(resolveProjectPath(root, "alpha")).toBe("/srv/projects/alpha");
    expect(resolveProjectPath(root, "a/b")).toBe("/srv/projects/a/b");
  });
  test("越界一律 null", () => {
    expect(resolveProjectPath(root, "../escape")).toBeNull();
    expect(resolveProjectPath(root, "../../etc")).toBeNull();
    expect(resolveProjectPath(root, "/etc/passwd")).toBeNull();
    expect(resolveProjectPath(root, "")).toBeNull();
    expect(resolveProjectPath(root, ".")).toBeNull(); // 根自身不可作项目
    expect(resolveProjectPath(root, "alpha/../../etc")).toBeNull();
  });
});

describe("项目路由（HTTP）", () => {
  let root: string;
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let sqlite: ReturnType<typeof createDb>["sqlite"];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arclight-root-"));
    mkdirSync(join(root, "proj-a"));
    mkdirSync(join(root, "proj-b"));
    dir = join(root, "proj-a"); // --repo = proj-a
    const arclightDir = join(dir, ".arclight");
    const { dbPath } = runMigrations(arclightDir);
    const conn = createDb(dbPath);
    sqlite = conn.sqlite;
    app = createApp({
      repoPath: dir,
      arclightDir,
      db: conn.db,
      bus: new EventBus(),
      token: "t",
      devNoAuth: true,
      projectsRoot: root,
    });
  });
  afterEach(() => {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("GET /api/projects 列出根下可用子目录", async () => {
    const res = await app.fetch(new Request("http://x/api/projects"));
    const body = (await res.json()) as {
      ok: boolean;
      projectsRoot: string;
      available: { name: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.projectsRoot).toBe(resolve(root));
    expect(body.available.map((a) => a.name).sort()).toEqual(["proj-a", "proj-b"]);
  });

  test("POST /api/projects 在根下新建项目 + 落库", async () => {
    const res = await app.fetch(
      new Request("http://x/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "proj-c" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; repoPath: string; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("proj-c");
    expect(existsSync(join(root, "proj-c"))).toBe(true); // 空项目目录已创建
  });

  test("POST 越界路径被拒（400）", async () => {
    for (const name of ["../escape", "/etc", "../../tmp"]) {
      const res = await app.fetch(
        new Request("http://x/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
      );
      expect(res.status).toBe(400);
    }
    expect(existsSync(resolve(root, "../escape"))).toBe(false);
  });

  test("符号链接逃逸：根下软链指向根外，既不被列出也不可注册（400）", async () => {
    // 在根外建一个真实目录，再在根内放一个指向它的软链
    const outside = mkdtempSync(join(tmpdir(), "arclight-outside-"));
    try {
      symlinkSync(outside, join(root, "escape"), "dir");

      // GET available 不应包含软链目录
      const res = await app.fetch(new Request("http://x/api/projects"));
      const body = (await res.json()) as { available: { name: string }[] };
      expect(body.available.map((a) => a.name)).not.toContain("escape");

      // POST 用该软链名注册应被围栏拒绝（真实路径越界）
      const reg = await app.fetch(
        new Request("http://x/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "escape" }),
        }),
      );
      expect(reg.status).toBe(400);

      // 软链下的子路径同样越界
      expect(resolveProjectPath(root, "escape/sub")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("POST 注册项目后，会话可挂到该 workspace 并出现在历史", async () => {
    const reg = await app.fetch(
      new Request("http://x/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "proj-b" }),
      }),
    );
    const { workspaceId } = (await reg.json()) as { workspaceId: string };

    const sess = await app.fetch(
      new Request("http://x/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, title: "测试会话" }),
      }),
    );
    expect(sess.status).toBe(201);
    const { sessionId, workspaceId: sw } = (await sess.json()) as {
      sessionId: string;
      workspaceId: string;
    };
    expect(sw).toBe(workspaceId);

    const hist = await app.fetch(new Request(`http://x/api/projects/${workspaceId}/sessions`));
    const { sessions } = (await hist.json()) as {
      sessions: { id: string; title: string | null }[];
    };
    expect(sessions.some((s) => s.id === sessionId && s.title === "测试会话")).toBe(true);
  });
});

describe("会话/项目 增删改（CRUD 补全）", () => {
  let root: string;
  let app: ReturnType<typeof createApp>;
  let sqlite: ReturnType<typeof createDb>["sqlite"];
  let wsId: string;
  let sessId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "arclight-crud-"));
    mkdirSync(join(root, "proj-a"));
    const dir = join(root, "proj-a");
    const arclightDir = join(dir, ".arclight");
    const { dbPath } = runMigrations(arclightDir);
    const conn = createDb(dbPath);
    sqlite = conn.sqlite;
    app = createApp({
      repoPath: dir,
      arclightDir,
      db: conn.db,
      bus: new EventBus(),
      token: "t",
      devNoAuth: true,
      projectsRoot: root,
    });
    const reg = await app.fetch(
      new Request("http://x/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "proj-a" }),
      }),
    );
    wsId = ((await reg.json()) as { workspaceId: string }).workspaceId;
    const sess = await app.fetch(
      new Request("http://x/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: wsId }),
      }),
    );
    sessId = ((await sess.json()) as { sessionId: string }).sessionId;
  });
  afterEach(() => {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  const json = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`http://x${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );

  test("PATCH /api/sessions/:id 重命名并反映在历史列表", async () => {
    const res = await json("PATCH", `/api/sessions/${sessId}`, { title: "重命名后的会话" });
    expect(res.status).toBe(200);
    const hist = await json("GET", `/api/projects/${wsId}/sessions`);
    const { sessions } = (await hist.json()) as { sessions: { id: string; title: string }[] };
    expect(sessions.find((s) => s.id === sessId)?.title).toBe("重命名后的会话");
  });

  test("PATCH 空标题 400；不存在的会话 404", async () => {
    expect((await json("PATCH", `/api/sessions/${sessId}`, { title: "  " })).status).toBe(400);
    expect((await json("PATCH", "/api/sessions/nope", { title: "x" })).status).toBe(404);
  });

  test("DELETE /api/sessions/:id 删除并从历史消失；重复删除 404", async () => {
    expect((await json("DELETE", `/api/sessions/${sessId}`)).status).toBe(200);
    const hist = await json("GET", `/api/projects/${wsId}/sessions`);
    const { sessions } = (await hist.json()) as { sessions: { id: string }[] };
    expect(sessions.some((s) => s.id === sessId)).toBe(false);
    expect((await json("DELETE", `/api/sessions/${sessId}`)).status).toBe(404);
  });

  test("DELETE 活跃 turn（running）→ 409 fail-closed", async () => {
    sqlite.run(
      "INSERT INTO turns (id, session_id, command_id, status, input) VALUES (?, ?, ?, 'running', '{}')",
      ["t-act", sessId, "c-act"],
    );
    const res = await json("DELETE", `/api/sessions/${sessId}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("TURN_ACTIVE");
  });

  test("PATCH /api/projects/:id 重命名（repoPath 不变）", async () => {
    expect((await json("PATCH", `/api/projects/${wsId}`, { name: "新项目名" })).status).toBe(200);
    const list = await json("GET", "/api/projects");
    const { projects } = (await list.json()) as {
      projects: { workspaceId: string; name: string; repoPath: string }[];
    };
    const p = projects.find((x) => x.workspaceId === wsId);
    expect(p?.name).toBe("新项目名");
    expect(p?.repoPath).toBe(join(root, "proj-a")); // 磁盘路径不动
  });

  test("DELETE /api/projects/:id 注销 + 级联清会话；磁盘目录保留", async () => {
    expect((await json("DELETE", `/api/projects/${wsId}`)).status).toBe(200);
    const list = await json("GET", "/api/projects");
    const { projects } = (await list.json()) as { projects: { workspaceId: string }[] };
    expect(projects.some((p) => p.workspaceId === wsId)).toBe(false);
    // 级联：其会话一并清除
    expect((await json("GET", `/api/sessions/${sessId}`)).status).toBe(404);
    // 磁盘文件一律不动
    expect(existsSync(join(root, "proj-a"))).toBe(true);
  });

  test("DELETE 项目内有活跃 turn → 409", async () => {
    sqlite.run(
      "INSERT INTO turns (id, session_id, command_id, status, input) VALUES (?, ?, ?, 'awaiting_approval', '{}')",
      ["t-act2", sessId, "c-act2"],
    );
    expect((await json("DELETE", `/api/projects/${wsId}`)).status).toBe(409);
  });

  test("submit 自动标题：title 为空时取首条提问前 40 字", async () => {
    const res = await json("POST", "/api/commands", {
      k: "submit",
      v: 1,
      commandId: "cmd-title-1",
      sessionId: sessId,
      input: {
        text: "帮我重构这个超长的函数名字测试标题截断".repeat(3),
        agent: "code",
        baseEpoch: 0,
      },
    });
    expect(res.status).toBe(202);
    const hist = await json("GET", `/api/projects/${wsId}/sessions`);
    const { sessions } = (await hist.json()) as { sessions: { id: string; title: string }[] };
    const title = sessions.find((s) => s.id === sessId)?.title ?? "";
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title.startsWith("帮我重构")).toBe(true);
    // runMockTurn 系 fire-and-forget：等其终态再收尾，防 afterEach 关库后异步写库泄漏
    const { turnId } = (await res.json()) as { turnId: string };
    for (let i = 0; i < 200; i++) {
      const row = sqlite
        .query<{ status: string }, [string]>("SELECT status FROM turns WHERE id = ?")
        .get(turnId);
      if (row && row.status !== "queued" && row.status !== "running") break;
      await Bun.sleep(10);
    }
  });
});
