type BudgetBarProps = {
  category: string;
  planned: string;
  spent: string;
  progress: number;
};

export function BudgetBar({ category, planned, spent, progress }: BudgetBarProps) {
  const percentUsed = Math.max(progress, 0);
  const width = Math.min(percentUsed, 100);
  const isOver = percentUsed > 100;

  return (
    <article className="rounded-2xl border border-ink-soft/15 bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{category}</h3>
          <p className="mt-1 text-xs text-muted">Planned {planned}</p>
        </div>
        <p className={`font-mono text-xs ${isOver ? "text-danger" : "text-ink-soft"}`}>
          {Math.round(percentUsed)}% used
        </p>
      </div>
      <div className="mt-4 h-2 rounded-full bg-ink-soft/10">
        <div
          className={`h-2 rounded-full ${isOver ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <p className={`mt-3 text-sm ${isOver ? "text-danger" : "text-foreground"}`}>
        Spent {spent}
      </p>
    </article>
  );
}
