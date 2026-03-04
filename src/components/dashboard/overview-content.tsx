"use client";

import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ACCOUNT_COLORS,
  ACCOUNT_KIND_CONFIG,
  type AccountCurrency,
  type AccountImportSummary,
  type AccountKind,
  type AccountState,
  type ComparableTransaction,
  type ImportConflictAction,
  type ImportPreviewConflict,
  type PersistedAccountSnapshot,
  buildDefaultAccountName,
  formatCurrencyCents,
  formatMonthLabel,
  getAccountTypeLabel,
  mergePersistedAccounts,
  resolveErrorMessage,
  REVOLUT_CURRENT_CURRENCIES,
} from "@/components/dashboard/dashboard-shared";
import { ImportReviewModal } from "@/components/dashboard/import-review-modal";
import { SectionShell } from "@/components/dashboard/section-shell";
import { type NormalizedTransaction, parseStatement, ParserNotImplementedError } from "@/lib/parsers";
import { trpc } from "@/trpc/react";

type OverviewContentProps = {
  initialAccounts: PersistedAccountSnapshot[];
  initialBudgetPlannerView: {
    month: string;
    rows: Array<{
      categoryName: string;
      currency: string;
      spentCents: number;
      transactionCount: number;
    }>;
  };
  mode?: "overview" | "data_intake";
};

type UploadContext = {
  accountId: number;
  accountName: string;
  uploadedFileNames: string[];
  parsedTransactions: NormalizedTransaction[];
  parsedFileCount: number;
  warnings: string[];
  parserError?: string;
};

type NormalizedPreviewImport = {
  totalCount: number;
  duplicateSkippedCount: number;
  autoCancelled: boolean;
  cancelReason?: string;
  conflicts: ImportPreviewConflict[];
};

type UploadCommitContext = UploadContext & {
  preview: NormalizedPreviewImport;
};

type PendingImportReviewState = UploadCommitContext & {
  conflictActions: Record<number, ImportConflictAction>;
};

type UnknownRecord = Record<string, unknown>;
type SpendingPieSlice = {
  categoryName: string;
  spentCents: number;
  sharePercent: number;
  color: string;
  startPercent: number;
  endPercent: number;
  href: string;
};

type SpendingComparisonRow = {
  categoryName: string;
  baseSpentCents: number;
  compareSpentCents: number;
  deltaCents: number;
  deltaPercent: number | null;
};

const SPENDING_PIE_COLORS = [
  "#0C8A69",
  "#0673A6",
  "#B56A16",
  "#8E5EA2",
  "#D14B66",
  "#2E7867",
  "#B14747",
  "#5B7CBA",
  "#6B8F2A",
  "#C26D3A",
];

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }

  return value;
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toDirection(value: unknown): "in" | "out" | undefined {
  return value === "in" || value === "out" ? value : undefined;
}

function toComparableTransaction(value: unknown): ComparableTransaction | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const amountCents = toNonNegativeInteger(value.amountCents);
  const transaction: ComparableTransaction = {
    id: toOptionalString(value.id),
    bookingDate: toOptionalString(value.bookingDate),
    amountCents,
    currency: toOptionalString(value.currency),
    direction: toDirection(value.direction),
    description: toOptionalString(value.description),
    counterparty: toOptionalString(value.counterparty),
    reference: toOptionalString(value.reference),
  };

  const hasAnyField = Object.values(transaction).some((entry) => typeof entry !== "undefined");
  return hasAnyField ? transaction : undefined;
}

function toCoverage(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function normalizePreviewImportResponse(rawResponse: unknown, parsed: NormalizedTransaction[]): NormalizedPreviewImport {
  const response = isRecord(rawResponse) ? rawResponse : {};
  const conflictEntries = Array.isArray(response.conflicts) ? response.conflicts : [];

  const conflicts: ImportPreviewConflict[] = conflictEntries.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const incomingIndex = toNonNegativeInteger(entry.incomingIndex);
    if (typeof incomingIndex !== "number") {
      return [];
    }

    const incomingTransaction = parsed[incomingIndex];
    if (!incomingTransaction) {
      return [];
    }

    const existingCandidate =
      entry.existingTransaction ??
      entry.existingTxn ??
      entry.existing ??
      entry.matchedTransaction ??
      entry.matchedExistingTransaction;

    return [
      {
        incomingIndex,
        incomingTransaction,
        existingTransaction: toComparableTransaction(existingCandidate),
        coverage: toCoverage(entry.coverage ?? entry.matchCoverage),
        reason: toOptionalString(entry.reason ?? entry.conflictReason),
      },
    ];
  });

  return {
    totalCount: toNonNegativeInteger(response.totalCount) ?? parsed.length,
    duplicateSkippedCount:
      toNonNegativeInteger(response.duplicateSkippedCount) ??
      toNonNegativeInteger(response.skippedCount) ??
      0,
    autoCancelled: Boolean(response.autoCancelled),
    cancelReason: toOptionalString(response.cancelReason),
    conflicts,
  };
}

function dedupeIndexes(indexes: number[]): number[] {
  return Array.from(
    new Set(
      indexes.filter((index) => {
        return Number.isInteger(index) && index >= 0;
      })
    )
  ).sort((left, right) => left - right);
}

function buildConflictActionMap(conflicts: ImportPreviewConflict[]): Record<number, ImportConflictAction> {
  const actions: Record<number, ImportConflictAction> = {};
  conflicts.forEach((conflict) => {
    actions[conflict.incomingIndex] = "keep_existing";
  });

  return actions;
}

function mergeErrorMessages(messages: Array<string | undefined>): string | undefined {
  const merged = messages
    .filter((message): message is string => Boolean(message))
    .join(" | ");

  return merged.length > 0 ? merged : undefined;
}

function buildAutoCancelledSummary(preview: NormalizedPreviewImport, fallbackReason: string): AccountImportSummary {
  return {
    totalCount: preview.totalCount,
    insertedCount: 0,
    duplicateSkippedCount: preview.duplicateSkippedCount,
    forcedImportedCount: 0,
    conflictsReviewedCount: preview.conflicts.length,
    autoCancelled: true,
    autoCancelReason: preview.cancelReason ?? fallbackReason,
  };
}

function buildCommitImportSummary(
  rawResponse: unknown,
  preview: NormalizedPreviewImport,
  forceImportIndexes: number[]
): AccountImportSummary {
  const response = isRecord(rawResponse) ? rawResponse : {};
  const totalCount = toNonNegativeInteger(response.totalCount) ?? preview.totalCount;
  const insertedCount = toNonNegativeInteger(response.insertedCount) ?? 0;
  const skippedCount = toNonNegativeInteger(response.skippedCount) ?? Math.max(totalCount - insertedCount, 0);
  const forcedImportedCount =
    toNonNegativeInteger(response.forcedImportCount) ??
    toNonNegativeInteger(response.forcedImportedCount) ??
    forceImportIndexes.length;

  return {
    totalCount,
    insertedCount,
    duplicateSkippedCount:
      toNonNegativeInteger(response.duplicateSkippedCount) ?? Math.max(skippedCount - forcedImportedCount, 0),
    forcedImportedCount,
    conflictsReviewedCount: toNonNegativeInteger(response.conflictsReviewedCount) ?? preview.conflicts.length,
    autoCancelled: Boolean(response.autoCancelled),
    autoCancelReason: toOptionalString(response.cancelReason),
  };
}

function buildSpendingTransactionsHref(month: string, categoryName: string): string {
  const params = new URLSearchParams();
  params.set("startMonth", month);
  params.set("endMonth", month);
  params.set("category", categoryName);
  params.set("direction", "outflow");
  return `/transactions?${params.toString()}`;
}

function toMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function OverviewContent({ initialAccounts, initialBudgetPlannerView, mode = "overview" }: OverviewContentProps) {
  const [draftKind, setDraftKind] = useState<AccountKind>("aib_current");
  const [draftRevolutCurrency, setDraftRevolutCurrency] = useState<AccountCurrency>("EUR");

  const accountsQuery = trpc.accounts.list.useQuery(undefined, {
    initialData: initialAccounts,
  });
  const budgetPlannerViewQuery = trpc.accounts.budgetPlannerView.useQuery(undefined, {
    initialData: initialBudgetPlannerView,
  });
  const createAccountMutation = trpc.accounts.create.useMutation();
  const deleteAccountMutation = trpc.accounts.delete.useMutation();
  const clearAccountMutation = trpc.accounts.clearAccount.useMutation();
  const previewImportTransactionsMutation = trpc.accounts.previewImportTransactions.useMutation();
  const importTransactionsMutation = trpc.accounts.importTransactions.useMutation();

  const [accounts, setAccounts] = useState<AccountState[]>(() => mergePersistedAccounts([], initialAccounts));
  const [deletingAccountIds, setDeletingAccountIds] = useState<Set<number>>(new Set());
  const [clearingAccountIds, setClearingAccountIds] = useState<Set<number>>(new Set());
  const [dataError, setDataError] = useState<string | null>(null);
  const [pendingImportReview, setPendingImportReview] = useState<PendingImportReviewState | null>(null);
  const [pendingImportReviewError, setPendingImportReviewError] = useState<string | null>(null);
  const [hoveredSpendingSliceCategoryName, setHoveredSpendingSliceCategoryName] = useState<string | null>(null);
  const [comparisonBaseMonth, setComparisonBaseMonth] = useState<string>("");
  const [comparisonTargetMonth, setComparisonTargetMonth] = useState<string>("");

  const comparisonOptionsViewQuery = trpc.accounts.spendingStatsView.useQuery({});
  const comparisonBaseViewQuery = trpc.accounts.spendingStatsView.useQuery(
    comparisonBaseMonth ? { month: comparisonBaseMonth } : {},
    {
      enabled: comparisonBaseMonth.length > 0,
    }
  );
  const comparisonTargetViewQuery = trpc.accounts.spendingStatsView.useQuery(
    comparisonTargetMonth ? { month: comparisonTargetMonth } : {},
    {
      enabled: comparisonTargetMonth.length > 0,
    }
  );

  const comparisonMonthOptions = useMemo(
    () => comparisonOptionsViewQuery.data?.monthOptions ?? [],
    [comparisonOptionsViewQuery.data?.monthOptions]
  );

  useEffect(() => {
    if (comparisonMonthOptions.length === 0) {
      setComparisonBaseMonth("");
      setComparisonTargetMonth("");
      return;
    }

    const now = new Date();
    const currentMonthKey = toMonthKey(now);
    const previousMonthKey = toMonthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const previousTwoMonthKey = toMonthKey(new Date(now.getFullYear(), now.getMonth() - 2, 1));
    const completedMonthOptions = comparisonMonthOptions.filter((month) => month < currentMonthKey);

    const defaultBaseMonth =
      (completedMonthOptions.includes(previousMonthKey) ? previousMonthKey : completedMonthOptions[0]) ??
      comparisonMonthOptions[0] ??
      "";
    const defaultTargetMonth =
      (completedMonthOptions.includes(previousTwoMonthKey)
        ? previousTwoMonthKey
        : completedMonthOptions.find((month) => month !== defaultBaseMonth)) ??
      comparisonMonthOptions.find((month) => month !== defaultBaseMonth) ??
      defaultBaseMonth;

    setComparisonBaseMonth((currentMonth) =>
      currentMonth && comparisonMonthOptions.includes(currentMonth) ? currentMonth : defaultBaseMonth
    );
    setComparisonTargetMonth((currentMonth) =>
      currentMonth && comparisonMonthOptions.includes(currentMonth) ? currentMonth : defaultTargetMonth
    );
  }, [comparisonMonthOptions]);

  const budgetPlannerRows = budgetPlannerViewQuery.data?.rows ?? initialBudgetPlannerView.rows;
  const budgetPlannerMonth = budgetPlannerViewQuery.data?.month ?? initialBudgetPlannerView.month;
  const visibleBudgetPlannerRows = useMemo(
    () => budgetPlannerRows.filter((row) => row.categoryName.trim().toLocaleLowerCase("en-US") !== "excluded"),
    [budgetPlannerRows]
  );
  const spendingPieSlices = useMemo<SpendingPieSlice[]>(() => {
    const sortedRows = [...visibleBudgetPlannerRows]
      .filter((row) => row.spentCents > 0)
      .sort((left, right) => right.spentCents - left.spentCents || left.categoryName.localeCompare(right.categoryName));
    const totalSpentCents = sortedRows.reduce((sum, row) => sum + row.spentCents, 0);

    let runningShare = 0;
    return sortedRows.map((row, index) => {
      const share = totalSpentCents > 0 ? row.spentCents / totalSpentCents : 0;
      const startPercent = runningShare * 100;
      const endPercent = index === sortedRows.length - 1 ? 100 : (runningShare + share) * 100;
      runningShare += share;

      return {
        categoryName: row.categoryName,
        spentCents: row.spentCents,
        sharePercent: share * 100,
        color: SPENDING_PIE_COLORS[index % SPENDING_PIE_COLORS.length] ?? "#9ba8b5",
        startPercent,
        endPercent,
        href: buildSpendingTransactionsHref(budgetPlannerMonth, row.categoryName),
      };
    });
  }, [visibleBudgetPlannerRows, budgetPlannerMonth]);
  const hoveredSpendingPieSlice = useMemo(
    () => spendingPieSlices.find((slice) => slice.categoryName === hoveredSpendingSliceCategoryName) ?? null,
    [hoveredSpendingSliceCategoryName, spendingPieSlices]
  );
  const spendingPieCircumference = 2 * Math.PI * 40;
  const totalSpentEurCents = useMemo(
    () => visibleBudgetPlannerRows.reduce((sum, row) => sum + row.spentCents, 0),
    [visibleBudgetPlannerRows]
  );
  const spendingShareByCategoryName = useMemo(() => {
    const byCategory = new Map<string, number>();
    visibleBudgetPlannerRows.forEach((row) => {
      if (totalSpentEurCents <= 0) {
        byCategory.set(row.categoryName, 0);
        return;
      }
      byCategory.set(row.categoryName, row.spentCents / totalSpentEurCents);
    });
    return byCategory;
  }, [visibleBudgetPlannerRows, totalSpentEurCents]);

  const comparisonBaseRows = useMemo(
    () =>
      (comparisonBaseViewQuery.data?.rows ?? []).filter(
        (row) => row.categoryName.trim().toLocaleLowerCase("en-US") !== "excluded"
      ),
    [comparisonBaseViewQuery.data?.rows]
  );
  const comparisonTargetRows = useMemo(
    () =>
      (comparisonTargetViewQuery.data?.rows ?? []).filter(
        (row) => row.categoryName.trim().toLocaleLowerCase("en-US") !== "excluded"
      ),
    [comparisonTargetViewQuery.data?.rows]
  );
  const comparisonBaseTotalCents = useMemo(
    () => comparisonBaseRows.reduce((sum, row) => sum + row.spentCents, 0),
    [comparisonBaseRows]
  );
  const comparisonTargetTotalCents = useMemo(
    () => comparisonTargetRows.reduce((sum, row) => sum + row.spentCents, 0),
    [comparisonTargetRows]
  );
  const comparisonTotalDeltaCents = comparisonBaseTotalCents - comparisonTargetTotalCents;
  const spendingComparisonRows = useMemo<SpendingComparisonRow[]>(() => {
    const baseByCategory = new Map<string, number>();
    comparisonBaseRows.forEach((row) => {
      baseByCategory.set(row.categoryName, row.spentCents);
    });

    const targetByCategory = new Map<string, number>();
    comparisonTargetRows.forEach((row) => {
      targetByCategory.set(row.categoryName, row.spentCents);
    });

    const allCategoryNames = new Set<string>([
      ...Array.from(baseByCategory.keys()),
      ...Array.from(targetByCategory.keys()),
    ]);

    return Array.from(allCategoryNames)
      .map((categoryName) => {
        const baseSpentCents = baseByCategory.get(categoryName) ?? 0;
        const compareSpentCents = targetByCategory.get(categoryName) ?? 0;
        const deltaCents = baseSpentCents - compareSpentCents;
        const deltaPercent = compareSpentCents > 0 ? (deltaCents / compareSpentCents) * 100 : null;

        return {
          categoryName,
          baseSpentCents,
          compareSpentCents,
          deltaCents,
          deltaPercent,
        };
      })
      .sort(
        (left, right) =>
          Math.abs(right.deltaCents) - Math.abs(left.deltaCents) || left.categoryName.localeCompare(right.categoryName)
      );
  }, [comparisonBaseRows, comparisonTargetRows]);
  const comparisonQueryErrorMessage = mergeErrorMessages([
    comparisonOptionsViewQuery.error
      ? resolveErrorMessage(comparisonOptionsViewQuery.error, "Failed to load monthly comparison options.")
      : undefined,
    comparisonBaseViewQuery.error
      ? resolveErrorMessage(comparisonBaseViewQuery.error, "Failed to load the base month comparison data.")
      : undefined,
    comparisonTargetViewQuery.error
      ? resolveErrorMessage(comparisonTargetViewQuery.error, "Failed to load the compare month data.")
      : undefined,
  ]);
  const showOverviewSections = mode === "overview";
  const showDataIntakeSection = mode === "data_intake";
  const incomeRowsByMonth = useMemo(() => {
    return new Map(
      (comparisonOptionsViewQuery.data?.incomeRows ?? []).map((row) => [row.month, row] as const)
    );
  }, [comparisonOptionsViewQuery.data?.incomeRows]);
  const selectedIncomeMonth = comparisonOptionsViewQuery.data?.selectedMonth ?? "";
  const selectedIncomeCents = comparisonOptionsViewQuery.data?.selectedIncomeCents ?? 0;
  const selectedIncomeTransactionCount = comparisonOptionsViewQuery.data?.selectedIncomeTransactionCount ?? 0;
  const compareIncomeMonth = comparisonOptionsViewQuery.data?.compareIncomeMonth;
  const compareIncomeCents = comparisonOptionsViewQuery.data?.compareIncomeCents ?? 0;
  const compareIncomeTransactionCount = comparisonOptionsViewQuery.data?.compareIncomeTransactionCount ?? 0;
  const incomeDeltaCents = selectedIncomeCents - compareIncomeCents;
  const incomeDeltaPercent = compareIncomeCents > 0 ? (incomeDeltaCents / compareIncomeCents) * 100 : null;
  const monthlyIncomeTrendRows = useMemo(() => {
    const monthOptions = comparisonOptionsViewQuery.data?.monthOptions ?? [];
    const currentMonthKey = toMonthKey(new Date());
    const completedMonths = monthOptions.filter((month) => month < currentMonthKey);
    const trendMonths = (completedMonths.length > 0 ? completedMonths : monthOptions).slice(0, 6);

    return trendMonths.map((month) => {
      const row = incomeRowsByMonth.get(month);
      return {
        month,
        incomeCents: row?.incomeCents ?? 0,
        transactionCount: row?.transactionCount ?? 0,
      };
    });
  }, [comparisonOptionsViewQuery.data?.monthOptions, incomeRowsByMonth]);

  const isHydratingData = accountsQuery.isPending && accounts.length === 0;
  const isCreatingAccount = createAccountMutation.isPending;
  const queryErrorMessage = accountsQuery.error
    ? resolveErrorMessage(accountsQuery.error, "Failed to hydrate account data from backend.")
    : null;
  const budgetPlannerQueryErrorMessage = budgetPlannerViewQuery.error
    ? resolveErrorMessage(budgetPlannerViewQuery.error, "Failed to load budget planner data.")
    : null;
  const activeDataError = dataError ?? queryErrorMessage ?? budgetPlannerQueryErrorMessage;

  useEffect(() => {
    if (!accountsQuery.data) {
      return;
    }

    setAccounts((current) => mergePersistedAccounts(current, accountsQuery.data));
  }, [accountsQuery.data]);

  async function refetchOverviewData() {
    const [accountsRefresh] = await Promise.all([
      accountsQuery.refetch(),
      budgetPlannerViewQuery.refetch(),
      comparisonOptionsViewQuery.refetch(),
    ]);

    if (comparisonBaseMonth.length > 0) {
      await comparisonBaseViewQuery.refetch();
    }
    if (comparisonTargetMonth.length > 0) {
      await comparisonTargetViewQuery.refetch();
    }

    return accountsRefresh;
  }

  async function handleAddAccount() {
    if (isCreatingAccount) {
      return;
    }

    const kindConfig = ACCOUNT_KIND_CONFIG[draftKind];
    const currency = kindConfig.requiresCurrency ? draftRevolutCurrency : undefined;
    const sameTypeCount =
      accounts.filter(
        (account) =>
          account.kind === draftKind && (account.currency ?? "none") === (currency ?? "none")
      ).length + 1;
    const draftName = buildDefaultAccountName(draftKind, currency, sameTypeCount);

    setDataError(null);

    try {
      await createAccountMutation.mutateAsync({
        name: draftName,
        kind: draftKind,
        provider: kindConfig.provider,
        currency,
        color: ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length],
      });
      await refetchOverviewData();
    } catch (error) {
      setDataError(resolveErrorMessage(error, "Could not add account."));
    }
  }

  async function handleDeleteAccount(account: AccountState) {
    if (isHydratingData || deletingAccountIds.has(account.id) || account.status === "loading") {
      return;
    }

    const transactionCount = account.transactions.length;
    const confirmed = window.confirm(
      `Delete "${account.name}"? This will remove the account and ${transactionCount} imported transaction${
        transactionCount === 1 ? "" : "s"
      }. This action cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    setDeletingAccountIds((current) => {
      const next = new Set(current);
      next.add(account.id);
      return next;
    });
    setDataError(null);

    try {
      await deleteAccountMutation.mutateAsync({
        accountId: account.id,
      });
      setAccounts((current) => current.filter((entry) => entry.id !== account.id));
      await refetchOverviewData();
    } catch (error) {
      setDataError(resolveErrorMessage(error, "Could not delete account."));
    } finally {
      setDeletingAccountIds((current) => {
        const next = new Set(current);
        next.delete(account.id);
        return next;
      });
    }
  }

  async function handleClearAccount(account: AccountState) {
    if (
      isHydratingData ||
      clearingAccountIds.has(account.id) ||
      deletingAccountIds.has(account.id) ||
      account.status === "loading"
    ) {
      return;
    }

    const confirmed = window.confirm(
      `Clear "${account.name}"? This will remove all ${account.recordCount} transaction record${
        account.recordCount === 1 ? "" : "s"
      } from this account, but keep the account itself.`
    );

    if (!confirmed) {
      return;
    }

    setClearingAccountIds((current) => {
      const next = new Set(current);
      next.add(account.id);
      return next;
    });
    setDataError(null);

    try {
      await clearAccountMutation.mutateAsync({
        accountId: account.id,
      });
      await refetchOverviewData();
    } catch (error) {
      setDataError(resolveErrorMessage(error, "Could not clear account transactions."));
    } finally {
      setClearingAccountIds((current) => {
        const next = new Set(current);
        next.delete(account.id);
        return next;
      });
    }
  }

  function finalizeUploadWithoutPersist(
    context: UploadContext,
    status: "success" | "error",
    errorMessage: string | undefined,
    summary?: AccountImportSummary
  ) {
    setAccounts((current) =>
      current.map((entry) => {
        if (entry.id !== context.accountId) {
          return entry;
        }

        return {
          ...entry,
          status,
          lastUploadedFiles: context.uploadedFileNames,
          parsedFileCountTotal: entry.parsedFileCountTotal + context.parsedFileCount,
          parsedFileCount: context.parsedFileCount,
          parsedCount: context.parsedTransactions.length,
          warnings: context.warnings,
          error: errorMessage,
          lastImportSummary: summary,
        };
      })
    );
  }

  async function commitParsedImport(context: UploadCommitContext, forceImportIndexes: number[]): Promise<void> {
    const dedupedForceImportIndexes = dedupeIndexes(forceImportIndexes);

    setAccounts((current) =>
      current.map((entry) =>
        entry.id === context.accountId
          ? {
              ...entry,
              status: "loading",
              error: undefined,
            }
          : entry
      )
    );

    const importResponse = await importTransactionsMutation.mutateAsync({
      accountId: context.accountId,
      transactions: context.parsedTransactions,
      forceImportIndexes: dedupedForceImportIndexes.length > 0 ? dedupedForceImportIndexes : undefined,
    });

    const importSummary = buildCommitImportSummary(importResponse, context.preview, dedupedForceImportIndexes);
    const refreshed = await refetchOverviewData();
    if (refreshed.error) {
      throw refreshed.error;
    }

    const persistedSnapshot = refreshed.data ?? [];
    setAccounts((current) => {
      const merged = mergePersistedAccounts(current, persistedSnapshot);

      return merged.map((entry) => {
        if (entry.id !== context.accountId) {
          return entry;
        }

        const currentEntry = current.find((candidate) => candidate.id === context.accountId);

        return {
          ...entry,
          status: context.parserError ? "error" : "success",
          lastUploadedFiles: context.uploadedFileNames,
          parsedFileCountTotal: (currentEntry?.parsedFileCountTotal ?? 0) + context.parsedFileCount,
          parsedFileCount: context.parsedFileCount,
          parsedCount: context.parsedTransactions.length,
          importedTotal: entry.recordCount,
          warnings: context.warnings,
          error: context.parserError,
          lastImportSummary: importSummary,
          transactions: entry.transactions,
        };
      });
    });
  }

  function getUploadButtonLabel(account: AccountState): string {
    if (account.status !== "loading") {
      return "Upload CSVs";
    }

    if (importTransactionsMutation.isPending) {
      return "Importing...";
    }

    if (pendingImportReview?.accountId === account.id) {
      return "Reviewing...";
    }

    if (previewImportTransactionsMutation.isPending) {
      return "Previewing...";
    }

    return "Parsing...";
  }

  function handleConflictActionChange(incomingIndex: number, action: ImportConflictAction) {
    setPendingImportReview((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        conflictActions: {
          ...current.conflictActions,
          [incomingIndex]: action,
        },
      };
    });
  }

  function handleClosePendingImportReview() {
    if (!pendingImportReview || importTransactionsMutation.isPending) {
      return;
    }

    const summary = buildAutoCancelledSummary(
      pendingImportReview.preview,
      "Import cancelled during conflict review."
    );
    finalizeUploadWithoutPersist(
      pendingImportReview,
      pendingImportReview.parserError ? "error" : "success",
      pendingImportReview.parserError,
      summary
    );

    setPendingImportReview(null);
    setPendingImportReviewError(null);
  }

  async function handleCommitPendingImportReview() {
    if (!pendingImportReview) {
      return;
    }

    const forceImportIndexes = dedupeIndexes(
      pendingImportReview.preview.conflicts
        .filter((conflict) => pendingImportReview.conflictActions[conflict.incomingIndex] === "force_import")
        .map((conflict) => conflict.incomingIndex)
    );

    setPendingImportReviewError(null);

    try {
      await commitParsedImport(pendingImportReview, forceImportIndexes);
      setPendingImportReview(null);
      setPendingImportReviewError(null);
    } catch (error) {
      setPendingImportReviewError(
        resolveErrorMessage(error, "Failed to commit import after reviewing conflicts.")
      );
    }
  }

  async function handleAccountUpload(accountId: number, event: ChangeEvent<HTMLInputElement>) {
    const inputElement = event.currentTarget;
    const files = Array.from(inputElement.files ?? []);
    if (files.length === 0) {
      return;
    }

    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) {
      return;
    }

    const uploadedFileNames = files.map((file) => file.name);
    const parsedTransactions: NormalizedTransaction[] = [];
    let parsedFileCount = 0;
    const warnings: string[] = [];
    const errors: string[] = [];

    setPendingImportReview(null);
    setPendingImportReviewError(null);

    setAccounts((current) =>
      current.map((entry) =>
        entry.id === accountId
          ? {
              ...entry,
              status: "loading",
              lastUploadedFiles: uploadedFileNames,
              error: undefined,
              lastImportSummary: undefined,
            }
          : entry
      )
    );

    try {
      for (const file of files) {
        const csvContent = await file.text();

        try {
          const result = parseStatement(account.provider, {
            csvContent,
            fileName: file.name,
          });

          if (account.kind === "revolut_current" && account.currency) {
            const mismatchCount = result.transactions.filter(
              (transaction) => transaction.currency !== account.currency
            ).length;

            if (mismatchCount > 0) {
              warnings.push(
                `${file.name}: ${mismatchCount} transaction${
                  mismatchCount === 1 ? "" : "s"
                } currency does not match account setting (${account.currency}).`
              );
            }
          }

          parsedFileCount += 1;
          parsedTransactions.push(...result.transactions);
          warnings.push(...result.warnings.map((warning) => `${file.name}: ${warning}`));
        } catch (error) {
          const message =
            error instanceof ParserNotImplementedError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Unexpected parser failure.";

          errors.push(`${file.name}: ${message}`);

          if (error instanceof ParserNotImplementedError) {
            break;
          }
        }
      }

      const parserError = errors.length > 0 ? errors.join(" | ") : undefined;
      const uploadContext: UploadContext = {
        accountId,
        accountName: account.name,
        uploadedFileNames,
        parsedTransactions,
        parsedFileCount,
        warnings,
        parserError,
      };

      if (parsedTransactions.length === 0) {
        finalizeUploadWithoutPersist(uploadContext, errors.length > 0 ? "error" : "success", parserError);
        return;
      }

      const previewResponse = await previewImportTransactionsMutation.mutateAsync({
        accountId,
        transactions: parsedTransactions,
      });
      const normalizedPreview = normalizePreviewImportResponse(previewResponse, parsedTransactions);

      if (normalizedPreview.autoCancelled) {
        const summary = buildAutoCancelledSummary(
          normalizedPreview,
          "Import auto-cancelled by duplicate protection."
        );
        finalizeUploadWithoutPersist(
          uploadContext,
          parserError ? "error" : "success",
          parserError,
          summary
        );
        return;
      }

      if (normalizedPreview.conflicts.length > 0) {
        setPendingImportReview({
          ...uploadContext,
          preview: normalizedPreview,
          conflictActions: buildConflictActionMap(normalizedPreview.conflicts),
        });
        return;
      }

      await commitParsedImport(
        {
          ...uploadContext,
          preview: normalizedPreview,
        },
        []
      );
    } catch (error) {
      const parserError = errors.length > 0 ? errors.join(" | ") : undefined;
      const uploadContext: UploadContext = {
        accountId,
        accountName: account.name,
        uploadedFileNames,
        parsedTransactions,
        parsedFileCount,
        warnings,
        parserError,
      };
      const persistenceError = resolveErrorMessage(error, "Failed to process uploaded files.");
      const mergedError = mergeErrorMessages([parserError, persistenceError]);

      finalizeUploadWithoutPersist(uploadContext, "error", mergedError);
    } finally {
      inputElement.value = "";
    }
  }

  return (
    <>
      <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
        <div
          className={
            showOverviewSections ? "grid gap-6 xl:grid-cols-[1.05fr_0.95fr] xl:items-start" : "space-y-6"
          }
        >
          {showOverviewSections ? (
            <SectionShell
            title="Month-over-Month Comparison"
            subtitle="Complete-month spending shifts by category, with direct links into transactions."
            className="relative overflow-hidden before:pointer-events-none before:absolute before:-right-16 before:-top-16 before:h-48 before:w-48 before:rounded-full before:bg-accent/10"
            >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                  Base
                  <select
                    value={comparisonBaseMonth}
                    onChange={(event) => {
                      setComparisonBaseMonth(event.target.value);
                    }}
                    disabled={comparisonMonthOptions.length === 0}
                    className="rounded-full border border-ink-soft/20 bg-surface px-3 py-1 text-xs text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {comparisonMonthOptions.length === 0 ? (
                      <option value="">No months</option>
                    ) : (
                      comparisonMonthOptions.map((month) => (
                        <option key={`comparison-base-${month}`} value={month}>
                          {formatMonthLabel(month)}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                  Compare
                  <select
                    value={comparisonTargetMonth}
                    onChange={(event) => {
                      setComparisonTargetMonth(event.target.value);
                    }}
                    disabled={comparisonMonthOptions.length === 0}
                    className="rounded-full border border-ink-soft/20 bg-surface px-3 py-1 text-xs text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {comparisonMonthOptions.length === 0 ? (
                      <option value="">No months</option>
                    ) : (
                      comparisonMonthOptions.map((month) => (
                        <option key={`comparison-target-${month}`} value={month}>
                          {formatMonthLabel(month)}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>
            </div>

            {comparisonQueryErrorMessage ? (
              <p className="mt-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
                {comparisonQueryErrorMessage}
              </p>
            ) : comparisonMonthOptions.length === 0 ? (
              <p className="mt-3 rounded-xl border border-ink-soft/15 bg-surface p-3 text-xs text-muted">
                No monthly statistics available yet.
              </p>
            ) : comparisonBaseMonth.length === 0 || comparisonTargetMonth.length === 0 ? (
              <p className="mt-3 rounded-xl border border-ink-soft/15 bg-surface p-3 text-xs text-muted">
                Select two months to compare category spending.
              </p>
            ) : comparisonOptionsViewQuery.isPending ||
              comparisonBaseViewQuery.isPending ||
              comparisonTargetViewQuery.isPending ? (
              <p className="mt-3 rounded-xl border border-ink-soft/15 bg-surface p-3 text-xs text-muted">
                Loading month comparison...
              </p>
            ) : spendingComparisonRows.length === 0 ? (
              <p className="mt-3 rounded-xl border border-ink-soft/15 bg-surface p-3 text-xs text-muted">
                No outflow category data found for the selected month pair.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-xl border border-ink-soft/15 bg-surface/80 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                      {formatMonthLabel(comparisonBaseMonth)}
                    </p>
                    <p className="mt-1 font-mono text-sm text-foreground">
                      {formatCurrencyCents(comparisonBaseTotalCents, "EUR", "en-IE")}
                    </p>
                  </div>
                  <div className="rounded-xl border border-ink-soft/15 bg-surface/80 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                      {formatMonthLabel(comparisonTargetMonth)}
                    </p>
                    <p className="mt-1 font-mono text-sm text-foreground">
                      {formatCurrencyCents(comparisonTargetTotalCents, "EUR", "en-IE")}
                    </p>
                  </div>
                  <div className="rounded-xl border border-ink-soft/15 bg-surface/80 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                      Change (Base - Compare)
                    </p>
                    <p
                      className={`mt-1 font-mono text-sm ${
                        comparisonTotalDeltaCents > 0
                          ? "text-danger"
                          : comparisonTotalDeltaCents < 0
                            ? "text-positive"
                            : "text-muted"
                      }`}
                    >
                      {comparisonTotalDeltaCents >= 0 ? "+" : "-"}
                      {formatCurrencyCents(Math.abs(comparisonTotalDeltaCents), "EUR", "en-IE")}
                    </p>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] border-separate border-spacing-y-2">
                    <thead className="text-left text-[11px] uppercase tracking-[0.1em] text-muted">
                      <tr>
                        <th className="px-3 py-1.5">Category</th>
                        <th className="px-3 py-1.5 text-right">{formatMonthLabel(comparisonBaseMonth)}</th>
                        <th className="px-3 py-1.5 text-right">{formatMonthLabel(comparisonTargetMonth)}</th>
                        <th className="px-3 py-1.5 text-right">Delta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spendingComparisonRows.map((row) => {
                        const baseMonthHref = buildSpendingTransactionsHref(comparisonBaseMonth, row.categoryName);
                        const targetMonthHref = buildSpendingTransactionsHref(comparisonTargetMonth, row.categoryName);
                        return (
                          <tr key={`comparison-${row.categoryName}`} className="rounded-xl bg-surface/80">
                            <td className="rounded-l-xl border border-r-0 border-ink-soft/15 px-3 py-2 text-xs text-foreground">
                              <Link
                                href={baseMonthHref}
                                className="underline decoration-ink-soft/30 underline-offset-4 transition hover:decoration-accent"
                              >
                                {row.categoryName}
                              </Link>
                            </td>
                            <td className="border-y border-ink-soft/15 px-3 py-2 text-right font-mono text-xs text-foreground">
                              <Link
                                href={baseMonthHref}
                                className="underline decoration-ink-soft/30 underline-offset-4 transition hover:decoration-accent"
                              >
                                {formatCurrencyCents(row.baseSpentCents, "EUR", "en-IE")}
                              </Link>
                            </td>
                            <td className="border-y border-ink-soft/15 px-3 py-2 text-right font-mono text-xs text-foreground">
                              <Link
                                href={targetMonthHref}
                                className="underline decoration-ink-soft/30 underline-offset-4 transition hover:decoration-accent"
                              >
                                {formatCurrencyCents(row.compareSpentCents, "EUR", "en-IE")}
                              </Link>
                            </td>
                            <td
                              className={`rounded-r-xl border border-l-0 border-ink-soft/15 px-3 py-2 text-right font-mono text-xs ${
                                row.deltaCents > 0 ? "text-danger" : row.deltaCents < 0 ? "text-positive" : "text-muted"
                              }`}
                            >
                              {row.deltaCents >= 0 ? "+" : "-"}
                              {formatCurrencyCents(Math.abs(row.deltaCents), "EUR", "en-IE")}
                              <span className="ml-1 text-[10px] text-muted">
                                {row.deltaPercent === null ? "(new)" : `(${row.deltaPercent.toFixed(1)}%)`}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            </SectionShell>
          ) : null}

          {showDataIntakeSection ? (
            <SectionShell
            title="Data Intake"
            subtitle="Add accounts by type and upload statement files directly into each account."
            >
            <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border border-ink-soft/15 bg-surface p-4">
              <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                Account Type
                <select
                  value={draftKind}
                  onChange={(event) => {
                    setDraftKind(event.target.value as AccountKind);
                  }}
                  disabled={isHydratingData || isCreatingAccount}
                  className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                >
                  {(Object.keys(ACCOUNT_KIND_CONFIG) as AccountKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {ACCOUNT_KIND_CONFIG[kind].label}
                    </option>
                  ))}
                </select>
              </label>

              {draftKind === "revolut_current" && (
                <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                  Currency
                  <select
                    value={draftRevolutCurrency}
                    onChange={(event) => {
                      setDraftRevolutCurrency(event.target.value as AccountCurrency);
                    }}
                    disabled={isHydratingData || isCreatingAccount}
                    className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                  >
                    {REVOLUT_CURRENT_CURRENCIES.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <button
                type="button"
                onClick={handleAddAccount}
                disabled={isHydratingData || isCreatingAccount}
                className="rounded-full border border-accent/40 bg-accent/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-accent transition hover:bg-accent/20"
              >
                {isCreatingAccount ? "Adding..." : "Add Account"}
              </button>
            </div>

            {isHydratingData && (
              <p className="mb-4 rounded-2xl border border-ink-soft/15 bg-surface p-4 text-sm text-muted">
                Loading persisted accounts and transactions...
              </p>
            )}

            {activeDataError && (
              <p className="mb-4 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                {activeDataError}
              </p>
            )}

            {!isHydratingData && accounts.length === 0 ? (
              <p className="rounded-2xl border border-ink-soft/15 bg-surface p-4 text-sm text-muted">
                No accounts yet. Add an account type above, then upload files into that account.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {accounts.map((account) => (
                  <article key={account.id} className="rounded-2xl border border-ink-soft/15 bg-surface p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-foreground">{account.name}</h3>
                        <p className="mt-1 text-xs text-muted">{getAccountTypeLabel(account.kind, account.currency)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-3 w-3 rounded-full"
                          style={{ backgroundColor: account.color }}
                          aria-label="account color"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            void handleClearAccount(account);
                          }}
                          disabled={
                            isHydratingData ||
                            account.status === "loading" ||
                            deletingAccountIds.has(account.id) ||
                            clearingAccountIds.has(account.id)
                          }
                          className="rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-warning transition hover:bg-warning/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {clearingAccountIds.has(account.id) ? "Clearing..." : "Clear"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void handleDeleteAccount(account);
                          }}
                          disabled={
                            isHydratingData ||
                            account.status === "loading" ||
                            deletingAccountIds.has(account.id) ||
                            clearingAccountIds.has(account.id)
                          }
                          className="rounded-full border border-danger/40 bg-danger/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-danger transition hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {deletingAccountIds.has(account.id) ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center gap-3">
                      <label className="inline-flex cursor-pointer items-center rounded-full border border-accent/40 bg-accent/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-accent transition hover:bg-accent/20">
                        {getUploadButtonLabel(account)}
                        <input
                          type="file"
                          accept=".csv,text/csv"
                          multiple
                          className="sr-only"
                          onChange={(event) => {
                            void handleAccountUpload(account.id, event);
                          }}
                          disabled={
                            account.status === "loading" ||
                            deletingAccountIds.has(account.id) ||
                            clearingAccountIds.has(account.id) ||
                            pendingImportReview !== null
                          }
                        />
                      </label>
                      <p className="font-mono text-xs text-muted">
                        {account.lastUploadedFiles.length > 0
                          ? `${account.lastUploadedFiles.length} file${
                              account.lastUploadedFiles.length === 1 ? "" : "s"
                            } selected`
                          : "No file selected"}
                      </p>
                    </div>

                    <div className="mt-4 space-y-2 text-sm">
                      <p className="text-foreground">
                        Records in account (DB): <span className="font-semibold">{account.recordCount}</span>
                      </p>
                      <p className="text-foreground">
                        Imported transactions total: <span className="font-semibold">{account.importedTotal}</span>
                      </p>
                      <p className="text-foreground">
                        Parsed files total: <span className="font-semibold">{account.parsedFileCountTotal}</span>
                      </p>
                      <p className="text-foreground">
                        Parsed files this upload: <span className="font-semibold">{account.parsedFileCount}</span>
                      </p>
                      <p className="text-foreground">
                        Parsed transactions this upload: <span className="font-semibold">{account.parsedCount}</span>
                      </p>

                      {account.lastImportSummary ? (
                        <div className="rounded-xl border border-ink-soft/15 bg-surface/80 p-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                            Last Import Summary
                          </p>
                          <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                            <p className="text-foreground">
                              Inserted: <span className="font-semibold">{account.lastImportSummary.insertedCount}</span>
                            </p>
                            <p className="text-foreground">
                              Duplicate skipped:{" "}
                              <span className="font-semibold">{account.lastImportSummary.duplicateSkippedCount}</span>
                            </p>
                            <p className="text-foreground">
                              Forced imported:{" "}
                              <span className="font-semibold">{account.lastImportSummary.forcedImportedCount}</span>
                            </p>
                            <p className="text-foreground">
                              Conflicts reviewed:{" "}
                              <span className="font-semibold">{account.lastImportSummary.conflictsReviewedCount}</span>
                            </p>
                          </div>
                          {account.lastImportSummary.autoCancelled ? (
                            <p className="mt-2 rounded-lg border border-warning/35 bg-warning/10 px-2 py-1 text-xs text-warning">
                              Auto-cancelled: {account.lastImportSummary.autoCancelReason ?? "No reason provided."}
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      {account.warnings.length > 0 && (
                        <p className="text-warning">
                          {account.warnings.length} warning{account.warnings.length === 1 ? "" : "s"}
                        </p>
                      )}
                      {account.error && <p className="text-danger">{account.error}</p>}
                    </div>
                  </article>
                ))}
              </div>
            )}
            </SectionShell>
          ) : null}

          {showOverviewSections ? (
            <SectionShell
            title="Last Month Spending Stats"
            subtitle={`Category statistics from ${formatMonthLabel(
              budgetPlannerMonth
            )} (excluding current month).`}
            className="relative overflow-hidden before:pointer-events-none before:absolute before:-left-16 before:-bottom-20 before:h-56 before:w-56 before:rounded-full before:bg-ink-soft/10"
            action={
              <Link
                href="/statistics"
                className="rounded-full border border-accent/35 bg-accent/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-accent transition hover:bg-accent/20"
              >
                Open Statistics Page
              </Link>
            }
          >
            <p className="mb-2 inline-flex items-center rounded-full border border-ink-soft/20 bg-surface px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
              Calculated Month: {formatMonthLabel(budgetPlannerMonth)}
            </p>
            {visibleBudgetPlannerRows.length === 0 ? (
              <p className="rounded-2xl border border-ink-soft/15 bg-surface p-4 text-sm text-muted">
                No spending transactions found for {formatMonthLabel(budgetPlannerMonth)}.
              </p>
            ) : (
              <div className="space-y-2">
                {spendingPieSlices.length > 0 ? (
                  <article className="rounded-2xl border border-ink-soft/15 bg-surface p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                      Spending Breakdown
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <div className="relative h-28 w-28 shrink-0 rounded-full border border-ink-soft/20">
                        <svg
                          viewBox="0 0 100 100"
                          className="h-full w-full -rotate-90"
                          aria-label="Spending distribution pie chart in EUR"
                        >
                          <circle cx="50" cy="50" r="40" fill="none" stroke="#d9dde1" strokeWidth="20" />
                          {spendingPieSlices.map((slice) => {
                            const dashLength = (slice.sharePercent / 100) * spendingPieCircumference;
                            const dashGap = Math.max(spendingPieCircumference - dashLength, 0);
                            const isHighlighted =
                              hoveredSpendingSliceCategoryName === null ||
                              hoveredSpendingSliceCategoryName === slice.categoryName;

                            return (
                              <circle
                                key={`overview-pie-slice-${slice.categoryName}`}
                                cx="50"
                                cy="50"
                                r="40"
                                fill="none"
                                stroke={slice.color}
                                strokeWidth="20"
                                strokeDasharray={`${dashLength} ${dashGap}`}
                                strokeDashoffset={-((slice.startPercent / 100) * spendingPieCircumference)}
                                pointerEvents="stroke"
                                className={`cursor-pointer transition-opacity ${isHighlighted ? "opacity-100" : "opacity-45"}`}
                                onPointerEnter={() => {
                                  setHoveredSpendingSliceCategoryName(slice.categoryName);
                                }}
                                onPointerLeave={() => {
                                  setHoveredSpendingSliceCategoryName(null);
                                }}
                                onFocus={() => {
                                  setHoveredSpendingSliceCategoryName(slice.categoryName);
                                }}
                                onBlur={() => {
                                  setHoveredSpendingSliceCategoryName(null);
                                }}
                                role="img"
                                tabIndex={0}
                                aria-label={`${slice.categoryName}: ${slice.sharePercent.toFixed(1)}% (${formatCurrencyCents(
                                  slice.spentCents,
                                  "EUR",
                                  "en-IE"
                                )})`}
                              />
                            );
                          })}
                        </svg>
                        <div className="pointer-events-none absolute inset-4 flex items-center justify-center rounded-full border border-ink-soft/15 bg-surface">
                          <div className="text-center">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">Total</p>
                            <p className="font-mono text-xs text-foreground">
                              {formatCurrencyCents(totalSpentEurCents, "EUR", "en-IE")}
                            </p>
                          </div>
                        </div>
                      </div>
                      {hoveredSpendingPieSlice ? (
                        <div className="rounded-xl border border-ink-soft/15 bg-surface/80 px-3 py-2 text-xs">
                          <p className="font-semibold text-foreground">{hoveredSpendingPieSlice.categoryName}</p>
                          <p className="mt-1 font-mono text-muted">
                            {hoveredSpendingPieSlice.sharePercent.toFixed(1)}% ·{" "}
                            {formatCurrencyCents(hoveredSpendingPieSlice.spentCents, "EUR", "en-IE")}
                          </p>
                        </div>
                      ) : null}
                      <ul className="min-w-0 flex-1 space-y-0.5">
                        {spendingPieSlices.slice(0, 8).map((slice) => (
                          <li key={`spending-pie-${slice.categoryName}`} className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: slice.color }}
                              aria-hidden
                            />
                            <Link
                              href={slice.href}
                              className="min-w-0 truncate text-xs font-semibold text-foreground underline decoration-ink-soft/30 underline-offset-4 transition hover:decoration-accent"
                              title={`View ${slice.categoryName} transactions`}
                            >
                              {slice.categoryName}
                            </Link>
                            <span className="ml-auto shrink-0 font-mono text-xs text-muted">
                              {formatCurrencyCents(slice.spentCents, "EUR", "en-IE")}
                            </span>
                          </li>
                        ))}
                        {spendingPieSlices.length > 8 ? (
                          <li className="text-[11px] text-muted">+{spendingPieSlices.length - 8} more categories</li>
                        ) : null}
                      </ul>
                    </div>
                  </article>
                ) : null}
                <div className="grid gap-2 sm:grid-cols-2">
                  {visibleBudgetPlannerRows.map((row) => {
                  const totalLabel = formatCurrencyCents(row.spentCents, "EUR", "en-IE");
                  const averageCents =
                    row.transactionCount > 0 ? Math.round(row.spentCents / row.transactionCount) : 0;
                  const averageLabel = formatCurrencyCents(averageCents, "EUR", "en-IE");
                  const share = spendingShareByCategoryName.get(row.categoryName) ?? 0;
                  const sharePercent = Math.max(0, Math.min(share * 100, 100));
                  const transactionHref = buildSpendingTransactionsHref(budgetPlannerMonth, row.categoryName);
                  return (
                    <article key={row.categoryName} className="rounded-xl border border-ink-soft/15 bg-surface p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-xs font-semibold text-foreground">
                            <Link
                              href={transactionHref}
                              className="underline decoration-ink-soft/30 underline-offset-4 transition hover:decoration-accent"
                            >
                              {row.categoryName}
                            </Link>
                          </h3>
                        </div>
                        <p className="font-mono text-xs text-foreground">{totalLabel}</p>
                      </div>
                      <div className="mt-2 grid gap-1 text-xs text-muted">
                        <p>
                          Transactions: <span className="font-semibold text-foreground">{row.transactionCount}</span>
                        </p>
                        <p>
                          Avg / transaction: <span className="font-semibold text-foreground">{averageLabel}</span>
                        </p>
                      </div>
                      <div className="mt-2">
                        <div className="h-2 w-full overflow-hidden rounded-full bg-ink-soft/15">
                          <div
                            className="h-full rounded-full bg-accent/70"
                            style={{ width: `${sharePercent.toFixed(2)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-[11px] text-muted">
                          {sharePercent.toFixed(1)}% of total {formatCurrencyCents(totalSpentEurCents, "EUR", "en-IE")}
                        </p>
                      </div>
                    </article>
                  );
                  })}
                </div>
              </div>
            )}
            </SectionShell>
          ) : null}

          {showOverviewSections ? (
            <SectionShell
              title="Monthly Income Analysis"
              subtitle='Income-tagged inflows aggregated in backend SQL by effective month (deemed date when available).'
              className="xl:col-span-2 relative overflow-hidden before:pointer-events-none before:absolute before:right-0 before:top-0 before:h-44 before:w-44 before:rounded-full before:bg-positive/10"
              action={
                <p className="font-mono text-xs uppercase tracking-[0.1em] text-muted">
                  {selectedIncomeMonth ? `Baseline ${formatMonthLabel(selectedIncomeMonth)}` : "No baseline month"}
                </p>
              }
            >
              {comparisonOptionsViewQuery.error ? (
                <p className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                  {resolveErrorMessage(comparisonOptionsViewQuery.error, "Failed to load monthly income analysis.")}
                </p>
              ) : comparisonOptionsViewQuery.isPending ? (
                <p className="rounded-2xl border border-ink-soft/15 bg-surface p-4 text-sm text-muted">
                  Loading monthly income analysis...
                </p>
              ) : !selectedIncomeMonth ? (
                <p className="rounded-2xl border border-ink-soft/15 bg-surface p-4 text-sm text-muted">
                  No month data available for monthly income analysis.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="rounded-xl border border-ink-soft/15 bg-surface/80 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                        Last Month Income ({formatMonthLabel(selectedIncomeMonth)})
                      </p>
                      <p className="mt-1 font-mono text-sm text-positive">
                        +{formatCurrencyCents(selectedIncomeCents, "EUR", "en-IE")}
                      </p>
                      <p className="mt-1 text-[11px] text-muted">
                        {selectedIncomeTransactionCount} income transaction
                        {selectedIncomeTransactionCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="rounded-xl border border-ink-soft/15 bg-surface/80 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                        Compare Month{" "}
                        {compareIncomeMonth ? `(${formatMonthLabel(compareIncomeMonth)})` : ""}
                      </p>
                      <p className="mt-1 font-mono text-sm text-foreground">
                        +{formatCurrencyCents(compareIncomeCents, "EUR", "en-IE")}
                      </p>
                      <p className="mt-1 text-[11px] text-muted">
                        {compareIncomeTransactionCount} income transaction
                        {compareIncomeTransactionCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="rounded-xl border border-ink-soft/15 bg-surface/80 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                        Monthly Income Comparison
                      </p>
                      <p
                        className={`mt-1 font-mono text-sm ${
                          incomeDeltaCents > 0 ? "text-positive" : incomeDeltaCents < 0 ? "text-danger" : "text-muted"
                        }`}
                      >
                        {incomeDeltaCents >= 0 ? "+" : "-"}
                        {formatCurrencyCents(Math.abs(incomeDeltaCents), "EUR", "en-IE")}
                      </p>
                      <p className="mt-1 text-[11px] text-muted">
                        {incomeDeltaPercent === null ? "No prior month baseline" : `${incomeDeltaPercent.toFixed(1)}% vs compare`}
                      </p>
                    </div>
                  </div>

                  {monthlyIncomeTrendRows.length === 0 ? (
                    <p className="rounded-xl border border-ink-soft/15 bg-surface p-3 text-xs text-muted">
                      No monthly income trend data yet.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[560px] border-separate border-spacing-y-2">
                        <thead className="text-left text-[11px] uppercase tracking-[0.1em] text-muted">
                          <tr>
                            <th className="px-3 py-1.5">Month</th>
                            <th className="px-3 py-1.5 text-right">Income</th>
                            <th className="px-3 py-1.5 text-right">Transactions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {monthlyIncomeTrendRows.map((row) => (
                            <tr key={`monthly-income-row-${row.month}`} className="rounded-xl bg-surface/80">
                              <td className="rounded-l-xl border border-r-0 border-ink-soft/15 px-3 py-2 text-xs text-foreground">
                                {formatMonthLabel(row.month)}
                              </td>
                              <td className="border-y border-ink-soft/15 px-3 py-2 text-right font-mono text-xs text-positive">
                                +{formatCurrencyCents(row.incomeCents, "EUR", "en-IE")}
                              </td>
                              <td className="rounded-r-xl border border-l-0 border-ink-soft/15 px-3 py-2 text-right text-xs text-muted">
                                {row.transactionCount}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </SectionShell>
          ) : null}
        </div>
      </div>

      <ImportReviewModal
        accountName={pendingImportReview?.accountName ?? ""}
        open={pendingImportReview !== null}
        conflicts={pendingImportReview?.preview.conflicts ?? []}
        conflictActions={pendingImportReview?.conflictActions ?? {}}
        isPending={importTransactionsMutation.isPending}
        errorMessage={pendingImportReviewError}
        onClose={handleClosePendingImportReview}
        onConfirm={() => {
          void handleCommitPendingImportReview();
        }}
        onActionChange={handleConflictActionChange}
      />
    </>
  );
}
