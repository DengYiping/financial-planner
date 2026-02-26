type SummaryCardTone = "neutral" | "positive" | "warning" | "danger";

type SummaryCardProps = {
  label: string;
  value: string;
  helper: string;
  tone?: SummaryCardTone;
};

const toneStyles: Record<SummaryCardTone, string> = {
  neutral: "text-ink-soft",
  positive: "text-positive",
  warning: "text-warning",
  danger: "text-danger",
};

export function SummaryCard({ label, value, helper, tone = "neutral" }: SummaryCardProps) {
  return (
    <article className="rounded-2xl border border-ink-soft/15 bg-surface p-4 shadow-[0_10px_30px_-24px_rgba(19,32,40,0.6)]">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">{label}</p>
      <p className="mt-3 text-3xl font-semibold text-foreground">{value}</p>
      <p className={`mt-2 text-sm ${toneStyles[tone]}`}>{helper}</p>
    </article>
  );
}
