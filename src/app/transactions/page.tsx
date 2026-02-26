import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { TransactionsContent } from "@/components/dashboard/transactions-content";
import { getServerTrpcCaller } from "@/trpc/server";

type SearchParams = Record<string, string | string[] | undefined>;
const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function toValidMonthParam(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return MONTH_KEY_PATTERN.test(value) ? value : undefined;
}

function canonicalTransactionsUrl(startMonth?: string, endMonth?: string): string {
  if (!startMonth || !endMonth) {
    return "/transactions";
  }

  const params = new URLSearchParams();
  params.set("startMonth", startMonth);
  params.set("endMonth", endMonth);
  return `/transactions?${params.toString()}`;
}

export default async function TransactionsIndexPage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const rawLegacyMonthParam =
    typeof resolvedSearchParams.month === "string" ? resolvedSearchParams.month : undefined;
  const rawStartMonthParam =
    typeof resolvedSearchParams.startMonth === "string" ? resolvedSearchParams.startMonth : undefined;
  const rawEndMonthParam =
    typeof resolvedSearchParams.endMonth === "string" ? resolvedSearchParams.endMonth : undefined;

  const legacyMonthParam = toValidMonthParam(rawLegacyMonthParam);
  const startMonthParam =
    typeof rawStartMonthParam === "string" ? toValidMonthParam(rawStartMonthParam) : legacyMonthParam;
  const endMonthParam =
    typeof rawEndMonthParam === "string" ? toValidMonthParam(rawEndMonthParam) : legacyMonthParam;
  const hasExplicitRangeParams =
    typeof rawStartMonthParam === "string" || typeof rawEndMonthParam === "string";
  const hasLegacyMonthParam = typeof rawLegacyMonthParam === "string";
  const hasInvalidMonthParams =
    (typeof rawLegacyMonthParam === "string" && !MONTH_KEY_PATTERN.test(rawLegacyMonthParam)) ||
    (typeof rawStartMonthParam === "string" && !MONTH_KEY_PATTERN.test(rawStartMonthParam)) ||
    (typeof rawEndMonthParam === "string" && !MONTH_KEY_PATTERN.test(rawEndMonthParam));
  const hasUnexpectedParams = Object.entries(resolvedSearchParams).some(
    ([key, value]) => !["startMonth", "endMonth"].includes(key) || typeof value !== "string"
  );

  const caller = await getServerTrpcCaller();
  const view = await caller.accounts.transactionsView({
    startMonth: startMonthParam,
    endMonth: endMonthParam,
  });

  const hasRangeMismatch =
    startMonthParam !== view.selectedStartMonth || endMonthParam !== view.selectedEndMonth;

  if (
    hasUnexpectedParams ||
    hasInvalidMonthParams ||
    hasLegacyMonthParam ||
    (hasExplicitRangeParams && hasRangeMismatch)
  ) {
    redirect(canonicalTransactionsUrl(view.selectedStartMonth, view.selectedEndMonth));
  }

  return (
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 lg:pt-14">
      <DashboardHeader />
      <DashboardNav activeTab="transactions" />
      <TransactionsContent view={view} />
    </main>
  );
}
