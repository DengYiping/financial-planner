import type { NormalizedTransaction, StatementProvider } from "@/lib/parsers";

export type DashboardTab =
  | "overview"
  | "data_intake"
  | "statistics"
  | "transactions"
  | "account_summary"
  | "rules"
  | "categories"
  | "tags";
export type AccountKind = "aib_current" | "aib_mortgage" | "revolut_current" | "revolut_credit_card";
export type AccountCurrency = "EUR" | "USD";
type ParserStatus = "idle" | "loading" | "success" | "error";
export type ImportConflictAction = "keep_existing" | "force_import";
export type ComparableTransaction = {
  id?: string;
  bookingDate?: string;
  amountCents?: number;
  currency?: string;
  direction?: "in" | "out";
  description?: string;
  counterparty?: string;
  reference?: string;
};
export type ImportPreviewConflict = {
  incomingIndex: number;
  incomingTransaction: NormalizedTransaction;
  existingTransaction?: ComparableTransaction;
  coverage?: number;
  reason?: string;
};
export type AccountImportSummary = {
  totalCount: number;
  insertedCount: number;
  duplicateSkippedCount: number;
  forcedImportedCount: number;
  conflictsReviewedCount: number;
  autoCancelled: boolean;
  autoCancelReason?: string;
};

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export type AccountState = {
  id: number;
  name: string;
  kind: AccountKind;
  provider: StatementProvider;
  currency?: AccountCurrency;
  color: string;
  recordCount: number;
  status: ParserStatus;
  lastUploadedFiles: string[];
  parsedFileCountTotal: number;
  parsedFileCount: number;
  importedTotal: number;
  parsedCount: number;
  warnings: string[];
  error?: string;
  lastImportSummary?: AccountImportSummary;
  transactions: NormalizedTransaction[];
};

export type PersistedAccountSnapshot = {
  id: number;
  name: string;
  kind: AccountKind;
  provider: StatementProvider;
  currency?: AccountCurrency;
  color: string;
  transactionCount: number;
  transactions: NormalizedTransaction[];
};

export const ACCOUNT_KIND_CONFIG: Record<
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

export const REVOLUT_CURRENT_CURRENCIES: AccountCurrency[] = ["EUR", "USD"];

export const ACCOUNT_COLORS = [
  "#0673A6",
  "#0C8A69",
  "#B56A16",
  "#8E5EA2",
  "#D14B66",
  "#2E7867",
  "#B14747",
  "#5B7CBA",
];

export function normalizeMonthKey(value: string | null): string {
  if (value === "all") {
    return value;
  }

  if (value && MONTH_KEY_PATTERN.test(value)) {
    return value;
  }

  return "all";
}

export function normalizeSummaryMonthKey(value: string | null): string {
  if (value && MONTH_KEY_PATTERN.test(value)) {
    return value;
  }

  return "";
}

export function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

export function mergePersistedAccounts(previous: AccountState[], persisted: PersistedAccountSnapshot[]): AccountState[] {
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
      recordCount: account.transactionCount,
      status: previousAccount?.status ?? "idle",
      lastUploadedFiles: previousAccount?.lastUploadedFiles ?? [],
      parsedFileCountTotal: previousAccount?.parsedFileCountTotal ?? 0,
      parsedFileCount: previousAccount?.parsedFileCount ?? 0,
      importedTotal: account.transactionCount,
      parsedCount: previousAccount?.parsedCount ?? 0,
      warnings: previousAccount?.warnings ?? [],
      error: previousAccount?.error,
      lastImportSummary: previousAccount?.lastImportSummary,
      transactions: mergedTransactions,
    };
  });
}

export function mergeTransactions(
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

export function getAccountTypeLabel(kind: AccountKind, currency?: AccountCurrency): string {
  if (kind === "revolut_current") {
    return `Revolut Current (${currency ?? "EUR"})`;
  }

  return ACCOUNT_KIND_CONFIG[kind].label;
}

export function buildDefaultAccountName(kind: AccountKind, currency: AccountCurrency | undefined, index: number): string {
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

export function formatMonthLabel(monthKey: string): string {
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

export function formatCurrencyCents(amountCents: number, currency: string, locale = "en-IE"): string {
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

export function tabPath(tab: DashboardTab): string {
  if (tab === "data_intake") {
    return "/data-intake";
  }

  if (tab === "statistics") {
    return "/statistics";
  }

  if (tab === "transactions") {
    return "/transactions";
  }

  if (tab === "account_summary") {
    return "/account-summary";
  }

  if (tab === "rules") {
    return "/rules";
  }

  if (tab === "categories") {
    return "/categories";
  }

  if (tab === "tags") {
    return "/tags";
  }

  return "/";
}
