import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { normalizeMonthKey } from "@/components/dashboard/dashboard-shared";
import { TransactionsContent } from "@/components/dashboard/transactions-content";
import { getServerTrpcCaller } from "@/trpc/server";

type SearchParams = Record<string, string | string[] | undefined>;

function canonicalTransactionsUrl(pathname: string, month: string): string {
  if (month === "all") {
    return pathname;
  }

  return `${pathname}?month=${encodeURIComponent(month)}`;
}

export default async function TransactionsAggregatedPage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const monthParam = typeof resolvedSearchParams.month === "string" ? resolvedSearchParams.month : undefined;
  const hasUnexpectedParams = Object.entries(resolvedSearchParams).some(
    ([key, value]) => key !== "month" || typeof value !== "string"
  );

  const caller = await getServerTrpcCaller();
  const view = await caller.accounts.transactionsView({
    month: normalizeMonthKey(monthParam ?? "all"),
    transactionTab: "aggregated",
  });

  const canonicalUrl = canonicalTransactionsUrl("/transactions/aggregated", view.selectedMonth);
  const currentCanonicalMonth = monthParam ? normalizeMonthKey(monthParam) : "all";
  if (hasUnexpectedParams || currentCanonicalMonth !== view.selectedMonth) {
    redirect(canonicalUrl);
  }

  return (
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 lg:pt-14">
      <DashboardHeader />
      <DashboardNav activeTab="transactions" />
      <TransactionsContent transactionTab="aggregated" view={view} />
    </main>
  );
}
