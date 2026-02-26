CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`currency` text,
	`color` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`source_id` text NOT NULL,
	`provider` text NOT NULL,
	`booking_date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`direction` text NOT NULL,
	`description` text NOT NULL,
	`category_hint` text,
	`counterparty` text,
	`reference` text,
	`raw_json` text NOT NULL,
	`imported_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_transactions_account_booking_date` ON `transactions` (`account_id`,`booking_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transactions_account_source_unique` ON `transactions` (`account_id`,`source_id`);