CREATE TABLE `transaction_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`description_contains` text,
	`description_regex` text,
	`amount_min_cents` integer,
	`amount_max_cents` integer,
	`amount_exact_cents` integer,
	`account_ids_json` text,
	`apply_category` text,
	`assign_counterparty_from_regex_group` integer DEFAULT false NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_transaction_rules_priority` ON `transaction_rules` (`priority`,`id`);