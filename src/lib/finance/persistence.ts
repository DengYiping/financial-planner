import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { NormalizedTransaction, StatementProvider } from "@/lib/parsers/types";
import { accounts, transactions as transactionsTable } from "@/lib/server/db/schema";
import { ensureFinanceSchema, getFinanceDb } from "@/lib/server/turso";

type AccountSummaryRecord = {
  id: number;
  name: string;
  kind: string;
  provider: StatementProvider;
  currency: string | null;
  color: string;
  createdAt: string;
  transactionCount: number;
  latestBookingDate: string | null;
};

export type AccountRecord = AccountSummaryRecord & {
  transactions: NormalizedTransaction[];
};

export type CreateAccountInput = {
  id?: number;
  name: string;
  kind: string;
  provider: StatementProvider;
  currency?: string | null;
  color: string;
};

export type ImportTransactionsResult = {
  totalCount: number;
  insertedCount: number;
  skippedCount: number;
};

function toNumberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function parseRawJson(value: string): Record<string, string> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const normalized: Record<string, string> = {};
    for (const [key, fieldValue] of Object.entries(parsed)) {
      if (typeof fieldValue === "string") {
        normalized[key] = fieldValue;
      }
    }
    return normalized;
  } catch {
    return {};
  }
}

async function listAccountSummaries(accountId?: number): Promise<AccountSummaryRecord[]> {
  await ensureFinanceSchema();
  const db = getFinanceDb();

  const baseSelection = {
    id: accounts.id,
    name: accounts.name,
    kind: accounts.kind,
    provider: accounts.provider,
    currency: accounts.currency,
    color: accounts.color,
    createdAt: accounts.createdAt,
    transactionCount: sql<number>`count(${transactionsTable.id})`,
    latestBookingDate: sql<string | null>`max(${transactionsTable.bookingDate})`,
  };

  const groupedColumns = [
    accounts.id,
    accounts.name,
    accounts.kind,
    accounts.provider,
    accounts.currency,
    accounts.color,
    accounts.createdAt,
  ] as const;

  const rows =
    typeof accountId === "number"
      ? await db
          .select(baseSelection)
          .from(accounts)
          .leftJoin(transactionsTable, eq(transactionsTable.accountId, accounts.id))
          .where(eq(accounts.id, accountId))
          .groupBy(...groupedColumns)
          .orderBy(asc(accounts.createdAt))
      : await db
          .select(baseSelection)
          .from(accounts)
          .leftJoin(transactionsTable, eq(transactionsTable.accountId, accounts.id))
          .groupBy(...groupedColumns)
          .orderBy(asc(accounts.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    currency: row.currency,
    color: row.color,
    createdAt: row.createdAt,
    transactionCount: Math.max(0, Math.trunc(toNumberValue(row.transactionCount))),
    latestBookingDate: row.latestBookingDate,
  }));
}

async function listTransactionsForAccounts(accountIds: number[]): Promise<Map<number, NormalizedTransaction[]>> {
  if (accountIds.length === 0) {
    return new Map();
  }

  const db = getFinanceDb();
  const rows = await db
    .select({
      accountId: transactionsTable.accountId,
      sourceId: transactionsTable.sourceId,
      provider: transactionsTable.provider,
      bookingDate: transactionsTable.bookingDate,
      amountCents: transactionsTable.amountCents,
      currency: transactionsTable.currency,
      direction: transactionsTable.direction,
      description: transactionsTable.description,
      categoryHint: transactionsTable.categoryHint,
      counterparty: transactionsTable.counterparty,
      reference: transactionsTable.reference,
      rawJson: transactionsTable.rawJson,
    })
    .from(transactionsTable)
    .where(inArray(transactionsTable.accountId, accountIds))
    .orderBy(desc(transactionsTable.bookingDate), asc(transactionsTable.sourceId));

  const transactionsByAccount = new Map<number, NormalizedTransaction[]>();

  rows.forEach((row) => {
    const transaction: NormalizedTransaction = {
      id: row.sourceId,
      provider: row.provider,
      bookingDate: row.bookingDate,
      amountCents: Math.abs(Math.trunc(toNumberValue(row.amountCents))),
      currency: row.currency,
      direction: row.direction === "out" ? "out" : "in",
      description: row.description,
      categoryHint: row.categoryHint ?? undefined,
      counterparty: row.counterparty ?? undefined,
      reference: row.reference ?? undefined,
      raw: parseRawJson(row.rawJson),
    };

    const existing = transactionsByAccount.get(row.accountId);
    if (existing) {
      existing.push(transaction);
      return;
    }

    transactionsByAccount.set(row.accountId, [transaction]);
  });

  return transactionsByAccount;
}

export async function listAccounts(): Promise<AccountRecord[]> {
  const summaries = await listAccountSummaries();
  const transactionsByAccount = await listTransactionsForAccounts(summaries.map((summary) => summary.id));

  return summaries.map((summary) => {
    const transactions = transactionsByAccount.get(summary.id) ?? [];

    return {
      ...summary,
      transactions,
      transactionCount: Math.max(summary.transactionCount, transactions.length),
    };
  });
}

export async function getAccountById(accountId: number): Promise<AccountRecord | null> {
  const summaries = await listAccountSummaries(accountId);
  if (summaries.length === 0) {
    return null;
  }

  const [summary] = summaries;
  const transactionsByAccount = await listTransactionsForAccounts([summary.id]);
  const transactions = transactionsByAccount.get(summary.id) ?? [];

  return {
    ...summary,
    transactions,
    transactionCount: Math.max(summary.transactionCount, transactions.length),
  };
}

export async function createAccount(input: CreateAccountInput): Promise<AccountRecord> {
  await ensureFinanceSchema();
  const db = getFinanceDb();
  const currency = input.currency ?? null;

  const inserted = await db
    .insert(accounts)
    .values({
      ...(typeof input.id === "number" ? { id: input.id } : {}),
      name: input.name,
      kind: input.kind,
      provider: input.provider,
      currency,
      color: input.color,
    })
    .returning({
      id: accounts.id,
    });

  const insertedId = inserted[0]?.id;
  if (typeof insertedId !== "number") {
    throw new Error("Account insert succeeded but account id was not returned.");
  }

  const account = await getAccountById(insertedId);
  if (!account) {
    throw new Error("Account insert succeeded but account could not be loaded.");
  }

  return account;
}

export async function deleteAccountById(accountId: number): Promise<boolean> {
  await ensureFinanceSchema();
  const db = getFinanceDb();

  const existing = await db
    .select({
      id: accounts.id,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (existing.length === 0) {
    return false;
  }

  await db.delete(accounts).where(eq(accounts.id, accountId));
  return true;
}

async function countTransactionsForAccountIds(accountId: number, sourceIds: string[]): Promise<number> {
  if (sourceIds.length === 0) {
    return 0;
  }

  const db = getFinanceDb();
  const result = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.accountId, accountId), inArray(transactionsTable.sourceId, sourceIds)));

  return Math.max(0, Math.trunc(toNumberValue(result[0]?.count)));
}

export async function importTransactionsForAccount(
  accountId: number,
  transactions: NormalizedTransaction[]
): Promise<ImportTransactionsResult> {
  await ensureFinanceSchema();
  const db = getFinanceDb();

  if (transactions.length === 0) {
    return {
      totalCount: 0,
      insertedCount: 0,
      skippedCount: 0,
    };
  }

  const uniqueSourceIds = Array.from(new Set(transactions.map((transaction) => transaction.id)));
  const beforeCount = await countTransactionsForAccountIds(accountId, uniqueSourceIds);

  await db
    .insert(transactionsTable)
    .values(
      transactions.map((transaction) => ({
        accountId,
        sourceId: transaction.id,
        provider: transaction.provider,
        bookingDate: transaction.bookingDate,
        amountCents: Math.abs(Math.trunc(transaction.amountCents)),
        currency: transaction.currency,
        direction: transaction.direction,
        description: transaction.description,
        categoryHint: transaction.categoryHint ?? null,
        counterparty: transaction.counterparty ?? null,
        reference: transaction.reference ?? null,
        rawJson: JSON.stringify(transaction.raw),
      }))
    )
    .onConflictDoNothing({
      target: [transactionsTable.accountId, transactionsTable.sourceId],
    });

  const afterCount = await countTransactionsForAccountIds(accountId, uniqueSourceIds);
  const insertedCount = Math.max(0, afterCount - beforeCount);

  return {
    totalCount: transactions.length,
    insertedCount,
    skippedCount: transactions.length - insertedCount,
  };
}

export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("unique constraint failed") || message.includes("constraint failed");
}
