// bearer 鉴权 + devNoAuth 测试旁路。/health 始终开放；/api/* 默认 fail-closed，
// devNoAuth=true（ARCLIGHT_DEV_NO_AUTH=1）时任意/空 token 放行。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { EventBus } from "../../events/bus";
import { createApp } from "../app";

const TOKEN = "auth-test-token-0123456789abcdef0123456789abcdef";

function makeApp(devNoAuth: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "arclight-auth-"));
  const arclightDir = join(dir, ".arclight");
  const { dbPath } = runMigrations(arclightDir);
  const { db, sqlite } = createDb(dbPath);
  const app = createApp({
    repoPath: dir,
    arclightDir,
    db,
    bus: new EventBus(),
    token: TOKEN,
    devNoAuth,
  });
  return { app, sqlite, dir };
}

describe("bearerAuth（默认 fail-closed）", () => {
  let h: ReturnType<typeof makeApp>;
  beforeAll(() => {
    h = makeApp(false);
  });
  afterAll(() => {
    h.sqlite.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("/health 无 token 也开放", async () => {
    const res = await h.app.fetch(new Request("http://x/health"));
    expect(res.status).toBe(200);
  });

  test("/api/* 无 token → 401", async () => {
    const res = await h.app.fetch(
      new Request("http://x/api/sessions", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  test("/api/* 错 token → 401", async () => {
    const res = await h.app.fetch(
      new Request("http://x/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  test("/api/* 正确 token → 放行（非 401）", async () => {
    const res = await h.app.fetch(
      new Request("http://x/api/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).not.toBe(401);
  });
});

describe("devNoAuth 旁路（ARCLIGHT_DEV_NO_AUTH=1）", () => {
  let h: ReturnType<typeof makeApp>;
  beforeAll(() => {
    h = makeApp(true);
  });
  afterAll(() => {
    h.sqlite.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("无 token 也放行（非 401）", async () => {
    const res = await h.app.fetch(
      new Request("http://x/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).not.toBe(401);
  });

  test("任意错 token 也放行（非 401）", async () => {
    const res = await h.app.fetch(
      new Request("http://x/api/sessions", {
        method: "POST",
        headers: { authorization: "Bearer anything", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).not.toBe(401);
  });
});
