"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
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
type TransactionRow = TransactionsView["transactions"][number];

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
  const [sorting, setSorting] = useState<SortingState>([]);
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
    data: view.transactions,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => `${row.accountId}-${row.transaction.id}`,
  });

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
                    <tr key={row.id} className="rounded-2xl bg-surface">
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
                                  isIncome ? "text-positive" : "text-foreground"
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
      </SectionShell>
    </div>
  );
}
