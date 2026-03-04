import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { StatementProvider, TransactionDirection } from "../../parsers/types";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  provider: text("provider", { enum: ["aib", "revolut"] }).$type<StatementProvider>().notNull(),
  currency: text("currency"),
  color: text("color").notNull(),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => ({
    nameUnique: uniqueIndex("idx_categories_name_unique").on(table.name),
  })
);

export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => ({
    nameUnique: uniqueIndex("idx_tags_name_unique").on(table.name),
  })
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    provider: text("provider", { enum: ["aib", "revolut"] }).$type<StatementProvider>().notNull(),
    bookingDate: text("booking_date").notNull(),
    deemedDate: text("deemed_date"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    direction: text("direction", { enum: ["in", "out"] }).$type<TransactionDirection>().notNull(),
    description: text("description").notNull(),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    counterparty: text("counterparty"),
    reference: text("reference"),
    rawJson: text("raw_json").notNull(),
    importedAt: text("imported_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => ({
    accountBookingDateIdx: index("idx_transactions_account_booking_date").on(
      table.accountId,
      table.bookingDate
    ),
    accountSourceUnique: uniqueIndex("idx_transactions_account_source_unique").on(
      table.accountId,
      table.sourceId
    ),
  })
);

export const transactionTags = sqliteTable(
  "transaction_tags",
  {
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.transactionId, table.tagId],
      name: "transaction_tags_pk",
    }),
    tagIdIdx: index("idx_transaction_tags_tag_id").on(table.tagId),
  })
);

export const transactionRules = sqliteTable(
  "transaction_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    descriptionContains: text("description_contains"),
    descriptionRegex: text("description_regex"),
    amountMinCents: integer("amount_min_cents"),
    amountMaxCents: integer("amount_max_cents"),
    amountExactCents: integer("amount_exact_cents"),
    accountIdsJson: text("account_ids_json"),
    applyCategoryId: integer("apply_category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    assignCounterpartyFromRegexGroup: integer("assign_counterparty_from_regex_group", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    priority: integer("priority").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => ({
    priorityIdx: index("idx_transaction_rules_priority").on(table.priority, table.id),
  })
);

export const transactionRuleTags = sqliteTable(
  "transaction_rule_tags",
  {
    transactionRuleId: integer("transaction_rule_id")
      .notNull()
      .references(() => transactionRules.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.transactionRuleId, table.tagId],
      name: "transaction_rule_tags_pk",
    }),
    tagIdIdx: index("idx_transaction_rule_tags_tag_id").on(table.tagId),
  })
);

export type AccountRow = typeof accounts.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type TransactionTagRow = typeof transactionTags.$inferSelect;
export type TransactionRuleRow = typeof transactionRules.$inferSelect;
export type TransactionRuleTagRow = typeof transactionRuleTags.$inferSelect;
