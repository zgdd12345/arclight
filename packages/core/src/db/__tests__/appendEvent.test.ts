import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArcEvent } from "@arclight/protocol";
import { eq } from "drizzle-orm";
import { appendEvent, SessionNotFoundError, StaleEpochError } from "../appendEvent";
import { createDb } from "../client";
import { runMigrations } from "../migrate";
import { events, sessions, turns, workspaces } from "../schema";

function mkTurn(db: ReturnType<typeof createDb>["db"], id: string, sessionId = "s1") {
  db.insert(turns)
    .values({ id, sessionId, commandId: `cmd-${id}`, status: "running", input: {} })
    .run();
}

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arclight-append-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces)
    .values({ id: "w1", name: "t", repoPath: "/r", arclightDir: "/r/.arclight" })
    .run();
  db.insert(sessions).values({ id: "s1", workspaceId: "w1" }).run();
  for (const t of ["t1", "t2", "t3"]) mkTurn(db, t);
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const draft = (turnId: string) => ({ v: 1, t: "turn.started", sessionId: "s1", turnId }) as const;

describe("appendEvent", () => {
  test("assigns monotonic seq starting at 1 and updates session counters", () => {
    const e1 = appendEvent({ db }, draft("t1"));
    const e2 = appendEvent({ db }, draft("t2"));
    const e3 = appendEvent({ db }, draft("t3"));
    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
    const s = db.select().from(sessions).where(eq(sessions.id, "s1")).get();
    expect(s?.nextSeq).toBe(4);
    expect(s?.lastEventSeq).toBe(3);
  });

  test("persisted row equals returned event (yield 对象即落库对象)", () => {
    const e = appendEvent({ db }, draft("t1"));
    const row = db.select().from(events).where(eq(events.seq, 1)).get();
    expect(row?.event).toEqual(e);
    expect(row?.type).toBe("turn.started");
    expect(row?.epoch).toBe(0);
  });

  test("stamps current session epoch onto the event", () => {
    db.update(sessions).set({ epoch: 5 }).where(eq(sessions.id, "s1")).run();
    const e = appendEvent({ db }, draft("t1"));
    expect(e.epoch).toBe(5);
  });

  test("throws StaleEpochError when expectedEpoch mismatches — 乐观锁", () => {
    db.update(sessions).set({ epoch: 2 }).where(eq(sessions.id, "s1")).run();
    expect(() => appendEvent({ db }, draft("t1"), { expectedEpoch: 1 })).toThrow(StaleEpochError);
    // 失败的事务不得消耗 seq
    const s = db.select().from(sessions).where(eq(sessions.id, "s1")).get();
    expect(s?.nextSeq).toBe(1);
  });

  test("throws SessionNotFoundError for unknown session", () => {
    expect(() => appendEvent({ db }, { ...draft("t1"), sessionId: "nope" })).toThrow(
      SessionNotFoundError,
    );
  });

  test("publishes to bus only after persistence, in seq order", () => {
    const seen: number[] = [];
    const bus = {
      publish(e: ArcEvent) {
        const row = db.select().from(events).where(eq(events.seq, e.seq)).get();
        expect(row).toBeDefined(); // 发布时必已落库
        seen.push(e.seq);
      },
    };
    appendEvent({ db, bus }, draft("t1"));
    appendEvent({ db, bus }, draft("t2"));
    expect(seen).toEqual([1, 2]);
  });

  test("per-session isolation: seq streams are independent", () => {
    db.insert(sessions).values({ id: "s2", workspaceId: "w1" }).run();
    mkTurn(db, "t9", "s2");
    appendEvent({ db }, draft("t1"));
    const e = appendEvent({ db }, { ...draft("t9"), sessionId: "s2" });
    expect(e.seq).toBe(1);
  });
});
