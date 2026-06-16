import { describe, expect, test } from "bun:test";
import type { ArcEvent } from "@arclight/protocol";
import type { DraftEvent } from "../../db/appendEvent";
import { WorkflowEvents } from "../events";
import { deriveChildSignal, terminalEvent } from "../interrupt";

function makeEmit() {
  const events: ArcEvent[] = [];
  let seq = 0;
  const emit = (draft: DraftEvent): ArcEvent => {
    const e = { ...draft, seq: ++seq, epoch: 0, ts: 1_700_000_000_000 + seq } as ArcEvent;
    events.push(e);
    return e;
  };
  return { events, emit };
}

describe("deriveChildSignal：父 interrupt 级联扇出（spec §10）", () => {
  test("父 abort → 派生信号 aborted", () => {
    const parent = new AbortController();
    const { signal } = deriveChildSignal(parent.signal);
    expect(signal.aborted).toBe(false);
    parent.abort();
    expect(signal.aborted).toBe(true);
  });

  test("scheduler 单独取消该 agent → 派生 aborted，父不受影响", () => {
    const parent = new AbortController();
    const { signal, abort } = deriveChildSignal(parent.signal);
    abort();
    expect(signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  test("父已 abort 时派生信号即刻为 aborted", () => {
    const parent = new AbortController();
    parent.abort();
    const { signal } = deriveChildSignal(parent.signal);
    expect(signal.aborted).toBe(true);
  });
});

describe("terminalEvent：run 终态映射（spec §10，词表 = M0 RunStatus）", () => {
  test("completed → workflow.completed", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    terminalEvent(w, "completed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: "workflow.completed", workflowId: "run-1" });
  });

  test("interrupted → workflow.failed{reason:interrupted}", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    terminalEvent(w, "interrupted");
    expect(events[0]).toMatchObject({ t: "workflow.failed", reason: "interrupted" });
  });

  test("failed → workflow.failed{reason:error}，带 message", () => {
    const { events, emit } = makeEmit();
    const w = new WorkflowEvents(emit, { sessionId: "s-parent", workflowId: "run-1" });
    terminalEvent(w, "failed", "boom");
    expect(events[0]).toMatchObject({ t: "workflow.failed", reason: "error", message: "boom" });
  });
});
