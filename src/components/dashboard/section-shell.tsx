import { ReactNode } from "react";

type SectionShellProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function SectionShell({
  title,
  subtitle,
  children,
  action,
  className,
}: SectionShellProps) {
  return (
    <section
      className={`rounded-3xl border border-ink-soft/15 bg-surface/80 p-6 shadow-[0_18px_36px_-28px_rgba(21,32,39,0.6)] backdrop-blur-sm ${className ?? ""}`}
    >
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl text-foreground">{title}</h2>
          <p className="mt-2 text-sm text-muted">{subtitle}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
