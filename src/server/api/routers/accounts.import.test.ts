import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import { TRPCError } from "@trpc/server";

type MockPersistence = Record<string, (...args: unknown[]) => unknown>;

type Caller = {
  previewImportTransactions: (input: unknown) => Promise<Record<string, unknown>>;
  importTransactions: (input: unknown) => Promise<Record<string, unknown>>;
};

function createTransaction(input: { id: string; provider?: "aib" | "revolut" }): Record<string, unknown> {
  return {
    id: input.id,
    provider: input.provider ?? "aib",
    bookingDate: "2026-01-01",
    amountCents: 1234,
    currency: "EUR",
    direction: "out",
    description: `transaction-${input.id}`,
    raw: {
      source: input.id,
    },
  };
}

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
  _load: (...args: unknown[]) => unknown;
};
const originalLoad = nodeModule._load;

let getAccountByIdImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  id: 1,
  provider: "aib",
});
let importTransactionsForAccountImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  totalCount: 0,
  insertedCount: 0,
  skippedCount: 0,
});
let previewImportTransactionsForAccountImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  totalCount: 0,
  insertedCount: 0,
  skippedCount: 0,
});

const persistenceMock: MockPersistence = {
  createTransactionForAccount: async () => {
    throw new Error("Not implemented in this test");
  },
  createAccount: async () => {
    throw new Error("Not implemented in this test");
  },
  createCategory: async () => {
    throw new Error("Not implemented in this test");
  },
  createTag: async () => {
    throw new Error("Not implemented in this test");
  },
  createTransactionRule: async () => {
    throw new Error("Not implemented in this test");
  },
  deleteCategory: async () => false,
  deleteAccountById: async () => false,
  deleteTransactionRule: async () => false,
  deleteTransactionForAccount: async () => false,
  getDashboardSummaryView: async () => ({
    monthOptions: [],
    accountCount: 0,
    importedTransactionCount: 0,
    rows: [],
  }),
  getDashboardTransactionsView: async () => ({
    monthOptions: [],
    importedTransactionCount: 0,
    transactions: [],
  }),
  getAccountById: (...args) => getAccountByIdImpl(...args),
  importTransactionsForAccount: (...args) => importTransactionsForAccountImpl(...args),
  previewImportTransactionsForAccount: (...args) => previewImportTransactionsForAccountImpl(...args),
  isUniqueConstraintError: () => false,
  listAccounts: async () => [],
  listCategories: async () => [],
  listTags: async () => [],
  listTransactionRules: async () => [],
  reapplyTransactionRulesForAllTransactions: async () => ({ totalCount: 0, updatedCount: 0 }),
  updateCategory: async () => null,
  updateTag: async () => null,
  updateTransactionRule: async () => null,
  updateTransactionForAccount: async () => null,
  deleteTag: async () => false,
};

nodeModule._load = function patchedLoad(...args: unknown[]): unknown {
  const [request] = args;
  if (typeof request === "string" && request.includes("/lib/finance/persistence")) {
    return persistenceMock;
  }

  return originalLoad.apply(this, args);
};

const accountsModule = require("@/server/api/routers/accounts") as {
  accountsRouter: {
    createCaller: (ctx: Record<string, never>) => Caller;
  };
};

nodeModule._load = originalLoad;

const caller = accountsModule.accountsRouter.createCaller({});

let importCalls: Array<{
  accountId: number;
  forceImportIndexes?: number[];
}> = [];

let previewCalls = 0;

beforeEach(() => {
  importCalls = [];
  previewCalls = 0;

  getAccountByIdImpl = async () => ({
    id: 1,
    provider: "aib",
  });

  importTransactionsForAccountImpl = async (
    accountId: unknown,
    transactions: unknown,
    options: unknown
  ) => {
    const normalizedOptions =
      options && typeof options === "object" ? (options as { forceImportIndexes?: number[] }) : undefined;

    importCalls.push({
      accountId: accountId as number,
      forceImportIndexes: normalizedOptions?.forceImportIndexes,
    });

    const count = Array.isArray(transactions) ? transactions.length : 0;

    return {
      totalCount: count,
      insertedCount: count,
      skippedCount: 0,
      duplicateCount: 7,
    };
  };

  previewImportTransactionsForAccountImpl = async () => {
    previewCalls += 1;
    return {
      totalCount: 1,
      insertedCount: 1,
      skippedCount: 0,
      duplicateCount: 0,
    };
  };
});

test("previewImportTransactions rejects provider mismatch", async () => {
  await assert.rejects(
    () =>
      caller.previewImportTransactions({
        accountId: 1,
        transactions: [createTransaction({ id: "tx-1", provider: "revolut" })],
      }),
    (error: unknown) => {
      return (
        error instanceof TRPCError &&
        error.code === "BAD_REQUEST" &&
        error.message.includes("provider")
      );
    }
  );

  assert.equal(previewCalls, 0);
});

test("importTransactions rejects invalid forceImportIndexes", async () => {
  await assert.rejects(
    () =>
      caller.importTransactions({
        accountId: 1,
        transactions: [createTransaction({ id: "tx-1" })],
        forceImportIndexes: [1],
      }),
    (error: unknown) => {
      return (
        error instanceof TRPCError &&
        error.code === "BAD_REQUEST" &&
        error.message.includes("forceImportIndexes")
      );
    }
  );

  assert.equal(importCalls.length, 0);
});

test("importTransactions passes valid forceImportIndexes to persistence", async () => {
  await caller.importTransactions({
    accountId: 1,
    transactions: [createTransaction({ id: "tx-1" }), createTransaction({ id: "tx-2" })],
    forceImportIndexes: [1],
  });

  assert.equal(importCalls.length, 1);
  assert.equal(importCalls[0]?.accountId, 1);
  assert.deepEqual(importCalls[0]?.forceImportIndexes, [1]);
});

test("importTransactions keeps legacy fields and returns extended fields", async () => {
  const result = await caller.importTransactions({
    accountId: 1,
    transactions: [createTransaction({ id: "tx-1" }), createTransaction({ id: "tx-2" })],
    forceImportIndexes: [0],
  });

  assert.equal(result.accountId, 1);
  assert.equal(result.totalCount, 2);
  assert.equal(result.insertedCount, 2);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.duplicateCount, 7);
});
