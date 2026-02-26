"use client";

export function DashboardHeader() {
  const todayLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

  return (
    <header className="mb-8 rounded-3xl border border-ink-soft/15 bg-surface/85 p-6 shadow-[0_24px_48px_-36px_rgba(23,34,40,0.7)] backdrop-blur-sm sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Personal Finance</p>
          <h1 className="mt-3 font-display text-4xl tracking-tight text-foreground sm:text-5xl">Tracker and Planner</h1>
          <p className="mt-3 max-w-2xl text-sm text-muted sm:text-base">
            Single-user finance workspace. Add accounts, upload statements, and review cross-account history.
          </p>
        </div>
        <div className="space-y-2 text-right">
          <p className="font-mono text-xs uppercase tracking-[0.15em] text-muted">{todayLabel}</p>
          <p className="rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
            No Login (V1)
          </p>
        </div>
      </div>
    </header>
  );
}
