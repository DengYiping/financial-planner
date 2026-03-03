import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  analyzeImportDedupe,
  buildImportDuplicateKey,
  normalizeImportDescription,
  type ImportDedupeTransaction,
} from "@/lib/finance/import-dedupe";

test("normalizeImportDescription and duplicate key normalization", () => {
  assert.equal(normalizeImportDescription("  MERCHANT   NAME\tLTD  "), "merchant name ltd");

  const duplicateKey = buildImportDuplicateKey({
    bookingDate: "2026-01-10",
    amountCents: -1250.99,
    description: "  Coffee   Shop  ",
  });

  assert.equal(duplicateKey, "2026-01-10|1250|coffee shop");
});

test("analyzeImportDedupe classifies existing/incoming/both conflicts and keeps unique rows", () => {
  const incoming: ImportDedupeTransaction[] = [
    {
      sourceId: "incoming-0",
      bookingDate: "2026-01-01",
      amountCents: 1000,
      description: " coffee   shop ",
    },
    {
      sourceId: "incoming-1",
      bookingDate: "2026-01-02",
      amountCents: 2200,
      description: "Taxi Ride",
    },
    {
      sourceId: "incoming-2",
      bookingDate: "2026-01-02",
      amountCents: 2200,
      description: " taxi   ride ",
    },
    {
      sourceId: "incoming-3",
      bookingDate: "2026-01-03",
      amountCents: 3000,
      description: "rent",
    },
    {
      sourceId: "incoming-4",
      bookingDate: "2026-01-03",
      amountCents: 3000,
      description: " RENT ",
    },
    {
      sourceId: "incoming-5",
      bookingDate: "2026-01-04",
      amountCents: 4500,
      description: "Salary",
    },
  ];

  const existing = [
    {
      sourceId: "existing-coffee",
      bookingDate: "2026-01-01",
      amountCents: 1000,
      currency: "EUR",
      direction: "out" as const,
      description: "Coffee Shop",
      counterparty: "Coffee Shop Ltd",
    },
    {
      sourceId: "existing-rent",
      bookingDate: "2026-01-03",
      amountCents: 3000,
      currency: "EUR",
      direction: "out" as const,
      description: "Rent",
    },
  ];

  const analyzed = analyzeImportDedupe(incoming, existing);
  const conflictByIndex = new Map(analyzed.conflicts.map((conflict) => [conflict.incomingIndex, conflict]));
  const decisionByIndex = new Map(analyzed.decisions.map((decision) => [decision.incomingIndex, decision]));

  assert.equal(analyzed.duplicateConflictCount, 5);
  assert.equal(analyzed.duplicateSkippedCount, 4);
  assert.equal(analyzed.forcedImportCount, 0);
  assert.equal(analyzed.autoCancelled, false);

  assert.equal(conflictByIndex.get(0)?.reason, "existing_match");
  assert.equal(conflictByIndex.get(0)?.action, "skip");
  assert.equal(conflictByIndex.get(0)?.existingTransaction?.id, "existing-coffee");
  assert.equal(conflictByIndex.get(0)?.existingTransaction?.counterparty, "Coffee Shop Ltd");
  assert.equal(conflictByIndex.get(1)?.reason, "incoming_duplicate");
  assert.equal(conflictByIndex.get(1)?.action, "import");
  assert.equal(conflictByIndex.get(2)?.reason, "incoming_duplicate");
  assert.equal(conflictByIndex.get(2)?.action, "skip");
  assert.equal(conflictByIndex.get(3)?.reason, "both");
  assert.equal(conflictByIndex.get(4)?.reason, "both");
  assert.equal(conflictByIndex.get(3)?.existingTransaction?.id, "existing-rent");

  assert.equal(decisionByIndex.get(5)?.reason, undefined);
  assert.equal(decisionByIndex.get(5)?.shouldImport, true);

  assert.deepEqual(analyzed.coverage, {
    totalIncomingCount: 6,
    uniqueIncomingCount: 4,
    existingMatchedUniqueCount: 2,
    uncoveredUniqueCount: 2,
    fullyCovered: false,
  });
});

test("analyzeImportDedupe marks fully covered imports as auto-cancelled by default", () => {
  const incoming: ImportDedupeTransaction[] = [
    {
      sourceId: "incoming-0",
      bookingDate: "2026-01-05",
      amountCents: 5100,
      description: "  Grocery Store",
    },
    {
      sourceId: "incoming-1",
      bookingDate: "2026-01-05",
      amountCents: 5100,
      description: "grocery   store  ",
    },
  ];

  const existing = [
    {
      bookingDate: "2026-01-05",
      amountCents: 5100,
      description: "GROCERY STORE",
    },
  ];

  const analyzed = analyzeImportDedupe(incoming, existing);
  assert.equal(analyzed.coverage.fullyCovered, true);
  assert.equal(analyzed.autoCancelled, true);
  assert.equal(analyzed.cancelReason, "all_unique_keys_already_exist");
  assert.equal(analyzed.duplicateSkippedCount, 2);
});

test("analyzeImportDedupe forceImportIndexes override default skip decisions", () => {
  const incoming: ImportDedupeTransaction[] = [
    {
      sourceId: "incoming-0",
      bookingDate: "2026-01-06",
      amountCents: 1800,
      description: "Streaming",
    },
    {
      sourceId: "incoming-1",
      bookingDate: "2026-01-06",
      amountCents: 1800,
      description: "streaming",
    },
    {
      sourceId: "incoming-2",
      bookingDate: "2026-01-07",
      amountCents: 999,
      description: "Unique Entry",
    },
  ];
  const existing = [
    {
      bookingDate: "2026-01-06",
      amountCents: 1800,
      description: "streaming",
    },
  ];

  const analyzed = analyzeImportDedupe(incoming, existing, [1, 2]);
  const decisionByIndex = new Map(analyzed.decisions.map((decision) => [decision.incomingIndex, decision]));

  assert.equal(analyzed.autoCancelled, false);
  assert.equal(analyzed.forcedImportCount, 1);
  assert.equal(analyzed.duplicateSkippedCount, 1);

  assert.equal(decisionByIndex.get(0)?.shouldImport, false);
  assert.equal(decisionByIndex.get(0)?.forced, false);
  assert.equal(decisionByIndex.get(1)?.shouldImport, true);
  assert.equal(decisionByIndex.get(1)?.forced, true);

  assert.equal(decisionByIndex.get(2)?.shouldImport, true);
  assert.equal(decisionByIndex.get(2)?.forced, false);
});
