"use client";

import { type FormEvent, useMemo, useState } from "react";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { resolveErrorMessage } from "@/components/dashboard/dashboard-shared";
import { SectionShell } from "@/components/dashboard/section-shell";
import type { AppRouter } from "@/server/api/routers/_app";
import { trpc } from "@/trpc/react";

type RouterInputs = inferRouterInputs<AppRouter>;
type RouterOutputs = inferRouterOutputs<AppRouter>;
type PersistedAccount = RouterOutputs["accounts"]["list"][number];
type PersistedRule = RouterOutputs["accounts"]["listRules"][number];

type RuleRecord = {
  id: number;
  descriptionContains?: string;
  descriptionRegex?: string;
  amountExactCents?: number;
  amountMinCents?: number;
  amountMaxCents?: number;
  accountIds: number[];
  actionCategory?: string;
  assignCounterpartyFromRegexCapture: boolean;
  priority: number;
};

type RuleDraft = {
  descriptionContains: string;
  descriptionRegex: string;
  amountExact: string;
  amountMin: string;
  amountMax: string;
  accountIds: number[];
  actionCategory: string;
  assignCounterpartyFromRegexCapture: boolean;
  priority: string;
};

type AccountChoice = {
  id: number;
  name: string;
  color: string;
};

const AMOUNT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;
const DEFAULT_PRIORITY = 100;

function createEmptyDraft(): RuleDraft {
  return {
    descriptionContains: "",
    descriptionRegex: "",
    amountExact: "",
    amountMin: "",
    amountMax: "",
    accountIds: [],
    actionCategory: "",
    assignCounterpartyFromRegexCapture: false,
    priority: String(DEFAULT_PRIORITY),
  };
}

function toAmountInput(cents: number | undefined): string {
  if (typeof cents !== "number") {
    return "";
  }

  return (Math.abs(cents) / 100).toFixed(2);
}

function parseAmountInputToCents(value: string): number | null | undefined {
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

function formatAmount(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2);
}

function toRuleRecord(rule: PersistedRule): RuleRecord {
  return {
    id: rule.id,
    descriptionContains: rule.descriptionContains,
    descriptionRegex: rule.descriptionRegex,
    amountExactCents: rule.amountExactCents,
    amountMinCents: rule.amountMinCents,
    amountMaxCents: rule.amountMaxCents,
    accountIds: rule.accountIds ?? [],
    actionCategory: rule.applyCategory,
    assignCounterpartyFromRegexCapture: rule.assignCounterpartyFromRegexGroup,
    priority: rule.priority,
  };
}

function normalizeRules(rules: PersistedRule[] | undefined): RuleRecord[] {
  return (rules ?? []).map(toRuleRecord).sort((left, right) => left.priority - right.priority || left.id - right.id);
}

function toRuleDraft(rule: RuleRecord): RuleDraft {
  return {
    descriptionContains: rule.descriptionContains ?? "",
    descriptionRegex: rule.descriptionRegex ?? "",
    amountExact: toAmountInput(rule.amountExactCents),
    amountMin: toAmountInput(rule.amountMinCents),
    amountMax: toAmountInput(rule.amountMaxCents),
    accountIds: [...rule.accountIds],
    actionCategory: rule.actionCategory ?? "",
    assignCounterpartyFromRegexCapture: rule.assignCounterpartyFromRegexCapture,
    priority: String(rule.priority),
  };
}

function buildRulePayload(
  draft: RuleDraft,
  parsedPriority: number,
  exactCents: number | undefined,
  minCents: number | undefined,
  maxCents: number | undefined
): RouterInputs["accounts"]["createRule"] {
  const descriptionContains = draft.descriptionContains.trim() || undefined;
  const descriptionRegex = draft.descriptionRegex.trim() || undefined;
  const actionCategory = draft.actionCategory.trim() || undefined;
  const accountIds = [...draft.accountIds].sort((a, b) => a - b);

  return {
    descriptionContains,
    descriptionRegex,
    amountExactCents: exactCents,
    amountMinCents: minCents,
    amountMaxCents: maxCents,
    accountIds: accountIds.length > 0 ? accountIds : undefined,
    applyCategory: actionCategory,
    assignCounterpartyFromRegexGroup: draft.assignCounterpartyFromRegexCapture,
    priority: parsedPriority,
  };
}

function summarizeAccountSet(rule: RuleRecord, accountNameById: Map<number, string>): string {
  if (rule.accountIds.length === 0) {
    return "Any account";
  }

  const labels = rule.accountIds.map((accountId) => accountNameById.get(accountId) ?? `Account #${accountId}`);
  if (labels.length <= 2) {
    return labels.join(", ");
  }

  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

function summarizeConditions(rule: RuleRecord, accountNameById: Map<number, string>): string {
  const parts: string[] = [];

  if (rule.descriptionContains) {
    parts.push(`Description contains "${rule.descriptionContains}"`);
  }

  if (rule.descriptionRegex) {
    parts.push(`Regex: ${rule.descriptionRegex}`);
  }

  if (typeof rule.amountExactCents === "number") {
    parts.push(`Amount = ${formatAmount(rule.amountExactCents)}`);
  } else if (typeof rule.amountMinCents === "number" || typeof rule.amountMaxCents === "number") {
    const minLabel = typeof rule.amountMinCents === "number" ? formatAmount(rule.amountMinCents) : "any";
    const maxLabel = typeof rule.amountMaxCents === "number" ? formatAmount(rule.amountMaxCents) : "any";
    parts.push(`Amount ${minLabel} - ${maxLabel}`);
  }

  parts.push(`Accounts: ${summarizeAccountSet(rule, accountNameById)}`);
  return parts.length > 0 ? parts.join(" • ") : "No condition details";
}

function summarizeActions(rule: RuleRecord): string {
  const parts: string[] = [];

  if (rule.actionCategory) {
    parts.push(`Set category to "${rule.actionCategory}"`);
  }

  if (rule.assignCounterpartyFromRegexCapture) {
    parts.push("Set counterparty from regex capture #1");
  }

  return parts.length > 0 ? parts.join(" • ") : "No actions configured";
}

export function RulesContent() {
  const utils = trpc.useUtils();
  const accountsQuery = trpc.accounts.list.useQuery();
  const rulesQuery = trpc.accounts.listRules.useQuery();
  const createRuleMutation = trpc.accounts.createRule.useMutation();
  const updateRuleMutation = trpc.accounts.updateRule.useMutation();
  const deleteRuleMutation = trpc.accounts.deleteRule.useMutation();
  const reapplyRulesMutation = trpc.accounts.reapplyRules.useMutation();

  const [draft, setDraft] = useState<RuleDraft>(() => createEmptyDraft());
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listSuccessMessage, setListSuccessMessage] = useState<string | null>(null);
  const [deletingRuleId, setDeletingRuleId] = useState<number | null>(null);

  const rules = useMemo(() => normalizeRules(rulesQuery.data), [rulesQuery.data]);
  const accountChoices = useMemo<AccountChoice[]>(
    () =>
      (accountsQuery.data ?? [])
        .map((account: PersistedAccount) => ({
          id: account.id,
          name: account.name,
          color: account.color,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [accountsQuery.data]
  );
  const accountNameById = useMemo(() => {
    const map = new Map<number, string>();
    accountChoices.forEach((account) => {
      map.set(account.id, account.name);
    });
    return map;
  }, [accountChoices]);

  const isEditing = editingRuleId !== null;
  const isSaving = createRuleMutation.isPending || updateRuleMutation.isPending;
  const isMutating = isSaving || deleteRuleMutation.isPending || reapplyRulesMutation.isPending;
  const loadError = rulesQuery.error
    ? resolveErrorMessage(rulesQuery.error, "Failed to load rules.")
    : accountsQuery.error
      ? resolveErrorMessage(accountsQuery.error, "Failed to load accounts.")
      : null;

  function resetEditor(): void {
    setDraft(createEmptyDraft());
    setEditingRuleId(null);
    setFormError(null);
    setListSuccessMessage(null);
  }

  function startEditingRule(rule: RuleRecord): void {
    setDraft(toRuleDraft(rule));
    setEditingRuleId(rule.id);
    setFormError(null);
    setListError(null);
    setListSuccessMessage(null);
  }

  function toggleAccountSelection(accountId: number): void {
    setDraft((current) => {
      const hasAccount = current.accountIds.includes(accountId);
      return {
        ...current,
        accountIds: hasAccount
          ? current.accountIds.filter((entry) => entry !== accountId)
          : [...current.accountIds, accountId],
      };
    });
  }

  async function handleSubmitRule(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSaving) {
      return;
    }

    const parsedPriority = Number.parseInt(draft.priority.trim(), 10);
    if (!Number.isFinite(parsedPriority)) {
      setFormError("Priority must be an integer.");
      return;
    }

    const exactCents = parseAmountInputToCents(draft.amountExact);
    if (exactCents === null) {
      setFormError("Exact amount must be a positive number with up to 2 decimal places.");
      return;
    }

    const minCents = parseAmountInputToCents(draft.amountMin);
    if (minCents === null) {
      setFormError("Minimum amount must be a positive number with up to 2 decimal places.");
      return;
    }

    const maxCents = parseAmountInputToCents(draft.amountMax);
    if (maxCents === null) {
      setFormError("Maximum amount must be a positive number with up to 2 decimal places.");
      return;
    }

    if (
      typeof exactCents === "number" &&
      (typeof minCents === "number" || typeof maxCents === "number")
    ) {
      setFormError("Use either exact amount or min/max range, not both.");
      return;
    }

    if (typeof minCents === "number" && typeof maxCents === "number" && minCents > maxCents) {
      setFormError("Minimum amount cannot exceed maximum amount.");
      return;
    }

    if (draft.assignCounterpartyFromRegexCapture && draft.descriptionRegex.trim().length === 0) {
      setFormError("Description regex is required when assigning counterparty from capture group.");
      return;
    }

    const payload = buildRulePayload(
      draft,
      parsedPriority,
      exactCents ?? undefined,
      minCents ?? undefined,
      maxCents ?? undefined
    );
    setFormError(null);
    setListError(null);
    setListSuccessMessage(null);

    try {
      if (isEditing && typeof editingRuleId === "number") {
        await updateRuleMutation.mutateAsync({
          ruleId: editingRuleId,
          rule: payload,
        });
      } else {
        await createRuleMutation.mutateAsync(payload);
      }

      await rulesQuery.refetch();
      resetEditor();
    } catch (error) {
      setFormError(
        resolveErrorMessage(error, isEditing ? "Could not update rule." : "Could not create rule.")
      );
    }
  }

  async function handleDeleteRule(rule: RuleRecord): Promise<void> {
    if (deletingRuleId === rule.id || deleteRuleMutation.isPending) {
      return;
    }

    const confirmed = window.confirm(
      `Delete rule #${rule.id}? This action cannot be undone.`
    );
    if (!confirmed) {
      return;
    }

    setDeletingRuleId(rule.id);
    setListError(null);
    setListSuccessMessage(null);

    try {
      await deleteRuleMutation.mutateAsync({
        ruleId: rule.id,
      });
      await rulesQuery.refetch();

      if (editingRuleId === rule.id) {
        resetEditor();
      }
    } catch (error) {
      setListError(resolveErrorMessage(error, "Could not delete rule."));
    } finally {
      setDeletingRuleId(null);
    }
  }

  async function handleReapplyRules(): Promise<void> {
    if (reapplyRulesMutation.isPending) {
      return;
    }

    setListError(null);
    setListSuccessMessage(null);

    try {
      const result = await reapplyRulesMutation.mutateAsync();
      await Promise.all([
        utils.accounts.list.invalidate(),
        utils.accounts.transactionsView.invalidate(),
        utils.accounts.summaryView.invalidate(),
      ]);

      const transactionLabel = result.totalCount === 1 ? "transaction" : "transactions";
      const updatedLabel = result.updatedCount === 1 ? "entry" : "entries";
      setListSuccessMessage(
        `Re-applied rules to ${result.totalCount} ${transactionLabel}. Updated ${result.updatedCount} ${updatedLabel}.`
      );
    } catch (error) {
      setListError(resolveErrorMessage(error, "Could not re-apply rules."));
    }
  }

  return (
    <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
      <SectionShell
        title="Automation Rules"
        subtitle="Route incoming transactions into categories and counterparties with match conditions."
        action={
          <div className="space-y-2 text-right">
            <button
              type="button"
              onClick={() => {
                void handleReapplyRules();
              }}
              disabled={isMutating || !!loadError}
              className="rounded-full border border-accent/35 bg-accent/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {reapplyRulesMutation.isPending ? "Re-applying..." : "Re-Apply Rules"}
            </button>
            <p className="font-mono text-xs text-muted">{rules.length} rules</p>
            <p className="font-mono text-xs text-muted">{accountChoices.length} accounts available</p>
          </div>
        }
      >
        <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-muted">Configured Rules</h3>
              <button
                type="button"
                onClick={resetEditor}
                disabled={isMutating}
                className="rounded-full border border-ink-soft/20 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                New Rule
              </button>
            </div>

            {loadError ? (
              <p className="rounded-2xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{loadError}</p>
            ) : null}
            {listError ? (
              <p className="rounded-2xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{listError}</p>
            ) : null}
            {listSuccessMessage ? (
              <p className="rounded-2xl border border-accent/30 bg-accent/10 p-3 text-sm text-accent">
                {listSuccessMessage}
              </p>
            ) : null}

            {rulesQuery.isPending && rules.length === 0 ? (
              <div className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4 text-sm text-muted">
                Loading rules...
              </div>
            ) : null}

            {!rulesQuery.isPending && rules.length === 0 ? (
              <div className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4 text-sm text-muted">
                No rules configured. Create your first automation rule using the form.
              </div>
            ) : null}

            <ul className="space-y-3">
              {rules.map((rule) => {
                const isActive = editingRuleId === rule.id;
                const isDeleting = deletingRuleId === rule.id;

                return (
                  <li key={rule.id}>
                    <article
                      className={`rounded-2xl border p-4 transition ${
                        isActive
                          ? "border-accent/35 bg-accent/5 shadow-[0_14px_30px_-26px_rgba(6,115,166,0.8)]"
                          : "border-ink-soft/15 bg-surface/90"
                      }`}
                    >
                      <header className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate font-mono text-xs uppercase tracking-[0.12em] text-muted">
                            Rule #{rule.id}
                          </p>
                          <span className="rounded-full border border-ink-soft/15 px-2 py-0.5 font-mono text-[11px] text-muted">
                            P{rule.priority}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              startEditingRule(rule);
                            }}
                            disabled={isMutating}
                            className="rounded-full border border-ink-soft/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void handleDeleteRule(rule);
                            }}
                            disabled={isDeleting || isMutating}
                            className="rounded-full border border-danger/30 bg-danger/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {isDeleting ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </header>
                      <p className="text-xs text-muted">{summarizeConditions(rule, accountNameById)}</p>
                      <p className="mt-2 text-xs text-foreground">{summarizeActions(rule)}</p>
                    </article>
                  </li>
                );
              })}
            </ul>
          </div>

          <form
            onSubmit={(event) => {
              void handleSubmitRule(event);
            }}
            className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4"
          >
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  {isEditing ? `Edit Rule #${editingRuleId}` : "Create Rule"}
                </h3>
                <p className="mt-1 text-xs text-muted">
                  Match by description, amount, and account set; then apply actions in priority order.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <button
                    type="button"
                    onClick={resetEditor}
                    disabled={isMutating}
                    className="rounded-full border border-ink-soft/20 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Cancel
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={isSaving || !!loadError}
                  className="rounded-full border border-accent/35 bg-accent/10 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {isSaving ? "Saving..." : isEditing ? "Update Rule" : "Create Rule"}
                </button>
              </div>
            </div>

            {formError ? (
              <p className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {formError}
              </p>
            ) : null}

            <div className="space-y-4">
              <section className="space-y-3 rounded-2xl border border-ink-soft/15 bg-background/50 p-3">
                <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Conditions</h4>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                    Description Contains
                    <input
                      type="text"
                      value={draft.descriptionContains}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          descriptionContains: event.target.value,
                        }));
                      }}
                      placeholder="e.g. Uber"
                      className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                    Description Regex
                    <input
                      type="text"
                      value={draft.descriptionRegex}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          descriptionRegex: event.target.value,
                        }));
                      }}
                      placeholder="e.g. ^PAYMENT TO (.+)$"
                      className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                    />
                  </label>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                    Amount Exact
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft.amountExact}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          amountExact: event.target.value,
                        }));
                      }}
                      placeholder="19.99"
                      className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                    Amount Min
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft.amountMin}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          amountMin: event.target.value,
                        }));
                      }}
                      placeholder="0.00"
                      className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                    Amount Max
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft.amountMax}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          amountMax: event.target.value,
                        }));
                      }}
                      placeholder="200.00"
                      className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                    />
                  </label>
                </div>
                <p className="text-[11px] text-muted">
                  Leave amount fields blank to match any amount. Exact amount cannot be combined with min/max.
                </p>

                <div className="rounded-2xl border border-ink-soft/15 bg-surface/80 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">Account Set</p>
                    <button
                      type="button"
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          accountIds: [],
                        }));
                      }}
                      disabled={draft.accountIds.length === 0}
                      className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Clear
                    </button>
                  </div>
                  {accountChoices.length === 0 ? (
                    <p className="text-xs text-muted">No accounts available yet. Rule will apply to all accounts.</p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {accountChoices.map((account) => {
                        const isSelected = draft.accountIds.includes(account.id);

                        return (
                          <button
                            key={account.id}
                            type="button"
                            onClick={() => {
                              toggleAccountSelection(account.id);
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
                  )}
                </div>
              </section>

              <section className="space-y-3 rounded-2xl border border-ink-soft/15 bg-background/50 p-3">
                <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Actions</h4>
                <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                    Action Category
                    <input
                      type="text"
                      value={draft.actionCategory}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          actionCategory: event.target.value,
                        }));
                      }}
                      placeholder="e.g. Transport"
                      className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                    <input
                      type="checkbox"
                      checked={draft.assignCounterpartyFromRegexCapture}
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          assignCounterpartyFromRegexCapture: event.target.checked,
                        }));
                      }}
                      className="h-3.5 w-3.5 rounded border-ink-soft/30"
                    />
                    <span>Counterparty from regex capture #1</span>
                  </label>
                </div>
              </section>

              <section className="space-y-3 rounded-2xl border border-ink-soft/15 bg-background/50 p-3">
                <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Execution</h4>
                <label className="flex max-w-[180px] flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
                  Priority
                  <input
                    type="number"
                    step={1}
                    value={draft.priority}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        priority: event.target.value,
                      }));
                    }}
                    className="rounded-full border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                  />
                </label>
                <p className="text-[11px] text-muted">Lower values run first (for example: priority 1 before 100).</p>
              </section>
            </div>
          </form>
        </div>
      </SectionShell>
    </div>
  );
}
