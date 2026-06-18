import { appendEvent } from "../db/appendEvent";
import type { Db } from "../db/client";
import type { EventBus } from "../events/bus";
import type { LoopToolContext } from "../loop/types";
import { runWorkflow } from "./runtime";
import type { WorkflowJournalService } from "./journal-service";
import type { WorkflowStore } from "./store";
import type { WorkflowContext, WorkflowResult } from "./types";

/** Per-call launch seam: builds a WorkflowContext from the calling LoopToolContext
 *  (parent session/turn/cwd/signal) and runs the workflow. Events bind to the parent
 *  session via appendEvent → main SSE stream (spec §8). Shared by serve.ts tool
 *  injection and the HTTP /api/workflows/run route so the context assembly never drifts. */
export type WorkflowRunner = (
  source: string,
  args: Record<string, unknown>,
  toolCtx: LoopToolContext,
) => Promise<WorkflowResult>;

export function createWorkflowRunner(
  deps: {
    db: Db;
    bus: EventBus;
    callProvider: WorkflowContext["callProvider"];
    registry: WorkflowContext["registry"];
    approvals: WorkflowContext["approvals"];
    executeTool: WorkflowContext["executeTool"];
    store: WorkflowStore;
    journal: WorkflowJournalService;
  },
  // Injectable seam (defaults to the real runWorkflow). The unit test injects a
  // capturing fake — do NOT swap this for mock.module, which leaks process-wide
  // and breaks runtime.test.ts by stripping runtime.ts's other exports.
  runWorkflowFn: typeof runWorkflow = runWorkflow,
): WorkflowRunner {
  return (source, args, toolCtx) =>
    runWorkflowFn(source, args, {
      parentSessionId: toolCtx.sessionId,
      parentTurnId: toolCtx.turnId,
      cwd: toolCtx.cwd,
      signal: toolCtx.signal,
      callProvider: deps.callProvider,
      registry: deps.registry,
      approvals: deps.approvals,
      executeTool: deps.executeTool,
      emit: (draft) => appendEvent({ db: deps.db, bus: deps.bus }, draft),
      store: deps.store,
      journal: deps.journal,
    });
}
