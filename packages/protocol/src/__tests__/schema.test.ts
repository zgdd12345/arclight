import { describe, expect, it } from "vitest";
import {
  ArcAckSchema,
  ArcCommandSchema,
  ArcEventSchema,
  parseArcCommand,
  parseArcEvent,
  ToolErrorEnvelopeSchema,
} from "../index";

const baseEvent = { v: 1, sessionId: "s1", seq: 1, epoch: 0, ts: 1_700_000_000_000 } as const;

describe("ArcEvent schema", () => {
  it("accepts a valid turn.started event", () => {
    const r = ArcEventSchema.safeParse({ ...baseEvent, t: "turn.started", turnId: "t1" });
    expect(r.success).toBe(true);
  });

  it("accepts a valid tool.output with spillRef", () => {
    const r = ArcEventSchema.safeParse({
      ...baseEvent,
      t: "tool.output",
      callId: "c1",
      status: "ok",
      preview: "ok",
      spillRef: "artifact://a1",
    });
    expect(r.success).toBe(true);
  });

  it("accepts permission.ask with risk fields", () => {
    const r = ArcEventSchema.safeParse({
      ...baseEvent,
      t: "permission.ask",
      askId: "a1",
      callId: "c1",
      risk: "high",
      cls: "irreversible",
      action: "bash",
      detail: { command: "rm -rf build/" },
      expiresAt: 1_700_000_060_000,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown event type", () => {
    const r = ArcEventSchema.safeParse({ ...baseEvent, t: "made.up" });
    expect(r.success).toBe(false);
  });

  it("rejects missing seq (seq is assigned by appendEvent and required on the wire)", () => {
    const { seq: _seq, ...noSeq } = baseEvent;
    const r = ArcEventSchema.safeParse({ ...noSeq, t: "turn.started", turnId: "t1" });
    expect(r.success).toBe(false);
  });

  it("rejects negative epoch", () => {
    const r = ArcEventSchema.safeParse({
      ...baseEvent,
      epoch: -1,
      t: "turn.started",
      turnId: "t1",
    });
    expect(r.success).toBe(false);
  });

  it("parseArcEvent returns flattened issues on failure", () => {
    const r = parseArcEvent({ t: "turn.started" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("ArcCommand schema", () => {
  it("accepts all five command kinds", () => {
    const cmds = [
      {
        k: "submit",
        v: 1,
        commandId: "c1",
        sessionId: "s1",
        input: { text: "hi", agent: "code", baseEpoch: 0 },
      },
      { k: "interrupt", v: 1, commandId: "c2", turnId: "t1", reason: "user" },
      { k: "approve", v: 1, commandId: "c3", askId: "a1", decision: "deny" },
      {
        k: "declareCap",
        v: 1,
        commandId: "c4",
        profile: {
          v: 1,
          localSandbox: true,
          screenshot: "none",
          background: "limited",
          fileSystem: "workspace",
          liveSession: false,
        },
      },
      { k: "resume", v: 1, commandId: "c5", sessionId: "s1", afterSeq: 0, epoch: 0 },
    ];
    for (const c of cmds) {
      const r = ArcCommandSchema.safeParse(c);
      expect(r.success, `command kind ${String((c as { k: string }).k)}`).toBe(true);
    }
  });

  it("rejects submit with non-code agent (阶段一仅 code)", () => {
    const r = parseArcCommand({
      k: "submit",
      v: 1,
      commandId: "c1",
      sessionId: "s1",
      input: { text: "hi", agent: "research", baseEpoch: 0 },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects submit without baseEpoch (乐观锁必填)", () => {
    const r = parseArcCommand({
      k: "submit",
      v: 1,
      commandId: "c1",
      sessionId: "s1",
      input: { text: "hi", agent: "code" },
    });
    expect(r.ok).toBe(false);
  });
});

describe("ToolErrorEnvelope (5 键收口)", () => {
  const valid = {
    status: "error",
    tool: "bash",
    error_class: "TIMEOUT",
    user_message: "command timed out",
    retry_allowed: true,
  };

  it("accepts a valid 5-key envelope", () => {
    expect(ToolErrorEnvelopeSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects extra keys — traceback 永不外泄", () => {
    const r = ToolErrorEnvelopeSchema.safeParse({ ...valid, stack: "Error: at ..." });
    expect(r.success).toBe(false);
  });

  it("rejects unknown error_class", () => {
    const r = ToolErrorEnvelopeSchema.safeParse({ ...valid, error_class: "OOPS" });
    expect(r.success).toBe(false);
  });
});

describe("ArcAck schema", () => {
  it("accepts ok ack", () => {
    const r = ArcAckSchema.safeParse({ ok: true, commandId: "c1", turnId: "t1" });
    expect(r.success).toBe(true);
  });

  it("accepts error ack with stable code", () => {
    const r = ArcAckSchema.safeParse({
      ok: false,
      commandId: "c1",
      code: "STALE_EPOCH",
      message: "epoch advanced",
    });
    expect(r.success).toBe(true);
  });
});
