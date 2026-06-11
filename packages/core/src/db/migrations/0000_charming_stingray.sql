CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`tool_call_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`risk` text NOT NULL,
	`cls` text NOT NULL,
	`action` text NOT NULL,
	`detail` text NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`decision_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `approvals_pending_idx` ON `approvals` (`session_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `approvals_tool_idx` ON `approvals` (`tool_call_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`tool_call_id` text,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`mime` text,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`preview` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `artifacts_session_kind_idx` ON `artifacts` (`session_id`,`kind`);--> statement-breakpoint
CREATE INDEX `artifacts_tool_idx` ON `artifacts` (`tool_call_id`);--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`backend` text NOT NULL,
	`ref` text NOT NULL,
	`label` text,
	`changed_files` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `checkpoints_workspace_session_idx` ON `checkpoints` (`workspace_id`,`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`seq` integer NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`type` text NOT NULL,
	`event` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_session_seq_uq` ON `events` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_session_created_idx` ON `events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_replay_idx` ON `events` (`session_id`,`seq`,`epoch`);--> statement-breakpoint
CREATE INDEX `events_tenant_idx` ON `events` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`parts` text,
	`epoch` integer DEFAULT 0 NOT NULL,
	`seq_start` integer,
	`seq_end` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_session_created_idx` ON `messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_session_epoch_idx` ON `messages` (`session_id`,`epoch`);--> statement-breakpoint
CREATE TABLE `secrets_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`user_id` text DEFAULT 'local-user' NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`storage_ref` text NOT NULL,
	`scopes` text,
	`last4` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_tenant_name_uq` ON `secrets_metadata` (`tenant_id`,`name`);--> statement-breakpoint
CREATE INDEX `secrets_kind_idx` ON `secrets_metadata` (`kind`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`user_id` text DEFAULT 'local-user' NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`summary` text,
	`context_snapshot` text,
	`last_response_id` text,
	`last_event_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_tenant_workspace_idx` ON `sessions` (`tenant_id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `sessions_tenant_epoch_idx` ON `sessions` (`tenant_id`,`id`,`epoch`);--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`args` text NOT NULL,
	`args_preview` text NOT NULL,
	`result_preview` text,
	`error` text,
	`approval_id` text,
	`artifact_id` text,
	`sandbox_run_id` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tool_calls_session_turn_idx` ON `tool_calls` (`session_id`,`turn_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_status_idx` ON `tool_calls` (`status`);--> statement-breakpoint
CREATE INDEX `tool_calls_name_idx` ON `tool_calls` (`name`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`command_id` text NOT NULL,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_session_command_uq` ON `turns` (`session_id`,`command_id`);--> statement-breakpoint
CREATE INDEX `turns_session_created_idx` ON `turns` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `turns_status_idx` ON `turns` (`status`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`session_id` text,
	`turn_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd_micros` integer DEFAULT 0 NOT NULL,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_session_idx` ON `usage` (`session_id`);--> statement-breakpoint
CREATE INDEX `usage_tenant_created_idx` ON `usage` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`user_id` text DEFAULT 'local-user' NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`arclight_dir` text NOT NULL,
	`current_session_id` text,
	`default_branch` text,
	`head_sha` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_tenant_repo_uq` ON `workspaces` (`tenant_id`,`repo_path`);--> statement-breakpoint
CREATE INDEX `workspaces_tenant_idx` ON `workspaces` (`tenant_id`);