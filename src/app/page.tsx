import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { OverviewContent } from "@/components/dashboard/overview-content";
import { getServerTrpcCaller } from "@/trpc/server";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function OverviewPage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  if (Object.keys(resolvedSearchParams).length > 0) {
    redirect("/");
  }

  const caller = await getServerTrpcCaller();
  const initialAccounts = await caller.accounts.list();

  return (
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 lg:pt-14">
      <DashboardHeader />
      <DashboardNav activeTab="overview" />
      <OverviewContent initialAccounts={initialAccounts} />
    </main>
  );
}
