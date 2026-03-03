export type ImportConflictReason = "existing_match" | "incoming_duplicate" | "both";

export type ImportCoverageSummary = {
  totalIncomingCount: number;
  uniqueIncomingCount: number;
  existingMatchedUniqueCount: number;
  uncoveredUniqueCount: number;
  fullyCovered: boolean;
};

export type ImportComparableTransaction = {
  id?: string;
  bookingDate?: string;
  amountCents?: number;
  currency?: string;
  direction?: "in" | "out";
  description?: string;
  counterparty?: string;
  reference?: string;
};

export type ImportConflict = {
  incomingIndex: number;
  incomingSourceId: string;
  duplicateKey: string;
  reason: ImportConflictReason;
  forced: boolean;
  action: "import" | "skip";
  existingTransaction?: ImportComparableTransaction;
};

export type ImportPreviewResult = {
  totalCount: number;
  duplicateConflictCount: number;
  duplicateSkippedCount: number;
  forcedImportCount: number;
  autoCancelled: boolean;
  cancelReason?: "all_unique_keys_already_exist";
  coverage: ImportCoverageSummary;
  conflicts: ImportConflict[];
};

export type ImportDedupeDecision = {
  incomingIndex: number;
  duplicateKey: string;
  reason?: ImportConflictReason;
  shouldImport: boolean;
  forced: boolean;
};

export type ImportDedupeTransaction = {
  sourceId: string;
  bookingDate: string;
  amountCents: number;
  description: string;
};

export type ImportExistingDedupeTransaction = {
  sourceId?: string;
  bookingDate: string;
  amountCents: number;
  description: string;
  currency?: string;
  direction?: "in" | "out";
  counterparty?: string;
  reference?: string;
};

const DESCRIPTION_WHITESPACE_PATTERN = /\s+/g;

function normalizeAmountCents(amountCents: number): number {
  if (!Number.isFinite(amountCents)) {
    return 0;
  }

  return Math.abs(Math.trunc(amountCents));
}

export function normalizeImportDescription(description: string): string {
  return description.trim().replace(DESCRIPTION_WHITESPACE_PATTERN, " ").toLowerCase();
}

export function buildImportDuplicateKey(input: {
  bookingDate: string;
  amountCents: number;
  description: string;
}): string {
  return `${input.bookingDate}|${normalizeAmountCents(input.amountCents)}|${normalizeImportDescription(
    input.description
  )}`;
}

function normalizeForceImportIndexes(forceImportIndexes: number[] | undefined, totalCount: number): Set<number> {
  if (!Array.isArray(forceImportIndexes) || forceImportIndexes.length === 0) {
    return new Set();
  }

  const normalized = new Set<number>();
  forceImportIndexes.forEach((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= totalCount) {
      return;
    }

    normalized.add(index);
  });

  return normalized;
}

export function analyzeImportDedupe(
  incomingTransactions: ImportDedupeTransaction[],
  existingTransactions: ImportExistingDedupeTransaction[],
  forceImportIndexes?: number[]
): ImportPreviewResult & {
  decisions: ImportDedupeDecision[];
} {
  const totalIncomingCount = incomingTransactions.length;
  const normalizedForceIndexes = normalizeForceImportIndexes(forceImportIndexes, totalIncomingCount);

  const incomingRows = incomingTransactions.map((transaction, incomingIndex) => ({
    incomingIndex,
    sourceId: transaction.sourceId,
    duplicateKey: buildImportDuplicateKey(transaction),
  }));

  const incomingCountByKey = new Map<string, number>();
  incomingRows.forEach((row) => {
    incomingCountByKey.set(row.duplicateKey, (incomingCountByKey.get(row.duplicateKey) ?? 0) + 1);
  });

  const existingKeySet = new Set<string>();
  const existingTransactionByKey = new Map<string, ImportComparableTransaction>();
  existingTransactions.forEach((transaction) => {
    const duplicateKey = buildImportDuplicateKey(transaction);
    existingKeySet.add(duplicateKey);

    if (!existingTransactionByKey.has(duplicateKey)) {
      existingTransactionByKey.set(duplicateKey, {
        id: transaction.sourceId,
        bookingDate: transaction.bookingDate,
        amountCents: normalizeAmountCents(transaction.amountCents),
        currency: transaction.currency,
        direction: transaction.direction,
        description: transaction.description,
        counterparty: transaction.counterparty,
        reference: transaction.reference,
      });
    }
  });

  const uniqueIncomingCount = incomingCountByKey.size;
  const existingMatchedUniqueCount = Array.from(incomingCountByKey.keys()).reduce(
    (count, duplicateKey) => (existingKeySet.has(duplicateKey) ? count + 1 : count),
    0
  );
  const uncoveredUniqueCount = uniqueIncomingCount - existingMatchedUniqueCount;
  const coverage: ImportCoverageSummary = {
    totalIncomingCount,
    uniqueIncomingCount,
    existingMatchedUniqueCount,
    uncoveredUniqueCount,
    fullyCovered: uniqueIncomingCount > 0 && uncoveredUniqueCount === 0,
  };

  const decisions: ImportDedupeDecision[] = [];
  const conflicts: ImportConflict[] = [];

  incomingRows.forEach((row) => {
    const hasExistingMatch = existingKeySet.has(row.duplicateKey);
    const incomingDuplicateCount = incomingCountByKey.get(row.duplicateKey) ?? 0;
    const hasIncomingDuplicate = incomingDuplicateCount > 1;
    const reason: ImportConflictReason | undefined = hasExistingMatch
      ? hasIncomingDuplicate
        ? "both"
        : "existing_match"
      : hasIncomingDuplicate
      ? "incoming_duplicate"
      : undefined;

    const defaultShouldImport = !hasExistingMatch;
    const forced = hasExistingMatch && normalizedForceIndexes.has(row.incomingIndex);
    const shouldImport = forced ? true : defaultShouldImport;

    decisions.push({
      incomingIndex: row.incomingIndex,
      duplicateKey: row.duplicateKey,
      reason,
      shouldImport,
      forced,
    });

    if (reason === "existing_match" || reason === "both") {
      conflicts.push({
        incomingIndex: row.incomingIndex,
        incomingSourceId: row.sourceId,
        duplicateKey: row.duplicateKey,
        reason,
        forced,
        action: shouldImport ? "import" : "skip",
        existingTransaction: hasExistingMatch ? existingTransactionByKey.get(row.duplicateKey) : undefined,
      });
    }
  });

  const forcedImportCount = decisions.reduce(
    (count, decision) => (decision.forced && decision.shouldImport ? count + 1 : count),
    0
  );
  const autoCancelled = coverage.fullyCovered && forcedImportCount === 0;

  return {
    totalCount: totalIncomingCount,
    duplicateConflictCount: conflicts.length,
    duplicateSkippedCount: decisions.reduce(
      (count, decision) => (decision.reason && !decision.shouldImport ? count + 1 : count),
      0
    ),
    forcedImportCount,
    autoCancelled,
    cancelReason: autoCancelled ? "all_unique_keys_already_exist" : undefined,
    coverage,
    conflicts,
    decisions,
  };
}
