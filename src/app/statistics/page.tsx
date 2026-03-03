import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { normalizeSummaryMonthKey } from "@/components/dashboard/dashboard-shared";
import { StatisticsContent } from "@/components/dashboard/statistics-content";
import { getServerTrpcCaller } from "@/trpc/server";

type SearchParams = Record<string, string | string[] | undefined>;

function canonicalStatisticsUrl(month?: string): string {
  if (!month) {
    return "/statistics";
  }

  return `/statistics?month=${encodeURIComponent(month)}`;
}

export default async function StatisticsPage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const monthParam = typeof resolvedSearchParams.month === "string" ? resolvedSearchParams.month : undefined;
  const hasMonthParam = typeof monthParam === "string";
  const hasUnexpectedParams = Object.entries(resolvedSearchParams).some(
    ([key, value]) => key !== "month" || typeof value !== "string"
  );

  const normalizedMonth = normalizeSummaryMonthKey(monthParam ?? null);
  const caller = await getServerTrpcCaller();
  const view = await caller.accounts.spendingStatsView({
    ...(normalizedMonth ? { month: normalizedMonth } : {}),
  });

  const canonicalCurrentMonth = monthParam ? normalizeSummaryMonthKey(monthParam) : "";
  const canonicalSelectedMonth = view.selectedMonth ?? "";

  if (hasUnexpectedParams || (hasMonthParam && canonicalCurrentMonth !== canonicalSelectedMonth)) {
    redirect(canonicalStatisticsUrl(view.selectedMonth));
  }

  return (
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 lg:pt-14">
      <DashboardHeader />
      <DashboardNav activeTab="statistics" />
      <StatisticsContent view={view} />
    </main>
  );
}
