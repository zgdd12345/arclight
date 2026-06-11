import type { ArcEvent } from "@arclight/protocol";

// SessionReducer（DEV_PLAN §2.2 ②）：ArcEvent → SessionState 纯函数。
// 纪律：part 级不可变更新（只替换变化的 part 引用，其余共享，assistant-ui 精准 diff）；
// seq <= maxSeq 丢弃；未知 t 静默忽略（forward-compat）。

export type TextPart = { type: "text"; text: string };
export type ToolPart = {
  type: "tool";
  callId: string;
  name: string;
  status: "requested" | "running" | "ok" | "error";
  argsPreview: string;
  riskTier: string;
  riskClass: string;
  outputPreview: string;
  spillRef?: string;
  progress: string; // stdout/stderr 合流 preview（slice2 起分流）
};
export type MsgPart = TextPart | ToolPart;
export type ThreadMsg = { id: string; role: "user" | "assistant"; parts: MsgPart[] };

export type PendingApproval = {
  askId: string;
  callId: string;
  risk: string;
  cls: string;
  action: string;
  detail: Record<string, unknown>;
  expiresAt: number;
};

export type TurnStatus = "idle" | "running" | "completed" | "failed" | "interrupted";

export type SessionState = {
  sessionId: string;
  epoch: number;
  maxSeq: number;
  messages: ThreadMsg[];
  pendingApprovals: PendingApproval[];
  turn: { id: string | null; status: TurnStatus };
  lastError: string | null;
};

export function initialState(sessionId: string): SessionState {
  return {
    sessionId,
    epoch: 0,
    maxSeq: 0,
    messages: [],
    pendingApprovals: [],
    turn: { id: null, status: "idle" },
    lastError: null,
  };
}

// 宽容输入：wire 上可能出现本版本未知的事件类型
type WireEvent = ArcEvent | { t: string; seq: number; epoch: number; [k: string]: unknown };

export function reduce(state: SessionState, ev: WireEvent): SessionState {
  if (ev.seq <= state.maxSeq) return state; // 纪律：去重
  const base = { ...state, maxSeq: ev.seq, epoch: Math.max(state.epoch, ev.epoch) };

  switch (ev.t) {
    case "turn.started":
      return { ...base, turn: { id: (ev as { turnId: string }).turnId, status: "running" } };

    case "message.delta": {
      const e = ev as Extract<ArcEvent, { t: "message.delta" }>;
      const idx = base.messages.findIndex((m) => m.id === e.messageId);
      if (idx === -1) {
        return {
          ...base,
          messages: [
            ...base.messages,
            { id: e.messageId, role: "assistant", parts: [{ type: "text", text: e.delta }] },
          ],
        };
      }
      const msg = base.messages[idx] as ThreadMsg;
      const last = msg.parts.at(-1);
      const parts =
        last?.type === "text"
          ? [...msg.parts.slice(0, -1), { type: "text", text: last.text + e.delta } as TextPart]
          : [...msg.parts, { type: "text", text: e.delta } as TextPart];
      return { ...base, messages: replaceAt(base.messages, idx, { ...msg, parts }) };
    }

    case "tool.requested": {
      const e = ev as Extract<ArcEvent, { t: "tool.requested" }>;
      const part: ToolPart = {
        type: "tool",
        callId: e.callId,
        name: e.name,
        status: "requested",
        argsPreview: e.argsPreview,
        riskTier: e.riskTier,
        riskClass: e.riskClass,
        outputPreview: "",
        progress: "",
      };
      return appendPartToCurrentAssistant(base, part, e.turnId);
    }

    case "tool.progress": {
      const e = ev as Extract<ArcEvent, { t: "tool.progress" }>;
      return patchTool(base, e.callId, (p) => ({
        ...p,
        status: "running",
        progress: p.progress + e.chunk,
      }));
    }

    case "tool.output": {
      const e = ev as Extract<ArcEvent, { t: "tool.output" }>;
      return patchTool(base, e.callId, (p) => ({
        ...p,
        status: e.status,
        outputPreview: e.preview,
        ...(e.spillRef !== undefined ? { spillRef: e.spillRef } : {}),
      }));
    }

    case "permission.ask": {
      const e = ev as Extract<ArcEvent, { t: "permission.ask" }>;
      return {
        ...base,
        pendingApprovals: [
          ...base.pendingApprovals,
          {
            askId: e.askId,
            callId: e.callId,
            risk: e.risk,
            cls: e.cls,
            action: e.action,
            detail: e.detail,
            expiresAt: e.expiresAt,
          },
        ],
      };
    }

    case "context.compacted":
      return base; // epoch 已在 base 中按事件 epoch 推进

    case "turn.completed": {
      const e = ev as Extract<ArcEvent, { t: "turn.completed" }>;
      return { ...base, turn: { id: e.turnId, status: e.status } };
    }

    case "session.error": {
      const e = ev as Extract<ArcEvent, { t: "session.error" }>;
      return { ...base, lastError: e.error.user_message };
    }

    case "interrupted": {
      const e = ev as Extract<ArcEvent, { t: "interrupted" }>;
      return { ...base, turn: { id: e.turnId, status: "interrupted" } };
    }

    default:
      return base; // 纪律：未知 t 静默忽略（仍推进 maxSeq/epoch）
  }
}

export function reduceBatch(state: SessionState, batch: WireEvent[]): SessionState {
  let s = state;
  for (const e of batch) s = reduce(s, e);
  return s;
}

// ── helpers（part 级不可变更新）──

function replaceAt(msgs: ThreadMsg[], idx: number, msg: ThreadMsg): ThreadMsg[] {
  const next = msgs.slice();
  next[idx] = msg;
  return next;
}

function appendPartToCurrentAssistant(
  state: SessionState,
  part: ToolPart,
  turnId: string | undefined,
): SessionState {
  const last = state.messages.at(-1);
  if (last?.role === "assistant") {
    const idx = state.messages.length - 1;
    return {
      ...state,
      messages: replaceAt(state.messages, idx, { ...last, parts: [...last.parts, part] }),
    };
  }
  return {
    ...state,
    messages: [
      ...state.messages,
      { id: `tool-${turnId ?? part.callId}`, role: "assistant", parts: [part] },
    ],
  };
}

function patchTool(
  state: SessionState,
  callId: string,
  fn: (p: ToolPart) => ToolPart,
): SessionState {
  for (let mi = state.messages.length - 1; mi >= 0; mi--) {
    const msg = state.messages[mi] as ThreadMsg;
    const pi = msg.parts.findIndex((p) => p.type === "tool" && p.callId === callId);
    if (pi === -1) continue;
    const parts = msg.parts.slice();
    parts[pi] = fn(msg.parts[pi] as ToolPart);
    return { ...state, messages: replaceAt(state.messages, mi, { ...msg, parts }) };
  }
  return state; // 找不到对应 tool part：宽容忽略
}
