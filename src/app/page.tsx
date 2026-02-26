"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { BudgetBar } from "@/components/dashboard/budget-bar";
import { SectionShell } from "@/components/dashboard/section-shell";
import { SummaryCard } from "@/components/dashboard/summary-card";
import {
  NormalizedTransaction,
  parseStatement,
  ParserNotImplementedError,
  StatementProvider,
} from "@/lib/parsers";
import { trpc } from "@/trpc/react";

type ParserStatus = "idle" | "loading" | "success" | "error";
type PageTab = "overview" | "transactions" | "account_summary";
type TransactionTab = "recent" | "aggregated";
type AccountKind = "aib_current" | "aib_mortgage" | "revolut_current" | "revolut_credit_card";
type AccountCurrency = "EUR" | "USD";

type AccountState = {
  id: number;
  name: string;
  kind: AccountKind;
  provider: StatementProvider;
  currency?: AccountCurrency;
  color: string;
  status: ParserStatus;
  lastUploadedFiles: string[];
  parsedFileCountTotal: number;
  parsedFileCount: number;
  importedTotal: number;
  parsedCount: number;
  warnings: string[];
  error?: string;
  transactions: NormalizedTransaction[];
};

type AccountTransactionRow = {
  accountId: number;
  accountName: string;
  accountColor: string;
  transaction: NormalizedTransaction;
};

type PersistedAccountSnapshot = {
  id: number;
  name: string;
  kind: AccountKind;
  provider: StatementProvider;
  currency?: AccountCurrency;
  color: string;
  transactionCount: number;
  transactions: NormalizedTransaction[];
};

const ACCOUNT_KIND_CONFIG: Record<
  AccountKind,
  {
    label: string;
    provider: StatementProvider;
    requiresCurrency: boolean;
  }
> = {
  aib_current: {
    label: "AIB Current Account",
    provider: "aib",
    requiresCurrency: false,
  },
  aib_mortgage: {
    label: "AIB Mortgage Account",
    provider: "aib",
    requiresCurrency: false,
  },
  revolut_current: {
    label: "Revolut Current Account",
    provider: "revolut",
    requiresCurrency: true,
  },
  revolut_credit_card: {
    label: "Revolut Credit Card",
    provider: "revolut",
    requiresCurrency: false,
  },
};

const REVOLUT_CURRENT_CURRENCIES: AccountCurrency[] = ["EUR", "USD"];

const ACCOUNT_COLORS = [
  "#0673A6",
  "#0C8A69",
  "#B56A16",
  "#8E5EA2",
  "#D14B66",
  "#2E7867",
  "#B14747",
  "#5B7CBA",
];

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function mergePersistedAccounts(previous: AccountState[], persisted: PersistedAccountSnapshot[]): AccountState[] {
  const previousById = new Map(previous.map((account) => [account.id, account]));

  return persisted.map((account) => {
    const previousAccount = previousById.get(account.id);
    const mergedTransactions =
      account.transactions.length > 0
        ? mergeTransactions(previousAccount?.transactions ?? [], account.transactions)
        : previousAccount?.transactions ?? [];

    return {
      id: account.id,
      name: account.name,
      kind: account.kind,
      provider: account.provider,
      currency: account.currency,
      color: account.color,
      status: previousAccount?.status ?? "idle",
      lastUploadedFiles: previousAccount?.lastUploadedFiles ?? [],
      parsedFileCountTotal: previousAccount?.parsedFileCountTotal ?? 0,
      parsedFileCount: previousAccount?.parsedFileCount ?? 0,
      importedTotal: Math.max(account.transactionCount, mergedTransactions.length),
      parsedCount: previousAccount?.parsedCount ?? 0,
      warnings: previousAccount?.warnings ?? [],
      error: previousAccount?.error,
      transactions: mergedTransactions,
    };
  });
}

function mergeTransactions(
  existing: NormalizedTransaction[],
  incoming: NormalizedTransaction[]
): NormalizedTransaction[] {
  if (incoming.length === 0) {
    return existing;
  }

  const seen = new Set<string>();
  const merged: NormalizedTransaction[] = [];

  [...existing, ...incoming].forEach((transaction) => {
    if (seen.has(transaction.id)) {
      return;
    }

    seen.add(transaction.id);
    merged.push(transaction);
  });

  return merged;
}

function getAccountTypeLabel(kind: AccountKind, currency?: AccountCurrency): string {
  if (kind === "revolut_current") {
    return `Revolut Current (${currency ?? "EUR"})`;
  }

  return ACCOUNT_KIND_CONFIG[kind].label;
}

function buildDefaultAccountName(kind: AccountKind, currency: AccountCurrency | undefined, index: number): string {
  if (kind === "revolut_current") {
    return `Revolut Current ${currency ?? "EUR"} #${index}`;
  }

  if (kind === "aib_current") {
    return `AIB Current #${index}`;
  }

  if (kind === "aib_mortgage") {
    return `AIB Mortgage #${index}`;
  }

  return `Revolut Credit Card #${index}`;
}

function formatMonthLabel(monthKey: string): string {
  const [yearToken, monthToken] = monthKey.split("-");
  const year = Number.parseInt(yearToken, 10);
  const month = Number.parseInt(monthToken, 10);
  if (Number.isNaN(year) || Number.isNaN(month)) {
    return monthKey;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatCurrencyCents(amountCents: number, currency: string, locale = "en-IE"): string {
  const absoluteCents = Math.abs(amountCents);
  const wholeUnits = Math.trunc(absoluteCents / 100);
  const fractionalUnits = absoluteCents % 100;

  const wholeUnitsLabel = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(wholeUnits);
  const fractionLabel = String(fractionalUnits).padStart(2, "0");

  const templateParts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).formatToParts(0);

  return templateParts
    .map((part) => {
      if (part.type === "integer") {
        return wholeUnitsLabel;
      }
      if (part.type === "fraction") {
        return fractionLabel;
      }

      return part.value;
    })
    .join("");
}

export default function Home() {
  const todayLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

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

  const [pageTab, setPageTab] = useState<PageTab>("overview");
  const [transactionTab, setTransactionTab] = useState<TransactionTab>("recent");
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [selectedSummaryMonth, setSelectedSummaryMonth] = useState<string>("");

  const [draftKind, setDraftKind] = useState<AccountKind>("aib_current");
  const [draftRevolutCurrency, setDraftRevolutCurrency] = useState<AccountCurrency>("EUR");

  const accountsQuery = trpc.accounts.list.useQuery();
  const createAccountMutation = trpc.accounts.create.useMutation();
  const deleteAccountMutation = trpc.accounts.delete.useMutation();
  const importTransactionsMutation = trpc.accounts.importTransactions.useMutation();

  const [accounts, setAccounts] = useState<AccountState[]>([]);
  const [deletingAccountIds, setDeletingAccountIds] = useState<Set<number>>(new Set());
  const [dataError, setDataError] = useState<string | null>(null);

  const isHydratingData = accountsQuery.isPending && accounts.length === 0;
  const isCreatingAccount = createAccountMutation.isPending;
  const queryErrorMessage = accountsQuery.error
    ? resolveErrorMessage(accountsQuery.error, "Failed to hydrate data from backend.")
    : null;
  const activeDataError = dataError ?? queryErrorMessage;

  useEffect(() => {
    if (!accountsQuery.data) {
      return;
    }

    setAccounts((current) => mergePersistedAccounts(current, accountsQuery.data));
  }, [accountsQuery.data]);

  const accountTransactions = useMemo(() => {
    const rows: AccountTransactionRow[] = [];

    accounts.forEach((account) => {
      account.transactions.forEach((transaction) => {
        rows.push({
          accountId: account.id,
          accountName: account.name,
          accountColor: account.color,
          transaction,
        });
      });
    });

    return rows.sort(
      (first, second) =>
        second.transaction.bookingDate.localeCompare(first.transaction.bookingDate) ||
        first.transaction.id.localeCompare(second.transaction.id)
    );
  }, [accounts]);

  const monthOptions = useMemo(() => {
    return [...new Set(accountTransactions.map((row) => row.transaction.bookingDate.slice(0, 7)))].sort((a, b) =>
      b.localeCompare(a)
    );
  }, [accountTransactions]);

  const monthFilteredTransactions = useMemo(() => {
    if (selectedMonth === "all") {
      return accountTransactions;
    }

    return accountTransactions.filter((row) => row.transaction.bookingDate.startsWith(selectedMonth));
  }, [accountTransactions, selectedMonth]);

  const recentTransactions = useMemo(() => {
    return monthFilteredTransactions.slice(0, 25);
  }, [monthFilteredTransactions]);

  const chronologicalTransactions = useMemo(() => {
    return [...monthFilteredTransactions].sort(
      (first, second) =>
        first.transaction.bookingDate.localeCompare(second.transaction.bookingDate) ||
        first.transaction.id.localeCompare(second.transaction.id)
    );
  }, [monthFilteredTransactions]);

  const transactionsForActiveTab =
    transactionTab === "aggregated" ? chronologicalTransactions : recentTransactions;

  const importedTransactionCount = accounts.reduce((sum, account) => sum + account.importedTotal, 0);
  const totalWarnings = accounts.reduce((sum, account) => sum + account.warnings.length, 0);

  const effectiveSummaryMonth = useMemo(() => {
    if (monthOptions.length === 0) {
      return "";
    }

    if (selectedSummaryMonth && monthOptions.includes(selectedSummaryMonth)) {
      return selectedSummaryMonth;
    }

    return monthOptions[0];
  }, [monthOptions, selectedSummaryMonth]);

  const accountSummaryRows = useMemo(() => {
    if (!effectiveSummaryMonth) {
      return [];
    }

    return accounts.map((account) => {
      const monthlyTransactions = account.transactions.filter((transaction) =>
        transaction.bookingDate.startsWith(effectiveSummaryMonth)
      );
      const inflowCents = monthlyTransactions.reduce(
        (sum, transaction) => sum + (transaction.direction === "in" ? transaction.amountCents : 0),
        0
      );
      const outflowCents = monthlyTransactions.reduce(
        (sum, transaction) => sum + (transaction.direction === "out" ? transaction.amountCents : 0),
        0
      );
      const currency = account.currency ?? monthlyTransactions[0]?.currency ?? account.transactions[0]?.currency ?? "EUR";

      return {
        accountId: account.id,
        accountName: account.name,
        accountType: getAccountTypeLabel(account.kind, account.currency),
        accountColor: account.color,
        currency,
        transactionCount: monthlyTransactions.length,
        inflowCents,
        outflowCents,
        netCents: inflowCents - outflowCents,
      };
    });
  }, [accounts, effectiveSummaryMonth]);

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
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 lg:pt-14">
      <header className="mb-8 rounded-3xl border border-ink-soft/15 bg-surface/85 p-6 shadow-[0_24px_48px_-36px_rgba(23,34,40,0.7)] backdrop-blur-sm sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Personal Finance</p>
            <h1 className="mt-3 font-display text-4xl tracking-tight text-foreground sm:text-5xl">
              Tracker and Planner
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-muted sm:text-base">
              Single-user finance workspace. Add accounts, upload statements, and review cross-account history.
            </p>
          </div>
          <div className="space-y-2 text-right">
            <p className="font-mono text-xs uppercase tracking-[0.15em] text-muted">{todayLabel}</p>
            <p className="rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
              No Login (V1)
            </p>
          </div>
        </div>
      </header>

      <div className="mb-6 inline-flex rounded-full border border-ink-soft/15 bg-surface p-1">
        <button
          type="button"
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
            pageTab === "overview"
              ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
              : "text-muted hover:text-foreground"
          }`}
          onClick={() => {
            setPageTab("overview");
          }}
        >
          Overview
        </button>
        <button
          type="button"
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
            pageTab === "transactions"
              ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
              : "text-muted hover:text-foreground"
          }`}
          onClick={() => {
            setPageTab("transactions");
          }}
        >
          Transactions
        </button>
        <button
          type="button"
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
            pageTab === "account_summary"
              ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
              : "text-muted hover:text-foreground"
          }`}
          onClick={() => {
            setPageTab("account_summary");
          }}
        >
          Account Summary
        </button>
      </div>

      {pageTab === "overview" ? (
        <>
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
                          <p className="mt-1 text-xs text-muted">
                            {getAccountTypeLabel(account.kind, account.currency)}
                          </p>
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
        </>
      ) : pageTab === "transactions" ? (
        <SectionShell
          title="Transactions"
          subtitle="Cross-account transaction view with month filtering and account color coding."
          action={
            <div className="space-y-1 text-right">
              <p className="font-mono text-xs text-muted">{importedTransactionCount} imported</p>
              {totalWarnings > 0 && (
                <p className="font-mono text-xs text-warning">
                  {totalWarnings} parser warning{totalWarnings === 1 ? "" : "s"}
                </p>
              )}
            </div>
          }
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-full border border-ink-soft/15 bg-surface p-1">
              <button
                type="button"
                className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] transition ${
                  transactionTab === "recent"
                    ? "bg-accent text-white shadow-[0_6px_16px_-10px_rgba(6,115,166,0.9)]"
                    : "text-muted hover:text-foreground"
                }`}
                onClick={() => {
                  setTransactionTab("recent");
                }}
              >
                Recent (25)
              </button>
              <button
                type="button"
                className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] transition ${
                  transactionTab === "aggregated"
                    ? "bg-accent text-white shadow-[0_6px_16px_-10px_rgba(6,115,166,0.9)]"
                    : "text-muted hover:text-foreground"
                }`}
                onClick={() => {
                  setTransactionTab("aggregated");
                }}
              >
                All Accounts Chronological
              </button>
            </div>

            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
              Month
              <select
                value={selectedMonth}
                onChange={(event) => {
                  setSelectedMonth(event.target.value);
                }}
                className="rounded-full border border-ink-soft/20 bg-surface px-3 py-1.5 text-xs text-foreground outline-none focus:border-accent"
              >
                <option value="all">All Months</option>
                {monthOptions.map((month) => (
                  <option key={month} value={month}>
                    {formatMonthLabel(month)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] border-separate border-spacing-y-2">
              <thead className="text-left text-xs uppercase tracking-[0.14em] text-muted">
                <tr>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactionsForActiveTab.length === 0 ? (
                  <tr className="rounded-2xl bg-surface">
                    <td
                      colSpan={5}
                      className="rounded-xl border border-ink-soft/15 px-3 py-6 text-center text-sm text-muted"
                    >
                      No transactions found. Add accounts and upload statement files on the Overview tab.
                    </td>
                  </tr>
                ) : (
                  transactionsForActiveTab.map((row) => {
                    const transaction = row.transaction;
                    const isIncome = transaction.direction === "in";
                    const amount = formatCurrencyCents(transaction.amountCents, transaction.currency || "EUR");

                    return (
                      <tr key={`${row.accountId}-${transaction.id}`} className="rounded-2xl bg-surface">
                        <td className="rounded-l-xl border border-r-0 border-ink-soft/15 px-3 py-3 text-sm text-foreground">
                          {transaction.description}
                        </td>
                        <td className="border-y border-ink-soft/15 px-3 py-3 text-sm text-muted">
                          {transaction.categoryHint ?? "Uncategorized"}
                        </td>
                        <td className="border-y border-ink-soft/15 px-3 py-3 text-sm">
                          <span
                            className="inline-flex items-center gap-2 rounded-full border border-ink-soft/20 px-2.5 py-1 text-xs font-semibold"
                            style={{ color: row.accountColor }}
                          >
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: row.accountColor }}
                              aria-hidden
                            />
                            {row.accountName}
                          </span>
                        </td>
                        <td className="border-y border-ink-soft/15 px-3 py-3 font-mono text-xs text-muted">
                          {transaction.bookingDate}
                        </td>
                        <td
                          className={`rounded-r-xl border border-l-0 border-ink-soft/15 px-3 py-3 text-right font-mono text-sm ${
                            isIncome ? "text-positive" : "text-foreground"
                          }`}
                        >
                          {isIncome ? "+" : "-"}
                          {amount}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </SectionShell>
      ) : (
        <SectionShell
          title="Account Summary"
          subtitle="Monthly inflow and outflow per account."
          action={
            <div className="space-y-1 text-right">
              <p className="font-mono text-xs text-muted">{accounts.length} accounts</p>
              <p className="font-mono text-xs text-muted">{importedTransactionCount} imported transactions</p>
            </div>
          }
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
              Month
              <select
                value={effectiveSummaryMonth}
                onChange={(event) => {
                  setSelectedSummaryMonth(event.target.value);
                }}
                disabled={monthOptions.length === 0}
                className="rounded-full border border-ink-soft/20 bg-surface px-3 py-1.5 text-xs text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {monthOptions.length === 0 ? (
                  <option value="">No months</option>
                ) : (
                  monthOptions.map((month) => (
                    <option key={month} value={month}>
                      {formatMonthLabel(month)}
                    </option>
                  ))
                )}
              </select>
            </label>
            {effectiveSummaryMonth && (
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                Showing {formatMonthLabel(effectiveSummaryMonth)}
              </p>
            )}
          </div>

          {monthOptions.length === 0 ? (
            <p className="rounded-2xl border border-ink-soft/15 bg-surface p-4 text-center text-sm text-muted">
              Add accounts and upload statements to see monthly account summaries.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-separate border-spacing-y-2">
                <thead className="text-left text-xs uppercase tracking-[0.14em] text-muted">
                  <tr>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2 text-right">Inflow</th>
                    <th className="px-3 py-2 text-right">Outflow</th>
                    <th className="px-3 py-2 text-right">Net</th>
                    <th className="px-3 py-2 text-right">Transactions</th>
                  </tr>
                </thead>
                <tbody>
                  {accountSummaryRows.map((row) => {
                    return (
                      <tr key={row.accountId} className="rounded-2xl bg-surface">
                        <td className="rounded-l-xl border border-r-0 border-ink-soft/15 px-3 py-3 text-sm text-foreground">
                          <span className="inline-flex items-center gap-2">
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: row.accountColor }}
                              aria-hidden
                            />
                            {row.accountName}
                          </span>
                        </td>
                        <td className="border-y border-ink-soft/15 px-3 py-3 text-xs text-muted">{row.accountType}</td>
                        <td className="border-y border-ink-soft/15 px-3 py-3 text-right font-mono text-sm text-positive">
                          +{formatCurrencyCents(row.inflowCents, row.currency)}
                        </td>
                        <td className="border-y border-ink-soft/15 px-3 py-3 text-right font-mono text-sm text-foreground">
                          -{formatCurrencyCents(row.outflowCents, row.currency)}
                        </td>
                        <td
                          className={`border-y border-ink-soft/15 px-3 py-3 text-right font-mono text-sm ${
                            row.netCents >= 0 ? "text-positive" : "text-danger"
                          }`}
                        >
                          {row.netCents >= 0 ? "+" : "-"}
                          {formatCurrencyCents(Math.abs(row.netCents), row.currency)}
                        </td>
                        <td className="rounded-r-xl border border-l-0 border-ink-soft/15 px-3 py-3 text-right font-mono text-sm text-muted">
                          {row.transactionCount}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionShell>
      )}
    </main>
  );
}
