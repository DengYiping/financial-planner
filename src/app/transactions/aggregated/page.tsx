import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function TransactionsAggregatedPage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const legacyMonthParam =
    typeof resolvedSearchParams.month === "string" ? resolvedSearchParams.month : undefined;
  const startMonthParam =
    typeof resolvedSearchParams.startMonth === "string"
      ? resolvedSearchParams.startMonth
      : legacyMonthParam;
  const endMonthParam =
    typeof resolvedSearchParams.endMonth === "string" ? resolvedSearchParams.endMonth : legacyMonthParam;

  const params = new URLSearchParams();
  if (startMonthParam) {
    params.set("startMonth", startMonthParam);
  }
  if (endMonthParam) {
    params.set("endMonth", endMonthParam);
  }

  const query = params.toString();
  redirect(query ? `/transactions?${query}` : "/transactions");
}
