"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { inferRouterOutputs } from "@trpc/server";
import { SectionShell } from "@/components/dashboard/section-shell";
import {
  formatCurrencyCents,
  formatMonthLabel,
  getAccountTypeLabel,
  normalizeSummaryMonthKey,
} from "@/components/dashboard/dashboard-shared";
import type { AppRouter } from "@/server/api/routers/_app";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type SummaryView = RouterOutputs["accounts"]["summaryView"];

type AccountSummaryContentProps = {
  view: SummaryView;
};

export function AccountSummaryContent({ view }: AccountSummaryContentProps) {
  const router = useRouter();
  const pathname = usePathname();
  const effectiveSummaryMonth = view.selectedMonth ?? "";
  const [selectedSummaryMonth, setSelectedSummaryMonth] = useState(effectiveSummaryMonth);
  const [isNavigating, startTransition] = useTransition();

  useEffect(() => {
    setSelectedSummaryMonth(effectiveSummaryMonth);
  }, [effectiveSummaryMonth]);

  return (
    <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
      <SectionShell
        title="Account Summary"
        subtitle="Monthly inflow and outflow per account."
        action={
          <div className="space-y-1 text-right">
            <p className="font-mono text-xs text-muted">{view.accountCount} accounts</p>
            <p className="font-mono text-xs text-muted">{view.importedTransactionCount} imported transactions</p>
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            Month
            <select
              value={selectedSummaryMonth}
              onChange={(event) => {
                const summaryMonth = normalizeSummaryMonthKey(event.target.value);
                setSelectedSummaryMonth(summaryMonth);
                const query = summaryMonth ? `?summaryMonth=${encodeURIComponent(summaryMonth)}` : "";
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
          {selectedSummaryMonth && (
            <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
              Showing {formatMonthLabel(selectedSummaryMonth)}
            </p>
          )}
        </div>

        {view.monthOptions.length === 0 ? (
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
                {view.rows.map((row) => {
                  const accountType = getAccountTypeLabel(row.accountKind, row.accountCurrency);

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
                      <td className="border-y border-ink-soft/15 px-3 py-3 text-xs text-muted">{accountType}</td>
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
    </div>
  );
}
