import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, workspaces } from "../../db/schema";
import { specHash } from "../hash";
import { WorkflowJournalService } from "../journal-service";
import { makeJournaledRun, type RunOneSpec } from "../journaled-run";
import { ResumePlanner } from "../resume";

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arclight-wf-run-"));
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

const mkRun = (j: WorkflowJournalService) =>
  j.startRun({ sessionId: "s1", scriptHash: "sh", argsHash: "ah", args: {} });

describe("makeJournaledRun", () => {
  test("空 planner → 起 live 并 journal 落 (seq, specHash, result)", async () => {
    const j = new WorkflowJournalService(db);
    const runId = mkRun(j);
    let live = 0;
    const runLive: RunOneSpec = async (spec) => {
      live++;
      return { echo: spec };
    };
    const run = makeJournaledRun({ journal: j, runId, planner: new ResumePlanner([]), runLive });

    const out = await run({ prompt: "a" }, { seq: 0, callKind: "agent" });
    expect(out).toEqual({ echo: { prompt: "a" } });
    expect(live).toBe(1);
    const journal = j.loadJournal(runId);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      seq: 0,
      specHash: specHash({ prompt: "a" }),
      status: "completed",
    });
  });

  test("planner 命中 → 不起 live，秒回 prior 结果，并补写一条 completed 行（可再 resume）", async () => {
    const j = new WorkflowJournalService(db);
    const runId = mkRun(j);
    let live = 0;
    const runLive: RunOneSpec = async () => {
      live++;
      return "LIVE";
    };
    const planner = new ResumePlanner([
      { seq: 0, specHash: specHash({ prompt: "a" }), status: "completed", resultJson: "CACHED" },
    ]);
    const run = makeJournaledRun({ journal: j, runId, planner, runLive });

    const out = await run({ prompt: "a" }, { seq: 0, callKind: "agent" });
    expect(out).toBe("CACHED");
    expect(live).toBe(0);
    const journal = j.loadJournal(runId);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ seq: 0, status: "completed", resultJson: "CACHED" });
  });

  test("runLive throw → failAgent 记 failed 并继续向上抛", async () => {
    const j = new WorkflowJournalService(db);
    const runId = mkRun(j);
    const runLive: RunOneSpec = async () => {
      throw new Error("boom");
    };
    const run = makeJournaledRun({ journal: j, runId, planner: new ResumePlanner([]), runLive });

    await expect(run({ prompt: "x" }, { seq: 0, callKind: "agent" })).rejects.toThrow("boom");
    expect(j.loadJournal(runId)[0]).toMatchObject({ status: "failed" });
  });
});
