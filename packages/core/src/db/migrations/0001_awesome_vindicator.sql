CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'local' NOT NULL,
	`content` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memories_enabled_idx` ON `memories` (`enabled`);