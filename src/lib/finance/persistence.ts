import "server-only";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { NormalizedTransaction, StatementProvider } from "@/lib/parsers/types";
import {
  accounts,
  categories,
  tags,
  transactionRuleTags as transactionRuleTagsTable,
  transactionRules as transactionRulesTable,
  transactionTags as transactionTagsTable,
  transactions as transactionsTable,
} from "@/lib/server/db/schema";
import { getFinanceDb } from "@/lib/server/turso";
import {
  analyzeImportDedupe,
  type ImportConflict,
  type ImportCoverageSummary,
  type ImportPreviewResult,
} from "@/lib/finance/import-dedupe";
import {
  applyPreparedTransactionRules,
  mapTransactionRuleRow,
  prepareTransactionRules,
  type PreparedTransactionRule,
  type TransactionRuleRecord,
  type TransactionRuleWriteInput,
  type ValidatedTransactionRuleWriteInput,
  validateAndNormalizeTransactionRuleInput,
} from "@/lib/finance/rules";

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

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

export type DashboardTransactionsViewInput = {
  startMonth?: string;
  endMonth?: string;
};

export type DashboardTransactionRow = {
  accountId: number;
  accountName: string;
  accountColor: string;
  transaction: NormalizedTransaction;
};

export type DashboardTransactionsView = {
  monthOptions: string[];
  selectedStartMonth?: string;
  selectedEndMonth?: string;
  importedTransactionCount: number;
  transactions: DashboardTransactionRow[];
};

export type DashboardAccountSummaryRow = {
  accountId: number;
  accountName: string;
  accountKind: string;
  accountCurrency?: string;
  accountColor: string;
  currency: string;
  transactionCount: number;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
};

export type DashboardSummaryViewInput = {
  month?: string;
};

export type DashboardSummaryView = {
  monthOptions: string[];
  selectedMonth?: string;
  accountCount: number;
  importedTransactionCount: number;
  rows: DashboardAccountSummaryRow[];
};

export type CreateAccountInput = {
  id?: number;
  name: string;
  kind: string;
  provider: StatementProvider;
  currency?: string | null;
  color: string;
};

export type { ImportCoverageSummary, ImportConflict, ImportPreviewResult };

export type ImportTransactionsOptions = {
  forceImportIndexes?: number[];
};

export type ImportTransactionsResult = {
  totalCount: number;
  insertedCount: number;
  skippedCount: number;
  duplicateConflictCount: number;
  duplicateSkippedCount: number;
  forcedImportCount: number;
  autoCancelled: boolean;
  cancelReason?: "all_unique_keys_already_exist";
  coverage: ImportCoverageSummary;
};

export type CreateTransactionForAccountInput = {
  provider: StatementProvider;
  bookingDate: string;
  amountCents: number;
  currency: string;
  direction: "in" | "out";
  description: string;
  categoryId?: number;
  tagIds?: number[];
  counterparty?: string;
  reference?: string;
};

export type CreateTransactionForAccountResult = {
  transactionId: string;
};

export type UpdateTransactionForAccountInput = {
  bookingDate: string;
  amountCents: number;
  currency: string;
  direction: "in" | "out";
  description: string;
  categoryId?: number;
  tagIds?: number[];
  counterparty?: string;
  reference?: string;
};

export type CreateTransactionRuleInput = TransactionRuleWriteInput;
export type UpdateTransactionRuleInput = TransactionRuleWriteInput;
export type { TransactionRuleRecord };
export type CategoryRecord = {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};
export type TagRecord = {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};
export type CreateCategoryInput = {
  name: string;
};
export type UpdateCategoryInput = {
  name: string;
};
export type CreateTagInput = {
  name: string;
};
export type UpdateTagInput = {
  name: string;
};
export type ReapplyTransactionRulesResult = {
  totalCount: number;
  updatedCount: number;
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

function toRulePersistenceValues(input: ValidatedTransactionRuleWriteInput): {
  descriptionContains: string | null;
  descriptionRegex: string | null;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  amountExactCents: number | null;
  accountIdsJson: string | null;
  applyCategoryId: number | null;
  assignCounterpartyFromRegexGroup: boolean;
  priority: number;
} {
  return {
    descriptionContains: input.descriptionContains ?? null,
    descriptionRegex: input.descriptionRegex ?? null,
    amountMinCents: input.amountMinCents ?? null,
    amountMaxCents: input.amountMaxCents ?? null,
    amountExactCents: input.amountExactCents ?? null,
    accountIdsJson: input.accountIds ? JSON.stringify(input.accountIds) : null,
    applyCategoryId: input.applyCategoryId ?? null,
    assignCounterpartyFromRegexGroup: input.assignCounterpartyFromRegexGroup,
    priority: input.priority,
  };
}

function normalizeTagIds(input: number[] | null | undefined): number[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [];
  }

  const unique = new Set<number>();
  input.forEach((tagId) => {
    if (!Number.isInteger(tagId) || tagId <= 0) {
      throw new Error("tagIds must contain positive integer tag ids.");
    }

    unique.add(tagId);
  });

  return Array.from(unique.values()).sort((left, right) => left - right);
}

type TagList = {
  tagIds: number[];
  tagNames: string[];
  tags: Array<{
    id: number;
    name: string;
  }>;
};

type TagListRow = {
  ownerId: number;
  tagId: number;
  tagName: string;
};

type ReplaceTagLinksOptions = {
  tagIds: number[];
  deleteAll: () => Promise<void>;
  listExistingTagIds: () => Promise<number[]>;
  deleteTagIds: (tagIds: number[]) => Promise<void>;
  insertTagIds: (tagIds: number[]) => Promise<void>;
};

function toTagListMap(rows: TagListRow[]): Map<number, TagList> {
  const tagsByOwnerId = new Map<number, TagList>();
  rows.forEach((row) => {
    const existing = tagsByOwnerId.get(row.ownerId);
    if (existing) {
      existing.tagIds.push(row.tagId);
      existing.tagNames.push(row.tagName);
      existing.tags.push({
        id: row.tagId,
        name: row.tagName,
      });
      return;
    }

    tagsByOwnerId.set(row.ownerId, {
      tagIds: [row.tagId],
      tagNames: [row.tagName],
      tags: [
        {
          id: row.tagId,
          name: row.tagName,
        },
      ],
    });
  });
  return tagsByOwnerId;
}

async function replaceTagLinks(options: ReplaceTagLinksOptions): Promise<void> {
  const normalizedTagIds = normalizeTagIds(options.tagIds);
  if (normalizedTagIds.length === 0) {
    await options.deleteAll();
    return;
  }

  const existingTagIds = await options.listExistingTagIds();
  const normalizedTagIdSet = new Set(normalizedTagIds);
  const existingTagIdSet = new Set(existingTagIds);
  const toDelete = existingTagIds.filter((tagId) => !normalizedTagIdSet.has(tagId));
  const toInsert = normalizedTagIds.filter((tagId) => !existingTagIdSet.has(tagId));

  if (toDelete.length > 0) {
    await options.deleteTagIds(toDelete);
  }
  if (toInsert.length > 0) {
    await options.insertTagIds(toInsert);
  }
}

async function listTransactionTagLists(transactionIds: number[]): Promise<Map<number, TagList>> {
  if (transactionIds.length === 0) {
    return new Map();
  }

  const db = getFinanceDb();
  const rows = await db
    .select({
      ownerId: transactionTagsTable.transactionId,
      tagId: transactionTagsTable.tagId,
      tagName: tags.name,
    })
    .from(transactionTagsTable)
    .innerJoin(tags, eq(tags.id, transactionTagsTable.tagId))
    .where(inArray(transactionTagsTable.transactionId, transactionIds))
    .orderBy(
      asc(transactionTagsTable.transactionId),
      asc(tags.name),
      asc(transactionTagsTable.tagId)
    );

  return toTagListMap(rows);
}

async function listTransactionRuleTagLists(ruleIds: number[]): Promise<Map<number, TagList>> {
  if (ruleIds.length === 0) {
    return new Map();
  }

  const db = getFinanceDb();
  const rows = await db
    .select({
      ownerId: transactionRuleTagsTable.transactionRuleId,
      tagId: transactionRuleTagsTable.tagId,
      tagName: tags.name,
    })
    .from(transactionRuleTagsTable)
    .innerJoin(tags, eq(tags.id, transactionRuleTagsTable.tagId))
    .where(inArray(transactionRuleTagsTable.transactionRuleId, ruleIds))
    .orderBy(
      asc(transactionRuleTagsTable.transactionRuleId),
      asc(tags.name),
      asc(transactionRuleTagsTable.tagId)
    );

  return toTagListMap(rows);
}

async function addTransactionTags(transactionId: number, tagIds: number[]): Promise<void> {
  const normalizedTagIds = normalizeTagIds(tagIds);
  if (normalizedTagIds.length === 0) {
    return;
  }

  const db = getFinanceDb();
  await db
    .insert(transactionTagsTable)
    .values(
      normalizedTagIds.map((tagId) => ({
        transactionId,
        tagId,
      }))
    )
    .onConflictDoNothing({
      target: [transactionTagsTable.transactionId, transactionTagsTable.tagId],
    });
}

async function replaceTransactionTags(transactionId: number, tagIds: number[]): Promise<void> {
  const db = getFinanceDb();
  await replaceTagLinks({
    tagIds,
    deleteAll: async () => {
      await db.delete(transactionTagsTable).where(eq(transactionTagsTable.transactionId, transactionId));
    },
    listExistingTagIds: async () => {
      const existingRows = await db
        .select({
          tagId: transactionTagsTable.tagId,
        })
        .from(transactionTagsTable)
        .where(eq(transactionTagsTable.transactionId, transactionId));
      return existingRows.map((row) => row.tagId);
    },
    deleteTagIds: async (toDelete) => {
      await db
        .delete(transactionTagsTable)
        .where(
          and(
            eq(transactionTagsTable.transactionId, transactionId),
            inArray(transactionTagsTable.tagId, toDelete)
          )
        );
    },
    insertTagIds: async (toInsert) => {
      await db.insert(transactionTagsTable).values(
        toInsert.map((tagId) => ({
          transactionId,
          tagId,
        }))
      );
    },
  });
}

async function replaceTransactionRuleTags(ruleId: number, tagIds: number[]): Promise<void> {
  const db = getFinanceDb();
  await replaceTagLinks({
    tagIds,
    deleteAll: async () => {
      await db
        .delete(transactionRuleTagsTable)
        .where(eq(transactionRuleTagsTable.transactionRuleId, ruleId));
    },
    listExistingTagIds: async () => {
      const existingRows = await db
        .select({
          tagId: transactionRuleTagsTable.tagId,
        })
        .from(transactionRuleTagsTable)
        .where(eq(transactionRuleTagsTable.transactionRuleId, ruleId));
      return existingRows.map((row) => row.tagId);
    },
    deleteTagIds: async (toDelete) => {
      await db
        .delete(transactionRuleTagsTable)
        .where(
          and(
            eq(transactionRuleTagsTable.transactionRuleId, ruleId),
            inArray(transactionRuleTagsTable.tagId, toDelete)
          )
        );
    },
    insertTagIds: async (toInsert) => {
      await db.insert(transactionRuleTagsTable).values(
        toInsert.map((tagId) => ({
          transactionRuleId: ruleId,
          tagId,
        }))
      );
    },
  });
}

async function getPreparedTransactionRules(): Promise<PreparedTransactionRule[]> {
  const rules = await listTransactionRules();
  return prepareTransactionRules(rules);
}

async function listAccountSummaries(accountId?: number): Promise<AccountSummaryRecord[]> {
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
      transactionPk: transactionsTable.id,
      accountId: transactionsTable.accountId,
      sourceId: transactionsTable.sourceId,
      provider: transactionsTable.provider,
      bookingDate: transactionsTable.bookingDate,
      amountCents: transactionsTable.amountCents,
      currency: transactionsTable.currency,
      direction: transactionsTable.direction,
      description: transactionsTable.description,
      categoryId: transactionsTable.categoryId,
      categoryName: categories.name,
      counterparty: transactionsTable.counterparty,
      reference: transactionsTable.reference,
      rawJson: transactionsTable.rawJson,
    })
    .from(transactionsTable)
    .leftJoin(categories, eq(categories.id, transactionsTable.categoryId))
    .where(inArray(transactionsTable.accountId, accountIds))
    .orderBy(desc(transactionsTable.bookingDate), asc(transactionsTable.sourceId));

  const transactionTagsById = await listTransactionTagLists(rows.map((row) => row.transactionPk));
  const transactionsByAccount = new Map<number, NormalizedTransaction[]>();

  rows.forEach((row) => {
    const tagList = transactionTagsById.get(row.transactionPk);
    const transaction: NormalizedTransaction = {
      id: row.sourceId,
      provider: row.provider,
      bookingDate: row.bookingDate,
      amountCents: Math.abs(Math.trunc(toNumberValue(row.amountCents))),
      currency: row.currency,
      direction: row.direction === "out" ? ("out" as const) : ("in" as const),
      description: row.description,
      categoryId: row.categoryId ?? undefined,
      categoryHint: row.categoryName ?? undefined,
      tags: tagList?.tags,
      tagIds: tagList?.tagIds,
      tagHints: tagList?.tagNames,
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

async function listTransactionMonthOptions(): Promise<string[]> {
  const db = getFinanceDb();
  const monthExpr = sql<string>`substr(${transactionsTable.bookingDate}, 1, 7)`;

  const rows = await db
    .select({
      month: monthExpr,
    })
    .from(transactionsTable)
    .groupBy(monthExpr)
    .orderBy(desc(monthExpr));

  return rows
    .map((row) => row.month)
    .filter((month): month is string => typeof month === "string" && MONTH_KEY_PATTERN.test(month));
}

async function countImportedTransactions(): Promise<number> {
  const db = getFinanceDb();
  const rows = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(transactionsTable);

  return Math.max(0, Math.trunc(toNumberValue(rows[0]?.count)));
}

async function countAccounts(): Promise<number> {
  const db = getFinanceDb();
  const rows = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(accounts);

  return Math.max(0, Math.trunc(toNumberValue(rows[0]?.count)));
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

export async function getDashboardTransactionsView(
  input: DashboardTransactionsViewInput
): Promise<DashboardTransactionsView> {
  const db = getFinanceDb();

  const monthOptions = await listTransactionMonthOptions();
  const latestMonth = monthOptions[0];
  const defaultStartMonth = monthOptions[Math.min(2, Math.max(monthOptions.length - 1, 0))];
  const hasValidStartMonth =
    typeof input.startMonth === "string" && monthOptions.includes(input.startMonth);
  const hasValidEndMonth = typeof input.endMonth === "string" && monthOptions.includes(input.endMonth);

  let selectedStartMonth: string | undefined;
  let selectedEndMonth: string | undefined;

  if (latestMonth && defaultStartMonth && hasValidStartMonth && hasValidEndMonth) {
    selectedStartMonth = input.startMonth!;
    selectedEndMonth = input.endMonth!;
    if (selectedStartMonth > selectedEndMonth) {
      [selectedStartMonth, selectedEndMonth] = [selectedEndMonth, selectedStartMonth];
    }
  } else if (latestMonth && defaultStartMonth) {
    selectedStartMonth = defaultStartMonth;
    selectedEndMonth = latestMonth;
  }

  const monthWhereClause =
    selectedStartMonth && selectedEndMonth
      ? and(
          sql`substr(${transactionsTable.bookingDate}, 1, 7) >= ${selectedStartMonth}`,
          sql`substr(${transactionsTable.bookingDate}, 1, 7) <= ${selectedEndMonth}`
        )
      : undefined;

  const transactionSelection = {
    transactionPk: transactionsTable.id,
    accountId: accounts.id,
    accountName: accounts.name,
    accountColor: accounts.color,
    sourceId: transactionsTable.sourceId,
    provider: transactionsTable.provider,
    bookingDate: transactionsTable.bookingDate,
    amountCents: transactionsTable.amountCents,
    currency: transactionsTable.currency,
    direction: transactionsTable.direction,
    description: transactionsTable.description,
    categoryId: transactionsTable.categoryId,
    categoryName: categories.name,
    counterparty: transactionsTable.counterparty,
    reference: transactionsTable.reference,
    rawJson: transactionsTable.rawJson,
  };

  const baseQuery = db
    .select(transactionSelection)
    .from(transactionsTable)
    .innerJoin(accounts, eq(accounts.id, transactionsTable.accountId))
    .leftJoin(categories, eq(categories.id, transactionsTable.categoryId));
  const scopedQuery = monthWhereClause ? baseQuery.where(monthWhereClause) : baseQuery;
  const rows = await scopedQuery.orderBy(asc(transactionsTable.bookingDate), asc(transactionsTable.sourceId));
  const transactionTagsById = await listTransactionTagLists(rows.map((row) => row.transactionPk));

  const importedTransactionCount = await countImportedTransactions();
  const transactions: DashboardTransactionRow[] = rows.map((row) => {
    const tagList = transactionTagsById.get(row.transactionPk);
    const transaction: NormalizedTransaction = {
      id: row.sourceId,
      provider: row.provider,
      bookingDate: row.bookingDate,
      amountCents: Math.abs(Math.trunc(toNumberValue(row.amountCents))),
      currency: row.currency,
      direction: row.direction === "out" ? "out" : "in",
      description: row.description,
      categoryId: row.categoryId ?? undefined,
      categoryHint: row.categoryName ?? undefined,
      tags: tagList?.tags,
      tagIds: tagList?.tagIds,
      tagHints: tagList?.tagNames,
      counterparty: row.counterparty ?? undefined,
      reference: row.reference ?? undefined,
      raw: parseRawJson(row.rawJson),
    };

    return {
      accountId: row.accountId,
      accountName: row.accountName,
      accountColor: row.accountColor,
      transaction,
    };
  });

  return {
    monthOptions,
    selectedStartMonth,
    selectedEndMonth,
    importedTransactionCount,
    transactions,
  };
}

export async function getDashboardSummaryView(input: DashboardSummaryViewInput): Promise<DashboardSummaryView> {
  const db = getFinanceDb();

  const monthOptions = await listTransactionMonthOptions();
  const selectedMonth =
    monthOptions.length === 0 ? "" : input.month && monthOptions.includes(input.month) ? input.month : monthOptions[0];

  const [importedTransactionCount, accountCount] = await Promise.all([countImportedTransactions(), countAccounts()]);
  if (!selectedMonth) {
    return {
      monthOptions,
      selectedMonth: undefined,
      accountCount,
      importedTransactionCount,
      rows: [],
    };
  }

  const fallbackCurrencyRows = await db
    .select({
      accountId: transactionsTable.accountId,
      fallbackCurrency: sql<string | null>`max(${transactionsTable.currency})`,
    })
    .from(transactionsTable)
    .groupBy(transactionsTable.accountId);

  const fallbackCurrencyByAccountId = new Map<number, string>();
  fallbackCurrencyRows.forEach((row) => {
    if (typeof row.fallbackCurrency === "string" && row.fallbackCurrency.length > 0) {
      fallbackCurrencyByAccountId.set(row.accountId, row.fallbackCurrency);
    }
  });

  const summaryRows = await db
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      accountKind: accounts.kind,
      accountCurrency: accounts.currency,
      accountColor: accounts.color,
      createdAt: accounts.createdAt,
      monthCurrency: sql<string | null>`max(${transactionsTable.currency})`,
      transactionCount: sql<number>`count(${transactionsTable.id})`,
      inflowCents:
        sql<number>`coalesce(sum(case when ${transactionsTable.direction} = 'in' then ${transactionsTable.amountCents} else 0 end), 0)`,
      outflowCents:
        sql<number>`coalesce(sum(case when ${transactionsTable.direction} = 'out' then ${transactionsTable.amountCents} else 0 end), 0)`,
    })
    .from(accounts)
    .leftJoin(
      transactionsTable,
      and(
        eq(transactionsTable.accountId, accounts.id),
        sql`substr(${transactionsTable.bookingDate}, 1, 7) = ${selectedMonth}`
      )
    )
    .groupBy(accounts.id, accounts.name, accounts.kind, accounts.currency, accounts.color, accounts.createdAt)
    .orderBy(asc(accounts.createdAt));

  const rows: DashboardAccountSummaryRow[] = summaryRows.map((row) => {
    const inflowCents = Math.max(0, Math.trunc(toNumberValue(row.inflowCents)));
    const outflowCents = Math.max(0, Math.trunc(toNumberValue(row.outflowCents)));
    const accountCurrency =
      row.accountCurrency && row.accountCurrency.length > 0 ? row.accountCurrency : undefined;
    const currency =
      accountCurrency ?? row.monthCurrency ?? fallbackCurrencyByAccountId.get(row.accountId) ?? "EUR";

    return {
      accountId: row.accountId,
      accountName: row.accountName,
      accountKind: row.accountKind,
      accountCurrency,
      accountColor: row.accountColor,
      currency,
      transactionCount: Math.max(0, Math.trunc(toNumberValue(row.transactionCount))),
      inflowCents,
      outflowCents,
      netCents: inflowCents - outflowCents,
    };
  });

  return {
    monthOptions,
    selectedMonth,
    accountCount,
    importedTransactionCount,
    rows,
  };
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

function toCategoryRecord(row: typeof categories.$inferSelect): CategoryRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getCategoryByIdInternal(categoryId: number): Promise<CategoryRecord | null> {
  const db = getFinanceDb();
  const rows = await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1);
  const row = rows[0];
  return row ? toCategoryRecord(row) : null;
}

export async function listCategories(): Promise<CategoryRecord[]> {
  const db = getFinanceDb();
  const rows = await db.select().from(categories).orderBy(asc(categories.name), asc(categories.id));
  return rows.map(toCategoryRecord);
}

export async function createCategory(input: CreateCategoryInput): Promise<CategoryRecord> {
  const db = getFinanceDb();
  const inserted = await db
    .insert(categories)
    .values({
      name: input.name,
    })
    .returning({
      id: categories.id,
    });

  const insertedId = inserted[0]?.id;
  if (typeof insertedId !== "number") {
    throw new Error("Category insert succeeded but category id was not returned.");
  }

  const category = await getCategoryByIdInternal(insertedId);
  if (!category) {
    throw new Error("Category insert succeeded but category could not be loaded.");
  }

  return category;
}

export async function updateCategory(categoryId: number, input: UpdateCategoryInput): Promise<CategoryRecord | null> {
  const db = getFinanceDb();

  const updated = await db
    .update(categories)
    .set({
      name: input.name,
      updatedAt: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(eq(categories.id, categoryId))
    .returning({
      id: categories.id,
    });

  if (updated.length === 0) {
    return null;
  }

  return getCategoryByIdInternal(categoryId);
}

export async function deleteCategory(categoryId: number): Promise<boolean> {
  const db = getFinanceDb();

  const existing = await db
    .select({
      id: categories.id,
    })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);

  if (existing.length === 0) {
    return false;
  }

  await db.delete(categories).where(eq(categories.id, categoryId));
  return true;
}

function toTagRecord(row: typeof tags.$inferSelect): TagRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getTagByIdInternal(tagId: number): Promise<TagRecord | null> {
  const db = getFinanceDb();
  const rows = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
  const row = rows[0];
  return row ? toTagRecord(row) : null;
}

export async function listTags(): Promise<TagRecord[]> {
  const db = getFinanceDb();
  const rows = await db.select().from(tags).orderBy(asc(tags.name), asc(tags.id));
  return rows.map(toTagRecord);
}

export async function createTag(input: CreateTagInput): Promise<TagRecord> {
  const db = getFinanceDb();
  const inserted = await db
    .insert(tags)
    .values({
      name: input.name,
    })
    .returning({
      id: tags.id,
    });

  const insertedId = inserted[0]?.id;
  if (typeof insertedId !== "number") {
    throw new Error("Tag insert succeeded but tag id was not returned.");
  }

  const tag = await getTagByIdInternal(insertedId);
  if (!tag) {
    throw new Error("Tag insert succeeded but tag could not be loaded.");
  }

  return tag;
}

export async function updateTag(tagId: number, input: UpdateTagInput): Promise<TagRecord | null> {
  const db = getFinanceDb();

  const updated = await db
    .update(tags)
    .set({
      name: input.name,
      updatedAt: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(eq(tags.id, tagId))
    .returning({
      id: tags.id,
    });

  if (updated.length === 0) {
    return null;
  }

  return getTagByIdInternal(tagId);
}

export async function deleteTag(tagId: number): Promise<boolean> {
  const db = getFinanceDb();

  const existing = await db
    .select({
      id: tags.id,
    })
    .from(tags)
    .where(eq(tags.id, tagId))
    .limit(1);

  if (existing.length === 0) {
    return false;
  }

  await db.delete(tags).where(eq(tags.id, tagId));
  return true;
}

async function getTransactionRuleByIdInternal(ruleId: number): Promise<TransactionRuleRecord | null> {
  const db = getFinanceDb();
  const rows = await db
    .select({
      id: transactionRulesTable.id,
      descriptionContains: transactionRulesTable.descriptionContains,
      descriptionRegex: transactionRulesTable.descriptionRegex,
      amountMinCents: transactionRulesTable.amountMinCents,
      amountMaxCents: transactionRulesTable.amountMaxCents,
      amountExactCents: transactionRulesTable.amountExactCents,
      accountIdsJson: transactionRulesTable.accountIdsJson,
      applyCategoryId: transactionRulesTable.applyCategoryId,
      assignCounterpartyFromRegexGroup: transactionRulesTable.assignCounterpartyFromRegexGroup,
      priority: transactionRulesTable.priority,
      createdAt: transactionRulesTable.createdAt,
      updatedAt: transactionRulesTable.updatedAt,
      applyCategoryName: categories.name,
    })
    .from(transactionRulesTable)
    .leftJoin(categories, eq(categories.id, transactionRulesTable.applyCategoryId))
    .where(eq(transactionRulesTable.id, ruleId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  const tagList = (await listTransactionRuleTagLists([row.id])).get(row.id);

  return {
    ...mapTransactionRuleRow(row),
    applyCategoryName: row.applyCategoryName ?? undefined,
    applyTags: tagList?.tags,
    applyTagIds: tagList?.tagIds,
    applyTagNames: tagList?.tagNames,
  };
}

export async function listTransactionRules(): Promise<TransactionRuleRecord[]> {
  const db = getFinanceDb();
  const rows = await db
    .select({
      id: transactionRulesTable.id,
      descriptionContains: transactionRulesTable.descriptionContains,
      descriptionRegex: transactionRulesTable.descriptionRegex,
      amountMinCents: transactionRulesTable.amountMinCents,
      amountMaxCents: transactionRulesTable.amountMaxCents,
      amountExactCents: transactionRulesTable.amountExactCents,
      accountIdsJson: transactionRulesTable.accountIdsJson,
      applyCategoryId: transactionRulesTable.applyCategoryId,
      assignCounterpartyFromRegexGroup: transactionRulesTable.assignCounterpartyFromRegexGroup,
      priority: transactionRulesTable.priority,
      createdAt: transactionRulesTable.createdAt,
      updatedAt: transactionRulesTable.updatedAt,
      applyCategoryName: categories.name,
    })
    .from(transactionRulesTable)
    .leftJoin(categories, eq(categories.id, transactionRulesTable.applyCategoryId))
    .orderBy(asc(transactionRulesTable.priority), asc(transactionRulesTable.id));

  const tagsByRuleId = await listTransactionRuleTagLists(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...mapTransactionRuleRow(row),
    applyCategoryName: row.applyCategoryName ?? undefined,
    applyTags: tagsByRuleId.get(row.id)?.tags,
    applyTagIds: tagsByRuleId.get(row.id)?.tagIds,
    applyTagNames: tagsByRuleId.get(row.id)?.tagNames,
  }));
}

export async function createTransactionRule(
  input: CreateTransactionRuleInput
): Promise<TransactionRuleRecord> {
  const db = getFinanceDb();
  const validatedInput = validateAndNormalizeTransactionRuleInput(input);

  const inserted = await db
    .insert(transactionRulesTable)
    .values(toRulePersistenceValues(validatedInput))
    .returning({
      id: transactionRulesTable.id,
    });

  const insertedId = inserted[0]?.id;
  if (typeof insertedId !== "number") {
    throw new Error("Rule insert succeeded but rule id was not returned.");
  }

  await replaceTransactionRuleTags(insertedId, validatedInput.applyTagIds ?? []);

  const createdRule = await getTransactionRuleByIdInternal(insertedId);
  if (!createdRule) {
    throw new Error("Rule insert succeeded but rule could not be loaded.");
  }

  return createdRule;
}

export async function updateTransactionRule(
  ruleId: number,
  input: UpdateTransactionRuleInput
): Promise<TransactionRuleRecord | null> {
  const db = getFinanceDb();
  const validatedInput = validateAndNormalizeTransactionRuleInput(input);

  const updated = await db
    .update(transactionRulesTable)
    .set({
      ...toRulePersistenceValues(validatedInput),
      updatedAt: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(eq(transactionRulesTable.id, ruleId))
    .returning({
      id: transactionRulesTable.id,
    });

  if (updated.length === 0) {
    return null;
  }

  await replaceTransactionRuleTags(ruleId, validatedInput.applyTagIds ?? []);
  return getTransactionRuleByIdInternal(ruleId);
}

export async function deleteTransactionRule(ruleId: number): Promise<boolean> {
  const db = getFinanceDb();

  const existing = await db
    .select({
      id: transactionRulesTable.id,
    })
    .from(transactionRulesTable)
    .where(eq(transactionRulesTable.id, ruleId))
    .limit(1);

  if (existing.length === 0) {
    return false;
  }

  await db.delete(transactionRulesTable).where(eq(transactionRulesTable.id, ruleId));
  return true;
}

export async function reapplyTransactionRulesForAllTransactions(): Promise<ReapplyTransactionRulesResult> {
  const db = getFinanceDb();
  const preparedRules = await getPreparedTransactionRules();

  const rows = await db
    .select({
      id: transactionsTable.id,
      accountId: transactionsTable.accountId,
      description: transactionsTable.description,
      amountCents: transactionsTable.amountCents,
      categoryId: transactionsTable.categoryId,
      counterparty: transactionsTable.counterparty,
    })
    .from(transactionsTable);

  if (rows.length === 0) {
    return {
      totalCount: 0,
      updatedCount: 0,
    };
  }

  const transactionTagsById = await listTransactionTagLists(rows.map((row) => row.id));
  let updatedCount = 0;

  for (const row of rows) {
    const currentTagIds = transactionTagsById.get(row.id)?.tagIds ?? [];
    const amountCents = Math.abs(Math.trunc(toNumberValue(row.amountCents)));
    const automationResult = applyPreparedTransactionRules(preparedRules, {
      accountId: row.accountId,
      description: row.description,
      amountCents,
      categoryId: row.categoryId ?? undefined,
      tagIds: currentTagIds,
      counterparty: row.counterparty ?? undefined,
    });

    const nextCategoryId = automationResult.categoryId ?? null;
    const nextTagIds = normalizeTagIds(automationResult.tagIds);
    const nextCounterparty = automationResult.counterparty ?? null;
    const currentCategoryId = row.categoryId ?? null;
    const currentCounterparty = row.counterparty ?? null;
    const currentTagIdSet = new Set(currentTagIds);
    const tagsToAdd = nextTagIds.filter((tagId) => !currentTagIdSet.has(tagId));
    const hasRowUpdate = currentCategoryId !== nextCategoryId || currentCounterparty !== nextCounterparty;

    if (hasRowUpdate) {
      await db
        .update(transactionsTable)
        .set({
          categoryId: nextCategoryId,
          counterparty: nextCounterparty,
        })
        .where(eq(transactionsTable.id, row.id));
    }

    if (tagsToAdd.length > 0) {
      await addTransactionTags(row.id, tagsToAdd);
    }

    if (hasRowUpdate || tagsToAdd.length > 0) {
      updatedCount += 1;
    }
  }

  return {
    totalCount: rows.length,
    updatedCount,
  };
}

type ExistingImportDedupeRow = {
  sourceId: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
  direction: "in" | "out";
  description: string;
  counterparty?: string;
  reference?: string;
};

type PreparedImportCommitRow = {
  incomingIndex: number;
  sourceId: string;
  shouldImport: boolean;
  forced: boolean;
  tagIds: number[];
  values: {
    accountId: number;
    sourceId: string;
    provider: StatementProvider;
    bookingDate: string;
    amountCents: number;
    currency: string;
    direction: "in" | "out";
    description: string;
    categoryId: number | null;
    counterparty: string | null;
    reference: string | null;
    rawJson: string;
  };
};

function toEmptyImportCoverageSummary(): ImportCoverageSummary {
  return {
    totalIncomingCount: 0,
    uniqueIncomingCount: 0,
    existingMatchedUniqueCount: 0,
    uncoveredUniqueCount: 0,
    fullyCovered: false,
  };
}

function getIncomingBookingDateRange(
  transactions: NormalizedTransaction[]
): { minBookingDate: string; maxBookingDate: string } | null {
  if (transactions.length === 0) {
    return null;
  }

  let minBookingDate = transactions[0]!.bookingDate;
  let maxBookingDate = transactions[0]!.bookingDate;

  for (let index = 1; index < transactions.length; index += 1) {
    const bookingDate = transactions[index]!.bookingDate;
    if (bookingDate < minBookingDate) {
      minBookingDate = bookingDate;
    }
    if (bookingDate > maxBookingDate) {
      maxBookingDate = bookingDate;
    }
  }

  return {
    minBookingDate,
    maxBookingDate,
  };
}

async function listExistingImportDedupeRows(
  accountId: number,
  transactions: NormalizedTransaction[]
): Promise<ExistingImportDedupeRow[]> {
  const incomingBookingDateRange = getIncomingBookingDateRange(transactions);
  if (!incomingBookingDateRange) {
    return [];
  }

  const db = getFinanceDb();
  const rows = await db
    .select({
      sourceId: transactionsTable.sourceId,
      bookingDate: transactionsTable.bookingDate,
      amountCents: transactionsTable.amountCents,
      currency: transactionsTable.currency,
      direction: transactionsTable.direction,
      description: transactionsTable.description,
      counterparty: transactionsTable.counterparty,
      reference: transactionsTable.reference,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.accountId, accountId),
        gte(transactionsTable.bookingDate, incomingBookingDateRange.minBookingDate),
        lte(transactionsTable.bookingDate, incomingBookingDateRange.maxBookingDate)
      )
    );

  return rows.map((row) => ({
    sourceId: row.sourceId,
    bookingDate: row.bookingDate,
    amountCents: Math.abs(Math.trunc(toNumberValue(row.amountCents))),
    currency: row.currency,
    direction: row.direction === "out" ? "out" : "in",
    description: row.description,
    counterparty: row.counterparty ?? undefined,
    reference: row.reference ?? undefined,
  }));
}

async function analyzeImportForAccount(
  accountId: number,
  transactions: NormalizedTransaction[],
  forceImportIndexes?: number[]
): Promise<ReturnType<typeof analyzeImportDedupe>> {
  if (transactions.length === 0) {
    return analyzeImportDedupe([], [], forceImportIndexes);
  }

  const existingRows = await listExistingImportDedupeRows(accountId, transactions);
  return analyzeImportDedupe(
    transactions.map((transaction) => ({
      sourceId: transaction.id,
      bookingDate: transaction.bookingDate,
      amountCents: transaction.amountCents,
      description: transaction.description,
    })),
    existingRows,
    forceImportIndexes
  );
}

async function insertForcedImportRowWithSourceIdRetry(
  row: PreparedImportCommitRow
): Promise<{ id: number; sourceId: string }> {
  const db = getFinanceDb();
  const baseSourceId = row.values.sourceId;

  for (let attempt = 0; attempt < 128; attempt += 1) {
    const sourceId =
      attempt === 0 ? baseSourceId : `${baseSourceId}__dup__${row.incomingIndex}__${attempt - 1}`;
    const insertedRows = await db
      .insert(transactionsTable)
      .values({
        ...row.values,
        sourceId,
      })
      .onConflictDoNothing({
        target: [transactionsTable.accountId, transactionsTable.sourceId],
      })
      .returning({
        id: transactionsTable.id,
        sourceId: transactionsTable.sourceId,
      });

    const inserted = insertedRows[0];
    if (inserted) {
      return inserted;
    }
  }

  throw new Error(
    `Unable to insert forced import row for source id '${baseSourceId}' after deterministic collision retries.`
  );
}

export async function previewImportTransactionsForAccount(
  accountId: number,
  transactions: NormalizedTransaction[],
  options: ImportTransactionsOptions = {}
): Promise<ImportPreviewResult> {
  const previewResult = await analyzeImportForAccount(accountId, transactions, options.forceImportIndexes);
  return {
    totalCount: previewResult.totalCount,
    duplicateConflictCount: previewResult.duplicateConflictCount,
    duplicateSkippedCount: previewResult.duplicateSkippedCount,
    forcedImportCount: previewResult.forcedImportCount,
    autoCancelled: previewResult.autoCancelled,
    cancelReason: previewResult.cancelReason,
    coverage: previewResult.coverage,
    conflicts: previewResult.conflicts,
  };
}

export async function importTransactionsForAccount(
  accountId: number,
  transactions: NormalizedTransaction[],
  options: ImportTransactionsOptions = {}
): Promise<ImportTransactionsResult> {
  const db = getFinanceDb();

  if (transactions.length === 0) {
    return {
      totalCount: 0,
      insertedCount: 0,
      skippedCount: 0,
      duplicateConflictCount: 0,
      duplicateSkippedCount: 0,
      forcedImportCount: 0,
      autoCancelled: false,
      coverage: toEmptyImportCoverageSummary(),
    };
  }

  const importPreview = await analyzeImportForAccount(accountId, transactions, options.forceImportIndexes);

  if (importPreview.autoCancelled) {
    return {
      totalCount: transactions.length,
      insertedCount: 0,
      skippedCount: transactions.length,
      duplicateConflictCount: importPreview.duplicateConflictCount,
      duplicateSkippedCount: importPreview.duplicateSkippedCount,
      forcedImportCount: 0,
      autoCancelled: true,
      cancelReason: importPreview.cancelReason,
      coverage: importPreview.coverage,
    };
  }

  const importDecisionsByIndex = new Map(
    importPreview.decisions.map((decision) => [decision.incomingIndex, decision])
  );
  const preparedRules = await getPreparedTransactionRules();
  const preparedRows = transactions.map((transaction, incomingIndex) => {
    const decision = importDecisionsByIndex.get(incomingIndex);
    const amountCents = Math.abs(Math.trunc(transaction.amountCents));
    const automationResult = applyPreparedTransactionRules(preparedRules, {
      accountId,
      description: transaction.description,
      amountCents,
      categoryId: transaction.categoryId,
      tagIds: transaction.tagIds,
      counterparty: transaction.counterparty,
    });

    return {
      incomingIndex,
      sourceId: transaction.id,
      shouldImport: decision?.shouldImport ?? true,
      forced: decision?.forced ?? false,
      tagIds: normalizeTagIds(automationResult.tagIds),
      values: {
        accountId,
        sourceId: transaction.id,
        provider: transaction.provider,
        bookingDate: transaction.bookingDate,
        amountCents,
        currency: transaction.currency,
        direction: transaction.direction,
        description: transaction.description,
        categoryId: automationResult.categoryId ?? null,
        counterparty: automationResult.counterparty ?? null,
        reference: transaction.reference ?? null,
        rawJson: JSON.stringify(transaction.raw),
      },
    };
  });
  const rowsToInsert = preparedRows.filter((row) => row.shouldImport);
  const regularRows = rowsToInsert.filter((row) => !row.forced);
  const forcedRows = rowsToInsert.filter((row) => row.forced);

  const tagIdsBySourceId = new Map<string, number[]>();
  regularRows.forEach((row) => {
    if (!tagIdsBySourceId.has(row.sourceId)) {
      tagIdsBySourceId.set(row.sourceId, row.tagIds);
    }
  });

  const insertedRegularRows =
    regularRows.length === 0
      ? []
      : await db
          .insert(transactionsTable)
          .values(regularRows.map((row) => row.values))
          .onConflictDoNothing({
            target: [transactionsTable.accountId, transactionsTable.sourceId],
          })
          .returning({
            id: transactionsTable.id,
            sourceId: transactionsTable.sourceId,
          });

  const forcedTransactionTagRows: Array<{
    transactionId: number;
    tagId: number;
  }> = [];

  for (const forcedRow of forcedRows) {
    const insertedForcedRow = await insertForcedImportRowWithSourceIdRetry(forcedRow);
    forcedRow.tagIds.forEach((tagId) => {
      forcedTransactionTagRows.push({
        transactionId: insertedForcedRow.id,
        tagId,
      });
    });
  }

  const transactionTagRows = insertedRegularRows
    .flatMap((row) => {
      const tagIds = tagIdsBySourceId.get(row.sourceId) ?? [];
      return tagIds.map((tagId) => ({
        transactionId: row.id,
        tagId,
      }));
    })
    .concat(forcedTransactionTagRows);

  if (transactionTagRows.length > 0) {
    await db
      .insert(transactionTagsTable)
      .values(transactionTagRows)
      .onConflictDoNothing({
        target: [transactionTagsTable.transactionId, transactionTagsTable.tagId],
      });
  }

  const insertedCount = insertedRegularRows.length + forcedRows.length;

  return {
    totalCount: transactions.length,
    insertedCount,
    skippedCount: transactions.length - insertedCount,
    duplicateConflictCount: importPreview.duplicateConflictCount,
    duplicateSkippedCount: importPreview.duplicateSkippedCount,
    forcedImportCount: forcedRows.length,
    autoCancelled: false,
    coverage: importPreview.coverage,
  };
}

export async function createTransactionForAccount(
  accountId: number,
  input: CreateTransactionForAccountInput
): Promise<CreateTransactionForAccountResult> {
  const db = getFinanceDb();
  const amountCents = Math.abs(Math.trunc(input.amountCents));
  const preparedRules = await getPreparedTransactionRules();
  const automationResult = applyPreparedTransactionRules(preparedRules, {
    accountId,
    description: input.description,
    amountCents,
    categoryId: input.categoryId,
    tagIds: input.tagIds,
    counterparty: input.counterparty,
  });
  const nextTagIds = normalizeTagIds(automationResult.tagIds);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const sourceId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${attempt}`;

    try {
      const inserted = await db
        .insert(transactionsTable)
        .values({
          accountId,
          sourceId,
          provider: input.provider,
          bookingDate: input.bookingDate,
          amountCents,
          currency: input.currency,
          direction: input.direction,
          description: input.description,
          categoryId: automationResult.categoryId ?? null,
          counterparty: automationResult.counterparty ?? null,
          reference: input.reference ?? null,
          rawJson: JSON.stringify({
            source: "manual",
          }),
        })
        .returning({
          id: transactionsTable.id,
        });

      const insertedId = inserted[0]?.id;
      if (typeof insertedId !== "number") {
        throw new Error("Transaction insert succeeded but transaction id was not returned.");
      }

      if (nextTagIds.length > 0) {
        await addTransactionTags(insertedId, nextTagIds);
      }

      return {
        transactionId: sourceId,
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Failed to generate a unique transaction id for manual transaction.");
}

export async function deleteTransactionForAccount(accountId: number, transactionId: string): Promise<boolean> {
  const db = getFinanceDb();

  const existing = await db
    .select({
      id: transactionsTable.id,
    })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.accountId, accountId), eq(transactionsTable.sourceId, transactionId)))
    .limit(1);

  if (existing.length === 0) {
    return false;
  }

  await db
    .delete(transactionsTable)
    .where(and(eq(transactionsTable.accountId, accountId), eq(transactionsTable.sourceId, transactionId)));

  return true;
}

export async function updateTransactionForAccount(
  accountId: number,
  transactionId: string,
  input: UpdateTransactionForAccountInput
): Promise<boolean> {
  const db = getFinanceDb();
  const amountCents = Math.abs(Math.trunc(input.amountCents));
  const preparedRules = await getPreparedTransactionRules();
  const automationResult = applyPreparedTransactionRules(preparedRules, {
    accountId,
    description: input.description,
    amountCents,
    categoryId: input.categoryId,
    tagIds: input.tagIds,
    counterparty: input.counterparty,
  });
  const nextTagIds = normalizeTagIds(automationResult.tagIds);

  const existing = await db
    .select({
      id: transactionsTable.id,
    })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.accountId, accountId), eq(transactionsTable.sourceId, transactionId)))
    .limit(1);

  if (existing.length === 0) {
    return false;
  }
  const existingTransactionId = existing[0]?.id;
  if (typeof existingTransactionId !== "number") {
    throw new Error("Transaction lookup succeeded but transaction id was not returned.");
  }

  await db
    .update(transactionsTable)
    .set({
      bookingDate: input.bookingDate,
      amountCents,
      currency: input.currency,
      direction: input.direction,
      description: input.description,
      categoryId: automationResult.categoryId ?? null,
      counterparty: automationResult.counterparty ?? null,
      reference: input.reference ?? null,
    })
    .where(and(eq(transactionsTable.accountId, accountId), eq(transactionsTable.sourceId, transactionId)));

  await replaceTransactionTags(existingTransactionId, nextTagIds);
  return true;
}

export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("unique constraint failed") || message.includes("constraint failed");
}
