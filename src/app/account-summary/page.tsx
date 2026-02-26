import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { normalizeSummaryMonthKey } from "@/components/dashboard/dashboard-shared";
import { AccountSummaryContent } from "@/components/dashboard/account-summary-content";
import { getServerTrpcCaller } from "@/trpc/server";

type SearchParams = Record<string, string | string[] | undefined>;

function canonicalAccountSummaryUrl(summaryMonth?: string): string {
  if (!summaryMonth) {
    return "/account-summary";
  }

  return `/account-summary?summaryMonth=${encodeURIComponent(summaryMonth)}`;
}

export default async function AccountSummaryPage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const summaryMonthParam =
    typeof resolvedSearchParams.summaryMonth === "string"
      ? resolvedSearchParams.summaryMonth
      : undefined;
  const hasSummaryMonthParam = typeof summaryMonthParam === "string";
  const hasUnexpectedParams = Object.entries(resolvedSearchParams).some(
    ([key, value]) => key !== "summaryMonth" || typeof value !== "string"
  );

  const normalizedSummaryMonth = normalizeSummaryMonthKey(summaryMonthParam ?? null);
  const caller = await getServerTrpcCaller();
  const view = await caller.accounts.summaryView({
    ...(normalizedSummaryMonth ? { month: normalizedSummaryMonth } : {}),
  });

  const canonicalCurrentMonth = summaryMonthParam ? normalizeSummaryMonthKey(summaryMonthParam) : "";
  const canonicalSelectedMonth = view.selectedMonth ?? "";

  if (hasUnexpectedParams || (hasSummaryMonthParam && canonicalCurrentMonth !== canonicalSelectedMonth)) {
    redirect(canonicalAccountSummaryUrl(view.selectedMonth));
  }

  return (
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 lg:pt-14">
      <DashboardHeader />
      <DashboardNav activeTab="account_summary" />
      <AccountSummaryContent view={view} />
    </main>
  );
}
