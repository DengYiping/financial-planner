import { mkdtempSync, rmSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { after, before, beforeEach, test } from "node:test";
import { sql } from "drizzle-orm";
import type { NormalizedTransaction } from "@/lib/parsers/types";

type PersistenceModule = typeof import("@/lib/finance/persistence");
type TursoModule = typeof import("@/lib/server/turso");

const testDbDirectory = mkdtempSync(path.join(tmpdir(), "financial-planner-import-"));
const testDbPath = path.join(testDbDirectory, "finance.db");

const moduleLoader = Module as unknown as {
  _load: (...args: unknown[]) => unknown;
};
const originalModuleLoad = moduleLoader._load;
moduleLoader._load = (...args: unknown[]) => {
  if (args[0] === "server-only") {
    return {};
  }

  return originalModuleLoad(...args);
};

process.env.TURSO_DATABASE_URL = `file:${testDbPath}`;
delete process.env.DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.DATABASE_AUTH_TOKEN;

let createAccount: PersistenceModule["createAccount"];
let getAccountById: PersistenceModule["getAccountById"];
let importTransactionsForAccount: PersistenceModule["importTransactionsForAccount"];
let previewImportTransactionsForAccount: PersistenceModule["previewImportTransactionsForAccount"];
let getFinanceDb: TursoModule["getFinanceDb"];
let resetFinanceSchemaForLocal: TursoModule["resetFinanceSchemaForLocal"];

async function createFinanceSchemaForTests(): Promise<void> {
  const db = getFinanceDb();
  await db.run(sql`PRAGMA foreign_keys = ON`);
  await db.run(
    sql.raw(
      "CREATE TABLE accounts (" +
        "id integer PRIMARY KEY AUTOINCREMENT NOT NULL," +
        "name text NOT NULL," +
        "kind text NOT NULL," +
        "provider text NOT NULL," +
        "currency text," +
        "color text NOT NULL," +
        "created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL" +
        ")"
    )
  );
  await db.run(
    sql.raw(
      "CREATE TABLE categories (" +
        "id integer PRIMARY KEY AUTOINCREMENT NOT NULL," +
        "name text NOT NULL," +
        "created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL," +
        "updated_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL" +
        ")"
    )
  );
  await db.run(sql.raw("CREATE UNIQUE INDEX idx_categories_name_unique ON categories (name)"));
  await db.run(
    sql.raw(
      "CREATE TABLE tags (" +
        "id integer PRIMARY KEY AUTOINCREMENT NOT NULL," +
        "name text NOT NULL," +
        "created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL," +
        "updated_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL" +
        ")"
    )
  );
  await db.run(sql.raw("CREATE UNIQUE INDEX idx_tags_name_unique ON tags (name)"));
  await db.run(
    sql.raw(
      "CREATE TABLE transaction_rules (" +
        "id integer PRIMARY KEY AUTOINCREMENT NOT NULL," +
        "description_contains text," +
        "description_regex text," +
        "amount_min_cents integer," +
        "amount_max_cents integer," +
        "amount_exact_cents integer," +
        "account_ids_json text," +
        "apply_category_id integer REFERENCES categories(id) ON DELETE set null," +
        "assign_counterparty_from_regex_group integer DEFAULT false NOT NULL," +
        "priority integer DEFAULT 0 NOT NULL," +
        "created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL," +
        "updated_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL" +
        ")"
    )
  );
  await db.run(sql.raw("CREATE INDEX idx_transaction_rules_priority ON transaction_rules (priority,id)"));
  await db.run(
    sql.raw(
      "CREATE TABLE transactions (" +
        "id integer PRIMARY KEY AUTOINCREMENT NOT NULL," +
        "account_id integer NOT NULL REFERENCES accounts(id) ON DELETE cascade," +
        "source_id text NOT NULL," +
        "provider text NOT NULL," +
        "booking_date text NOT NULL," +
        "deemed_date text," +
        "amount_cents integer NOT NULL," +
        "currency text NOT NULL," +
        "direction text NOT NULL," +
        "description text NOT NULL," +
        "category_id integer REFERENCES categories(id) ON DELETE set null," +
        "counterparty text," +
        "reference text," +
        "raw_json text NOT NULL," +
        "imported_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL" +
        ")"
    )
  );
  await db.run(sql.raw("CREATE INDEX idx_transactions_account_booking_date ON transactions (account_id,booking_date)"));
  await db.run(
    sql.raw("CREATE UNIQUE INDEX idx_transactions_account_source_unique ON transactions (account_id,source_id)")
  );
  await db.run(
    sql.raw(
      "CREATE TABLE transaction_rule_tags (" +
        "transaction_rule_id integer NOT NULL REFERENCES transaction_rules(id) ON DELETE cascade," +
        "tag_id integer NOT NULL REFERENCES tags(id) ON DELETE cascade," +
        "created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL," +
        "PRIMARY KEY(transaction_rule_id, tag_id)" +
        ")"
    )
  );
  await db.run(sql.raw("CREATE INDEX idx_transaction_rule_tags_tag_id ON transaction_rule_tags (tag_id)"));
  await db.run(
    sql.raw(
      "CREATE TABLE transaction_tags (" +
        "transaction_id integer NOT NULL REFERENCES transactions(id) ON DELETE cascade," +
        "tag_id integer NOT NULL REFERENCES tags(id) ON DELETE cascade," +
        "created_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL," +
        "PRIMARY KEY(transaction_id, tag_id)" +
        ")"
    )
  );
  await db.run(sql.raw("CREATE INDEX idx_transaction_tags_tag_id ON transaction_tags (tag_id)"));
}

function createTransaction(
  id: string,
  bookingDate: string,
  amountCents: number,
  description: string,
  overrides: Partial<NormalizedTransaction> = {}
): NormalizedTransaction {
  return {
    id,
    provider: "aib",
    bookingDate,
    amountCents,
    currency: "EUR",
    direction: "out",
    description,
    raw: {},
    ...overrides,
  };
}

async function createTestAccountId(): Promise<number> {
  const account = await createAccount({
    name: "Primary account",
    kind: "bank",
    provider: "aib",
    currency: "EUR",
    color: "#0f766e",
  });
  return account.id;
}

before(async () => {
  const persistence = await import("@/lib/finance/persistence");
  const turso = await import("@/lib/server/turso");

  createAccount = persistence.createAccount;
  getAccountById = persistence.getAccountById;
  importTransactionsForAccount = persistence.importTransactionsForAccount;
  previewImportTransactionsForAccount = persistence.previewImportTransactionsForAccount;
  getFinanceDb = turso.getFinanceDb;
  resetFinanceSchemaForLocal = turso.resetFinanceSchemaForLocal;
});

beforeEach(async () => {
  await resetFinanceSchemaForLocal();
  await createFinanceSchemaForTests();
});

after(() => {
  moduleLoader._load = originalModuleLoad;
  rmSync(testDbDirectory, { recursive: true, force: true });
});

test("preview and default import only skip rows already existing in account", async () => {
  const accountId = await createTestAccountId();

  const seedImport = await importTransactionsForAccount(accountId, [
    createTransaction("seed-1", "2026-02-01", 1000, "Coffee Shop"),
  ]);
  assert.equal(seedImport.insertedCount, 1);

  const incoming = [
    createTransaction("new-existing-match", "2026-02-01", 1000, " coffee   shop "),
    createTransaction("new-incoming-first", "2026-02-02", 2200, "Taxi Ride"),
    createTransaction("new-incoming-second", "2026-02-02", 2200, " taxi   ride "),
    createTransaction("new-unique", "2026-02-03", 5000, "Salary"),
  ];

  const preview = await previewImportTransactionsForAccount(accountId, incoming);
  assert.equal(preview.totalCount, 4);
  assert.equal(preview.duplicateConflictCount, 1);
  assert.equal(preview.duplicateSkippedCount, 1);
  assert.equal(preview.forcedImportCount, 0);
  assert.equal(preview.autoCancelled, false);
  assert.equal(preview.coverage.fullyCovered, false);

  const imported = await importTransactionsForAccount(accountId, incoming);
  assert.equal(imported.totalCount, 4);
  assert.equal(imported.insertedCount, 3);
  assert.equal(imported.skippedCount, 1);
  assert.equal(imported.duplicateConflictCount, 1);
  assert.equal(imported.duplicateSkippedCount, 1);
  assert.equal(imported.forcedImportCount, 0);
  assert.equal(imported.autoCancelled, false);

  const account = await getAccountById(accountId);
  assert.ok(account);
  const importedIds = new Set(account.transactions.map((transaction) => transaction.id));
  assert.ok(importedIds.has("seed-1"));
  assert.ok(importedIds.has("new-incoming-first"));
  assert.ok(importedIds.has("new-incoming-second"));
  assert.ok(importedIds.has("new-unique"));
  assert.equal(importedIds.has("new-existing-match"), false);
  assert.equal(account.transactions.length, 4);
});

test("incoming-only duplicates are imported without opening review conflicts", async () => {
  const accountId = await createTestAccountId();
  const incoming = [
    createTransaction("incoming-dup-1", "2026-03-15", 3200, "Utility Payment"),
    createTransaction("incoming-dup-2", "2026-03-15", 3200, " utility   payment "),
  ];

  const preview = await previewImportTransactionsForAccount(accountId, incoming);
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.duplicateConflictCount, 0);
  assert.equal(preview.duplicateSkippedCount, 0);
  assert.equal(preview.autoCancelled, false);

  const imported = await importTransactionsForAccount(accountId, incoming);
  assert.equal(imported.insertedCount, 2);
  assert.equal(imported.skippedCount, 0);
  assert.equal(imported.duplicateConflictCount, 0);
  assert.equal(imported.duplicateSkippedCount, 0);
  assert.equal(imported.forcedImportCount, 0);

  const account = await getAccountById(accountId);
  assert.ok(account);
  const importedIds = new Set(account.transactions.map((transaction) => transaction.id));
  assert.equal(account.transactions.length, 2);
  assert.ok(importedIds.has("incoming-dup-1"));
  assert.ok(importedIds.has("incoming-dup-2"));
});

test("duplicate transaction is flagged in preview and can be reviewed via force import", async () => {
  const accountId = await createTestAccountId();

  await importTransactionsForAccount(accountId, [
    createTransaction("seed-dup", "2026-02-21", 1599, "Spotify Subscription", {
      reference: "INV-2026-02",
      counterparty: "Spotify",
    }),
  ]);

  const incoming = [
    createTransaction("incoming-dup", "2026-02-21", 1599, "  spotify   subscription ", {
      reference: "INV-2026-02",
      counterparty: "Spotify",
    }),
  ];

  const preview = await previewImportTransactionsForAccount(accountId, incoming);
  assert.equal(preview.duplicateConflictCount, 1);
  assert.equal(preview.conflicts.length, 1);

  const [conflict] = preview.conflicts;
  assert.equal(conflict?.incomingIndex, 0);
  assert.equal(conflict?.reason, "existing_match");
  assert.equal(conflict?.action, "skip");
  assert.equal(conflict?.existingTransaction?.id, "seed-dup");
  assert.equal(conflict?.existingTransaction?.description, "Spotify Subscription");

  const reviewedImport = await importTransactionsForAccount(accountId, incoming, {
    forceImportIndexes: [0],
  });
  assert.equal(reviewedImport.insertedCount, 1);
  assert.equal(reviewedImport.duplicateSkippedCount, 0);
  assert.equal(reviewedImport.forcedImportCount, 1);
  assert.equal(reviewedImport.autoCancelled, false);

  const account = await getAccountById(accountId);
  assert.ok(account);
  assert.equal(account.transactions.length, 2);
});

test("second import of same dataset is auto-cancelled because coverage is complete", async () => {
  const accountId = await createTestAccountId();
  const incoming = [
    createTransaction("idempotent-1", "2026-02-10", 3300, "Groceries"),
    createTransaction("idempotent-2", "2026-02-11", 7700, "Insurance"),
  ];

  const firstImport = await importTransactionsForAccount(accountId, incoming);
  assert.equal(firstImport.insertedCount, 2);
  assert.equal(firstImport.autoCancelled, false);

  const secondPreview = await previewImportTransactionsForAccount(accountId, incoming);
  assert.equal(secondPreview.coverage.fullyCovered, true);
  assert.equal(secondPreview.autoCancelled, true);
  assert.equal(secondPreview.cancelReason, "all_unique_keys_already_exist");

  const secondImport = await importTransactionsForAccount(accountId, incoming);
  assert.equal(secondImport.insertedCount, 0);
  assert.equal(secondImport.skippedCount, 2);
  assert.equal(secondImport.autoCancelled, true);
  assert.equal(secondImport.cancelReason, "all_unique_keys_already_exist");
  assert.equal(secondImport.coverage.fullyCovered, true);
  assert.equal(secondImport.duplicateConflictCount, 2);
  assert.equal(secondImport.duplicateSkippedCount, 2);

  const account = await getAccountById(accountId);
  assert.ok(account);
  assert.equal(account.transactions.length, 2);
});

test("force import overrides default skip and appends deterministic sourceId suffix on collision", async () => {
  const accountId = await createTestAccountId();

  await importTransactionsForAccount(accountId, [
    createTransaction("src-collision", "2026-03-01", 777, "Membership"),
    createTransaction("src-collision__dup__0__0", "2026-03-10", 123, "Reserved Suffix"),
  ]);

  const incoming = [createTransaction("src-collision", "2026-03-01", 777, " membership ")];

  const imported = await importTransactionsForAccount(accountId, incoming, {
    forceImportIndexes: [0],
  });
  assert.equal(imported.totalCount, 1);
  assert.equal(imported.insertedCount, 1);
  assert.equal(imported.skippedCount, 0);
  assert.equal(imported.duplicateConflictCount, 1);
  assert.equal(imported.duplicateSkippedCount, 0);
  assert.equal(imported.forcedImportCount, 1);
  assert.equal(imported.autoCancelled, false);

  const account = await getAccountById(accountId);
  assert.ok(account);
  const importedIds = new Set(account.transactions.map((transaction) => transaction.id));
  assert.ok(importedIds.has("src-collision"));
  assert.ok(importedIds.has("src-collision__dup__0__0"));
  assert.ok(importedIds.has("src-collision__dup__0__1"));
});
