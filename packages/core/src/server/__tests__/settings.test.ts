// 设置面三端点：/api/memories CRUD、/api/sessions/:id/files 上传围栏、/api/config 可用性。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { EventBus } from "../../events/bus";
import { createApp } from "../app";
import { sanitizeFilename } from "../routes/files";

describe("sanitizeFilename 围栏", () => {
  test("剔除路径段与特殊字符，空回退 file", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a\\b\\c.txt")).toBe("c.txt");
    expect(sanitizeFilename('x":?<>|*.md')).toBe("x.md");
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
  });
});

describe("设置面端点（HTTP）", () => {
  let root: string;
  let app: ReturnType<typeof createApp>;
  let sqlite: ReturnType<typeof createDb>["sqlite"];
  let repo: string;
  let sessId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "arclight-settings-"));
    repo = join(root, "proj");
    mkdirSync(repo);
    const arclightDir = join(repo, ".arclight");
    const { dbPath } = runMigrations(arclightDir);
    const conn = createDb(dbPath);
    sqlite = conn.sqlite;
    app = createApp({
      repoPath: repo,
      arclightDir,
      db: conn.db,
      bus: new EventBus(),
      token: "t",
      devNoAuth: true,
      projectsRoot: root,
    });
    const sess = await app.fetch(
      new Request("http://x/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
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

  test("memories CRUD：增→列→停用→删", async () => {
    const created = await json("POST", "/api/memories", { content: "回答一律用中文" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    let list = (await (await json("GET", "/api/memories")).json()) as {
      memories: { id: string; content: string; enabled: boolean }[];
    };
    expect(list.memories).toHaveLength(1);
    expect(list.memories[0]?.content).toBe("回答一律用中文");
    expect(list.memories[0]?.enabled).toBe(true);

    expect((await json("PATCH", `/api/memories/${id}`, { enabled: false })).status).toBe(200);
    list = (await (await json("GET", "/api/memories")).json()) as typeof list;
    expect(list.memories[0]?.enabled).toBe(false);

    expect((await json("DELETE", `/api/memories/${id}`)).status).toBe(200);
    list = (await (await json("GET", "/api/memories")).json()) as typeof list;
    expect(list.memories).toHaveLength(0);
  });

  test("memories 校验：空 content 400；不存在 404", async () => {
    expect((await json("POST", "/api/memories", { content: "  " })).status).toBe(400);
    expect((await json("PATCH", "/api/memories/nope", { enabled: true })).status).toBe(404);
    expect((await json("DELETE", "/api/memories/nope")).status).toBe(404);
  });

  test("文件上传：落 .arclight/uploads/，路径名消毒，内容完整", async () => {
    const form = new FormData();
    form.append("file", new File(["hello arclight"], "../escape 计划.txt"));
    const res = await app.fetch(
      new Request(`http://x/api/sessions/${sessId}/files`, { method: "POST", body: form }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.path.startsWith(".arclight/uploads/")).toBe(true);
    expect(body.path).not.toContain("..");
    const abs = join(repo, body.path);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe("hello arclight");
  });

  test("文件上传：缺 file 字段 400；会话不存在 404", async () => {
    const form = new FormData();
    const res = await app.fetch(
      new Request(`http://x/api/sessions/${sessId}/files`, { method: "POST", body: form }),
    );
    expect(res.status).toBe(400);
    const f2 = new FormData();
    f2.append("file", new File(["x"], "a.txt"));
    const r2 = await app.fetch(
      new Request("http://x/api/sessions/nope/files", { method: "POST", body: f2 }),
    );
    expect(r2.status).toBe(404);
  });

  test("/api/config 未注入 providerManager → 503（测试拓扑）", async () => {
    expect((await json("GET", "/api/config")).status).toBe(503);
    expect((await json("PATCH", "/api/config", { model: "x" })).status).toBe(503);
  });

  test("/api/sessions/:id/grants 未注入 approvals → 空列表 + 撤销 503（测试拓扑）", async () => {
    const list = await json("GET", `/api/sessions/${sessId}/grants`);
    expect(list.status).toBe(200);
    expect((await list.json()) as { ok: boolean; grants: string[] }).toEqual({
      ok: true,
      grants: [],
    });
    expect((await json("DELETE", `/api/sessions/${sessId}/grants/bash`)).status).toBe(503);
  });

  test("/api/sessions/:id/context-usage：默认 0 token + 标准窗口；不存在 404", async () => {
    const res = await json("GET", `/api/sessions/${sessId}/context-usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      currentTokens: number;
      effectiveWindow: number;
    };
    expect(body.currentTokens).toBe(0);
    expect(body.effectiveWindow).toBe(120_000);
    // 写入一个 contextTokens 后应回读
    sqlite.run("UPDATE sessions SET context_tokens = 4321 WHERE id = ?", [sessId]);
    const res2 = await json("GET", `/api/sessions/${sessId}/context-usage`);
    expect(((await res2.json()) as { currentTokens: number }).currentTokens).toBe(4321);
    expect((await json("GET", "/api/sessions/nope/context-usage")).status).toBe(404);
  });

  test("/api/sessions/:id/checkpoints：空 → []；插入后按 rowid 序返回", async () => {
    const empty = await json("GET", `/api/sessions/${sessId}/checkpoints`);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { checkpoints: unknown[] }).checkpoints).toEqual([]);
    // 取该 session 的 workspace 以满足 checkpoints FK
    const wsRow = sqlite
      .query<{ workspace_id: string }, [string]>("SELECT workspace_id FROM sessions WHERE id = ?")
      .get(sessId);
    const wsId = wsRow?.workspace_id ?? "";
    sqlite.run(
      "INSERT INTO checkpoints (id, workspace_id, session_id, backend, ref, label, changed_files) VALUES (?, ?, ?, 'shadow-git', ?, ?, ?)",
      ["cp1", wsId, sessId, "sha1", "pre-edit:apply_patch", JSON.stringify([])],
    );
    sqlite.run(
      "INSERT INTO checkpoints (id, workspace_id, session_id, backend, ref, label, changed_files) VALUES (?, ?, ?, 'shadow-git', ?, ?, ?)",
      ["cp2", wsId, sessId, "sha2", "post-edit:apply_patch", JSON.stringify(["a.ts", "b.ts"])],
    );
    const res = await json("GET", `/api/sessions/${sessId}/checkpoints`);
    const body = (await res.json()) as {
      checkpoints: { id: string; label: string; changedFiles: string[] }[];
    };
    expect(body.checkpoints.map((c) => c.id)).toEqual(["cp1", "cp2"]); // rowid 序（旧→新）
    expect(body.checkpoints[1]?.changedFiles).toEqual(["a.ts", "b.ts"]);
  });
});
