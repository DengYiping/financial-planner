import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { TransactionsContent } from "@/components/dashboard/transactions-content";
import { getServerTrpcCaller } from "@/trpc/server";

type SearchParams = Record<string, string | string[] | undefined>;
const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
type DirectionParam = "all" | "inflow" | "outflow";

function toValidMonthParam(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return MONTH_KEY_PATTERN.test(value) ? value : undefined;
}

function toValidCategoryParam(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    return undefined;
  }

  return trimmed;
}

function toValidDirectionParam(value: string | undefined): DirectionParam {
  if (value === "inflow" || value === "outflow") {
    return value;
  }

  return "all";
}

function canonicalTransactionsUrl(
  startMonth?: string,
  endMonth?: string,
  category?: string,
  direction: DirectionParam = "all"
): string {
  if (!startMonth || !endMonth) {
    return "/transactions";
  }

  const params = new URLSearchParams();
  params.set("startMonth", startMonth);
  params.set("endMonth", endMonth);
  if (category) {
    params.set("category", category);
  }
  if (direction !== "all") {
    params.set("direction", direction);
  }
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
  const rawCategoryParam =
    typeof resolvedSearchParams.category === "string" ? resolvedSearchParams.category : undefined;
  const rawDirectionParam =
    typeof resolvedSearchParams.direction === "string" ? resolvedSearchParams.direction : undefined;

  const legacyMonthParam = toValidMonthParam(rawLegacyMonthParam);
  const startMonthParam =
    typeof rawStartMonthParam === "string" ? toValidMonthParam(rawStartMonthParam) : legacyMonthParam;
  const endMonthParam =
    typeof rawEndMonthParam === "string" ? toValidMonthParam(rawEndMonthParam) : legacyMonthParam;
  const categoryParam = toValidCategoryParam(rawCategoryParam);
  const directionParam = toValidDirectionParam(rawDirectionParam);
  const hasExplicitRangeParams =
    typeof rawStartMonthParam === "string" || typeof rawEndMonthParam === "string";
  const hasLegacyMonthParam = typeof rawLegacyMonthParam === "string";
  const hasInvalidMonthParams =
    (typeof rawLegacyMonthParam === "string" && !MONTH_KEY_PATTERN.test(rawLegacyMonthParam)) ||
    (typeof rawStartMonthParam === "string" && !MONTH_KEY_PATTERN.test(rawStartMonthParam)) ||
    (typeof rawEndMonthParam === "string" && !MONTH_KEY_PATTERN.test(rawEndMonthParam));
  const hasInvalidCategoryParam = typeof rawCategoryParam === "string" && !categoryParam;
  const hasInvalidDirectionParam =
    typeof rawDirectionParam === "string" && !["all", "inflow", "outflow"].includes(rawDirectionParam);
  const hasUnexpectedParams = Object.entries(resolvedSearchParams).some(
    ([key, value]) =>
      !["startMonth", "endMonth", "category", "direction"].includes(key) || typeof value !== "string"
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
    hasInvalidCategoryParam ||
    hasInvalidDirectionParam ||
    hasLegacyMonthParam ||
    (hasExplicitRangeParams && hasRangeMismatch)
  ) {
    redirect(canonicalTransactionsUrl(view.selectedStartMonth, view.selectedEndMonth, categoryParam, directionParam));
  }

  return (
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 lg:pt-14">
      <DashboardHeader />
      <DashboardNav activeTab="transactions" />
      <TransactionsContent
        view={view}
        initialSelectedCategory={categoryParam}
        initialDirectionFilter={directionParam}
      />
    </main>
  );
}
