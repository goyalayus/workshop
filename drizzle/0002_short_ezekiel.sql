CREATE TABLE `auto_debug_failure_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`first_seen_run_id` text,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auto_debug_failure_cases_updated` ON `auto_debug_failure_cases` ("updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_auto_debug_failure_cases_status` ON `auto_debug_failure_cases` (`status`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `auto_debug_failure_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_run_id` text NOT NULL,
	`failure_case_id` text NOT NULL,
	`trace_run_id` text NOT NULL,
	`span_id` text,
	`trace_part_index` integer DEFAULT 0 NOT NULL,
	`summary` text NOT NULL,
	`evidence` text,
	`difference` text,
	`raw_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `auto_debug_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`failure_case_id`) REFERENCES `auto_debug_failure_cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_auto_debug_occurrences_case` ON `auto_debug_failure_occurrences` (`failure_case_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_auto_debug_occurrences_run` ON `auto_debug_failure_occurrences` (`analysis_run_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_auto_debug_occurrences_trace` ON `auto_debug_failure_occurrences` (`trace_run_id`);--> statement-breakpoint
CREATE TABLE `auto_debug_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`run_ids` text NOT NULL,
	`architecture_context` text,
	`summary` text,
	`error` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auto_debug_runs_status` ON `auto_debug_runs` (`status`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_auto_debug_runs_updated` ON `auto_debug_runs` ("updated_at" desc);