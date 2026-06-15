import type { ArcEvent } from "@arclight/protocol";

// SessionReducer（DEV_PLAN §2.2 ②）：ArcEvent → SessionState 纯函数。
// 纪律：part 级不可变更新（只替换变化的 part 引用，其余共享，assistant-ui 精准 diff）；
// seq <= maxSeq 丢弃；未知 t 静默忽略（forward-compat）。

export type TextPart = { type: "text"; text: string };
export type ThinkingPart = { type: "thinking"; text: string };
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
export type MsgPart = TextPart | ThinkingPart | ToolPart;
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

    case "user.message": {
      // 用户输入回显（问答 transcript 的"问"）：整条落一个 user 消息。
      const e = ev as Extract<ArcEvent, { t: "user.message" }>;
      if (base.messages.some((m) => m.id === e.messageId)) return base; // replay 宽容
      return {
        ...base,
        messages: [
          ...base.messages,
          { id: e.messageId, role: "user", parts: [{ type: "text", text: e.text }] },
        ],
      };
    }

    case "thinking.delta": {
      // 与 message.delta 同构：按 messageId 定位消息；尾部 thinking part 续接，
      // 否则开新 thinking part（thinking→text→thinking 交错时保持声道分段）。
      const e = ev as Extract<ArcEvent, { t: "thinking.delta" }>;
      const idx = base.messages.findIndex((m) => m.id === e.messageId);
      if (idx === -1) {
        return {
          ...base,
          messages: [
            ...base.messages,
            { id: e.messageId, role: "assistant", parts: [{ type: "thinking", text: e.delta }] },
          ],
        };
      }
      const msg = base.messages[idx] as ThreadMsg;
      const last = msg.parts.at(-1);
      const parts =
        last?.type === "thinking"
          ? [
              ...msg.parts.slice(0, -1),
              { type: "thinking", text: last.text + e.delta } as ThinkingPart,
            ]
          : [...msg.parts, { type: "thinking", text: e.delta } as ThinkingPart];
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
      // 内核 envelope 是审批的「解决信号」：同 callId 的 tool.output（allow 落 ok / deny 落
      // error）到达即清掉对应 pendingApproval —— 与 PermissionModal「不前端乐观删除、以内核
      // 事件为准」的 fail-closed 纪律一致。
      const patched = patchTool(base, e.callId, (p) => ({
        ...p,
        status: e.status,
        outputPreview: e.preview,
        ...(e.spillRef !== undefined ? { spillRef: e.spillRef } : {}),
      }));
      return clearApproval(patched, (a) => a.callId === e.callId);
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
      // 终态兜底：被取消/过期的审批可能不产生 tool.output；模态不得活过本轮。
      return clearAllApprovals({ ...base, turn: { id: e.turnId, status: e.status } });
    }

    case "session.error": {
      const e = ev as Extract<ArcEvent, { t: "session.error" }>;
      return clearAllApprovals({ ...base, lastError: e.error.user_message });
    }

    case "interrupted": {
      const e = ev as Extract<ArcEvent, { t: "interrupted" }>;
      return clearAllApprovals({ ...base, turn: { id: e.turnId, status: "interrupted" } });
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

// 移除满足 pred 的 pendingApproval；无命中则共享原引用（零重渲染）。
function clearApproval(state: SessionState, pred: (a: PendingApproval) => boolean): SessionState {
  const next = state.pendingApprovals.filter((a) => !pred(a));
  if (next.length === state.pendingApprovals.length) return state;
  return { ...state, pendingApprovals: next };
}

// 终态兜底：清空全部 pendingApprovals；已空则共享原引用。
function clearAllApprovals(state: SessionState): SessionState {
  if (state.pendingApprovals.length === 0) return state;
  return { ...state, pendingApprovals: [] };
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
