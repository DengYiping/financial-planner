import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { NormalizedTransaction, StatementProvider } from "@/lib/parsers/types";
import {
  accounts,
  categories,
  transactionRules as transactionRulesTable,
  transactions as transactionsTable,
} from "@/lib/server/db/schema";
import { ensureFinanceSchema, getFinanceDb } from "@/lib/server/turso";
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

export type ImportTransactionsResult = {
  totalCount: number;
  insertedCount: number;
  skippedCount: number;
};

export type CreateTransactionForAccountInput = {
  provider: StatementProvider;
  bookingDate: string;
  amountCents: number;
  currency: string;
  direction: "in" | "out";
  description: string;
  categoryId?: number;
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
export type CreateCategoryInput = {
  name: string;
};
export type UpdateCategoryInput = {
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

async function getPreparedTransactionRules(): Promise<PreparedTransactionRule[]> {
  const rules = await listTransactionRules();
  return prepareTransactionRules(rules);
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

  const transactionsByAccount = new Map<number, NormalizedTransaction[]>();

  rows.forEach((row) => {
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
  await ensureFinanceSchema();
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

  const importedTransactionCount = await countImportedTransactions();
  const transactions: DashboardTransactionRow[] = rows.map((row) => {
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
  await ensureFinanceSchema();
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
  await ensureFinanceSchema();
  const db = getFinanceDb();
  const rows = await db.select().from(categories).orderBy(asc(categories.name), asc(categories.id));
  return rows.map(toCategoryRecord);
}

export async function createCategory(input: CreateCategoryInput): Promise<CategoryRecord> {
  await ensureFinanceSchema();
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
  await ensureFinanceSchema();
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
  await ensureFinanceSchema();
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

  return {
    ...mapTransactionRuleRow(row),
    applyCategoryName: row.applyCategoryName ?? undefined,
  };
}

export async function listTransactionRules(): Promise<TransactionRuleRecord[]> {
  await ensureFinanceSchema();
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

  return rows.map((row) => ({
    ...mapTransactionRuleRow(row),
    applyCategoryName: row.applyCategoryName ?? undefined,
  }));
}

export async function createTransactionRule(
  input: CreateTransactionRuleInput
): Promise<TransactionRuleRecord> {
  await ensureFinanceSchema();
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
  await ensureFinanceSchema();
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

  return getTransactionRuleByIdInternal(ruleId);
}

export async function deleteTransactionRule(ruleId: number): Promise<boolean> {
  await ensureFinanceSchema();
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
  await ensureFinanceSchema();
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

  let updatedCount = 0;

  for (const row of rows) {
    const amountCents = Math.abs(Math.trunc(toNumberValue(row.amountCents)));
    const automationResult = applyPreparedTransactionRules(preparedRules, {
      accountId: row.accountId,
      description: row.description,
      amountCents,
      categoryId: row.categoryId ?? undefined,
    });

    const nextCategoryId = automationResult.categoryId ?? null;
    const nextCounterparty = automationResult.counterparty ?? null;
    const currentCategoryId = row.categoryId ?? null;
    const currentCounterparty = row.counterparty ?? null;

    if (currentCategoryId === nextCategoryId && currentCounterparty === nextCounterparty) {
      continue;
    }

    await db
      .update(transactionsTable)
      .set({
        categoryId: nextCategoryId,
        counterparty: nextCounterparty,
      })
      .where(eq(transactionsTable.id, row.id));

    updatedCount += 1;
  }

  return {
    totalCount: rows.length,
    updatedCount,
  };
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
  const preparedRules = await getPreparedTransactionRules();

  await db
    .insert(transactionsTable)
    .values(
      transactions.map((transaction) => {
        const amountCents = Math.abs(Math.trunc(transaction.amountCents));
        const automationResult = applyPreparedTransactionRules(preparedRules, {
          accountId,
          description: transaction.description,
          amountCents,
          categoryId: transaction.categoryId,
        });

        return {
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
        };
      })
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

export async function createTransactionForAccount(
  accountId: number,
  input: CreateTransactionForAccountInput
): Promise<CreateTransactionForAccountResult> {
  await ensureFinanceSchema();
  const db = getFinanceDb();
  const amountCents = Math.abs(Math.trunc(input.amountCents));
  const preparedRules = await getPreparedTransactionRules();
  const automationResult = applyPreparedTransactionRules(preparedRules, {
    accountId,
    description: input.description,
    amountCents,
    categoryId: input.categoryId,
    counterparty: input.counterparty,
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const sourceId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${attempt}`;

    try {
      await db.insert(transactionsTable).values({
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
      });

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
  await ensureFinanceSchema();
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
  await ensureFinanceSchema();
  const db = getFinanceDb();
  const amountCents = Math.abs(Math.trunc(input.amountCents));
  const preparedRules = await getPreparedTransactionRules();
  const automationResult = applyPreparedTransactionRules(preparedRules, {
    accountId,
    description: input.description,
    amountCents,
    categoryId: input.categoryId,
    counterparty: input.counterparty,
  });

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

  return true;
}

export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("unique constraint failed") || message.includes("constraint failed");
}
