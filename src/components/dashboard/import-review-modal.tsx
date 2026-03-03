"use client";

import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  type ComparableTransaction,
  type ImportConflictAction,
  type ImportPreviewConflict,
  formatCurrencyCents,
} from "@/components/dashboard/dashboard-shared";

type ImportReviewModalProps = {
  accountName: string;
  open: boolean;
  conflicts: ImportPreviewConflict[];
  conflictActions: Record<number, ImportConflictAction>;
  isPending: boolean;
  errorMessage?: string | null;
  onClose: () => void;
  onConfirm: () => void;
  onActionChange: (incomingIndex: number, action: ImportConflictAction) => void;
};

function toText(value: string | undefined): string {
  return value && value.trim().length > 0 ? value : "Not provided";
}

function formatDirection(direction: ComparableTransaction["direction"]): string {
  if (direction === "in") {
    return "Inflow";
  }
  if (direction === "out") {
    return "Outflow";
  }

  return "Unknown";
}

function formatAmount(transaction: ComparableTransaction): string {
  if (typeof transaction.amountCents !== "number" || !transaction.currency) {
    return "Not provided";
  }

  const signedPrefix = transaction.direction === "out" ? "-" : transaction.direction === "in" ? "+" : "";
  return `${signedPrefix}${formatCurrencyCents(transaction.amountCents, transaction.currency)}`;
}

function formatCoverage(coverage: number | undefined): string | null {
  if (typeof coverage !== "number" || !Number.isFinite(coverage)) {
    return null;
  }

  const normalized = coverage <= 1 ? coverage * 100 : coverage;
  const bounded = Math.max(0, Math.min(100, normalized));
  return `${bounded.toFixed(1)}% match`;
}

type TransactionDetailCardProps = {
  title: string;
  transaction?: ComparableTransaction;
  tone: "incoming" | "existing";
};

function TransactionDetailCard({ title, transaction, tone }: TransactionDetailCardProps) {
  const wrapperToneClasses =
    tone === "incoming"
      ? "border-accent/25 bg-accent/5"
      : "border-warning/30 bg-warning/10";
  const directionToneClasses =
    transaction?.direction === "in"
      ? "border-positive/30 bg-positive/10 text-positive"
      : transaction?.direction === "out"
        ? "border-danger/30 bg-danger/10 text-danger"
        : "border-ink-soft/20 bg-surface text-muted";

  return (
    <section className={`rounded-xl border p-3 ${wrapperToneClasses}`}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{title}</h4>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${directionToneClasses}`}>
          {formatDirection(transaction?.direction)}
        </span>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <dt className="text-muted">ID</dt>
          <dd className="font-mono text-[12px] break-all text-foreground">{toText(transaction?.id)}</dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <dt className="text-muted">Booking Date</dt>
          <dd className="text-foreground">{toText(transaction?.bookingDate)}</dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <dt className="text-muted">Amount</dt>
          <dd className="font-mono text-foreground">{formatAmount(transaction ?? {})}</dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <dt className="text-muted">Description</dt>
          <dd className="text-foreground">{toText(transaction?.description)}</dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <dt className="text-muted">Counterparty</dt>
          <dd className="text-foreground">{toText(transaction?.counterparty)}</dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <dt className="text-muted">Reference</dt>
          <dd className="text-foreground">{toText(transaction?.reference)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function ImportReviewModal({
  accountName,
  open,
  conflicts,
  conflictActions,
  isPending,
  errorMessage,
  onClose,
  onConfirm,
  onActionChange,
}: ImportReviewModalProps) {
  const forceImportCount = useMemo(
    () =>
      conflicts.reduce((count, conflict) => {
        return conflictActions[conflict.incomingIndex] === "force_import" ? count + 1 : count;
      }, 0),
    [conflicts, conflictActions]
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isPending) {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, isPending, onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-foreground/45 px-4 py-6"
      onClick={() => {
        if (!isPending) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-review-title"
        className="w-full max-w-5xl rounded-2xl border border-ink-soft/20 bg-surface p-5 shadow-[0_28px_90px_-48px_rgba(20,34,43,0.8)]"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="import-review-title" className="text-base font-semibold text-foreground">
              Review Potential Duplicates
            </h3>
            <p className="mt-1 text-xs text-muted">
              {accountName} · {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"} detected
            </p>
            <p className="mt-1 text-xs text-muted">
              Default action is <span className="font-semibold">Keep Existing</span>. Toggle only rows you want to
              force import.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="rounded-full border border-ink-soft/20 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            Close
          </button>
        </div>

        {errorMessage ? (
          <p className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {errorMessage}
          </p>
        ) : null}

        <div className="mt-4 max-h-[68vh] space-y-4 overflow-y-auto pr-1">
          {conflicts.map((conflict, index) => {
            const selectedAction = conflictActions[conflict.incomingIndex] ?? "keep_existing";
            const coverageLabel = formatCoverage(conflict.coverage);

            return (
              <article key={conflict.incomingIndex} className="rounded-2xl border border-ink-soft/20 bg-surface/80">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-soft/15 px-4 py-3">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">Conflict #{index + 1}</h4>
                    <p className="text-xs text-muted">Incoming transaction index: {conflict.incomingIndex}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {coverageLabel ? (
                      <span className="rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
                        {coverageLabel}
                      </span>
                    ) : null}
                    {conflict.reason ? (
                      <span className="rounded-full border border-ink-soft/20 px-2 py-0.5 text-[11px] text-muted">
                        {conflict.reason}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-3 border-b border-ink-soft/15 p-4 md:grid-cols-2">
                  <TransactionDetailCard title="Incoming" transaction={conflict.incomingTransaction} tone="incoming" />
                  <TransactionDetailCard title="Existing" transaction={conflict.existingTransaction} tone="existing" />
                </div>

                <fieldset className="px-4 py-3">
                  <legend className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Resolution</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label
                      className={`rounded-xl border px-3 py-2 text-sm transition ${
                        selectedAction === "keep_existing"
                          ? "border-ink-soft/40 bg-ink-soft/10 text-foreground"
                          : "border-ink-soft/20 text-muted hover:text-foreground"
                      } ${isPending ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                    >
                      <input
                        type="radio"
                        name={`conflict-resolution-${conflict.incomingIndex}`}
                        checked={selectedAction === "keep_existing"}
                        onChange={() => {
                          onActionChange(conflict.incomingIndex, "keep_existing");
                        }}
                        disabled={isPending}
                        className="sr-only"
                      />
                      Keep Existing
                    </label>

                    <label
                      className={`rounded-xl border px-3 py-2 text-sm transition ${
                        selectedAction === "force_import"
                          ? "border-accent/50 bg-accent/10 text-accent"
                          : "border-ink-soft/20 text-muted hover:text-foreground"
                      } ${isPending ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                    >
                      <input
                        type="radio"
                        name={`conflict-resolution-${conflict.incomingIndex}`}
                        checked={selectedAction === "force_import"}
                        onChange={() => {
                          onActionChange(conflict.incomingIndex, "force_import");
                        }}
                        disabled={isPending}
                        className="sr-only"
                      />
                      Force Import
                    </label>
                  </div>
                </fieldset>
              </article>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-ink-soft/15 pt-4">
          <p className="text-sm text-muted">
            <span className="font-semibold text-foreground">{forceImportCount}</span> of{" "}
            <span className="font-semibold text-foreground">{conflicts.length}</span> conflict
            {conflicts.length === 1 ? "" : "s"} set to force import
          </p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="rounded-full border border-ink-soft/20 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className="rounded-full border border-accent/40 bg-accent/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Importing..." : "Commit Import"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
