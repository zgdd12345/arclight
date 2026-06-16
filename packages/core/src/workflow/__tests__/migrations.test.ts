import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../db/migrate";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function columns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  db.close();
  return rows.map((r) => r.name);
}

describe("workflow journal 迁移", () => {
  test("workflow_runs / workflow_agents 建表且含 resume 关键列", () => {
    dir = mkdtempSync(join(tmpdir(), "arclight-wf-mig-"));
    const { dbPath } = runMigrations(join(dir, ".arclight"));

    const runCols = columns(dbPath, "workflow_runs");
    for (const c of [
      "id",
      "session_id",
      "script_hash",
      "args_hash",
      "args",
      "status",
      "started_at",
      "finished_at",
    ]) {
      expect(runCols).toContain(c);
    }
    const agentCols = columns(dbPath, "workflow_agents");
    for (const c of ["id", "run_id", "seq", "call_kind", "spec_hash", "status", "result_json"]) {
      expect(agentCols).toContain(c);
    }
  });
});
