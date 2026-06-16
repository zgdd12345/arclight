import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, workspaces } from "../../db/schema";
import { WorkflowJournalService } from "../journal-service";

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), "arclight-wf-journal-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces)
    .values({ id: "w1", name: "t", repoPath: "/r", arclightDir: "/r/.arclight" })
    .run();
  db.insert(sessions).values({ id: "s1", workspaceId: "w1" }).run();
});
afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("WorkflowJournalService", () => {
  test("startRun → record/complete agent → loadJournal 按 seq 升序回放，result 往返", () => {
    const j = new WorkflowJournalService(db, now);
    const runId = j.startRun({
      sessionId: "s1",
      scriptHash: "sh1",
      argsHash: "ah1",
      args: { seed: 1 },
    });
    const a0 = j.recordAgentStart({ runId, seq: 0, callKind: "agent", specHash: "spec-0" });
    j.completeAgent(a0, { ok: true });
    const a1 = j.recordAgentStart({ runId, seq: 1, callKind: "parallel-item", specHash: "spec-1" });
    j.completeAgent(a1, "text-result");

    const journal = j.loadJournal(runId);
    expect(journal).toHaveLength(2);
    expect(journal[0]).toMatchObject({
      seq: 0,
      specHash: "spec-0",
      status: "completed",
      resultJson: { ok: true },
    });
    expect(journal[1]).toMatchObject({
      seq: 1,
      specHash: "spec-1",
      status: "completed",
      resultJson: "text-result",
    });
  });

  test("failAgent 记 failed", () => {
    const j = new WorkflowJournalService(db, now);
    const runId = j.startRun({ sessionId: "s1", scriptHash: "sh1", argsHash: "ah1", args: {} });
    const a = j.recordAgentStart({ runId, seq: 0, callKind: "agent", specHash: "x" });
    j.failAgent(a, "boom");
    expect(j.loadJournal(runId)[0]).toMatchObject({ status: "failed", resultJson: null });
  });

  test("findResumableRun 按 (scriptHash, argsHash) 取最近，不按 status 过滤（崩溃 run 仍可续）", () => {
    const j = new WorkflowJournalService(db, now);
    const r1 = j.startRun({ sessionId: "s1", scriptHash: "sh1", argsHash: "ah1", args: {} });
    j.finishRun(r1, "failed", "crash");
    clock += 1000;
    const r2 = j.startRun({ sessionId: "s1", scriptHash: "sh1", argsHash: "ah1", args: {} }); // 留 running（模拟崩溃）
    expect(j.findResumableRun("sh1", "ah1")?.runId).toBe(r2);
    expect(j.findResumableRun("sh1", "ah-other")).toBeNull();
    expect(j.findResumableRun("sh-other", "ah1")).toBeNull();
  });
});
