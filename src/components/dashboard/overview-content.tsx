"use client";

import { type ChangeEvent, useEffect, useState } from "react";
import { BudgetBar } from "@/components/dashboard/budget-bar";
import { SectionShell } from "@/components/dashboard/section-shell";
import { SummaryCard } from "@/components/dashboard/summary-card";
import {
  ACCOUNT_COLORS,
  ACCOUNT_KIND_CONFIG,
  type AccountCurrency,
  type AccountKind,
  type AccountState,
  type PersistedAccountSnapshot,
  buildDefaultAccountName,
  getAccountTypeLabel,
  mergePersistedAccounts,
  mergeTransactions,
  resolveErrorMessage,
  REVOLUT_CURRENT_CURRENCIES,
} from "@/components/dashboard/dashboard-shared";
import { NormalizedTransaction, parseStatement, ParserNotImplementedError } from "@/lib/parsers";
import { trpc } from "@/trpc/react";

const summaryCards = [
  { label: "Net Worth", value: "EUR 38,420", helper: "+2.4% month to date", tone: "positive" as const },
  { label: "Cash Position", value: "EUR 6,210", helper: "Covers ~2.8 months", tone: "neutral" as const },
  { label: "Spending", value: "EUR 1,740", helper: "62% of monthly budget", tone: "warning" as const },
  { label: "Savings Rate", value: "26%", helper: "Target is 30%", tone: "danger" as const },
];

const budgetRows = [
  { category: "Housing", planned: "EUR 1,200", spent: "EUR 1,200", progress: 100 },
  { category: "Groceries", planned: "EUR 420", spent: "EUR 318", progress: 76 },
  { category: "Transport", planned: "EUR 240", spent: "EUR 182", progress: 75.8 },
  { category: "Dining", planned: "EUR 280", spent: "EUR 305", progress: 108.9 },
];

const upcomingBills = [
  { label: "Electricity Bill", due: "Mar 3", amount: "EUR 96" },
  { label: "Internet", due: "Mar 7", amount: "EUR 55" },
  { label: "Rent", due: "Mar 1", amount: "EUR 1,200" },
];

type OverviewContentProps = {
  initialAccounts: PersistedAccountSnapshot[];
};

export function OverviewContent({ initialAccounts }: OverviewContentProps) {
  const [draftKind, setDraftKind] = useState<AccountKind>("aib_current");
  const [draftRevolutCurrency, setDraftRevolutCurrency] = useState<AccountCurrency>("EUR");

  const accountsQuery = trpc.accounts.list.useQuery(undefined, {
    initialData: initialAccounts,
  });
  const createAccountMutation = trpc.accounts.create.useMutation();
  const deleteAccountMutation = trpc.accounts.delete.useMutation();
  const importTransactionsMutation = trpc.accounts.importTransactions.useMutation();

  const [accounts, setAccounts] = useState<AccountState[]>(() => mergePersistedAccounts([], initialAccounts));
  const [deletingAccountIds, setDeletingAccountIds] = useState<Set<number>>(new Set());
  const [dataError, setDataError] = useState<string | null>(null);

  const isHydratingData = accountsQuery.isPending && accounts.length === 0;
  const isCreatingAccount = createAccountMutation.isPending;
  const queryErrorMessage = accountsQuery.error
    ? resolveErrorMessage(accountsQuery.error, "Failed to hydrate account data from backend.")
    : null;
  const activeDataError = dataError ?? queryErrorMessage;

  useEffect(() => {
    if (!accountsQuery.data) {
      return;
    }

    setAccounts((current) => mergePersistedAccounts(current, accountsQuery.data));
  }, [accountsQuery.data]);

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
      await accountsQuery.refetch();
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
      await accountsQuery.refetch();
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

    setAccounts((current) =>
      current.map((entry) =>
        entry.id === accountId
          ? {
              ...entry,
              status: "loading",
              lastUploadedFiles: files.map((file) => file.name),
              error: undefined,
            }
          : entry
      )
    );

    const parsedTransactions: NormalizedTransaction[] = [];
    let parsedFileCount = 0;
    const warnings: string[] = [];
    const errors: string[] = [];
    const uploadedFileNames = files.map((file) => file.name);

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

      if (parsedTransactions.length > 0) {
        await importTransactionsMutation.mutateAsync({
          accountId,
          transactions: parsedTransactions,
        });
        const refreshed = await accountsQuery.refetch();
        if (refreshed.error) {
          throw refreshed.error;
        }
        const persistedSnapshot = refreshed.data ?? [];

        setAccounts((current) => {
          const merged = mergePersistedAccounts(current, persistedSnapshot);

          return merged.map((entry) => {
            if (entry.id !== accountId) {
              return entry;
            }

            const currentEntry = current.find((candidate) => candidate.id === accountId);
            const mergedTransactions = mergeTransactions(entry.transactions, parsedTransactions);

            return {
              ...entry,
              status: "success",
              lastUploadedFiles: uploadedFileNames,
              parsedFileCountTotal: (currentEntry?.parsedFileCountTotal ?? 0) + parsedFileCount,
              parsedFileCount,
              parsedCount: parsedTransactions.length,
              importedTotal: Math.max(entry.importedTotal, mergedTransactions.length),
              warnings,
              error: parserError,
              transactions: mergedTransactions,
            };
          });
        });
      } else {
        setAccounts((current) =>
          current.map((entry) => {
            if (entry.id !== accountId) {
              return entry;
            }

            return {
              ...entry,
              status: errors.length > 0 ? "error" : "success",
              lastUploadedFiles: uploadedFileNames,
              parsedFileCountTotal: entry.parsedFileCountTotal + parsedFileCount,
              parsedFileCount,
              parsedCount: 0,
              warnings,
              error: parserError,
            };
          })
        );
      }
    } catch (error) {
      const persistenceError = resolveErrorMessage(error, "Failed to process uploaded files.");

      setAccounts((current) =>
        current.map((entry) => {
          if (entry.id !== accountId) {
            return entry;
          }

          const mergedError = [errors.length > 0 ? errors.join(" | ") : undefined, persistenceError]
            .filter((message): message is string => Boolean(message))
            .join(" | ");

          return {
            ...entry,
            status: "error",
            lastUploadedFiles: uploadedFileNames,
            parsedFileCountTotal: entry.parsedFileCountTotal + parsedFileCount,
            parsedFileCount,
            parsedCount: parsedTransactions.length,
            warnings,
            error: mergedError,
          };
        })
      );
    } finally {
      inputElement.value = "";
    }
  }

  return (
    <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((card) => (
          <SummaryCard key={card.label} {...card} />
        ))}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
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
                      {account.status === "loading" ? "Parsing..." : "Upload CSVs"}
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        multiple
                        className="sr-only"
                        onChange={(event) => {
                          void handleAccountUpload(account.id, event);
                        }}
                        disabled={account.status === "loading" || deletingAccountIds.has(account.id)}
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

        <SectionShell title="Budget Planner" subtitle="Track planned vs. actual spend for each category.">
          <div className="space-y-3">
            {budgetRows.map((budget) => (
              <BudgetBar key={budget.category} {...budget} />
            ))}
          </div>
        </SectionShell>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionShell title="Upcoming Bills" subtitle="Prioritized obligations in the next two weeks.">
          <ul className="space-y-3">
            {upcomingBills.map((bill) => (
              <li
                key={bill.label}
                className="flex items-center justify-between rounded-2xl border border-ink-soft/15 bg-surface p-4"
              >
                <div>
                  <p className="font-semibold text-foreground">{bill.label}</p>
                  <p className="mt-1 text-sm text-muted">Due {bill.due}</p>
                </div>
                <p className="font-mono text-sm text-foreground">{bill.amount}</p>
              </li>
            ))}
          </ul>
        </SectionShell>
      </div>
    </div>
  );
}
