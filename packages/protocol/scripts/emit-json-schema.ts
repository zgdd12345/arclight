// Emits a single JSON Schema bundle from the protocol's exported zod schemas.
// zod v4 native: z.toJSONSchema. The bundle is the cross-language contract artifact.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ArcAckSchema } from "../src/ack";
import { CapabilityProfileSchema } from "../src/capability";
import { ArcCommandSchema } from "../src/commands";
import {
  ContextCompactedSchema,
  InterruptedSchema,
  MessageDeltaSchema,
  PermissionAskSchema,
  SessionErrorSchema,
  SessionStartedSchema,
  ThinkingDeltaSchema,
  ToolOutputSchema,
  ToolProgressSchema,
  ToolRequestedSchema,
  TurnCompletedSchema,
  TurnStartedSchema,
  UserMessageSchema,
  WorkflowAgentCompletedSchema,
  WorkflowAgentStartedSchema,
  WorkflowCompletedSchema,
  WorkflowFailedSchema,
  WorkflowPhaseSchema,
  WorkflowStartedSchema,
} from "../src/events";

// name → zod schema. Names become $defs keys and pydantic class names.
const REGISTRY: Record<string, z.ZodType> = {
  ArcCommand: ArcCommandSchema,
  ArcAck: ArcAckSchema,
  CapabilityProfile: CapabilityProfileSchema,
  SessionStarted: SessionStartedSchema,
  TurnStarted: TurnStartedSchema,
  MessageDelta: MessageDeltaSchema,
  UserMessage: UserMessageSchema,
  ThinkingDelta: ThinkingDeltaSchema,
  ToolRequested: ToolRequestedSchema,
  ToolProgress: ToolProgressSchema,
  ToolOutput: ToolOutputSchema,
  PermissionAsk: PermissionAskSchema,
  ContextCompacted: ContextCompactedSchema,
  TurnCompleted: TurnCompletedSchema,
  SessionError: SessionErrorSchema,
  Interrupted: InterruptedSchema,
  WorkflowStarted: WorkflowStartedSchema,
  WorkflowPhase: WorkflowPhaseSchema,
  WorkflowAgentStarted: WorkflowAgentStartedSchema,
  WorkflowAgentCompleted: WorkflowAgentCompletedSchema,
  WorkflowCompleted: WorkflowCompletedSchema,
  WorkflowFailed: WorkflowFailedSchema,
};

export function emitProtocolJsonSchema(): Record<string, unknown> {
  const $defs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(REGISTRY)) {
    $defs[name] = z.toJSONSchema(schema, { target: "draft-2020-12" });
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "ArclightProtocol",
    $defs,
  };
}

export function writeBundle(): string {
  const out = join(import.meta.dir, "..", "schema", "arclight-protocol.schema.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(emitProtocolJsonSchema(), null, 2)}\n`);
  return out;
}

if (import.meta.main) {
  const path = writeBundle();
  console.log(`wrote ${path}`);
}
