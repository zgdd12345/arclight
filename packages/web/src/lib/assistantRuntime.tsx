"use client";

// ArcRuntimeProvider —— 薄 React 适配层（DEV_PLAN §2.2）。
// useExternalStoreRuntime 接 SessionStore（useSyncExternalStore 订阅），
// convertMessage 把 client-core ThreadMsg → assistant-ui ThreadMessageLike。
// 前端零 `ai` 运行时。业务真相只读自 client-core，UI 不复制业务状态。

import type { CommandClient, SessionState, SessionStore, ThreadMsg } from "@arclight/client-core";
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

// ToolCallCard / SessionStatusBar 直接从该 context 读取实时 SessionState，
// 取 client-core ToolPart 的富信息（status/risk/preview/progress），
// 避免把这些挤进 assistant-ui 的 tool-call 协议。
const ArcSessionContext = createContext<SessionState | null>(null);

export function useArcSession(): SessionState {
  const state = useContext(ArcSessionContext);
  if (!state) throw new Error("useArcSession 必须在 ArcRuntimeProvider 内调用");
  return state;
}

// Composer 的"停止"按钮等 UI 需要直接下发内核命令（interrupt）；与状态 context 分开，
// 避免命令引用变化触发纯展示组件重渲染。
const ArcCommandContext = createContext<CommandClient | null>(null);

export function useArcCommand(): CommandClient {
  const command = useContext(ArcCommandContext);
  if (!command) throw new Error("useArcCommand 必须在 ArcRuntimeProvider 内调用");
  return command;
}

// 续问队列（仿 ChatGPT：turn 运行中可继续输入并排队，完成后自动发出）。
export type FollowUpQueue = {
  queue: string[];
  enqueue: (text: string) => void;
  clear: () => void;
  error: string | null; // 自动发送失败（如 STALE_EPOCH）时的提示；用户可重试或清空
  retry: () => void; // 手动重试队首（自动发送失败后用）
};
const ArcFollowUpContext = createContext<FollowUpQueue | null>(null);

export function useFollowUpQueue(): FollowUpQueue {
  const q = useContext(ArcFollowUpContext);
  if (!q) throw new Error("useFollowUpQueue 必须在 ArcRuntimeProvider 内调用");
  return q;
}

function convertMessage(message: ThreadMsg): ThreadMessageLike {
  return {
    role: message.role,
    id: message.id,
    content: message.parts.map((part) => {
      if (part.type === "text") {
        return { type: "text" as const, text: part.text };
      }
      if (part.type === "thinking") {
        // thinking part → assistant-ui reasoning part；ThinkingDisclosure 经
        // partComponents.Reasoning 渲染为可折叠"思考过程"披露区。
        return { type: "reasoning" as const, text: part.text };
      }
      // tool part → tool-call；富渲染细节由 ToolCallCard 经 callId 回查 store。
      const done = part.status === "ok" || part.status === "error";
      return {
        type: "tool-call" as const,
        toolCallId: part.callId,
        toolName: part.name,
        argsText: part.argsPreview,
        ...(done ? { result: part.outputPreview, isError: part.status === "error" } : {}),
      };
    }),
  };
}

export function ArcRuntimeProvider({
  sessionId,
  store,
  command,
  children,
}: {
  sessionId: string;
  store: SessionStore;
  command: CommandClient;
  children: React.ReactNode;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // 续问队列状态。queueRef 镜像 queue 供 drain 读最新值而不进 deps（避免每次入队重跑）。
  const [queue, setQueue] = useState<string[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);
  const queueRef = useRef<string[]>([]);
  queueRef.current = queue;
  const submittingRef = useRef(false);
  const prevStatusRef = useRef(state.turn.status);

  // 统一提交（带最新 epoch 乐观锁）。
  const submitText = useCallback(
    (text: string) =>
      command.submit(sessionId, { text, agent: "code", baseEpoch: store.getSnapshot().epoch }),
    [command, sessionId, store],
  );

  // 出队首条：成功 ack 才出队并清错；失败（STALE_EPOCH / 网络）留队并记错，交用户重试/清空，
  // 不自动重试以免刷屏。submittingRef 防并发与 strict-mode 双调用重复提交。
  const drainHead = useCallback(() => {
    if (submittingRef.current || queueRef.current.length === 0) return;
    submittingRef.current = true;
    const head = queueRef.current[0] as string;
    void submitText(head)
      .then((ack) => {
        if (ack?.ok) {
          setQueue((q) => q.slice(1));
          setQueueError(null);
        } else {
          setQueueError(`发送失败（${ack?.code ?? "未知"}），可重试或清空`);
        }
      })
      .catch(() => setQueueError("发送失败（网络异常），可重试或清空"))
      .finally(() => {
        submittingRef.current = false;
      });
  }, [submitText]);

  const enqueue = useCallback((text: string) => {
    const t = text.trim();
    if (t) setQueue((q) => [...q, t]);
  }, []);
  const clear = useCallback(() => {
    setQueue([]);
    setQueueError(null);
  }, []);
  const followUp = useMemo<FollowUpQueue>(
    () => ({ queue, enqueue, clear, error: queueError, retry: drainHead }),
    [queue, enqueue, clear, queueError, drainHead],
  );

  // 自动发送：仅在 turn running→completed 的跃迁上出队首条（failed/interrupted 保留队列，
  // 交用户决定）。队列长度读 queueRef（边沿处与 queue 同步），失败重试走 retry()=drainHead 直调。
  useEffect(() => {
    const prev = prevStatusRef.current;
    const now = state.turn.status;
    prevStatusRef.current = now;
    if (prev === "running" && now === "completed" && queueRef.current.length > 0) {
      drainHead();
    }
  }, [state.turn.status, drainHead]);

  const runtime = useExternalStoreRuntime<ThreadMsg>({
    messages: state.messages,
    isRunning: state.turn.status === "running",
    convertMessage,
    onNew: async (message) => {
      const text = message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (!text.trim()) return;
      // turn 运行中：入队（防御性——正常 UI 在 running 时走 Composer 的"排队"按钮，不触发 onNew）。
      if (store.getSnapshot().turn.status === "running") {
        enqueue(text);
        return;
      }
      // baseEpoch 取 store 当前 epoch（乐观锁；≠ sessions.epoch → STALE_EPOCH）。
      await submitText(text);
    },
  });

  // useSyncExternalStore 已保证同快照返回同引用，无需再 useMemo（state 本身即稳定引用）。
  return (
    <ArcSessionContext.Provider value={state}>
      <ArcCommandContext.Provider value={command}>
        <ArcFollowUpContext.Provider value={followUp}>
          <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
        </ArcFollowUpContext.Provider>
      </ArcCommandContext.Provider>
    </ArcSessionContext.Provider>
  );
}
