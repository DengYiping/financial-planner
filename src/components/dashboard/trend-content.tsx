"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SectionShell } from "@/components/dashboard/section-shell";
import {
  formatCurrencyCents,
  formatMonthLabel,
  normalizeTrendDateRange,
  normalizeTrendFrequency,
  resolveErrorMessage,
  type TrendFrequency,
} from "@/components/dashboard/dashboard-shared";
import type { AppRouter } from "@/server/api/routers/_app";
import { trpc } from "@/trpc/react";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type SpendingTrendView = RouterOutputs["accounts"]["spendingTrendView"];
type SpendingTrendSeries = SpendingTrendView["series"][number];

type TrendContentProps = {
  initialFrequency: TrendFrequency;
  initialStartDate: string;
  initialEndDate: string;
};

const CHART_COLORS = [
  "#0673A6",
  "#0C8A69",
  "#B56A16",
  "#8E5EA2",
  "#D14B66",
  "#2E7867",
  "#B14747",
  "#5B7CBA",
];

function buildTrendUrl(pathname: string, frequency: TrendFrequency, startDate: string, endDate: string): string {
  const params = new URLSearchParams();
  params.set("freq", frequency);
  params.set("start", startDate);
  params.set("end", endDate);
  return `${pathname}?${params.toString()}`;
}

function formatDateLabel(value: string): string {
  const [yearToken, monthToken, dayToken] = value.split("-");
  const year = Number.parseInt(yearToken ?? "", 10);
  const month = Number.parseInt(monthToken ?? "", 10);
  const day = Number.parseInt(dayToken ?? "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, day))
  );
}

function formatPeriodLabel(period: string, frequency: TrendFrequency): string {
  if (frequency === "month") {
    return formatMonthLabel(period);
  }

  if (frequency === "week") {
    return `Week of ${formatDateLabel(period)}`;
  }

  return formatDateLabel(period);
}

function formatCompactPeriodLabel(period: string, frequency: TrendFrequency): string {
  if (frequency === "month") {
    const [yearToken, monthToken] = period.split("-");
    const year = Number.parseInt(yearToken ?? "", 10);
    const month = Number.parseInt(monthToken ?? "", 10);
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
      return period;
    }

    return new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" }).format(
      new Date(Date.UTC(year, month - 1, 1))
    );
  }

  return formatDateLabel(period);
}

function formatCompactCurrencyCents(amountCents: number): string {
  const euros = amountCents / 100;
  if (Math.abs(euros) >= 1000) {
    return `€${(euros / 1000).toFixed(1)}k`;
  }

  return `€${Math.round(euros)}`;
}

function TrendSeriesChart({
  series,
  periods,
  frequency,
  color,
}: {
  series: SpendingTrendSeries;
  periods: string[];
  frequency: TrendFrequency;
  color: string;
}) {
  const values = useMemo(() => {
    const spendingByPeriod = new Map(series.points.map((point) => [point.period, point.spentCents] as const));
    return periods.map((period) => spendingByPeriod.get(period) ?? 0);
  }, [periods, series.points]);
  const chartData = useMemo(
    () =>
      periods.map((period, index) => ({
        period,
        spentCents: values[index] ?? 0,
      })),
    [periods, values]
  );
  const totalSpentCents = useMemo(() => values.reduce((sum, value) => sum + value, 0), [values]);
  const peakSpentCents = useMemo(() => values.reduce((max, value) => Math.max(max, value), 0), [values]);
  const averageSpentCents = useMemo(
    () => (values.length > 0 ? Math.round(totalSpentCents / values.length) : 0),
    [totalSpentCents, values.length]
  );

  if (periods.length === 0) {
    return null;
  }

  return (
    <article className="rounded-2xl border border-ink-soft/15 bg-surface/90 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{series.categoryName}</h3>
          <p className="mt-1 text-xs text-muted">
            {periods.length} period{periods.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-xs text-muted">Total</p>
          <p className="font-mono text-sm text-foreground">{formatCurrencyCents(totalSpentCents, "EUR", "en-IE")}</p>
          <p className="mt-1 font-mono text-[11px] text-muted">
            Peak {formatCurrencyCents(peakSpentCents, "EUR", "en-IE")}
          </p>
        </div>
      </header>

      <div className="mt-3 rounded-xl border border-ink-soft/15 bg-surface/70 p-2">
        <div className="h-64 w-full">
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 10, right: 16, left: 4, bottom: 8 }}>
              <CartesianGrid stroke="#d9dde1" strokeDasharray="3 3" />
              <XAxis
                dataKey="period"
                minTickGap={20}
                tick={{ fontSize: 11, fill: "#65707a" }}
                tickFormatter={(value) => formatCompactPeriodLabel(String(value), frequency)}
              />
              <YAxis
                width={56}
                tick={{ fontSize: 11, fill: "#65707a" }}
                tickFormatter={(value) => formatCompactCurrencyCents(Number(value))}
              />
              <Tooltip
                formatter={(value) => formatCurrencyCents(Number(value), "EUR", "en-IE")}
                labelFormatter={(label) => formatPeriodLabel(String(label), frequency)}
              />
              <Legend
                formatter={(value) => <span className="text-xs text-foreground">{value}</span>}
              />
              <ReferenceLine
                y={averageSpentCents}
                stroke="#64748b"
                strokeDasharray="4 4"
                label={{ value: `Avg ${formatCompactCurrencyCents(averageSpentCents)}`, position: "insideTopRight", fontSize: 10 }}
              />
              <ReferenceLine
                y={peakSpentCents}
                stroke="#b56a16"
                strokeDasharray="3 3"
                label={{ value: `Peak ${formatCompactCurrencyCents(peakSpentCents)}`, position: "right", fontSize: 10 }}
              />
              <Line
                type="monotone"
                dataKey="spentCents"
                name="Spending"
                stroke={color}
                strokeWidth={2.5}
                dot={{ r: 2 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </article>
  );
}

function sumSeriesSpentCents(series: SpendingTrendSeries): number {
  return series.points.reduce((sum, point) => sum + point.spentCents, 0);
}

export function TrendContent({ initialFrequency, initialStartDate, initialEndDate }: TrendContentProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isNavigating, startTransition] = useTransition();
  const [frequency, setFrequency] = useState<TrendFrequency>(initialFrequency);
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);

  const trendQuery = trpc.accounts.spendingTrendView.useQuery({
    frequency,
    startDate,
    endDate,
  });
  const view = trendQuery.data;
  const loadError = trendQuery.error
    ? resolveErrorMessage(trendQuery.error, "Failed to load trend data.")
    : null;

  function applyFilters(nextValue: {
    frequency?: TrendFrequency;
    startDate?: string;
    endDate?: string;
  }): void {
    const nextFrequency = normalizeTrendFrequency(nextValue.frequency ?? frequency);
    const normalizedRange = normalizeTrendDateRange(nextValue.startDate ?? startDate, nextValue.endDate ?? endDate);

    setFrequency(nextFrequency);
    setStartDate(normalizedRange.startDate);
    setEndDate(normalizedRange.endDate);

    startTransition(() => {
      router.replace(buildTrendUrl(pathname, nextFrequency, normalizedRange.startDate, normalizedRange.endDate), {
        scroll: false,
      });
    });
  }

  const sortedSeries = useMemo(() => {
    return [...(view?.series ?? [])].sort(
      (left, right) => sumSeriesSpentCents(right) - sumSeriesSpentCents(left)
    );
  }, [view?.series]);

  return (
    <div className="animate-[tab-content-enter_280ms_cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform]">
      <SectionShell
        title="Spending Trend"
        subtitle="Track category spending over time with daily, weekly, or monthly buckets."
        action={
          view ? (
            <div className="space-y-1 text-right">
              <p className="font-mono text-xs text-muted">{view.periods.length} periods</p>
              <p className="font-mono text-xs text-muted">{view.series.length} categories</p>
            </div>
          ) : undefined
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
            Frequency
            <select
              value={frequency}
              onChange={(event) => {
                applyFilters({
                  frequency: event.target.value as TrendFrequency,
                });
              }}
              disabled={isNavigating}
              className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-55"
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
            Start Date
            <input
              type="date"
              value={startDate}
              onChange={(event) => {
                if (!event.target.value) {
                  return;
                }

                applyFilters({
                  startDate: event.target.value,
                });
              }}
              max={endDate}
              disabled={isNavigating}
              className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-55"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted">
            End Date
            <input
              type="date"
              value={endDate}
              onChange={(event) => {
                if (!event.target.value) {
                  return;
                }

                applyFilters({
                  endDate: event.target.value,
                });
              }}
              min={startDate}
              disabled={isNavigating}
              className="rounded-xl border border-ink-soft/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-55"
            />
          </label>
        </div>

        {trendQuery.isPending && !view ? (
          <p className="rounded-2xl border border-ink-soft/15 bg-surface p-4 text-sm text-muted">Loading trend data...</p>
        ) : null}

        {!trendQuery.isPending && loadError ? (
          <p className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{loadError}</p>
        ) : null}

        {!trendQuery.isPending && !loadError && view && view.series.length === 0 ? (
          <p className="rounded-2xl border border-ink-soft/15 bg-surface p-4 text-sm text-muted">
            No categorized spending found for this date range.
          </p>
        ) : null}

        {!trendQuery.isPending && !loadError && view && view.series.length > 0 ? (
          <div className="space-y-3">
            {trendQuery.isFetching ? (
              <p className="rounded-xl border border-ink-soft/15 bg-surface/80 px-3 py-2 text-xs text-muted">
                Updating trend...
              </p>
            ) : null}

            {sortedSeries.map((series, index) => (
              <TrendSeriesChart
                key={`trend-series-${series.categoryName}`}
                series={series}
                periods={view.periods}
                frequency={view.frequency}
                color={CHART_COLORS[index % CHART_COLORS.length] ?? "#0673A6"}
              />
            ))}
          </div>
        ) : null}
      </SectionShell>
    </div>
  );
}
