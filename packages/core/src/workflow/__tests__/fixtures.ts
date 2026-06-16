import type { ArcEvent } from "@arclight/protocol";
import type { DraftEvent } from "../../db/appendEvent";
import type {
  ApprovalSeam,
  CallProvider,
  LlmMessage,
  ProviderResult,
  ProviderStreamPart,
} from "../../loop/types";
import type { SandboxService } from "../../sandbox/service";
import { makeExecuteTool, ToolRegistry } from "../../tools/registry";
// 共享契约类型自 M0；__tests__ 用 ../types。
import type { WorkflowContext, WorkflowStorePort } from "../types";

export type Step = { parts?: ProviderStreamPart[]; result: ProviderResult };

// 脚本化 provider：每轮消费一个 step；记录每次调用收到的 messages（用于隔离断言）。
export function scriptedProvider(steps: Step[]): { provider: CallProvider; calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = [];
  let i = 0;
  const provider: CallProvider = async function* (messages, _tools, _signal) {
    // 快照：queryLoop 在 provider 返回后会向 st.messages append assistant 消息，
    // 若直接推引用则断言时消息数已变，故此处取浅拷贝记录调用时的视图（隔离断言用）。
    calls.push([...messages] as LlmMessage[]);
    const step = steps[i++] ?? { result: { text: "", toolCalls: [], finishReason: "stop" } };
    for (const part of step.parts ?? []) yield part;
    return step.result;
  };
  return { provider, calls };
}

// StructuredOutput.execute 不触达 sandbox；此桩仅满足 makeExecuteTool 的依赖形状。
export const dummySandbox = {
  backend: "docker-fallback",
  probe: async () => ({ available: false }),
  run: async () => {
    throw new Error("sandbox not used in workflow unit tests");
  },
  cancel: async () => {},
} as unknown as SandboxService;

export const allowAllApprovals: ApprovalSeam = {
  async check() {
    return { decision: "allow" };
  },
};

// WorkflowContext.store 是可选字段（store?），但 runSubagent(M1) 不触达 store——给一个抛错桩满足类型。
export const dummyStore: WorkflowStorePort = {
  has: () => false,
  load: (name) => {
    throw new Error(`workflow store not used in M1 unit tests: ${name}`);
  },
  save: (name) => ({ name, scriptHash: "" }),
  list: () => [],
};

export function emitSpy(): { emit: WorkflowContext["emit"]; events: ArcEvent[] } {
  const events: ArcEvent[] = [];
  let seq = 0;
  const emit: WorkflowContext["emit"] = (draft: DraftEvent) => {
    const stamped = { ...draft, seq: ++seq, ts: Date.now(), epoch: 0 } as ArcEvent;
    events.push(stamped);
    return stamped;
  };
  return { emit, events };
}

export function makeCtx(opts: {
  provider: CallProvider;
  registry?: WorkflowContext["registry"];
  executeTool?: WorkflowContext["executeTool"];
  signal?: AbortSignal; // run 级父信号（M0 WorkflowContext.signal）
  maxReflections?: number;
  emit?: WorkflowContext["emit"];
  onPhase?: (t: string) => void;
  onLog?: (m: string) => void;
}): WorkflowContext {
  let n = 0;
  return {
    parentSessionId: "parent-s",
    parentTurnId: "parent-t",
    cwd: "/tmp/wf-test",
    signal: opts.signal ?? new AbortController().signal,
    callProvider: opts.provider,
    registry: opts.registry ?? new ToolRegistry(),
    approvals: allowAllApprovals,
    executeTool: opts.executeTool ?? makeExecuteTool({ sandbox: dummySandbox }),
    emit: opts.emit ?? emitSpy().emit,
    store: dummyStore,
    maxRetries: 0,
    maxReflections: opts.maxReflections ?? 3,
    newId: () => `wfid-${++n}`,
    ...(opts.onPhase !== undefined ? { onPhase: opts.onPhase } : {}),
    ...(opts.onLog !== undefined ? { onLog: opts.onLog } : {}),
  };
}
