import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { sessions, toolCalls, turns, workspaces } from "../../db/schema";
import { ApprovalService } from "../service";

let dir: string;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), "arclight-appr-"));
  const { dbPath } = runMigrations(join(dir, ".arclight"));
  ({ db, sqlite } = createDb(dbPath));
  db.insert(workspaces)
    .values({ id: "w1", name: "t", repoPath: "/r", arclightDir: "/r/.arclight" })
    .run();
  db.insert(sessions).values({ id: "s1", workspaceId: "w1" }).run();
  db.insert(turns)
    .values({ id: "t1", sessionId: "s1", commandId: "c1", status: "running", input: {} })
    .run();
  db.insert(toolCalls)
    .values({
      id: "tc1",
      sessionId: "s1",
      turnId: "t1",
      name: "bash",
      status: "awaiting_approval",
      args: {},
      argsPreview: "rm",
    })
    .run();
});
afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const mkAsk = (svc: ApprovalService) =>
  svc.create({
    sessionId: "s1",
    turnId: "t1",
    toolCallId: "tc1",
    risk: "high",
    cls: "irreversible",
    action: "rm -rf build/",
    detail: { command: "rm -rf build/" },
  });

describe("ApprovalService 状态机", () => {
  test("allow：pending → allowed", () => {
    const svc = new ApprovalService(db, 60_000, now);
    const { askId } = mkAsk(svc);
    expect(svc.decide(askId, "allow")).toBe("allowed");
    expect(svc.get(askId)).toBe("allowed");
  });

  test("deny：pending → denied", () => {
    const svc = new ApprovalService(db, 60_000, now);
    const { askId } = mkAsk(svc);
    expect(svc.decide(askId, "deny")).toBe("denied");
  });

  test("四终态唯一：decide 幂等，二次决议返回首次终态", () => {
    const svc = new ApprovalService(db, 60_000, now);
    const { askId } = mkAsk(svc);
    expect(svc.decide(askId, "allow")).toBe("allowed");
    expect(svc.decide(askId, "deny")).toBe("allowed"); // 不被覆盖
    expect(svc.cancel(askId)).toBe("allowed");
  });

  test("60s 过期：到期后 expireIfDue → expired", () => {
    const svc = new ApprovalService(db, 60_000, now);
    const { askId } = mkAsk(svc);
    expect(svc.expireIfDue(askId)).toBe("pending");
    clock += 60_001;
    expect(svc.expireIfDue(askId)).toBe("expired");
  });

  test("过期权威优先：到期后 approve allow 仍判 expired（防时钟漂移误放行）", () => {
    const svc = new ApprovalService(db, 60_000, now);
    const { askId } = mkAsk(svc);
    clock += 60_001;
    expect(svc.decide(askId, "allow")).toBe("expired");
  });

  test("中断：cancel → cancelled（即便已过期窗口内仍可取消）", () => {
    const svc = new ApprovalService(db, 60_000, now);
    const { askId } = mkAsk(svc);
    expect(svc.cancel(askId)).toBe("cancelled");
    expect(svc.decide(askId, "allow")).toBe("cancelled"); // 终态不可逆
  });

  test("expiresAt = now + ttl", () => {
    const svc = new ApprovalService(db, 60_000, now);
    const { expiresAt } = mkAsk(svc);
    expect(expiresAt).toBe(1_000_000 + 60_000);
  });
});
