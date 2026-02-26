import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { TagsContent } from "@/components/dashboard/tags-content";

export default function TagsPage() {
  return (
    <main className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 lg:pt-14">
      <DashboardHeader />
      <DashboardNav activeTab="tags" />
      <TagsContent />
    </main>
  );
}
