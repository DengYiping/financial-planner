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
  ACCOUNT_COLORS,
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
type PersistedCategory = RouterOutputs["accounts"]["listCategories"][number];
type TransactionDirectionFilter = "all" | "inflow" | "outflow";

type TransactionsContentProps = {
  view: TransactionsView;
  initialSelectedCategory?: string;
  initialDirectionFilter?: TransactionDirectionFilter;
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
  categoryId: string;
  tagIds: number[];
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
  applyCategoryId: string;
  applyTagIds: number[];
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

type CategoryChoice = {
  id: number;
  name: string;
};

type TagChoice = {
  id: number;
  name: string;
  color: string;
};

type TransactionTagBadge = {
  id?: number;
  name: string;
  color: string;
};

type ParsedTagReference = {
  id?: number;
  name?: string;
};

const BOOKING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;
const RULE_DEFAULT_PRIORITY = "50";
const DEFAULT_TAG_COLOR = "#5B7CBA";

function tagAccent(tagId: number): string {
  return ACCOUNT_COLORS[(tagId - 1 + ACCOUNT_COLORS.length) % ACCOUNT_COLORS.length] ?? DEFAULT_TAG_COLOR;
}

function parseTagId(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? Math.trunc(value)
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseTagIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Set<number>();
  value.forEach((entry) => {
    const parsed = parseTagId(entry);
    if (parsed !== null) {
      deduped.add(parsed);
    }
  });

  return Array.from(deduped.values()).sort((left, right) => left - right);
}

function parseTagNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Set<string>();
  value.forEach((entry) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      deduped.add(entry.trim());
    }
  });

  return Array.from(deduped.values()).sort((left, right) => left.localeCompare(right));
}

function parseTagReferences(value: unknown): ParsedTagReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const dedupedById = new Set<number>();
  const dedupedByName = new Set<string>();
  const parsed: ParsedTagReference[] = [];

  value.forEach((entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }

    const record = entry as Record<string, unknown>;
    const id = parseTagId(record.id) ?? undefined;
    const rawName = typeof record.name === "string" ? record.name.trim() : "";
    const name = rawName.length > 0 ? rawName : undefined;
    if (typeof id !== "number" && !name) {
      return;
    }

    if (typeof id === "number") {
      if (dedupedById.has(id)) {
        return;
      }
      dedupedById.add(id);
      if (name) {
        dedupedByName.add(name.toLowerCase());
      }
      parsed.push({ id, name });
      return;
    }

    if (!name) {
      return;
    }

    const nameKey = name.toLowerCase();
    if (dedupedByName.has(nameKey)) {
      return;
    }
    dedupedByName.add(nameKey);
    parsed.push({ name });
  });

  return parsed;
}

function getTransactionTagIds(
  transaction: TransactionRow["transaction"],
  parsedTagReferences?: ParsedTagReference[]
): number[] {
  const transactionRecord = transaction as unknown as Record<string, unknown>;
  const directIds = parseTagIds(transactionRecord.tagIds);
  if (directIds.length > 0) {
    return directIds;
  }

  const nestedRefs = parsedTagReferences ?? parseTagReferences(transactionRecord.tags);
  return parseTagIds(nestedRefs.map((entry) => entry.id));
}

function getTransactionTagBadges(
  transaction: TransactionRow["transaction"],
  tagById: Map<number, TagChoice>
): TransactionTagBadge[] {
  const transactionRecord = transaction as unknown as Record<string, unknown>;
  const parsedTagReferences = parseTagReferences(transactionRecord.tags);
  const tagNameById = new Map<number, string>();
  parsedTagReferences.forEach((entry) => {
    if (typeof entry.id === "number" && entry.name && !tagNameById.has(entry.id)) {
      tagNameById.set(entry.id, entry.name);
    }
  });

  const tagIds = getTransactionTagIds(transaction, parsedTagReferences);
  if (tagIds.length > 0) {
    return tagIds.map((tagId) => {
      const tag = tagById.get(tagId);
      return {
        id: tagId,
        name: tag?.name ?? tagNameById.get(tagId) ?? `Tag #${tagId}`,
        color: tag?.color ?? tagAccent(tagId),
      };
    });
  }

  const parsedBadges = parsedTagReferences.flatMap((entry) => {
    if (!entry.name) {
      return [];
    }

    return [
      {
        id: entry.id,
        name: entry.name,
        color: typeof entry.id === "number" ? tagAccent(entry.id) : DEFAULT_TAG_COLOR,
      },
    ];
  });
  if (parsedBadges.length > 0) {
    return parsedBadges;
  }

  const tagNames = parseTagNames(transactionRecord.tagHints ?? transactionRecord.tagNames);
  return tagNames.map((name) => ({
    name,
    color: DEFAULT_TAG_COLOR,
  }));
}

function getCategoryLabel(row: TransactionRow): string {
  return row.transaction.categoryHint ?? "Uncategorized";
}

function getTransactionSelectionKey(row: TransactionRow): string {
  return `${row.accountId}::${row.transaction.id}`;
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
    categoryId: typeof row.transaction.categoryId === "number" ? String(row.transaction.categoryId) : "",
    tagIds: getTransactionTagIds(row.transaction),
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
    categoryId: "",
    tagIds: [],
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
    applyCategoryId: "",
    applyTagIds: [...draft.tagIds],
    assignCounterpartyFromRegexGroup: false,
    priority: RULE_DEFAULT_PRIORITY,
  };
}

type ParseCreateRulePayloadResult =
  | {
      ok: true;
      value: RouterInputs["accounts"]["createRule"];
    }
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

  const parsedCategoryId = Number.parseInt(draft.applyCategoryId, 10);
  const applyCategoryId =
    Number.isInteger(parsedCategoryId) && parsedCategoryId > 0 ? parsedCategoryId : undefined;
  const accountIds = Array.from(
    new Set(draft.accountIds.filter((accountId) => Number.isInteger(accountId) && accountId > 0))
  ).sort((left, right) => left - right);
  const applyTagIds = Array.from(
    new Set(draft.applyTagIds.filter((tagId) => Number.isInteger(tagId) && tagId > 0))
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

  const hasAction =
    typeof applyCategoryId === "number" ||
    draft.assignCounterpartyFromRegexGroup ||
    applyTagIds.length > 0;
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
      applyCategoryId,
      applyTagIds: applyTagIds.length > 0 ? applyTagIds : undefined,
      assignCounterpartyFromRegexGroup: draft.assignCounterpartyFromRegexGroup,
      priority: parsedPriority,
    },
  };
}

export function TransactionsContent({
  view,
  initialSelectedCategory,
  initialDirectionFilter = "all",
}: TransactionsContentProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isMounted, setIsMounted] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [descriptionSearchTerm, setDescriptionSearchTerm] = useState("");
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(() =>
    initialSelectedCategory ? [initialSelectedCategory] : []
  );
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedDirectionFilter, setSelectedDirectionFilter] =
    useState<TransactionDirectionFilter>(initialDirectionFilter);
  const [selectedTransactionKeys, setSelectedTransactionKeys] = useState<Set<string>>(new Set());
  const [batchCategorySelection, setBatchCategorySelection] = useState("");
  const [batchTagSelections, setBatchTagSelections] = useState<number[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [isBatchApplying, setIsBatchApplying] = useState(false);
  const [accountFilterOpen, setAccountFilterOpen] = useState(false);
  const [categoryFilterOpen, setCategoryFilterOpen] = useState(false);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [transactionModal, setTransactionModal] = useState<TransactionModalState | null>(null);
  const [ruleModal, setRuleModal] = useState<RuleFromTransactionModalState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleNotice, setRuleNotice] = useState<string | null>(null);
  const accountsQuery = trpc.accounts.list.useQuery();
  const categoriesQuery = trpc.accounts.listCategories.useQuery();
  const createTransactionMutation = trpc.accounts.createTransaction.useMutation();
  const deleteTransactionMutation = trpc.accounts.deleteTransaction.useMutation();
  const createRuleMutation = trpc.accounts.createRule.useMutation();
  const accountFilterRef = useRef<HTMLDivElement | null>(null);
  const categoryFilterRef = useRef<HTMLDivElement | null>(null);
  const tagFilterRef = useRef<HTMLDivElement | null>(null);
  const updateTransactionMutation = trpc.accounts.updateTransaction.useMutation();
  const tagsQuery = trpc.accounts.listTags.useQuery();

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    setSelectedCategories(initialSelectedCategory ? [initialSelectedCategory] : []);
  }, [initialSelectedCategory]);

  useEffect(() => {
    setSelectedDirectionFilter(initialDirectionFilter);
  }, [initialDirectionFilter]);

  useEffect(() => {
    const validKeys = new Set(view.transactions.map((row) => getTransactionSelectionKey(row)));
    setSelectedTransactionKeys((current) => {
      const next = new Set<string>();
      current.forEach((key) => {
        if (validKeys.has(key)) {
          next.add(key);
        }
      });
      return next;
    });
  }, [view.transactions]);

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
    if (!accountFilterOpen && !categoryFilterOpen && !tagFilterOpen) {
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
      if (target && tagFilterRef.current && !tagFilterRef.current.contains(target)) {
        setTagFilterOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountFilterOpen(false);
        setCategoryFilterOpen(false);
        setTagFilterOpen(false);
      }
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [accountFilterOpen, categoryFilterOpen, tagFilterOpen]);

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

  function toggleSelectedTag(tagName: string): void {
    setSelectedTags((current) =>
      current.includes(tagName) ? current.filter((value) => value !== tagName) : [...current, tagName]
    );
  }

  function removeSelectedAccount(accountName: string): void {
    setSelectedAccounts((current) => current.filter((value) => value !== accountName));
  }

  function removeSelectedCategory(category: string): void {
    setSelectedCategories((current) => current.filter((value) => value !== category));
  }

  function removeSelectedTag(tagName: string): void {
    setSelectedTags((current) => current.filter((value) => value !== tagName));
  }

  function clearAllClientFilters(): void {
    setDescriptionSearchTerm("");
    setSelectedAccounts([]);
    setSelectedCategories([]);
    setSelectedTags([]);
    setSelectedDirectionFilter("all");
    setAccountFilterOpen(false);
    setCategoryFilterOpen(false);
    setTagFilterOpen(false);
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

  function toggleEditingTag(tagId: number): void {
    setTransactionModal((current) => {
      if (!current) {
        return null;
      }

      const selected = current.draft.tagIds.includes(tagId);
      return {
        ...current,
        draft: {
          ...current.draft,
          tagIds: selected
            ? current.draft.tagIds.filter((entry) => entry !== tagId)
            : [...current.draft.tagIds, tagId],
        },
      };
    });
  }

  function toggleRuleApplyTag(tagId: number): void {
    setRuleModal((current) => {
      if (!current) {
        return null;
      }

      const selected = current.draft.applyTagIds.includes(tagId);
      const nextTagIds = selected
        ? current.draft.applyTagIds.filter((entry) => entry !== tagId)
        : [...current.draft.applyTagIds, tagId];

      return {
        ...current,
        draft: {
          ...current.draft,
          applyTagIds: nextTagIds,
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
    const parsedCategoryId = Number.parseInt(draft.categoryId, 10);
    const categoryId = Number.isInteger(parsedCategoryId) && parsedCategoryId > 0 ? parsedCategoryId : undefined;
    const tagIds = Array.from(
      new Set(draft.tagIds.filter((tagId) => Number.isInteger(tagId) && tagId > 0))
    ).sort((left, right) => left - right);
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
        const createPayload: RouterInputs["accounts"]["createTransaction"] & {
          tagIds?: number[];
        } = {
          accountId: draft.accountId,
          bookingDate,
          amountCents,
          currency,
          direction: draft.direction,
          description,
          categoryId,
          counterparty: counterparty.length > 0 ? counterparty : undefined,
          reference: reference.length > 0 ? reference : undefined,
        };
        if (tagIds.length > 0) {
          createPayload.tagIds = tagIds;
        }
        await createTransactionMutation.mutateAsync(createPayload);
      } else {
        if (!draft.transactionId) {
          setEditError("Transaction id is missing.");
          return;
        }

        const updatePayload: RouterInputs["accounts"]["updateTransaction"] & {
          tagIds?: number[];
        } = {
          accountId: draft.accountId,
          transactionId: draft.transactionId,
          bookingDate,
          amountCents,
          currency,
          direction: draft.direction,
          description,
          categoryId,
          counterparty: counterparty.length > 0 ? counterparty : undefined,
          reference: reference.length > 0 ? reference : undefined,
        };
        if (tagIds.length > 0) {
          updatePayload.tagIds = tagIds;
        }
        await updateTransactionMutation.mutateAsync(updatePayload);
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

  const categoryChoices = useMemo<CategoryChoice[]>(() => {
    return (categoriesQuery.data ?? [])
      .map((category: PersistedCategory) => ({
        id: category.id,
        name: category.name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [categoriesQuery.data]);

  const tagChoices = useMemo<TagChoice[]>(() => {
    const fromApi = tagsQuery.data ?? [];
    const byId = new Map<number, TagChoice>(
      fromApi.map((tag) => [
        tag.id,
        {
          id: tag.id,
          name: tag.name,
          color: tagAccent(tag.id),
        },
      ])
    );
    const byName = new Map<string, TagChoice>();
    fromApi.forEach((tag) => {
      byName.set(tag.name, {
        id: tag.id,
        name: tag.name,
        color: tagAccent(tag.id),
      });
    });

    view.transactions.forEach((row) => {
      const transaction = row.transaction as unknown as Record<string, unknown>;
      getTransactionTagIds(row.transaction).forEach((tagId) => {
        if (!byId.has(tagId)) {
          byId.set(tagId, {
            id: tagId,
            name: `Tag #${tagId}`,
            color: tagAccent(tagId),
          });
        }
      });

      const transactionNames = parseTagNames(transaction.tagHints ?? transaction.tagNames);
      transactionNames.forEach((name) => {
        if (!byName.has(name)) {
          byName.set(name, {
            id: Number.MIN_SAFE_INTEGER + byName.size,
            name,
            color: DEFAULT_TAG_COLOR,
          });
        }
      });
    });

    return [...byId.values(), ...Array.from(byName.values()).filter((tag) => tag.id <= 0)].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [tagsQuery.data, view.transactions]);

  const tagChoiceById = useMemo(() => {
    const byId = new Map<number, TagChoice>();
    tagChoices.forEach((tag) => {
      if (tag.id > 0) {
        byId.set(tag.id, tag);
      }
    });
    return byId;
  }, [tagChoices]);

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

  const tagOptions = useMemo(() => {
    return Array.from(new Set(tagChoices.map((tag) => tag.name))).sort((left, right) =>
      left.localeCompare(right)
    );
  }, [tagChoices]);

  const rowTagNames = useMemo(() => {
    const byRowKey = new Map<string, string[]>();
    view.transactions.forEach((row) => {
      const key = `${row.accountId}-${row.transaction.id}`;
      const names = getTransactionTagBadges(row.transaction, tagChoiceById).map((tag) => tag.name);
      byRowKey.set(key, names);
    });
    return byRowKey;
  }, [view.transactions, tagChoiceById]);

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

      if (selectedTags.length > 0) {
        const rowKey = `${row.accountId}-${row.transaction.id}`;
        const names = rowTagNames.get(rowKey) ?? [];
        if (!selectedTags.some((selectedTag) => names.includes(selectedTag))) {
          return false;
        }
      }

      if (selectedDirectionFilter === "inflow" && row.transaction.direction !== "in") {
        return false;
      }
      if (selectedDirectionFilter === "outflow" && row.transaction.direction !== "out") {
        return false;
      }

      return true;
    });
  }, [
    descriptionSearchTerm,
    selectedAccounts,
    selectedCategories,
    selectedTags,
    selectedDirectionFilter,
    rowTagNames,
    view.transactions,
  ]);

  const transactionBySelectionKey = useMemo(() => {
    const byKey = new Map<string, TransactionRow>();
    view.transactions.forEach((row) => {
      byKey.set(getTransactionSelectionKey(row), row);
    });
    return byKey;
  }, [view.transactions]);

  const filteredSelectionKeys = useMemo(
    () => filteredTransactions.map((row) => getTransactionSelectionKey(row)),
    [filteredTransactions]
  );

  const selectedTransactionRows = useMemo(() => {
    return Array.from(selectedTransactionKeys)
      .map((key) => transactionBySelectionKey.get(key))
      .filter((row): row is TransactionRow => Boolean(row));
  }, [selectedTransactionKeys, transactionBySelectionKey]);

  const selectedFilteredCount = useMemo(
    () => filteredSelectionKeys.filter((key) => selectedTransactionKeys.has(key)).length,
    [filteredSelectionKeys, selectedTransactionKeys]
  );
  const allFilteredSelected =
    filteredSelectionKeys.length > 0 && selectedFilteredCount === filteredSelectionKeys.length;

  const batchTagChoices = useMemo(() => tagChoices.filter((tag) => tag.id > 0), [tagChoices]);

  function toggleTransactionSelection(row: TransactionRow): void {
    const key = getTransactionSelectionKey(row);
    setSelectedTransactionKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function toggleSelectAllFilteredTransactions(): void {
    setSelectedTransactionKeys((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        filteredSelectionKeys.forEach((key) => {
          next.delete(key);
        });
      } else {
        filteredSelectionKeys.forEach((key) => {
          next.add(key);
        });
      }
      return next;
    });
  }

  function clearTransactionSelection(): void {
    setSelectedTransactionKeys(new Set());
  }

  async function handleBatchApplyCategory(): Promise<void> {
    if (isBatchApplying) {
      return;
    }
    if (selectedTransactionRows.length === 0) {
      setBatchError("Select at least one transaction row to apply a category.");
      setBatchNotice(null);
      return;
    }
    if (batchCategorySelection.length === 0) {
      setBatchError('Choose a category first (or "Uncategorized").');
      setBatchNotice(null);
      return;
    }

    const parsedCategoryId = Number.parseInt(batchCategorySelection, 10);
    const nextCategoryId =
      batchCategorySelection === "uncategorized"
        ? undefined
        : Number.isInteger(parsedCategoryId) && parsedCategoryId > 0
        ? parsedCategoryId
        : null;
    if (nextCategoryId === null) {
      setBatchError("Selected category is invalid.");
      setBatchNotice(null);
      return;
    }

    setIsBatchApplying(true);
    setBatchError(null);
    setBatchNotice(null);

    let updatedCount = 0;
    let failedCount = 0;
    let firstFailureMessage: string | undefined;

    for (const row of selectedTransactionRows) {
      try {
        const preservedTagIds = getTransactionTagIds(row.transaction);
        await updateTransactionMutation.mutateAsync({
          accountId: row.accountId,
          transactionId: row.transaction.id,
          bookingDate: row.transaction.bookingDate,
          amountCents: Math.abs(Math.trunc(row.transaction.amountCents)),
          currency: row.transaction.currency,
          direction: row.transaction.direction,
          description: row.transaction.description,
          categoryId: nextCategoryId,
          tagIds: preservedTagIds.length > 0 ? preservedTagIds : undefined,
          counterparty: row.transaction.counterparty ?? undefined,
          reference: row.transaction.reference ?? undefined,
        });
        updatedCount += 1;
      } catch (error) {
        failedCount += 1;
        if (!firstFailureMessage) {
          firstFailureMessage = resolveErrorMessage(error, "Could not apply batch category update.");
        }
      }
    }

    setIsBatchApplying(false);
    router.refresh();

    if (updatedCount > 0) {
      setBatchNotice(
        `Applied category to ${updatedCount} transaction${updatedCount === 1 ? "" : "s"}.`
      );
    }
    if (failedCount > 0) {
      setBatchError(
        `Failed to update ${failedCount} transaction${failedCount === 1 ? "" : "s"}${
          firstFailureMessage ? `: ${firstFailureMessage}` : "."
        }`
      );
    }
    if (failedCount === 0) {
      setSelectedTransactionKeys(new Set());
    }
  }

  async function handleBatchApplyTags(): Promise<void> {
    if (isBatchApplying) {
      return;
    }
    if (selectedTransactionRows.length === 0) {
      setBatchError("Select at least one transaction row to apply tags.");
      setBatchNotice(null);
      return;
    }

    const nextTagIds = Array.from(
      new Set(batchTagSelections.filter((tagId) => Number.isInteger(tagId) && tagId > 0))
    ).sort((left, right) => left - right);

    if (nextTagIds.length === 0) {
      setBatchError("Choose at least one tag first.");
      setBatchNotice(null);
      return;
    }

    setIsBatchApplying(true);
    setBatchError(null);
    setBatchNotice(null);

    let updatedCount = 0;
    let failedCount = 0;
    let firstFailureMessage: string | undefined;

    for (const row of selectedTransactionRows) {
      try {
        await updateTransactionMutation.mutateAsync({
          accountId: row.accountId,
          transactionId: row.transaction.id,
          bookingDate: row.transaction.bookingDate,
          amountCents: Math.abs(Math.trunc(row.transaction.amountCents)),
          currency: row.transaction.currency,
          direction: row.transaction.direction,
          description: row.transaction.description,
          categoryId:
            typeof row.transaction.categoryId === "number" && row.transaction.categoryId > 0
              ? row.transaction.categoryId
              : undefined,
          tagIds: nextTagIds,
          counterparty: row.transaction.counterparty ?? undefined,
          reference: row.transaction.reference ?? undefined,
        });
        updatedCount += 1;
      } catch (error) {
        failedCount += 1;
        if (!firstFailureMessage) {
          firstFailureMessage = resolveErrorMessage(error, "Could not apply batch tag update.");
        }
      }
    }

    setIsBatchApplying(false);
    router.refresh();

    if (updatedCount > 0) {
      setBatchNotice(`Applied tags to ${updatedCount} transaction${updatedCount === 1 ? "" : "s"}.`);
    }
    if (failedCount > 0) {
      setBatchError(
        `Failed to update ${failedCount} transaction${failedCount === 1 ? "" : "s"}${
          firstFailureMessage ? `: ${firstFailureMessage}` : "."
        }`
      );
    }
    if (failedCount === 0) {
      setSelectedTransactionKeys(new Set());
    }
  }

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
        id: "tags",
        header: "Tags",
        accessorFn: (row) =>
          getTransactionTagBadges(row.transaction, tagChoiceById)
            .map((tag) => tag.name)
            .join(", "),
        cell: ({ row }) => {
          const badges = getTransactionTagBadges(row.original.transaction, tagChoiceById);
          if (badges.length === 0) {
            return <span className="text-muted">No tags</span>;
          }

          return (
            <div className="flex flex-wrap gap-1.5">
              {badges.map((tag) => (
                <span
                  key={`${row.original.accountId}-${row.original.transaction.id}-tag-${tag.id ?? tag.name}`}
                  className="inline-flex items-center gap-1 rounded-full border border-ink-soft/20 px-2 py-0.5 text-[11px] font-semibold"
                  style={{ color: tag.color }}
                >
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} />
                  <span className="truncate">{tag.name}</span>
                </span>
              ))}
            </div>
          );
        },
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
    [tagChoiceById]
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
    if (selectedCategories.length === 1) {
      params.set("category", selectedCategories[0] ?? "");
    }
    if (selectedDirectionFilter !== "all") {
      params.set("direction", selectedDirectionFilter);
    }
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
            <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.2fr)_minmax(180px,1fr)_minmax(180px,1fr)_minmax(180px,1fr)_auto] lg:items-end">
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
                    setTagFilterOpen(false);
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
                    setTagFilterOpen(false);
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

              <div className="relative" ref={tagFilterRef}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Tags</p>
                <button
                  type="button"
                  onClick={() => {
                    setTagFilterOpen((current) => !current);
                    setAccountFilterOpen(false);
                    setCategoryFilterOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground transition hover:border-ink-soft/35"
                >
                  <span className="truncate">
                    {selectedTags.length === 0 ? "All tags" : `${selectedTags.length} selected`}
                  </span>
                  <span className="text-muted">{tagFilterOpen ? "▴" : "▾"}</span>
                </button>
                {tagFilterOpen ? (
                  <div className="absolute z-30 mt-2 w-full rounded-xl border border-ink-soft/20 bg-surface p-2 shadow-[0_20px_40px_-28px_rgba(22,34,43,0.55)]">
                    <div className="mb-2 flex items-center justify-between px-1">
                      <span className="text-[11px] uppercase tracking-[0.1em] text-muted">
                        {selectedTags.length} selected
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTags([]);
                        }}
                        className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted hover:text-foreground"
                      >
                        Clear
                      </button>
                    </div>
                    <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
                      {tagOptions.length === 0 ? (
                        <li className="px-2 py-1.5 text-xs text-muted">No tags</li>
                      ) : (
                        tagOptions.map((tagName) => (
                          <li key={tagName}>
                            <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground hover:bg-background/70">
                              <input
                                type="checkbox"
                                checked={selectedTags.includes(tagName)}
                                onChange={() => {
                                  toggleSelectedTag(tagName);
                                }}
                                className="h-3.5 w-3.5 rounded border-ink-soft/30"
                              />
                              <span className="truncate">{tagName}</span>
                            </label>
                          </li>
                        ))
                      )}
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
                    selectedCategories.length === 0 &&
                    selectedTags.length === 0 &&
                    selectedDirectionFilter === "all"
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

              <div className="inline-flex items-center gap-1 rounded-full border border-ink-soft/20 bg-surface p-1">
                {(
                  [
                    { id: "all", label: "All" },
                    { id: "outflow", label: "Outflow" },
                    { id: "inflow", label: "Inflow" },
                  ] satisfies Array<{ id: TransactionDirectionFilter; label: string }>
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setSelectedDirectionFilter(option.id);
                    }}
                    className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] transition ${
                      selectedDirectionFilter === option.id
                        ? "border border-accent/40 bg-accent/10 text-accent"
                        : "text-muted hover:text-foreground"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

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
              {selectedTags.map((tagName) => (
                <button
                  key={`tag-${tagName}`}
                  type="button"
                  onClick={() => {
                    removeSelectedTag(tagName);
                  }}
                  className="inline-flex items-center gap-2 rounded-full border border-ink-soft/20 bg-surface px-3 py-1 text-xs font-semibold text-foreground transition hover:border-ink-soft/35"
                  title="Remove tag filter"
                >
                  <span className="text-muted">Tag</span>
                  {tagName}
                  <span className="text-muted">x</span>
                </button>
              ))}
              {selectedDirectionFilter !== "all" ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDirectionFilter("all");
                  }}
                  className="inline-flex items-center gap-2 rounded-full border border-ink-soft/20 bg-surface px-3 py-1 text-xs font-semibold text-foreground transition hover:border-ink-soft/35"
                  title="Remove direction filter"
                >
                  <span className="text-muted">Direction</span>
                  {selectedDirectionFilter}
                  <span className="text-muted">x</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mb-4 rounded-2xl border border-ink-soft/15 bg-surface/80 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
              Row Selection:{" "}
              <span className="text-foreground">
                {selectedTransactionRows.length} selected
                {selectedFilteredCount > 0 && selectedFilteredCount !== selectedTransactionRows.length
                  ? ` (${selectedFilteredCount} in current view)`
                  : ""}
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={toggleSelectAllFilteredTransactions}
                disabled={filteredSelectionKeys.length === 0 || isBatchApplying}
                className="rounded-full border border-ink-soft/20 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
              >
                {allFilteredSelected ? "Unselect View" : "Select View"}
              </button>
              <button
                type="button"
                onClick={clearTransactionSelection}
                disabled={selectedTransactionRows.length === 0 || isBatchApplying}
                className="rounded-full border border-ink-soft/20 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
              >
                Clear Selection
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-ink-soft/15 bg-surface p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Batch Category</p>
              <div className="mt-2 flex items-center gap-2">
                <select
                  value={batchCategorySelection}
                  onChange={(event) => {
                    setBatchCategorySelection(event.target.value);
                  }}
                  disabled={isBatchApplying}
                  className="w-full rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">Choose category...</option>
                  <option value="uncategorized">Uncategorized</option>
                  {categoryChoices.map((category) => (
                    <option key={category.id} value={String(category.id)}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    void handleBatchApplyCategory();
                  }}
                  disabled={isBatchApplying || selectedTransactionRows.length === 0}
                  className="rounded-full border border-accent/40 bg-accent/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Apply
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-ink-soft/15 bg-surface p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Batch Tags</p>
              <div className="mt-2 flex items-start gap-2">
                <select
                  multiple
                  value={batchTagSelections.map((tagId) => String(tagId))}
                  onChange={(event) => {
                    const selectedTagIds = Array.from(event.target.selectedOptions)
                      .map((option) => Number.parseInt(option.value, 10))
                      .filter((tagId) => Number.isInteger(tagId) && tagId > 0);
                    setBatchTagSelections(selectedTagIds);
                  }}
                  disabled={isBatchApplying}
                  className="h-20 w-full rounded-xl border border-ink-soft/20 bg-surface px-2 py-1 text-xs text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {batchTagChoices.length === 0 ? (
                    <option value="" disabled>
                      No tags available
                    </option>
                  ) : (
                    batchTagChoices.map((tag) => (
                      <option key={tag.id} value={String(tag.id)}>
                        {tag.name}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    void handleBatchApplyTags();
                  }}
                  disabled={isBatchApplying || selectedTransactionRows.length === 0}
                  className="rounded-full border border-accent/40 bg-accent/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>

          {batchError ? (
            <p className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {batchError}
            </p>
          ) : null}
          {batchNotice ? (
            <p className="mt-3 rounded-xl border border-positive/35 bg-positive/10 px-3 py-2 text-xs text-positive">
              {batchNotice}
            </p>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-separate border-spacing-y-2">
            <thead className="text-left text-xs uppercase tracking-[0.14em] text-muted">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  <th className="px-3 py-2">Select</th>
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
                    colSpan={table.getAllLeafColumns().length + 1}
                    className="rounded-xl border border-ink-soft/15 px-3 py-6 text-center text-sm text-muted"
                  >
                    No transactions found. Add accounts and upload statement files on the Overview tab.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => {
                  const rowSelectionKey = getTransactionSelectionKey(row.original);
                  const isRowSelected = selectedTransactionKeys.has(rowSelectionKey);
                  return (
                    <tr
                      key={row.id}
                      className={`rounded-2xl bg-surface transition hover:bg-surface/70 ${
                        isRowSelected ? "ring-1 ring-accent/40" : ""
                      }`}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (isBatchApplying) {
                          return;
                        }
                        openEditModal(row.original);
                      }}
                      onKeyDown={(event) => {
                        if (isBatchApplying) {
                          return;
                        }
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openEditModal(row.original);
                        }
                      }}
                      aria-label={`Edit transaction ${row.original.transaction.description}`}
                    >
                      <td
                        className="rounded-l-xl border border-r-0 border-ink-soft/15 px-3 py-3"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isRowSelected}
                          disabled={isBatchApplying}
                          onChange={() => {
                            toggleTransactionSelection(row.original);
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                          }}
                          aria-label={`Select transaction ${row.original.transaction.description}`}
                          className="h-4 w-4 rounded border-ink-soft/30"
                        />
                      </td>
                      {row.getVisibleCells().map((cell) => {
                        const isDescription = cell.column.id === "description";
                        const isCategory = cell.column.id === "category";
                        const isTags = cell.column.id === "tags";
                        const isAccount = cell.column.id === "account";
                        const isDate = cell.column.id === "date";
                        const isAmount = cell.column.id === "amount";
                        const isIncome = row.original.transaction.direction === "in";

                        return (
                          <td
                            key={cell.id}
                            className={[
                              "border-ink-soft/15 px-3 py-3",
                              isDescription && "border-y text-sm text-foreground",
                              isCategory && "border-y text-sm text-muted",
                              isTags && "border-y text-sm",
                              isAccount && "border-y text-sm text-foreground",
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
                        <select
                          value={transactionModal.draft.categoryId}
                          onChange={(event) => {
                            updateEditingField("categoryId", event.target.value);
                          }}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        >
                          <option value="">Uncategorized</option>
                          {categoryChoices.map((category) => (
                            <option key={category.id} value={String(category.id)}>
                              {category.name}
                            </option>
                          ))}
                        </select>
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

                    <div className="rounded-2xl border border-ink-soft/15 bg-surface/80 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Tags</p>
                        <button
                          type="button"
                          onClick={() => {
                            updateEditingField("tagIds", []);
                          }}
                          disabled={transactionModal.draft.tagIds.length === 0}
                          className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          Clear
                        </button>
                      </div>
                      {tagChoices.filter((tag) => tag.id > 0).length === 0 ? (
                        <p className="text-xs text-muted">
                          No tags available yet. Create tags from the Tags tab to assign them here.
                        </p>
                      ) : (
                        <div className="grid gap-2 sm:grid-cols-2">
                          {tagChoices
                            .filter((tag) => tag.id > 0)
                            .map((tag) => {
                              const isSelected = transactionModal.draft.tagIds.includes(tag.id);
                              return (
                                <button
                                  key={tag.id}
                                  type="button"
                                  onClick={() => {
                                    toggleEditingTag(tag.id);
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
                                      style={{ backgroundColor: tag.color }}
                                      aria-hidden
                                    />
                                    <span className="truncate">{tag.name}</span>
                                  </span>
                                  <span className="font-mono text-[11px]">{isSelected ? "ON" : "OFF"}</span>
                                </button>
                              );
                            })}
                        </div>
                      )}
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
                        <select
                          value={ruleModal.draft.applyCategoryId}
                          onChange={(event) => {
                            updateRuleField("applyCategoryId", event.target.value);
                          }}
                          className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                        >
                          <option value="">None</option>
                          {categoryChoices.map((category) => (
                            <option key={category.id} value={String(category.id)}>
                              {category.name}
                            </option>
                          ))}
                        </select>
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

                    <div className="rounded-2xl border border-ink-soft/15 bg-surface/80 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Apply Tags</p>
                        <button
                          type="button"
                          onClick={() => {
                            updateRuleField("applyTagIds", []);
                          }}
                          disabled={ruleModal.draft.applyTagIds.length === 0}
                          className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          Clear
                        </button>
                      </div>
                      {tagChoices.filter((tag) => tag.id > 0).length === 0 ? (
                        <p className="text-xs text-muted">No tags available.</p>
                      ) : (
                        <div className="grid gap-2 sm:grid-cols-2">
                          {tagChoices
                            .filter((tag) => tag.id > 0)
                            .map((tag) => {
                              const isSelected = ruleModal.draft.applyTagIds.includes(tag.id);
                              return (
                                <button
                                  key={`rule-apply-tag-${tag.id}`}
                                  type="button"
                                  onClick={() => {
                                    toggleRuleApplyTag(tag.id);
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
                                      style={{ backgroundColor: tag.color }}
                                      aria-hidden
                                    />
                                    <span className="truncate">{tag.name}</span>
                                  </span>
                                  <span className="font-mono text-[11px]">{isSelected ? "ON" : "OFF"}</span>
                                </button>
                              );
                            })}
                        </div>
                      )}
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
