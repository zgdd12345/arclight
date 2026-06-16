// 11 张域表，照搬 P0 施工图（doc/research/P0-基础三件套-拓扑-数据模型-工具契约.md §B）。
// 口径说明：文档处的"12 张表"= 11 张域表 + drizzle 迁移记账表（__drizzle_migrations）。
// 约定：tenant_id="local"、user_id="local-user"；epoch=会话乐观锁+压缩边界；
// seq=per-session 单调事件序；JSON 用 text({mode:"json"})；时间 Unix ms。

import type { ArcEvent, ToolErrorEnvelope } from "@arclight/protocol";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const nowMs = sql`(unixepoch() * 1000)`;

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    userId: text("user_id").notNull().default("local-user"),
    name: text("name").notNull(),
    repoPath: text("repo_path").notNull(),
    arclightDir: text("arclight_dir").notNull(),
    currentSessionId: text("current_session_id"),
    defaultBranch: text("default_branch"),
    headSha: text("head_sha"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex("workspaces_tenant_repo_uq").on(t.tenantId, t.repoPath),
    index("workspaces_tenant_idx").on(t.tenantId),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    userId: text("user_id").notNull().default("local-user"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title"),
    status: text("status", { enum: ["active", "idle", "completed", "errored", "archived"] })
      .notNull()
      .default("active"),
    epoch: integer("epoch").notNull().default(0), // 乐观锁 + 压缩边界
    nextSeq: integer("next_seq").notNull().default(1), // per-session event seq
    summary: text("summary"), // P0 单级压缩摘要
    contextTokens: integer("context_tokens").notNull().default(0), // 上次 turn 结束时的上下文 token 估计（余量仪表）
    contextSnapshot: text("context_snapshot", { mode: "json" }).$type<Record<string, unknown>>(),
    lastResponseId: text("last_response_id"),
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    index("sessions_tenant_workspace_idx").on(t.tenantId, t.workspaceId),
    index("sessions_tenant_epoch_idx").on(t.tenantId, t.id, t.epoch),
    index("sessions_status_idx").on(t.status),
  ],
);

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    commandId: text("command_id").notNull(),
    status: text("status", {
      enum: ["queued", "running", "awaiting_approval", "completed", "failed", "interrupted"],
    }).notNull(),
    input: text("input", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    error: text("error", { mode: "json" }).$type<ToolErrorEnvelope>(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex("turns_session_command_uq").on(t.sessionId, t.commandId), // 幂等
    index("turns_session_created_idx").on(t.sessionId, t.createdAt),
    index("turns_status_idx").on(t.status),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    role: text("role", { enum: ["system", "user", "assistant", "tool"] }).notNull(),
    content: text("content").notNull(),
    parts: text("parts", { mode: "json" }).$type<unknown[]>(),
    epoch: integer("epoch").notNull().default(0),
    seqStart: integer("seq_start"),
    seqEnd: integer("seq_end"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    index("messages_session_created_idx").on(t.sessionId, t.createdAt),
    index("messages_session_epoch_idx").on(t.sessionId, t.epoch),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    seq: integer("seq").notNull(),
    epoch: integer("epoch").notNull().default(0),
    type: text("type").notNull(), // ArcEvent["t"]
    event: text("event", { mode: "json" }).$type<ArcEvent>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex("events_session_seq_uq").on(t.sessionId, t.seq), // SSE id: = seq
    index("events_session_created_idx").on(t.sessionId, t.createdAt),
    index("events_replay_idx").on(t.sessionId, t.seq, t.epoch),
    index("events_tenant_idx").on(t.tenantId),
  ],
);

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(), // callId
    tenantId: text("tenant_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status", {
      enum: ["requested", "awaiting_approval", "running", "completed", "failed", "cancelled"],
    }).notNull(),
    args: text("args", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    argsPreview: text("args_preview").notNull(),
    resultPreview: text("result_preview"),
    error: text("error", { mode: "json" }).$type<ToolErrorEnvelope>(),
    approvalId: text("approval_id"),
    artifactId: text("artifact_id"),
    sandboxRunId: text("sandbox_run_id"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    index("tool_calls_session_turn_idx").on(t.sessionId, t.turnId),
    index("tool_calls_status_idx").on(t.status),
    index("tool_calls_name_idx").on(t.name),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    toolCallId: text("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
    kind: text("kind", {
      enum: ["stdout", "stderr", "tool-output", "diff", "file", "audit", "snapshot"],
    }).notNull(),
    path: text("path").notNull(),
    mime: text("mime"),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    preview: text("preview"),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    index("artifacts_session_kind_idx").on(t.sessionId, t.kind),
    index("artifacts_tool_idx").on(t.toolCallId),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(), // askId
    tenantId: text("tenant_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").references(() => toolCalls.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "allowed", "denied", "expired", "cancelled"] })
      .notNull()
      .default("pending"),
    risk: text("risk", { enum: ["low", "med", "high"] }).notNull(),
    cls: text("cls", { enum: ["read", "write", "irreversible", "funds"] }).notNull(),
    action: text("action").notNull(),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    decisionReason: text("decision_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    index("approvals_pending_idx").on(t.sessionId, t.status, t.expiresAt),
    index("approvals_tool_idx").on(t.toolCallId),
  ],
);

export const checkpoints = sqliteTable(
  "checkpoints",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    backend: text("backend", { enum: ["shadow-git", "nono-snapshot"] }).notNull(),
    ref: text("ref").notNull(), // shadow git sha 或 nono snapshot id
    label: text("label"),
    changedFiles: text("changed_files", { mode: "json" }).$type<string[]>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [index("checkpoints_workspace_session_idx").on(t.workspaceId, t.sessionId, t.createdAt)],
);

export const usage = sqliteTable(
  "usage",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsdMicros: integer("cost_usd_micros").notNull().default(0),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    index("usage_session_idx").on(t.sessionId),
    index("usage_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const secretsMetadata = sqliteTable(
  "secrets_metadata",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    userId: text("user_id").notNull().default("local-user"),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["provider-api-key", "mcp-oauth-token", "credential-proxy-handle"],
    }).notNull(),
    storageRef: text("storage_ref").notNull(), // 不存明文：env/keychain/KMS 引用
    scopes: text("scopes", { mode: "json" }).$type<string[]>(),
    last4: text("last4"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex("secrets_tenant_name_uq").on(t.tenantId, t.name),
    index("secrets_kind_idx").on(t.kind),
  ],
);

// 用户记忆（仿 ChatGPT Memory）：跨会话长期偏好/事实，启用项在每 turn 注入上下文前缀。
// 阶段一单租户单用户；enabled=false 为停用（保留不注入）。
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    content: text("content").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [index("memories_enabled_idx").on(t.enabled)],
);

// ── workflow_runs ────────────────────────────────────────────────────────────
// 一次 workflow 脚本执行；(scriptHash, argsHash) 唯一确定一个可 resume 的逻辑 run。
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(), // runId = randomUUID()
    tenantId: text("tenant_id").notNull().default("local"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    scriptHash: text("script_hash").notNull(), // resume 主键之一（脚本源指纹）
    argsHash: text("args_hash").notNull(), // resume 主键之二（入参指纹）
    args: text("args", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    // 镜像 M0 PersistedRunStatus = RunStatus("completed"|"failed"|"interrupted") + "running"。禁用 "cancelled"。
    status: text("status", {
      enum: ["running", "completed", "failed", "interrupted"],
    })
      .notNull()
      .default("running"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  },
  (t) => [
    index("workflow_runs_session_idx").on(t.sessionId),
    index("workflow_runs_resume_idx").on(t.scriptHash, t.argsHash),
  ],
);

// ── workflow_agents ──────────────────────────────────────────────────────────
// run 内每次原语调用（agent / parallel 单项 / pipeline 单项）的 journal 行。
// (seq, specHash) 是 spec §7 的 prefix-cache 键；seq 在 run 内单调唯一。
export const workflowAgents = sqliteTable(
  "workflow_agents",
  {
    id: text("id").primaryKey(), // randomUUID()
    tenantId: text("tenant_id").notNull().default("local"),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(), // run 内单调调用序（并行项按规格数组序取连续 seq）
    callKind: text("call_kind", {
      enum: ["agent", "parallel-item", "pipeline-item"], // 镜像 M0 CallKind
    }).notNull(),
    specHash: text("spec_hash").notNull(), // 该调用规格指纹（逐调用缓存命中键）
    // 镜像 M0 AgentStatus = "running"|"completed"|"failed"。
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    resultJson: text("result_json", { mode: "json" }).$type<unknown>(), // 结构化/文本结果，resume 重放载荷
    subTurnId: text("sub_turn_id").references(() => turns.id, { onDelete: "set null" }), // 子 agent turn（审计下钻 §8）
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("workflow_agents_run_seq_uq").on(t.runId, t.seq),
    index("workflow_agents_run_status_idx").on(t.runId, t.status),
  ],
);
