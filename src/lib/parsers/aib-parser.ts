import { parseAmountToCents } from "@/lib/parsers/amount";
import { indexHeaders, normalizeCell, parseCsvRows, readCell, toRawRecord } from "@/lib/parsers/csv";
import { StatementParser } from "@/lib/parsers/statement-parser";
import { NormalizedTransaction, ParseStatementInput, ParseStatementResult } from "@/lib/parsers/types";

export const AIB_EXPECTED_COLUMNS = [
  "Posted Transactions Date",
  "Description",
  "Debit Amount",
  "Credit Amount",
  "Balance",
  "Transaction Type",
] as const;

export const AIB_ACCOUNT_COLUMNS = ["Posted Account", "Masked Card Number"] as const;

export class AibStatementParser implements StatementParser {
  readonly provider = "aib" as const;

  parse(input: ParseStatementInput): ParseStatementResult {
    const rows = parseCsvRows(input.csvContent);
    if (rows.length === 0) {
      throw new Error("AIB CSV content is empty.");
    }

    const [headerRow, ...dataRows] = rows;
    const headers = headerRow.map((header) => normalizeCell(header));
    const missingColumns = AIB_EXPECTED_COLUMNS.filter((column) => !headers.includes(column));

    if (missingColumns.length > 0) {
      throw new Error(`AIB CSV is missing expected columns: ${missingColumns.join(", ")}`);
    }

    const warnings: string[] = [];
    const accountColumn = AIB_ACCOUNT_COLUMNS.find((column) => headers.includes(column));
    if (!accountColumn) {
      warnings.push(
        `Account identifier column not found. Expected one of: ${AIB_ACCOUNT_COLUMNS.join(", ")}.`
      );
    }

    const headerIndices = indexHeaders(headers);
    const transactions: NormalizedTransaction[] = [];

    dataRows.forEach((row, index) => {
      const rowNumber = index + 2;
      if (row.every((cell) => normalizeCell(cell).length === 0)) {
        return;
      }

      const raw = toRawRecord(headers, row);
      const bookingDateText = readCell(row, headerIndices["Posted Transactions Date"]);
      const bookingDate = parseAibDate(bookingDateText);
      if (!bookingDate) {
        warnings.push(`Row ${rowNumber}: invalid booking date "${bookingDateText}".`);
        return;
      }

      const debitAmountCents = parseAmountToCents(readCell(row, headerIndices["Debit Amount"]));
      const creditAmountCents = parseAmountToCents(readCell(row, headerIndices["Credit Amount"]));
      const direction = resolveDirection(
        debitAmountCents,
        creditAmountCents,
        readCell(row, headerIndices["Transaction Type"])
      );

      if (!direction) {
        if (debitAmountCents === 0 && creditAmountCents === 0) {
          return;
        }

        warnings.push(`Row ${rowNumber}: could not resolve transaction direction from debit/credit/type values.`);
        return;
      }

      const amountCents = direction === "out" ? debitAmountCents : creditAmountCents;
      if (amountCents <= 0) {
        return;
      }

      const accountIdentifier = accountColumn ? readCell(row, headerIndices[accountColumn]) : "";
      const description = readCell(row, headerIndices["Description"]);
      const reference = inferReference(description);

      transactions.push({
        id: buildTransactionId({
          rowNumber,
          accountIdentifier,
          bookingDate,
          amountCents,
          description,
          direction,
        }),
        provider: this.provider,
        bookingDate,
        amountCents,
        currency: "EUR",
        direction,
        description,
        reference,
        raw,
      });
    });

    return {
      provider: this.provider,
      transactions,
      warnings,
    };
  }
}

function resolveDirection(
  debitAmountCents: number,
  creditAmountCents: number,
  transactionTypeRaw: string
): "in" | "out" | null {
  if (debitAmountCents > 0 && creditAmountCents > 0) {
    return null;
  }
  if (debitAmountCents > 0) {
    return "out";
  }
  if (creditAmountCents > 0) {
    return "in";
  }

  const transactionType = transactionTypeRaw.toLowerCase();
  if (transactionType === "debit") {
    return "out";
  }
  if (transactionType === "credit") {
    return "in";
  }

  return null;
}

function parseAibDate(value: string): string | null {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  if (!match) {
    return null;
  }

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const yearToken = match[3];
  const year = yearToken.length === 2 ? 2000 + Number.parseInt(yearToken, 10) : Number.parseInt(yearToken, 10);

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function buildTransactionId(params: {
  rowNumber: number;
  accountIdentifier: string;
  bookingDate: string;
  amountCents: number;
  description: string;
  direction: "in" | "out";
}): string {
  const accountToken = sanitizeToken(params.accountIdentifier, 24);
  const slug = params.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const amountToken = String(params.amountCents);
  return `aib-${accountToken}-${params.rowNumber}-${params.bookingDate}-${params.direction}-${amountToken}-${slug || "txn"}`;
}

function sanitizeToken(value: string, maxLength: number): string {
  const token = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);

  return token || "account";
}

function inferReference(description: string): string | undefined {
  const normalized = description.replace(/\s+/g, "");
  if (/^IE\d{8,}$/i.test(normalized)) {
    return normalized.toUpperCase();
  }
  if (/^\d{8,}$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}
