import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import {
  normalizeTrendDateRange,
  normalizeTrendFrequency,
  type TrendFrequency,
} from "@/components/dashboard/dashboard-shared";
import { TrendContent } from "@/components/dashboard/trend-content";

type SearchParams = Record<string, string | string[] | undefined>;

function canonicalTrendUrl(frequency: TrendFrequency, startDate: string, endDate: string): string {
  const params = new URLSearchParams();
  params.set("freq", frequency);
  params.set("start", startDate);
  params.set("end", endDate);
  return `/trend?${params.toString()}`;
}

export default async function TrendPage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const frequencyParam = typeof resolvedSearchParams.freq === "string" ? resolvedSearchParams.freq : null;
  const startDateParam = typeof resolvedSearchParams.start === "string" ? resolvedSearchParams.start : null;
  const endDateParam = typeof resolvedSearchParams.end === "string" ? resolvedSearchParams.end : null;
  const hasUnexpectedParams = Object.entries(resolvedSearchParams).some(
    ([key, value]) => !["freq", "start", "end"].includes(key) || typeof value !== "string"
  );

  const frequency = normalizeTrendFrequency(frequencyParam);
  const normalizedRange = normalizeTrendDateRange(startDateParam, endDateParam);
  const canonicalStartDate = normalizedRange.startDate;
  const canonicalEndDate = normalizedRange.endDate;

  if (
    hasUnexpectedParams ||
    frequencyParam !== frequency ||
    startDateParam !== canonicalStartDate ||
    endDateParam !== canonicalEndDate
  ) {
    redirect(canonicalTrendUrl(frequency, canonicalStartDate, canonicalEndDate));
  }

  return (
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 lg:pt-14">
      <DashboardHeader />
      <DashboardNav activeTab="trend" />
      <TrendContent
        key={`${frequency}:${canonicalStartDate}:${canonicalEndDate}`}
        initialFrequency={frequency}
        initialStartDate={canonicalStartDate}
        initialEndDate={canonicalEndDate}
      />
    </main>
  );
}
