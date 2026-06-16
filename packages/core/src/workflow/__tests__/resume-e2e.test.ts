import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, workspaces } from "../../db/schema";
import { argsHash, scriptHash } from "../hash";
import { WorkflowJournalService } from "../journal-service";
import { makeJournaledRun, type RunOneSpec } from "../journaled-run";
import { ResumePlanner } from "../resume";

// 确定性 runLive：结果只由 spec 决定（模拟 guest 内 Date/random 已被 M6 runtime 桩死，spec §7 前提）。
const deterministicRun =
  (counter: { n: number }): RunOneSpec =>
  async (spec) => {
    counter.n++;
    return { for: (spec as { prompt: string }).prompt };
  };

const SCRIPT = "agent('a'); agent('b'); agent('c');";
const ARGS = { seed: 7 };

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arclight-wf-e2e-"));
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

// 跑一遍脚本的三次 agent 调用，返回结果数组 + live 次数 + 命中数。
async function driveRun(
  j: WorkflowJournalService,
  prompts: string[],
  planner: ResumePlanner,
): Promise<{ runId: string; results: unknown[]; live: number; hits: number }> {
  const runId = j.startRun({
    sessionId: "s1",
    scriptHash: scriptHash(SCRIPT),
    argsHash: argsHash(ARGS),
    args: ARGS,
  });
  const counter = { n: 0 };
  const run = makeJournaledRun({ journal: j, runId, planner, runLive: deterministicRun(counter) });
  const results: unknown[] = [];
  for (let seq = 0; seq < prompts.length; seq++) {
    results.push(await run({ prompt: prompts[seq] }, { seq, callKind: "agent" }));
  }
  j.finishRun(runId, "completed");
  return { runId, results, live: counter.n, hits: planner.cacheHits };
}

describe("journal + resume 端到端 (spec §14)", () => {
  test("相同 scriptHash+args 重跑 → 全缓存命中，零 live 调用，结果一致", async () => {
    const j = new WorkflowJournalService(db);
    const first = await driveRun(j, ["a", "b", "c"], new ResumePlanner([]));
    expect(first.live).toBe(3);

    const prior = j.findResumableRun(scriptHash(SCRIPT), argsHash(ARGS));
    expect(prior).not.toBeNull();
    const replay = await driveRun(
      j,
      ["a", "b", "c"],
      // biome-ignore lint/style/noNonNullAssertion: asserted non-null by expect() above
      new ResumePlanner(j.loadJournal(prior!.runId)),
    );
    expect(replay.hits).toBe(3);
    expect(replay.live).toBe(0);
    expect(replay.results).toEqual(first.results); // 确定性：重放结果逐位等于首跑
  });

  test("改中段调用 → 前缀命中、变更点及其后 live", async () => {
    const j = new WorkflowJournalService(db);
    await driveRun(j, ["a", "b", "c"], new ResumePlanner([]));
    // biome-ignore lint/style/noNonNullAssertion: first run just completed, prior is guaranteed non-null
    const prior = j.findResumableRun(scriptHash(SCRIPT), argsHash(ARGS))!;

    const changed = await driveRun(
      j,
      ["a", "B-CHANGED", "c"],
      new ResumePlanner(j.loadJournal(prior.runId)),
    );
    expect(changed.hits).toBe(1); // seq0 命中
    expect(changed.live).toBe(2); // seq1（变更）+ seq2（尾部失效）live
    expect(changed.results[0]).toEqual({ for: "a" });
    expect(changed.results[1]).toEqual({ for: "B-CHANGED" });
  });

  test("确定性回归：无 Date/random，两次独立全新跑结果逐位相等", async () => {
    const j = new WorkflowJournalService(db);
    const a = await driveRun(j, ["a", "b", "c"], new ResumePlanner([]));
    const b = await driveRun(j, ["a", "b", "c"], new ResumePlanner([]));
    expect(b.results).toEqual(a.results);
  });
});
