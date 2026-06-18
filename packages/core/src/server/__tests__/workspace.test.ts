import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { workspaces } from "../../db/schema";
import { ensureWorkspace } from "../workspace";

describe("ensureWorkspace", () => {
  let dir: string;
  let conn: ReturnType<typeof createDb>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arclight-ws-"));
    const arclightDir = join(dir, ".arclight");
    const { dbPath } = runMigrations(arclightDir);
    conn = createDb(dbPath);
  });
  afterEach(() => {
    conn.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("inserts a workspace row on first call, returns its id", () => {
    const arclightDir = join(dir, ".arclight");
    const id = ensureWorkspace(conn.db, dir, arclightDir);
    const row = conn.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    expect(row?.repoPath).toBe(dir);
  });

  test("is idempotent — same repoPath returns the same id", () => {
    const arclightDir = join(dir, ".arclight");
    const a = ensureWorkspace(conn.db, dir, arclightDir);
    const b = ensureWorkspace(conn.db, dir, arclightDir);
    expect(b).toBe(a);
    expect(conn.db.select().from(workspaces).all()).toHaveLength(1);
  });
});
