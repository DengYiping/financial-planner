import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function TransactionsIndexPage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const month = typeof resolvedSearchParams.month === "string" ? resolvedSearchParams.month : undefined;
  const query = month ? `?month=${encodeURIComponent(month)}` : "";

  redirect(`/transactions/recent${query}`);
}
