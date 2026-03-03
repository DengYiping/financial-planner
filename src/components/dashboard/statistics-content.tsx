"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useTransition } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { SectionShell } from "@/components/dashboard/section-shell";
import { formatCurrencyCents, formatMonthLabel, normalizeSummaryMonthKey } from "@/components/dashboard/dashboard-shared";
import type { AppRouter } from "@/server/api/routers/_app";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type SpendingStatsView = RouterOutputs["accounts"]["spendingStatsView"];

type StatisticsContentProps = {
  view: SpendingStatsView;
};

type SpendingPieSlice = {
  categoryName: string;
  spentCents: number;
  color: string;
  startPercent: number;
  endPercent: number;
  href: string;
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

function buildSpendingTransactionsHref(month: string, categoryName: string): string {
  const params = new URLSearchParams();
  params.set("startMonth", month);
  params.set("endMonth", month);
  params.set("category", categoryName);
  params.set("direction", "outflow");
  return `/transactions?${params.toString()}`;
}

function buildSpendingConicGradient(slices: SpendingPieSlice[]): string {
  if (slices.length === 0) {
    return "conic-gradient(#d9dde1 0% 100%)";
  }

  return `conic-gradient(${slices
    .map((slice) => `${slice.color} ${slice.startPercent.toFixed(2)}% ${slice.endPercent.toFixed(2)}%`)
    .join(", ")})`;
}

export function StatisticsContent({ view }: StatisticsContentProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isNavigating, startTransition] = useTransition();
  const selectedMonth = view.selectedMonth ?? "";

  const rows = useMemo(
    () => view.rows.filter((row) => row.categoryName.trim().toLocaleLowerCase("en-US") !== "excluded"),
    [view.rows]
  );
  const totalSpentEurCents = useMemo(() => rows.reduce((sum, row) => sum + row.spentCents, 0), [rows]);
  const spendingShareByCategoryName = useMemo(() => {
    const byCategory = new Map<string, number>();
    rows.forEach((row) => {
      if (totalSpentEurCents <= 0) {
        byCategory.set(row.categoryName, 0);
        return;
      }
      byCategory.set(row.categoryName, row.spentCents / totalSpentEurCents);
    });
    return byCategory;
  }, [rows, totalSpentEurCents]);

  const spendingPieSlices = useMemo<SpendingPieSlice[]>(() => {
    if (!selectedMonth) {
      return [];
    }

    const sortedRows = [...rows]
      .filter((row) => row.spentCents > 0)
      .sort((left, right) => right.spentCents - left.spentCents || left.categoryName.localeCompare(right.categoryName));
    const total = sortedRows.reduce((sum, row) => sum + row.spentCents, 0);

    let runningShare = 0;
    return sortedRows.map((row, index) => {
      const share = total > 0 ? row.spentCents / total : 0;
      const startPercent = runningShare * 100;
      const endPercent = index === sortedRows.length - 1 ? 100 : (runningShare + share) * 100;
      runningShare += share;

      return {
        categoryName: row.categoryName,
        spentCents: row.spentCents,
        color: SPENDING_PIE_COLORS[index % SPENDING_PIE_COLORS.length] ?? "#9ba8b5",
        startPercent,
        endPercent,
        href: buildSpendingTransactionsHref(selectedMonth, row.categoryName),
      };
    });
  }, [rows, selectedMonth]);

  return (
    <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
      <SectionShell
        title="Spending Statistics"
        subtitle="Monthly spending distribution by category, converted and aggregated to EUR."
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            Month
            <select
              value={selectedMonth}
              onChange={(event) => {
                const normalizedMonth = normalizeSummaryMonthKey(event.target.value);
                const query = normalizedMonth ? `?month=${encodeURIComponent(normalizedMonth)}` : "";
                const nextUrl = query ? `${pathname}${query}` : pathname;
                startTransition(() => {
                  router.replace(nextUrl, { scroll: false });
                });
              }}
              disabled={view.monthOptions.length === 0 || isNavigating}
              className="rounded-full border border-ink-soft/20 bg-surface px-3 py-1.5 text-xs text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
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
          {selectedMonth ? (
            <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
              Showing {formatMonthLabel(selectedMonth)}
            </p>
          ) : null}
        </div>

        {view.monthOptions.length === 0 || !selectedMonth || rows.length === 0 ? (
          <p className="rounded-2xl border border-ink-soft/15 bg-surface p-4 text-sm text-muted">
            No spending transactions found for the selected month.
          </p>
        ) : (
          <div className="space-y-3">
            {spendingPieSlices.length > 0 ? (
              <article className="rounded-2xl border border-ink-soft/15 bg-surface p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">Spending Breakdown</p>
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <div
                    className="relative h-32 w-32 shrink-0 rounded-full border border-ink-soft/20"
                    style={{ background: buildSpendingConicGradient(spendingPieSlices) }}
                    aria-label="Monthly spending distribution pie chart in EUR"
                  >
                    <div className="absolute inset-5 flex items-center justify-center rounded-full border border-ink-soft/15 bg-surface">
                      <div className="text-center">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">Total</p>
                        <p className="font-mono text-xs text-foreground">
                          {formatCurrencyCents(totalSpentEurCents, "EUR", "en-IE")}
                        </p>
                      </div>
                    </div>
                  </div>
                  <ul className="min-w-0 flex-1 space-y-1">
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

            {rows.map((row) => {
              const totalLabel = formatCurrencyCents(row.spentCents, "EUR", "en-IE");
              const averageCents = row.transactionCount > 0 ? Math.round(row.spentCents / row.transactionCount) : 0;
              const averageLabel = formatCurrencyCents(averageCents, "EUR", "en-IE");
              const share = spendingShareByCategoryName.get(row.categoryName) ?? 0;
              const sharePercent = Math.max(0, Math.min(share * 100, 100));
              const transactionHref = buildSpendingTransactionsHref(selectedMonth, row.categoryName);

              return (
                <article key={row.categoryName} className="rounded-2xl border border-ink-soft/15 bg-surface p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-semibold text-foreground">
                      <Link
                        href={transactionHref}
                        className="underline decoration-ink-soft/30 underline-offset-4 transition hover:decoration-accent"
                      >
                        {row.categoryName}
                      </Link>
                    </h3>
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
                  <div className="mt-3">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-soft/15">
                      <div className="h-full rounded-full bg-accent/70" style={{ width: `${sharePercent.toFixed(2)}%` }} />
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      {sharePercent.toFixed(1)}% of total {formatCurrencyCents(totalSpentEurCents, "EUR", "en-IE")}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SectionShell>
    </div>
  );
}
