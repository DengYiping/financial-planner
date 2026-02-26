import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    direction: text("direction", { enum: ["in", "out"] }).$type<TransactionDirection>().notNull(),
    description: text("description").notNull(),
    categoryHint: text("category_hint"),
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

export type AccountRow = typeof accounts.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
