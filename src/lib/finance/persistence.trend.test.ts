import { mkdtempSync, rmSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { after, before, beforeEach, test } from "node:test";
import { sql } from "drizzle-orm";

type PersistenceModule = typeof import("@/lib/finance/persistence");
type TursoModule = typeof import("@/lib/server/turso");
type SchemaModule = typeof import("@/lib/server/db/schema");

const testDbDirectory = mkdtempSync(path.join(tmpdir(), "financial-planner-trend-"));
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

let getCategorySpendingTrend: PersistenceModule["getCategorySpendingTrend"];
let getFinanceDb: TursoModule["getFinanceDb"];
let resetFinanceSchemaForLocal: TursoModule["resetFinanceSchemaForLocal"];
let accounts: SchemaModule["accounts"];
let categories: SchemaModule["categories"];
let transactionsTable: SchemaModule["transactions"];

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
}

async function insertTestAccount(name = "Primary Account"): Promise<number> {
  const db = getFinanceDb();
  const inserted = await db
    .insert(accounts)
    .values({
      name,
      kind: "bank",
      provider: "aib",
      currency: "EUR",
      color: "#0f766e",
    })
    .returning({
      id: accounts.id,
    });

  const accountId = inserted[0]?.id;
  if (typeof accountId !== "number") {
    throw new Error("Failed to create test account.");
  }
  return accountId;
}

async function insertTestCategory(name: string): Promise<number> {
  const db = getFinanceDb();
  const inserted = await db
    .insert(categories)
    .values({
      name,
    })
    .returning({
      id: categories.id,
    });

  const categoryId = inserted[0]?.id;
  if (typeof categoryId !== "number") {
    throw new Error("Failed to create test category.");
  }
  return categoryId;
}

async function insertTestTransaction(input: {
  accountId: number;
  sourceId: string;
  bookingDate: string;
  deemedDate?: string;
  amountCents: number;
  categoryId?: number;
  direction?: "in" | "out";
}): Promise<void> {
  const db = getFinanceDb();
  await db.insert(transactionsTable).values({
    accountId: input.accountId,
    sourceId: input.sourceId,
    provider: "aib",
    bookingDate: input.bookingDate,
    deemedDate: input.deemedDate ?? null,
    amountCents: input.amountCents,
    currency: "EUR",
    direction: input.direction ?? "out",
    description: `transaction-${input.sourceId}`,
    categoryId: input.categoryId ?? null,
    counterparty: null,
    reference: null,
    rawJson: "{}",
  });
}

before(async () => {
  const persistence = await import("@/lib/finance/persistence");
  const turso = await import("@/lib/server/turso");
  const schema = await import("@/lib/server/db/schema");

  getCategorySpendingTrend = persistence.getCategorySpendingTrend;
  getFinanceDb = turso.getFinanceDb;
  resetFinanceSchemaForLocal = turso.resetFinanceSchemaForLocal;
  accounts = schema.accounts;
  categories = schema.categories;
  transactionsTable = schema.transactions;
});

beforeEach(async () => {
  await resetFinanceSchemaForLocal();
  await createFinanceSchemaForTests();
});

after(() => {
  moduleLoader._load = originalModuleLoad;
  rmSync(testDbDirectory, { recursive: true, force: true });
});

test("deemedDate overrides bookingDate for day bucket assignment", async () => {
  const accountId = await insertTestAccount();
  const groceriesId = await insertTestCategory("Groceries");

  await insertTestTransaction({
    accountId,
    sourceId: "deemed-day-1",
    bookingDate: "2026-01-01",
    deemedDate: "2026-01-03",
    amountCents: 1234,
    categoryId: groceriesId,
  });

  const trend = await getCategorySpendingTrend({
    frequency: "day",
    startDate: "2026-01-01",
    endDate: "2026-01-03",
  });

  assert.deepEqual(trend.periods, ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.equal(trend.series.length, 1);
  assert.equal(trend.series[0]?.categoryName, "Groceries");
  assert.deepEqual(
    trend.series[0]?.points,
    [
      { period: "2026-01-01", spentCents: 0 },
      { period: "2026-01-02", spentCents: 0 },
      { period: "2026-01-03", spentCents: 1234 },
    ]
  );
});

test("week bucketing uses Monday keys and zero-fills missing buckets", async () => {
  const accountId = await insertTestAccount();
  const transportId = await insertTestCategory("Transport");

  await insertTestTransaction({
    accountId,
    sourceId: "week-1",
    bookingDate: "2026-01-01",
    amountCents: 500,
    categoryId: transportId,
  });
  await insertTestTransaction({
    accountId,
    sourceId: "week-2",
    bookingDate: "2026-01-08",
    amountCents: 700,
    categoryId: transportId,
  });

  const trend = await getCategorySpendingTrend({
    frequency: "week",
    startDate: "2026-01-01",
    endDate: "2026-01-12",
  });

  assert.deepEqual(trend.periods, ["2025-12-29", "2026-01-05", "2026-01-12"]);
  assert.equal(trend.series.length, 1);
  assert.equal(trend.series[0]?.categoryName, "Transport");
  assert.deepEqual(
    trend.series[0]?.points,
    [
      { period: "2025-12-29", spentCents: 500 },
      { period: "2026-01-05", spentCents: 700 },
      { period: "2026-01-12", spentCents: 0 },
    ]
  );
});

test("month bucketing is correct across month boundaries", async () => {
  const accountId = await insertTestAccount();
  const rentId = await insertTestCategory("Rent");

  await insertTestTransaction({
    accountId,
    sourceId: "month-1",
    bookingDate: "2026-01-10",
    amountCents: 150000,
    categoryId: rentId,
  });
  await insertTestTransaction({
    accountId,
    sourceId: "month-2",
    bookingDate: "2026-03-05",
    amountCents: 150500,
    categoryId: rentId,
  });

  const trend = await getCategorySpendingTrend({
    frequency: "month",
    startDate: "2026-01-01",
    endDate: "2026-03-31",
  });

  assert.deepEqual(trend.periods, ["2026-01", "2026-02", "2026-03"]);
  assert.equal(trend.series.length, 1);
  assert.equal(trend.series[0]?.categoryName, "Rent");
  assert.deepEqual(
    trend.series[0]?.points,
    [
      { period: "2026-01", spentCents: 150000 },
      { period: "2026-02", spentCents: 0 },
      { period: "2026-03", spentCents: 150500 },
    ]
  );
});

test("excluded categories are filtered and uncategorized is retained", async () => {
  const accountId = await insertTestAccount();
  const excludedLowerId = await insertTestCategory("excluded");
  const excludedTrimmedId = await insertTestCategory("  ExCLuDeD  ");
  const diningId = await insertTestCategory("Dining");

  await insertTestTransaction({
    accountId,
    sourceId: "excluded-1",
    bookingDate: "2026-02-10",
    amountCents: 100,
    categoryId: excludedLowerId,
  });
  await insertTestTransaction({
    accountId,
    sourceId: "excluded-2",
    bookingDate: "2026-02-10",
    amountCents: 200,
    categoryId: excludedTrimmedId,
  });
  await insertTestTransaction({
    accountId,
    sourceId: "dining-out",
    bookingDate: "2026-02-10",
    amountCents: 300,
    categoryId: diningId,
  });
  await insertTestTransaction({
    accountId,
    sourceId: "uncategorized-out",
    bookingDate: "2026-02-10",
    amountCents: 400,
  });
  await insertTestTransaction({
    accountId,
    sourceId: "dining-in",
    bookingDate: "2026-02-10",
    amountCents: 999,
    categoryId: diningId,
    direction: "in",
  });

  const trend = await getCategorySpendingTrend({
    frequency: "day",
    startDate: "2026-02-10",
    endDate: "2026-02-10",
  });

  assert.deepEqual(trend.periods, ["2026-02-10"]);
  assert.deepEqual(
    trend.series.map((item) => ({
      categoryName: item.categoryName,
      points: item.points,
    })),
    [
      {
        categoryName: "Dining",
        points: [{ period: "2026-02-10", spentCents: 300 }],
      },
      {
        categoryName: "Uncategorized",
        points: [{ period: "2026-02-10", spentCents: 400 }],
      },
    ]
  );
});

test("invalid date ranges throw", async () => {
  await assert.rejects(
    () =>
      getCategorySpendingTrend({
        frequency: "day",
        startDate: "2026-03-05",
        endDate: "2026-03-01",
      }),
    /startDate must be less than or equal to endDate\./
  );
});
