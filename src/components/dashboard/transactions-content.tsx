"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { SectionShell } from "@/components/dashboard/section-shell";
import {
  formatCurrencyCents,
  formatMonthLabel,
  resolveErrorMessage,
} from "@/components/dashboard/dashboard-shared";
import type { AppRouter } from "@/server/api/routers/_app";
import { trpc } from "@/trpc/react";

type RouterInputs = inferRouterInputs<AppRouter>;
type RouterOutputs = inferRouterOutputs<AppRouter>;
type TransactionsView = RouterOutputs["accounts"]["transactionsView"];
type TransactionRow = TransactionsView["transactions"][number];
type PersistedAccount = RouterOutputs["accounts"]["list"][number];

type TransactionsContentProps = {
  view: TransactionsView;
};

type EditableTransactionDraft = {
  accountId: number;
  accountName: string;
  transactionId?: string;
  bookingDate: string;
  amount: string;
  direction: "in" | "out";
  currency: string;
  description: string;
  categoryHint: string;
  counterparty: string;
  reference: string;
};

type TransactionModalState = {
  mode: "create" | "edit";
  draft: EditableTransactionDraft;
};

type RuleFromTransactionDraft = {
  descriptionContains: string;
  descriptionRegex: string;
  amountExact: string;
  amountMin: string;
  amountMax: string;
  accountIds: number[];
  applyCategory: string;
  assignCounterpartyFromRegexGroup: boolean;
  priority: string;
};

type RuleFromTransactionModalState = {
  sourceAccountName: string;
  sourceTransactionId?: string;
  sourceDescription: string;
  draft: RuleFromTransactionDraft;
};

type AccountChoice = {
  id: number;
  name: string;
  color: string;
  currency?: string;
};

const BOOKING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;
const RULE_DEFAULT_PRIORITY = "100";

function getCategoryLabel(row: TransactionRow): string {
  return row.transaction.categoryHint ?? "Uncategorized";
}

function centsToAmountInput(amountCents: number): string {
  return (Math.abs(amountCents) / 100).toFixed(2);
}

function amountInputToCents(value: string): number | null {
  const normalized = value.trim();
  if (!AMOUNT_PATTERN.test(normalized)) {
    return null;
  }

  const parsed = Number.parseFloat(normalized.replace(",", "."));
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const cents = Math.round(parsed * 100);
  return cents > 0 ? cents : null;
}

function ruleAmountInputToCents(value: string): number | null | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (!AMOUNT_PATTERN.test(normalized)) {
    return null;
  }

  const parsed = Number.parseFloat(normalized.replace(",", "."));
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.round(Math.abs(parsed) * 100);
}

function toEditableTransactionDraft(row: TransactionRow): EditableTransactionDraft {
  return {
    accountId: row.accountId,
    accountName: row.accountName,
    transactionId: row.transaction.id,
    bookingDate: row.transaction.bookingDate,
    amount: centsToAmountInput(row.transaction.amountCents),
    direction: row.transaction.direction,
    currency: row.transaction.currency,
    description: row.transaction.description,
    categoryHint: row.transaction.categoryHint ?? "",
    counterparty: row.transaction.counterparty ?? "",
    reference: row.transaction.reference ?? "",
  };
}

function toCreateTransactionDraft(account: AccountChoice | undefined, fallbackCurrency: string): EditableTransactionDraft {
  const now = new Date();
  const yyyyMmDd = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

  return {
    accountId: account?.id ?? 0,
    accountName: account?.name ?? "",
    transactionId: undefined,
    bookingDate: yyyyMmDd,
    amount: "0.00",
    direction: "out",
    currency: account?.currency ?? fallbackCurrency,
    description: "",
    categoryHint: "",
    counterparty: "",
    reference: "",
  };
}

function toCreateRuleDraftFromTransaction(draft: EditableTransactionDraft): RuleFromTransactionDraft {
  return {
    descriptionContains: draft.description,
    descriptionRegex: "",
    amountExact: "",
    amountMin: "",
    amountMax: "",
    accountIds: [],
    applyCategory: "",
    assignCounterpartyFromRegexGroup: false,
    priority: RULE_DEFAULT_PRIORITY,
  };
}

type ParseCreateRulePayloadResult =
  | { ok: true; value: RouterInputs["accounts"]["createRule"] }
  | { ok: false; message: string };

function parseCreateRulePayload(draft: RuleFromTransactionDraft): ParseCreateRulePayloadResult {
  const parsedPriority = Number.parseInt(draft.priority.trim(), 10);
  if (!Number.isFinite(parsedPriority)) {
    return { ok: false, message: "Priority must be an integer." };
  }

  const amountExactCents = ruleAmountInputToCents(draft.amountExact);
  if (amountExactCents === null) {
    return {
      ok: false,
      message: "Exact amount must be a non-negative number with up to 2 decimal places.",
    };
  }

  const amountMinCents = ruleAmountInputToCents(draft.amountMin);
  if (amountMinCents === null) {
    return {
      ok: false,
      message: "Minimum amount must be a non-negative number with up to 2 decimal places.",
    };
  }

  const amountMaxCents = ruleAmountInputToCents(draft.amountMax);
  if (amountMaxCents === null) {
    return {
      ok: false,
      message: "Maximum amount must be a non-negative number with up to 2 decimal places.",
    };
  }

  if (
    typeof amountExactCents === "number" &&
    (typeof amountMinCents === "number" || typeof amountMaxCents === "number")
  ) {
    return { ok: false, message: "Use either exact amount or min/max range, not both." };
  }

  if (
    typeof amountMinCents === "number" &&
    typeof amountMaxCents === "number" &&
    amountMinCents > amountMaxCents
  ) {
    return { ok: false, message: "Minimum amount cannot exceed maximum amount." };
  }

  const descriptionContains = draft.descriptionContains.trim();
  const descriptionRegex = draft.descriptionRegex.trim();
  if (draft.assignCounterpartyFromRegexGroup && descriptionRegex.length === 0) {
    return {
      ok: false,
      message: "Description regex is required when assigning counterparty from capture group.",
    };
  }

  const applyCategory = draft.applyCategory.trim();
  const accountIds = Array.from(
    new Set(draft.accountIds.filter((accountId) => Number.isInteger(accountId) && accountId > 0))
  ).sort((left, right) => left - right);

  const hasCondition =
    descriptionContains.length > 0 ||
    descriptionRegex.length > 0 ||
    typeof amountExactCents === "number" ||
    typeof amountMinCents === "number" ||
    typeof amountMaxCents === "number" ||
    accountIds.length > 0;
  if (!hasCondition) {
    return { ok: false, message: "At least one condition is required." };
  }

  const hasAction = applyCategory.length > 0 || draft.assignCounterpartyFromRegexGroup;
  if (!hasAction) {
    return { ok: false, message: "At least one action is required." };
  }

  return {
    ok: true,
    value: {
      descriptionContains: descriptionContains.length > 0 ? descriptionContains : undefined,
      descriptionRegex: descriptionRegex.length > 0 ? descriptionRegex : undefined,
      amountExactCents,
      amountMinCents,
      amountMaxCents,
      accountIds: accountIds.length > 0 ? accountIds : undefined,
      applyCategory: applyCategory.length > 0 ? applyCategory : undefined,
      assignCounterpartyFromRegexGroup: draft.assignCounterpartyFromRegexGroup,
      priority: parsedPriority,
    },
  };
}

export function TransactionsContent({ view }: TransactionsContentProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isMounted, setIsMounted] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [descriptionSearchTerm, setDescriptionSearchTerm] = useState("");
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [accountFilterOpen, setAccountFilterOpen] = useState(false);
  const [categoryFilterOpen, setCategoryFilterOpen] = useState(false);
  const [transactionModal, setTransactionModal] = useState<TransactionModalState | null>(null);
  const [ruleModal, setRuleModal] = useState<RuleFromTransactionModalState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleNotice, setRuleNotice] = useState<string | null>(null);
  const accountsQuery = trpc.accounts.list.useQuery();
  const createTransactionMutation = trpc.accounts.createTransaction.useMutation();
  const deleteTransactionMutation = trpc.accounts.deleteTransaction.useMutation();
  const createRuleMutation = trpc.accounts.createRule.useMutation();
  const accountFilterRef = useRef<HTMLDivElement | null>(null);
  const categoryFilterRef = useRef<HTMLDivElement | null>(null);
  const updateTransactionMutation = trpc.accounts.updateTransaction.useMutation();

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!transactionModal) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const isTransactionMutating =
        updateTransactionMutation.isPending ||
        createTransactionMutation.isPending ||
        deleteTransactionMutation.isPending;
      const isRuleMutating = createRuleMutation.isPending;

      if (event.key === "Escape" && ruleModal && !isRuleMutating) {
        event.preventDefault();
        setRuleModal(null);
        setRuleError(null);
        return;
      }

      if (event.key === "Escape" && !ruleModal && !isTransactionMutating) {
        event.preventDefault();
        setTransactionModal(null);
        setRuleModal(null);
        setEditError(null);
        setRuleError(null);
        setRuleNotice(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    transactionModal,
    ruleModal,
    updateTransactionMutation.isPending,
    createTransactionMutation.isPending,
    deleteTransactionMutation.isPending,
    createRuleMutation.isPending,
  ]);

  useEffect(() => {
    if (!isMounted || !transactionModal) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [transactionModal, isMounted]);

  useEffect(() => {
    if (!accountFilterOpen && !categoryFilterOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && accountFilterRef.current && !accountFilterRef.current.contains(target)) {
        setAccountFilterOpen(false);
      }
      if (target && categoryFilterRef.current && !categoryFilterRef.current.contains(target)) {
        setCategoryFilterOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountFilterOpen(false);
        setCategoryFilterOpen(false);
      }
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [accountFilterOpen, categoryFilterOpen]);

  function openEditModal(row: TransactionRow): void {
    setEditError(null);
    setRuleError(null);
    setRuleNotice(null);
    setRuleModal(null);
    setTransactionModal({
      mode: "edit",
      draft: toEditableTransactionDraft(row),
    });
  }

  function closeEditModal(): void {
    if (
      updateTransactionMutation.isPending ||
      createTransactionMutation.isPending ||
      deleteTransactionMutation.isPending ||
      createRuleMutation.isPending
    ) {
      return;
    }

    setTransactionModal(null);
    setRuleModal(null);
    setEditError(null);
    setRuleError(null);
    setRuleNotice(null);
  }

  function updateEditingField<Key extends keyof EditableTransactionDraft>(
    key: Key,
    value: EditableTransactionDraft[Key]
  ): void {
    setTransactionModal((current) => {
      if (!current) {
        return null;
      }

      return {
        ...current,
        draft: {
          ...current.draft,
          [key]: value,
        },
      };
    });
  }

  function toggleSelectedAccount(accountName: string): void {
    setSelectedAccounts((current) =>
      current.includes(accountName)
        ? current.filter((value) => value !== accountName)
        : [...current, accountName]
    );
  }

  function toggleSelectedCategory(category: string): void {
    setSelectedCategories((current) =>
      current.includes(category) ? current.filter((value) => value !== category) : [...current, category]
    );
  }

  function removeSelectedAccount(accountName: string): void {
    setSelectedAccounts((current) => current.filter((value) => value !== accountName));
  }

  function removeSelectedCategory(category: string): void {
    setSelectedCategories((current) => current.filter((value) => value !== category));
  }

  function clearAllClientFilters(): void {
    setDescriptionSearchTerm("");
    setSelectedAccounts([]);
    setSelectedCategories([]);
    setAccountFilterOpen(false);
    setCategoryFilterOpen(false);
  }

  function openCreateModal(): void {
    const fallbackCurrency = view.transactions[0]?.transaction.currency ?? "EUR";
    setEditError(null);
    setRuleError(null);
    setRuleNotice(null);
    setRuleModal(null);
    setTransactionModal({
      mode: "create",
      draft: toCreateTransactionDraft(accountChoices[0], fallbackCurrency),
    });
  }

  function openCreateRuleModalFromTransaction(): void {
    if (!transactionModal || transactionModal.mode !== "edit") {
      return;
    }

    setRuleError(null);
    setRuleNotice(null);
    setRuleModal({
      sourceAccountName: transactionModal.draft.accountName,
      sourceTransactionId: transactionModal.draft.transactionId,
      sourceDescription: transactionModal.draft.description,
      draft: toCreateRuleDraftFromTransaction(transactionModal.draft),
    });
  }

  function closeCreateRuleModal(): void {
    if (createRuleMutation.isPending) {
      return;
    }

    setRuleModal(null);
    setRuleError(null);
  }

  function updateRuleField<Key extends keyof RuleFromTransactionDraft>(
    key: Key,
    value: RuleFromTransactionDraft[Key]
  ): void {
    setRuleModal((current) => {
      if (!current) {
        return null;
      }

      return {
        ...current,
        draft: {
          ...current.draft,
          [key]: value,
        },
      };
    });
  }

  function toggleRuleAccount(accountId: number): void {
    setRuleModal((current) => {
      if (!current) {
        return null;
      }

      const selected = current.draft.accountIds.includes(accountId);
      return {
        ...current,
        draft: {
          ...current.draft,
          accountIds: selected
            ? current.draft.accountIds.filter((entry) => entry !== accountId)
            : [...current.draft.accountIds, accountId],
        },
      };
    });
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!transactionModal) {
      return;
    }

    const draft = transactionModal.draft;
    const bookingDate = draft.bookingDate.trim();
    const amountCents = amountInputToCents(draft.amount);
    const currency = draft.currency.trim();
    const description = draft.description.trim();
    const categoryHint = draft.categoryHint.trim();
    const counterparty = draft.counterparty.trim();
    const reference = draft.reference.trim();

    if (!BOOKING_DATE_PATTERN.test(bookingDate)) {
      setEditError("Booking date must use YYYY-MM-DD format.");
      return;
    }

    if (!amountCents) {
      setEditError("Amount must be a positive number with up to 2 decimal places.");
      return;
    }

    if (currency.length === 0) {
      setEditError("Currency is required.");
      return;
    }

    if (description.length === 0) {
      setEditError("Description is required.");
      return;
    }

    if (draft.accountId <= 0) {
      setEditError("Please select an account.");
      return;
    }

    setEditError(null);

    try {
      if (transactionModal.mode === "create") {
        await createTransactionMutation.mutateAsync({
          accountId: draft.accountId,
          bookingDate,
          amountCents,
          currency,
          direction: draft.direction,
          description,
          categoryHint: categoryHint.length > 0 ? categoryHint : undefined,
          counterparty: counterparty.length > 0 ? counterparty : undefined,
          reference: reference.length > 0 ? reference : undefined,
        });
      } else {
        if (!draft.transactionId) {
          setEditError("Transaction id is missing.");
          return;
        }

        await updateTransactionMutation.mutateAsync({
          accountId: draft.accountId,
          transactionId: draft.transactionId,
          bookingDate,
          amountCents,
          currency,
          direction: draft.direction,
          description,
          categoryHint: categoryHint.length > 0 ? categoryHint : undefined,
          counterparty: counterparty.length > 0 ? counterparty : undefined,
          reference: reference.length > 0 ? reference : undefined,
        });
      }

      setTransactionModal(null);
      setRuleModal(null);
      router.refresh();
    } catch (error) {
      setEditError(
        resolveErrorMessage(
          error,
          transactionModal.mode === "create" ? "Could not create transaction." : "Could not update transaction."
        )
      );
    }
  }

  async function handleDeleteTransaction(): Promise<void> {
    if (!transactionModal || transactionModal.mode !== "edit") {
      return;
    }

    const draft = transactionModal.draft;
    if (!draft.transactionId) {
      setEditError("Transaction id is missing.");
      return;
    }

    const confirmed = window.confirm(
      `Delete transaction "${draft.description}" from ${draft.accountName}? This action cannot be undone.`
    );
    if (!confirmed) {
      return;
    }

    setEditError(null);

    try {
      await deleteTransactionMutation.mutateAsync({
        accountId: draft.accountId,
        transactionId: draft.transactionId,
      });
      setTransactionModal(null);
      setRuleModal(null);
      router.refresh();
    } catch (error) {
      setEditError(resolveErrorMessage(error, "Could not delete transaction."));
    }
  }

  async function handleCreateRuleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ruleModal || createRuleMutation.isPending) {
      return;
    }

    const parsed = parseCreateRulePayload(ruleModal.draft);
    if (!parsed.ok) {
      setRuleError(parsed.message);
      return;
    }

    setRuleError(null);

    try {
      await createRuleMutation.mutateAsync(parsed.value);
      setRuleModal(null);
      setRuleNotice(
        "Rule created. It will apply on future imports and manual transaction changes."
      );
    } catch (error) {
      setRuleError(resolveErrorMessage(error, "Could not create rule from this transaction."));
    }
  }

  const accountChoices = useMemo<AccountChoice[]>(() => {
    if (accountsQuery.data && accountsQuery.data.length > 0) {
      return [...accountsQuery.data]
        .map((account: PersistedAccount) => ({
          id: account.id,
          name: account.name,
          color: account.color,
          currency: account.currency,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    const byId = new Map<number, AccountChoice>();
    view.transactions.forEach((row) => {
      if (!byId.has(row.accountId)) {
        byId.set(row.accountId, {
          id: row.accountId,
          name: row.accountName,
          color: row.accountColor,
          currency: row.transaction.currency || undefined,
        });
      }
    });

    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [accountsQuery.data, view.transactions]);

  const accountOptions = useMemo(() => {
    return accountChoices.map((account) => account.name);
  }, [accountChoices]);

  const accountColorByName = useMemo(() => {
    const colors = new Map<string, string>();

    accountChoices.forEach((account) => {
      if (!colors.has(account.name)) {
        colors.set(account.name, account.color);
      }
    });

    view.transactions.forEach((row) => {
      if (!colors.has(row.accountName)) {
        colors.set(row.accountName, row.accountColor);
      }
    });

    return colors;
  }, [accountChoices, view.transactions]);

  const categoryOptions = useMemo(() => {
    return Array.from(new Set(view.transactions.map((row) => getCategoryLabel(row)))).sort((a, b) =>
      a.localeCompare(b)
    );
  }, [view.transactions]);

  const filteredTransactions = useMemo(() => {
    const normalizedSearchTerm = descriptionSearchTerm.trim().toLocaleLowerCase("en-US");

    return view.transactions.filter((row) => {
      if (
        normalizedSearchTerm.length > 0 &&
        !row.transaction.description.toLocaleLowerCase("en-US").includes(normalizedSearchTerm)
      ) {
        return false;
      }

      if (selectedAccounts.length > 0 && !selectedAccounts.includes(row.accountName)) {
        return false;
      }

      const categoryLabel = getCategoryLabel(row);
      if (selectedCategories.length > 0 && !selectedCategories.includes(categoryLabel)) {
        return false;
      }

      return true;
    });
  }, [descriptionSearchTerm, selectedAccounts, selectedCategories, view.transactions]);

  const columns = useMemo<ColumnDef<TransactionRow>[]>(
    () => [
      {
        id: "description",
        header: "Description",
        accessorFn: (row) => row.transaction.description,
        cell: ({ row }) => row.original.transaction.description,
      },
      {
        id: "category",
        header: "Category",
        accessorFn: (row) => row.transaction.categoryHint ?? "Uncategorized",
        cell: ({ row }) => row.original.transaction.categoryHint ?? "Uncategorized",
      },
      {
        id: "account",
        header: "Account",
        accessorFn: (row) => row.accountName,
        cell: ({ row }) => (
          <span
            className="inline-flex items-center gap-2 rounded-full border border-ink-soft/20 px-2.5 py-1 text-xs font-semibold"
            style={{ color: row.original.accountColor }}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: row.original.accountColor }}
              aria-hidden
            />
            {row.original.accountName}
          </span>
        ),
      },
      {
        id: "date",
        header: "Date",
        accessorFn: (row) => row.transaction.bookingDate,
        cell: ({ row }) => row.original.transaction.bookingDate,
      },
      {
        id: "amount",
        header: "Amount",
        accessorFn: (row) =>
          row.transaction.direction === "in" ? row.transaction.amountCents : -row.transaction.amountCents,
        cell: ({ row }) => {
          const transaction = row.original.transaction;
          const isIncome = transaction.direction === "in";
          const amount = formatCurrencyCents(transaction.amountCents, transaction.currency || "EUR");

          return (
            <>
              {isIncome ? "+" : "-"}
              {amount}
            </>
          );
        },
      },
    ],
    []
  );
  // TanStack table exposes mutable APIs that React Compiler's compatibility lint does not support.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: filteredTransactions,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => `${row.accountId}-${row.transaction.id}`,
  });
  const isModalMutating =
    updateTransactionMutation.isPending ||
    createTransactionMutation.isPending ||
    deleteTransactionMutation.isPending ||
    createRuleMutation.isPending;
  const selectedStartMonth = view.selectedStartMonth ?? "";
  const selectedEndMonth = view.selectedEndMonth ?? "";

  function navigateToMonthRange(nextStartMonth: string, nextEndMonth: string): void {
    if (nextStartMonth.length === 0 || nextEndMonth.length === 0) {
      router.replace(pathname, { scroll: false });
      return;
    }

    const startMonth = nextStartMonth <= nextEndMonth ? nextStartMonth : nextEndMonth;
    const endMonth = nextStartMonth <= nextEndMonth ? nextEndMonth : nextStartMonth;
    const params = new URLSearchParams();
    params.set("startMonth", startMonth);
    params.set("endMonth", endMonth);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
      <SectionShell
        title="Transactions"
        subtitle="Cross-account transaction view with month-range filtering and account color coding."
        action={
          <div className="space-y-1 text-right">
            <p className="font-mono text-xs text-muted">{view.importedTransactionCount} imported</p>
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap items-start gap-3">
          <button
            type="button"
            onClick={openCreateModal}
            disabled={accountChoices.length === 0}
            className="rounded-full border border-accent/35 bg-accent/10 px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Add Transaction
          </button>

          <div className="w-full basis-full rounded-2xl border border-ink-soft/15 bg-surface/80 p-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.2fr)_minmax(190px,1fr)_minmax(190px,1fr)_auto] lg:items-end">
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                Description Search
                <input
                  type="text"
                  value={descriptionSearchTerm}
                  onChange={(event) => {
                    setDescriptionSearchTerm(event.target.value);
                  }}
                  placeholder="Contains text..."
                  className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                />
              </label>

              <div className="relative" ref={accountFilterRef}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Accounts</p>
                <button
                  type="button"
                  onClick={() => {
                    setAccountFilterOpen((current) => !current);
                    setCategoryFilterOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground transition hover:border-ink-soft/35"
                >
                  <span className="truncate">
                    {selectedAccounts.length === 0 ? "All accounts" : `${selectedAccounts.length} selected`}
                  </span>
                  <span className="text-muted">{accountFilterOpen ? "▴" : "▾"}</span>
                </button>
                {accountFilterOpen ? (
                  <div className="absolute z-30 mt-2 w-full rounded-xl border border-ink-soft/20 bg-surface p-2 shadow-[0_20px_40px_-28px_rgba(22,34,43,0.55)]">
                    <div className="mb-2 flex items-center justify-between px-1">
                      <span className="text-[11px] uppercase tracking-[0.1em] text-muted">
                        {selectedAccounts.length} selected
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAccounts([]);
                        }}
                        className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted hover:text-foreground"
                      >
                        Clear
                      </button>
                    </div>
                    <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
                      {accountOptions.map((accountName) => (
                        <li key={accountName}>
                          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground hover:bg-background/70">
                            <input
                              type="checkbox"
                              checked={selectedAccounts.includes(accountName)}
                              onChange={() => {
                                toggleSelectedAccount(accountName);
                              }}
                              className="h-3.5 w-3.5 rounded border-ink-soft/30"
                            />
                            <span
                              className="inline-flex min-w-0 items-center gap-2 rounded-full border border-ink-soft/20 px-2.5 py-1 font-semibold"
                              style={{ color: accountColorByName.get(accountName) }}
                            >
                              <span
                                className="inline-block h-2.5 w-2.5 rounded-full"
                                style={{ backgroundColor: accountColorByName.get(accountName) }}
                                aria-hidden
                              />
                              <span className="truncate">{accountName}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="relative" ref={categoryFilterRef}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Categories</p>
                <button
                  type="button"
                  onClick={() => {
                    setCategoryFilterOpen((current) => !current);
                    setAccountFilterOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground transition hover:border-ink-soft/35"
                >
                  <span className="truncate">
                    {selectedCategories.length === 0 ? "All categories" : `${selectedCategories.length} selected`}
                  </span>
                  <span className="text-muted">{categoryFilterOpen ? "▴" : "▾"}</span>
                </button>
                {categoryFilterOpen ? (
                  <div className="absolute z-30 mt-2 w-full rounded-xl border border-ink-soft/20 bg-surface p-2 shadow-[0_20px_40px_-28px_rgba(22,34,43,0.55)]">
                    <div className="mb-2 flex items-center justify-between px-1">
                      <span className="text-[11px] uppercase tracking-[0.1em] text-muted">
                        {selectedCategories.length} selected
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCategories([]);
                        }}
                        className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted hover:text-foreground"
                      >
                        Clear
                      </button>
                    </div>
                    <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
                      {categoryOptions.map((category) => (
                        <li key={category}>
                          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground hover:bg-background/70">
                            <input
                              type="checkbox"
                              checked={selectedCategories.includes(category)}
                              onChange={() => {
                                toggleSelectedCategory(category);
                              }}
                              className="h-3.5 w-3.5 rounded border-ink-soft/30"
                            />
                            <span className="truncate">{category}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={clearAllClientFilters}
                  disabled={
                    descriptionSearchTerm.trim().length === 0 &&
                    selectedAccounts.length === 0 &&
                    selectedCategories.length === 0
                  }
                  className="rounded-full border border-ink-soft/20 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                Start Month
                <select
                  value={selectedStartMonth}
                  disabled={view.monthOptions.length === 0}
                  onChange={(event) => {
                    const nextStartMonth = event.target.value;
                    const nextEndMonth =
                      selectedEndMonth.length > 0 && nextStartMonth <= selectedEndMonth
                        ? selectedEndMonth
                        : nextStartMonth;
                    navigateToMonthRange(nextStartMonth, nextEndMonth);
                  }}
                  className="rounded-full border border-ink-soft/20 bg-surface px-3 py-1.5 text-xs text-foreground outline-none focus:border-accent"
                >
                  {view.monthOptions.length === 0 ? (
                    <option value="">No months</option>
                  ) : (
                    view.monthOptions.map((month) => (
                      <option key={month} value={month}>
                        {formatMonthLabel(month)}
                      </option>
                    ))
                  )}
                </select>
              </label>

              <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                End Month
                <select
                  value={selectedEndMonth}
                  disabled={view.monthOptions.length === 0}
                  onChange={(event) => {
                    const nextEndMonth = event.target.value;
                    const nextStartMonth =
                      selectedStartMonth.length > 0 && selectedStartMonth <= nextEndMonth
                        ? selectedStartMonth
                        : nextEndMonth;
                    navigateToMonthRange(nextStartMonth, nextEndMonth);
                  }}
                  className="rounded-full border border-ink-soft/20 bg-surface px-3 py-1.5 text-xs text-foreground outline-none focus:border-accent"
                >
                  {view.monthOptions.length === 0 ? (
                    <option value="">No months</option>
                  ) : (
                    view.monthOptions.map((month) => (
                      <option key={month} value={month}>
                        {formatMonthLabel(month)}
                      </option>
                    ))
                  )}
                </select>
              </label>

              {selectedAccounts.map((accountName) => (
                <button
                  key={`account-${accountName}`}
                  type="button"
                  onClick={() => {
                    removeSelectedAccount(accountName);
                  }}
                  className="inline-flex items-center gap-2 rounded-full border border-ink-soft/20 bg-surface px-2.5 py-1 text-xs font-semibold transition hover:border-ink-soft/35"
                  style={{ color: accountColorByName.get(accountName) }}
                  title="Remove account filter"
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: accountColorByName.get(accountName) }}
                    aria-hidden
                  />
                  {accountName}
                  <span className="text-muted">x</span>
                </button>
              ))}
              {selectedCategories.map((category) => (
                <button
                  key={`category-${category}`}
                  type="button"
                  onClick={() => {
                    removeSelectedCategory(category);
                  }}
                  className="inline-flex items-center gap-2 rounded-full border border-ink-soft/20 bg-surface px-3 py-1 text-xs font-semibold text-foreground transition hover:border-ink-soft/35"
                  title="Remove category filter"
                >
                  <span className="text-muted">Category</span>
                  {category}
                  <span className="text-muted">x</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] border-separate border-spacing-y-2">
            <thead className="text-left text-xs uppercase tracking-[0.14em] text-muted">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const isAmount = header.column.id === "amount";
                    const sorted = header.column.getIsSorted();

                    return (
                      <th key={header.id} className={`px-3 py-2 ${isAmount ? "text-right" : ""}`}>
                        {header.isPlaceholder ? null : header.column.getCanSort() ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className={`inline-flex items-center gap-1 rounded-sm hover:text-foreground ${
                              isAmount ? "ml-auto" : ""
                            }`}
                            aria-label={`Sort by ${String(header.column.columnDef.header)}`}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <span className="font-mono text-[10px] leading-none text-muted">
                              {sorted === "asc" ? "^" : sorted === "desc" ? "v" : "-"}
                            </span>
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr className="rounded-2xl bg-surface">
                  <td
                    colSpan={5}
                    className="rounded-xl border border-ink-soft/15 px-3 py-6 text-center text-sm text-muted"
                  >
                    No transactions found. Add accounts and upload statement files on the Overview tab.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => {
                  return (
                    <tr
                      key={row.id}
                      className="rounded-2xl bg-surface transition hover:bg-surface/70"
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        openEditModal(row.original);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openEditModal(row.original);
                        }
                      }}
                      aria-label={`Edit transaction ${row.original.transaction.description}`}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const isDescription = cell.column.id === "description";
                        const isCategory = cell.column.id === "category";
                        const isAccount = cell.column.id === "account";
                        const isDate = cell.column.id === "date";
                        const isAmount = cell.column.id === "amount";
                        const isIncome = row.original.transaction.direction === "in";

                        return (
                          <td
                            key={cell.id}
                            className={[
                              "border-ink-soft/15 px-3 py-3",
                              isDescription && "rounded-l-xl border border-r-0 text-sm text-foreground",
                              isCategory && "border-y text-sm text-muted",
                              isAccount && "border-y text-sm",
                              isDate && "border-y font-mono text-xs text-muted",
                              isAmount &&
                                `rounded-r-xl border border-l-0 text-right font-mono text-sm ${
                                  isIncome ? "text-positive" : "text-danger"
                                }`,
                            ]
                              .filter(Boolean)
                              .join(" ")}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {isMounted && transactionModal
          ? createPortal(
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 px-4 py-6"
                onClick={closeEditModal}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="transaction-edit-title"
                  className="w-full max-w-2xl rounded-2xl border border-ink-soft/20 bg-surface p-5 shadow-[0_24px_90px_-40px_rgba(20,34,43,0.7)]"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 id="transaction-edit-title" className="text-base font-semibold text-foreground">
                        {transactionModal.mode === "create" ? "Add Transaction" : "Edit Transaction"}
                      </h3>
                      <p className="mt-1 text-xs text-muted">
                        {transactionModal.mode === "create"
                          ? transactionModal.draft.accountName || "Select an account"
                          : `${transactionModal.draft.accountName} · ${transactionModal.draft.transactionId}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={closeEditModal}
                      disabled={isModalMutating}
                      className="rounded-full border border-ink-soft/20 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Close
                    </button>
                  </div>

                  <form className="mt-5 space-y-4" onSubmit={(event) => void handleEditSubmit(event)}>
                    {transactionModal.mode === "create" ? (
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Account
                        <select
                          value={String(transactionModal.draft.accountId)}
                          onChange={(event) => {
                            const nextAccountId = Number.parseInt(event.target.value, 10);
                            const nextAccount = accountChoices.find((account) => account.id === nextAccountId);
                            setTransactionModal((current) => {
                              if (!current) {
                                return null;
                              }

                              return {
                                ...current,
                                draft: {
                                  ...current.draft,
                                  accountId: nextAccount?.id ?? 0,
                                  accountName: nextAccount?.name ?? "",
                                  currency:
                                    current.mode === "create" && nextAccount?.currency
                                      ? nextAccount.currency
                                      : current.draft.currency,
                                },
                              };
                            });
                          }}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        >
                          {accountChoices.length === 0 ? (
                            <option value="0">No accounts available</option>
                          ) : (
                            accountChoices.map((account) => (
                              <option key={account.id} value={String(account.id)}>
                                {account.name}
                              </option>
                            ))
                          )}
                        </select>
                      </label>
                    ) : (
                      <div className="inline-flex items-center gap-2 rounded-full border border-ink-soft/20 px-2.5 py-1 text-xs font-semibold">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{
                            backgroundColor: accountColorByName.get(transactionModal.draft.accountName),
                          }}
                          aria-hidden
                        />
                        {transactionModal.draft.accountName}
                      </div>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Booking Date
                        <input
                          type="date"
                          value={transactionModal.draft.bookingDate}
                          onChange={(event) => {
                            updateEditingField("bookingDate", event.target.value);
                          }}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Amount
                        <input
                          type="text"
                          inputMode="decimal"
                          value={transactionModal.draft.amount}
                          onChange={(event) => {
                            updateEditingField("amount", event.target.value);
                          }}
                          placeholder="0.00"
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Direction
                        <select
                          value={transactionModal.draft.direction}
                          onChange={(event) => {
                            updateEditingField("direction", event.target.value as "in" | "out");
                          }}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        >
                          <option value="in">Inflow</option>
                          <option value="out">Outflow</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Currency
                        <input
                          type="text"
                          value={transactionModal.draft.currency}
                          onChange={(event) => {
                            updateEditingField("currency", event.target.value);
                          }}
                          maxLength={16}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                    </div>

                    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                      Description
                      <input
                        type="text"
                        value={transactionModal.draft.description}
                        onChange={(event) => {
                          updateEditingField("description", event.target.value);
                        }}
                        maxLength={500}
                        className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                      />
                    </label>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Category
                        <input
                          type="text"
                          value={transactionModal.draft.categoryHint}
                          onChange={(event) => {
                            updateEditingField("categoryHint", event.target.value);
                          }}
                          maxLength={120}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Counterparty
                        <input
                          type="text"
                          value={transactionModal.draft.counterparty}
                          onChange={(event) => {
                            updateEditingField("counterparty", event.target.value);
                          }}
                          maxLength={300}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                    </div>

                    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                      Reference
                      <input
                        type="text"
                        value={transactionModal.draft.reference}
                        onChange={(event) => {
                          updateEditingField("reference", event.target.value);
                        }}
                        maxLength={300}
                        className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                      />
                    </label>

                    {editError && (
                      <p className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                        {editError}
                      </p>
                    )}
                    {ruleNotice && (
                      <p className="rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">
                        {ruleNotice}
                      </p>
                    )}

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {transactionModal.mode === "edit" ? (
                          <>
                            <button
                              type="button"
                              onClick={openCreateRuleModalFromTransaction}
                              disabled={isModalMutating}
                              className="rounded-full border border-accent/40 bg-accent/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Create Rule
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteTransaction()}
                              disabled={isModalMutating}
                              className="rounded-full border border-danger/40 bg-danger/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-danger transition hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {deleteTransactionMutation.isPending ? "Deleting..." : "Delete"}
                            </button>
                          </>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={closeEditModal}
                          disabled={isModalMutating}
                          className="rounded-full border border-ink-soft/20 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={isModalMutating}
                          className="rounded-full border border-accent/40 bg-accent/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {transactionModal.mode === "create"
                            ? createTransactionMutation.isPending
                              ? "Creating..."
                              : "Create Transaction"
                            : updateTransactionMutation.isPending
                              ? "Saving..."
                              : "Save Changes"}
                        </button>
                      </div>
                    </div>
                  </form>
                </div>
              </div>,
              document.body
            )
          : null}

        {isMounted && ruleModal
          ? createPortal(
              <div
                className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/50 px-4 py-6"
                onClick={closeCreateRuleModal}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="transaction-rule-create-title"
                  className="w-full max-w-2xl rounded-2xl border border-ink-soft/20 bg-surface p-5 shadow-[0_24px_90px_-40px_rgba(20,34,43,0.7)]"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 id="transaction-rule-create-title" className="text-base font-semibold text-foreground">
                        Create Rule From Transaction
                      </h3>
                      <p className="mt-1 text-xs text-muted">
                        {ruleModal.sourceAccountName}
                        {ruleModal.sourceTransactionId ? ` · ${ruleModal.sourceTransactionId}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        Prefilled from: {ruleModal.sourceDescription}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={closeCreateRuleModal}
                      disabled={createRuleMutation.isPending}
                      className="rounded-full border border-ink-soft/20 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Close
                    </button>
                  </div>

                  <form className="mt-5 space-y-4" onSubmit={(event) => void handleCreateRuleSubmit(event)}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Description Contains
                        <input
                          type="text"
                          value={ruleModal.draft.descriptionContains}
                          onChange={(event) => {
                            updateRuleField("descriptionContains", event.target.value);
                          }}
                          maxLength={500}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Description Regex
                        <input
                          type="text"
                          value={ruleModal.draft.descriptionRegex}
                          onChange={(event) => {
                            updateRuleField("descriptionRegex", event.target.value);
                          }}
                          maxLength={500}
                          placeholder="e.g. ^Transfer to (.+)$"
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Amount Exact
                        <input
                          type="text"
                          inputMode="decimal"
                          value={ruleModal.draft.amountExact}
                          onChange={(event) => {
                            updateRuleField("amountExact", event.target.value);
                          }}
                          placeholder="0.00"
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Amount Min
                        <input
                          type="text"
                          inputMode="decimal"
                          value={ruleModal.draft.amountMin}
                          onChange={(event) => {
                            updateRuleField("amountMin", event.target.value);
                          }}
                          placeholder="0.00"
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Amount Max
                        <input
                          type="text"
                          inputMode="decimal"
                          value={ruleModal.draft.amountMax}
                          onChange={(event) => {
                            updateRuleField("amountMax", event.target.value);
                          }}
                          placeholder="0.00"
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                    </div>

                    <div className="rounded-2xl border border-ink-soft/15 bg-surface/80 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Account Set</p>
                        <button
                          type="button"
                          onClick={() => {
                            updateRuleField("accountIds", []);
                          }}
                          disabled={ruleModal.draft.accountIds.length === 0}
                          className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {accountChoices.map((account) => {
                          const isSelected = ruleModal.draft.accountIds.includes(account.id);

                          return (
                            <button
                              key={account.id}
                              type="button"
                              onClick={() => {
                                toggleRuleAccount(account.id);
                              }}
                              className={`flex items-center justify-between rounded-xl border px-3 py-2 text-xs transition ${
                                isSelected
                                  ? "border-accent/35 bg-accent/10 text-accent"
                                  : "border-ink-soft/20 bg-surface text-foreground hover:border-ink-soft/35"
                              }`}
                            >
                              <span className="inline-flex min-w-0 items-center gap-2">
                                <span
                                  className="inline-block h-2.5 w-2.5 rounded-full"
                                  style={{ backgroundColor: account.color }}
                                  aria-hidden
                                />
                                <span className="truncate">{account.name}</span>
                              </span>
                              <span className="font-mono text-[11px]">{isSelected ? "ON" : "OFF"}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Apply Category
                        <input
                          type="text"
                          value={ruleModal.draft.applyCategory}
                          onChange={(event) => {
                            updateRuleField("applyCategory", event.target.value);
                          }}
                          maxLength={120}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                        Priority
                        <input
                          type="number"
                          step={1}
                          value={ruleModal.draft.priority}
                          onChange={(event) => {
                            updateRuleField("priority", event.target.value);
                          }}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        />
                      </label>
                    </div>

                    <label className="inline-flex items-center gap-2 rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                      <input
                        type="checkbox"
                        checked={ruleModal.draft.assignCounterpartyFromRegexGroup}
                        onChange={(event) => {
                          updateRuleField("assignCounterpartyFromRegexGroup", event.target.checked);
                        }}
                        className="h-3.5 w-3.5 rounded border-ink-soft/30"
                      />
                      Counterparty from regex capture #1
                    </label>

                    {ruleError ? (
                      <p className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                        {ruleError}
                      </p>
                    ) : null}

                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={closeCreateRuleModal}
                        disabled={createRuleMutation.isPending}
                        className="rounded-full border border-ink-soft/20 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={createRuleMutation.isPending}
                        className="rounded-full border border-accent/40 bg-accent/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {createRuleMutation.isPending ? "Creating Rule..." : "Create Rule"}
                      </button>
                    </div>
                  </form>
                </div>
              </div>,
              document.body
            )
          : null}
      </SectionShell>
    </div>
  );
}
