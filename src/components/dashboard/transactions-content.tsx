"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { inferRouterOutputs } from "@trpc/server";
import { SectionShell } from "@/components/dashboard/section-shell";
import {
  formatCurrencyCents,
  formatMonthLabel,
  normalizeMonthKey,
  type TransactionTab,
} from "@/components/dashboard/dashboard-shared";
import type { AppRouter } from "@/server/api/routers/_app";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type TransactionsView = RouterOutputs["accounts"]["transactionsView"];

type TransactionsContentProps = {
  transactionTab: TransactionTab;
  view: TransactionsView;
};

function transactionsSubTabPath(tab: TransactionTab): string {
  if (tab === "aggregated") {
    return "/transactions/aggregated";
  }

  return "/transactions/recent";
}

export function TransactionsContent({ transactionTab, view }: TransactionsContentProps) {
  const router = useRouter();
  const pathname = usePathname();

  const monthQuery = view.selectedMonth === "all" ? "" : `?month=${encodeURIComponent(view.selectedMonth)}`;
  const recentHref = `${transactionsSubTabPath("recent")}${monthQuery}`;
  const aggregatedHref = `${transactionsSubTabPath("aggregated")}${monthQuery}`;

  return (
    <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
      <SectionShell
        title="Transactions"
        subtitle="Cross-account transaction view with month filtering and account color coding."
        action={
          <div className="space-y-1 text-right">
            <p className="font-mono text-xs text-muted">{view.importedTransactionCount} imported</p>
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-full border border-ink-soft/15 bg-surface p-1">
            <Link
              href={recentHref}
              scroll={false}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] transition ${
                transactionTab === "recent"
                  ? "bg-accent text-white shadow-[0_6px_16px_-10px_rgba(6,115,166,0.9)]"
                  : "text-muted hover:text-foreground"
              }`}
            >
              Recent (25)
            </Link>
            <Link
              href={aggregatedHref}
              scroll={false}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] transition ${
                transactionTab === "aggregated"
                  ? "bg-accent text-white shadow-[0_6px_16px_-10px_rgba(6,115,166,0.9)]"
                  : "text-muted hover:text-foreground"
              }`}
            >
              All Accounts Chronological
            </Link>
          </div>

          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            Month
            <select
              value={view.selectedMonth}
              onChange={(event) => {
                const month = normalizeMonthKey(event.target.value);
                const query = month === "all" ? "" : `?month=${encodeURIComponent(month)}`;
                const nextUrl = query ? `${pathname}${query}` : pathname;
                router.replace(nextUrl, { scroll: false });
              }}
              className="rounded-full border border-ink-soft/20 bg-surface px-3 py-1.5 text-xs text-foreground outline-none focus:border-accent"
            >
              <option value="all">All Months</option>
              {view.monthOptions.map((month) => (
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
              {view.transactions.length === 0 ? (
                <tr className="rounded-2xl bg-surface">
                  <td
                    colSpan={5}
                    className="rounded-xl border border-ink-soft/15 px-3 py-6 text-center text-sm text-muted"
                  >
                    No transactions found. Add accounts and upload statement files on the Overview tab.
                  </td>
                </tr>
              ) : (
                view.transactions.map((row) => {
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
    </div>
  );
}
