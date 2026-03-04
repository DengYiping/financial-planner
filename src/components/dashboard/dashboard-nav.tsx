"use client";

import Link from "next/link";
import { type DashboardTab, tabPath } from "@/components/dashboard/dashboard-shared";

type DashboardNavProps = {
  activeTab: DashboardTab;
};

export function DashboardNav({ activeTab }: DashboardNavProps) {
  const overviewHref = tabPath("overview");
  const dataIntakeHref = tabPath("data_intake");
  const statisticsHref = tabPath("statistics");
  const transactionsHref = tabPath("transactions");
  const accountSummaryHref = tabPath("account_summary");
  const rulesHref = tabPath("rules");
  const categoriesHref = tabPath("categories");
  const tagsHref = tabPath("tags");

  return (
    <div className="mb-6 flex flex-wrap rounded-full border border-ink-soft/15 bg-surface p-1">
      <Link
        href={overviewHref}
        scroll={false}
        className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
          activeTab === "overview"
            ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
            : "text-muted hover:text-foreground"
        }`}
      >
        Overview
      </Link>
      <Link
        href={dataIntakeHref}
        scroll={false}
        className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
          activeTab === "data_intake"
            ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
            : "text-muted hover:text-foreground"
        }`}
      >
        Data Intake
      </Link>
      <Link
        href={statisticsHref}
        scroll={false}
        className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
          activeTab === "statistics"
            ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
            : "text-muted hover:text-foreground"
        }`}
      >
        Statistics
      </Link>
      <Link
        href={transactionsHref}
        scroll={false}
        className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
          activeTab === "transactions"
            ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
            : "text-muted hover:text-foreground"
        }`}
      >
        Transactions
      </Link>
      <Link
        href={accountSummaryHref}
        scroll={false}
        className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
          activeTab === "account_summary"
            ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
            : "text-muted hover:text-foreground"
        }`}
      >
        Account Summary
      </Link>
      <Link
        href={rulesHref}
        scroll={false}
        className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
          activeTab === "rules"
            ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
            : "text-muted hover:text-foreground"
        }`}
      >
        Rules
      </Link>
      <Link
        href={categoriesHref}
        scroll={false}
        className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
          activeTab === "categories"
            ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
            : "text-muted hover:text-foreground"
        }`}
      >
        Categories
      </Link>
      <Link
        href={tagsHref}
        scroll={false}
        className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
          activeTab === "tags"
            ? "bg-accent text-white shadow-[0_8px_20px_-12px_rgba(6,115,166,0.9)]"
            : "text-muted hover:text-foreground"
        }`}
      >
        Tags
      </Link>
    </div>
  );
}
