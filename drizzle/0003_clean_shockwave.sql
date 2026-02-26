CREATE TABLE IF NOT EXISTS `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_categories_name_unique` ON `categories` (`name`);
--> statement-breakpoint
ALTER TABLE `transaction_rules` ADD `apply_category_id` integer REFERENCES categories(id);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `category_id` integer REFERENCES categories(id);
--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`name`)
SELECT DISTINCT `category_name`
FROM (
	SELECT trim(`category_hint`) AS `category_name`
	FROM `transactions`
	WHERE `category_hint` IS NOT NULL AND trim(`category_hint`) <> ''
	UNION
	SELECT trim(`apply_category`) AS `category_name`
	FROM `transaction_rules`
	WHERE `apply_category` IS NOT NULL AND trim(`apply_category`) <> ''
) AS `names`;
--> statement-breakpoint
UPDATE `transactions`
SET `category_id` = (
	SELECT `categories`.`id`
	FROM `categories`
	WHERE `categories`.`name` = trim(`transactions`.`category_hint`)
)
WHERE `category_hint` IS NOT NULL AND trim(`category_hint`) <> '';
--> statement-breakpoint
UPDATE `transaction_rules`
SET `apply_category_id` = (
	SELECT `categories`.`id`
	FROM `categories`
	WHERE `categories`.`name` = trim(`transaction_rules`.`apply_category`)
)
WHERE `apply_category` IS NOT NULL AND trim(`apply_category`) <> '';
--> statement-breakpoint
ALTER TABLE `transaction_rules` DROP COLUMN `apply_category`;
--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `category_hint`;
