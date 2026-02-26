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

      const debitAmount = parseAmount(readCell(row, headerIndices["Debit Amount"]));
      const creditAmount = parseAmount(readCell(row, headerIndices["Credit Amount"]));
      const direction = resolveDirection(
        debitAmount,
        creditAmount,
        readCell(row, headerIndices["Transaction Type"])
      );

      if (!direction) {
        if (debitAmount === 0 && creditAmount === 0) {
          return;
        }

        warnings.push(`Row ${rowNumber}: could not resolve transaction direction from debit/credit/type values.`);
        return;
      }

      const amount = direction === "out" ? debitAmount : creditAmount;
      if (amount <= 0) {
        return;
      }

      const accountIdentifier = accountColumn ? readCell(row, headerIndices[accountColumn]) : "";
      const description = readCell(row, headerIndices["Description"]);
      const reference = inferReference(description);
      const counterparty = reference ? undefined : description;

      transactions.push({
        id: buildTransactionId({
          rowNumber,
          accountIdentifier,
          bookingDate,
          amount,
          description,
          direction,
        }),
        provider: this.provider,
        bookingDate,
        amount,
        currency: "EUR",
        direction,
        description,
        categoryHint: inferCategoryHint(description),
        counterparty,
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

function parseCsvRows(csvContent: string): string[][] {
  const sanitized = csvContent.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let currentCell = "";
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < sanitized.length; i += 1) {
    const char = sanitized[i];

    if (char === '"') {
      const nextChar = sanitized[i + 1];
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && sanitized[i + 1] === "\n") {
        i += 1;
      }
      currentRow.push(currentCell);
      if (!isBlankRow(currentRow)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    if (!isBlankRow(currentRow)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function isBlankRow(row: string[]): boolean {
  return row.every((cell) => normalizeCell(cell).length === 0);
}

function indexHeaders(headers: string[]): Record<string, number> {
  const index: Record<string, number> = {};
  headers.forEach((header, headerIndex) => {
    index[header] = headerIndex;
  });
  return index;
}

function toRawRecord(headers: string[], row: string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  headers.forEach((header, index) => {
    raw[header] = readCell(row, index);
  });
  return raw;
}

function readCell(row: string[], index: number | undefined): string {
  if (index === undefined || index < 0) {
    return "";
  }

  return normalizeCell(row[index] ?? "");
}

function normalizeCell(value: string): string {
  return value.trim();
}

function parseAmount(value: string): number {
  if (!value) {
    return 0;
  }

  const normalized = value.replace(/[,\s]/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveDirection(
  debitAmount: number,
  creditAmount: number,
  transactionTypeRaw: string
): "in" | "out" | null {
  if (debitAmount > 0 && creditAmount > 0) {
    return null;
  }
  if (debitAmount > 0) {
    return "out";
  }
  if (creditAmount > 0) {
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
  amount: number;
  description: string;
  direction: "in" | "out";
}): string {
  const accountToken = sanitizeToken(params.accountIdentifier, 24);
  const slug = params.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const amountToken = params.amount.toFixed(2).replace(".", "_");
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

function inferCategoryHint(description: string): string | undefined {
  const normalized = description.toUpperCase();
  if (normalized.includes("MORTGAGE") || normalized.includes("HOME LOAN")) {
    return "housing";
  }
  if (normalized.includes("ASSURANCE") || normalized.includes("INSURANCE")) {
    return "insurance";
  }
  if (normalized.includes("REVOLUT") || normalized.includes("TOP-UP")) {
    return "transfer";
  }
  if (normalized.includes("FEE") || normalized.includes("STAMP DUTY")) {
    return "fees";
  }
  if (normalized.includes("INTEREST")) {
    return "interest";
  }
  return undefined;
}
