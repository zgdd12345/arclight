CREATE TABLE `workflow_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`call_kind` text NOT NULL,
	`spec_hash` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`result_json` text,
	`sub_turn_id` text,
	`error` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sub_turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_agents_run_seq_uq` ON `workflow_agents` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `workflow_agents_run_status_idx` ON `workflow_agents` (`run_id`,`status`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`script_hash` text NOT NULL,
	`args_hash` text NOT NULL,
	`args` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_session_idx` ON `workflow_runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_resume_idx` ON `workflow_runs` (`script_hash`,`args_hash`);