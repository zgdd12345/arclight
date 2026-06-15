// @arclight/client-core — 端共享层（纯 TS，Node/Bun/浏览器三环境可跑；不 import core，不引 react）
export { CommandClient } from "./command";
export { EpochTracker } from "./epoch";
export {
  initialState,
  type MsgPart,
  type PendingApproval,
  reduce,
  reduceBatch,
  type SessionState,
  type TextPart,
  type ThinkingPart,
  type ThreadMsg,
  type ToolPart,
  type TurnStatus,
} from "./store/reducer";
export { SessionStore } from "./store/sessionStore";
export { HttpClient, type HttpClientOptions } from "./transport/httpClient";
export {
  type ConnectionStatus,
  EventStreamManager,
  type EventStreamOptions,
  type Snapshot,
} from "./transport/sseTransport";
export { parseSseStream, type SseFrame } from "./transport/stream";
