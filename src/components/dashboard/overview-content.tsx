"use client";

import { type ChangeEvent, useEffect, useState } from "react";
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

export function OverviewContent({ initialAccounts, initialBudgetPlannerView }: OverviewContentProps) {
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
  const previewImportTransactionsMutation = trpc.accounts.previewImportTransactions.useMutation();
  const importTransactionsMutation = trpc.accounts.importTransactions.useMutation();

  const [accounts, setAccounts] = useState<AccountState[]>(() => mergePersistedAccounts([], initialAccounts));
  const [deletingAccountIds, setDeletingAccountIds] = useState<Set<number>>(new Set());
  const [dataError, setDataError] = useState<string | null>(null);
  const [pendingImportReview, setPendingImportReview] = useState<PendingImportReviewState | null>(null);
  const [pendingImportReviewError, setPendingImportReviewError] = useState<string | null>(null);
  const budgetPlannerRows = budgetPlannerViewQuery.data?.rows ?? [];
  const budgetPlannerMonth = budgetPlannerViewQuery.data?.month ?? initialBudgetPlannerView.month;

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
    ]);
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
          importedTotal: Math.max(entry.importedTotal, entry.transactions.length),
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
        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
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
                    <div className="flex items-start justify-between gap-3">
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
                            void handleDeleteAccount(account);
                          }}
                          disabled={
                            isHydratingData || account.status === "loading" || deletingAccountIds.has(account.id)
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

          <SectionShell
            title="Last Month Spending Stats"
            subtitle={`Category statistics from ${formatMonthLabel(
              budgetPlannerMonth
            )} (excluding current month).`}
          >
            <p className="mb-3 inline-flex items-center rounded-full border border-ink-soft/20 bg-surface px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
              Calculated Month: {formatMonthLabel(budgetPlannerMonth)}
            </p>
            {budgetPlannerRows.length === 0 ? (
              <p className="rounded-2xl border border-ink-soft/15 bg-surface p-4 text-sm text-muted">
                No spending transactions found for {formatMonthLabel(budgetPlannerMonth)}.
              </p>
            ) : (
              <div className="space-y-3">
                {budgetPlannerRows.map((row) => {
                  const totalLabel = formatCurrencyCents(row.spentCents, row.currency, "en-IE");
                  const averageCents =
                    row.transactionCount > 0 ? Math.round(row.spentCents / row.transactionCount) : 0;
                  const averageLabel = formatCurrencyCents(averageCents, row.currency, "en-IE");
                  return (
                    <article
                      key={`${row.categoryName}-${row.currency}`}
                      className="rounded-2xl border border-ink-soft/15 bg-surface p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-foreground">{row.categoryName}</h3>
                          <p className="mt-1 text-xs text-muted">{row.currency}</p>
                        </div>
                        <p className="font-mono text-sm text-foreground">{totalLabel}</p>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-muted sm:grid-cols-2">
                        <p>
                          Transactions: <span className="font-semibold text-foreground">{row.transactionCount}</span>
                        </p>
                        <p>
                          Avg / transaction: <span className="font-semibold text-foreground">{averageLabel}</span>
                        </p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </SectionShell>
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
