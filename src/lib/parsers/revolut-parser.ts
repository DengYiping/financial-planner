import { parseAmountToCents } from "@/lib/parsers/amount";
import { StatementParser } from "@/lib/parsers/statement-parser";
import { NormalizedTransaction, ParseStatementInput, ParseStatementResult } from "@/lib/parsers/types";

export const REVOLUT_EXPECTED_COLUMNS = [
  "Type",
  "Started Date",
  "Completed Date",
  "Description",
  "Amount",
  "Fee",
  "Balance",
] as const;

export const REVOLUT_OPTIONAL_COLUMNS = [
  "Product",
  "Currency",
  "State",
] as const;

export class RevolutStatementParser implements StatementParser {
  readonly provider = "revolut" as const;

  parse(input: ParseStatementInput): ParseStatementResult {
    const rows = parseCsvRows(input.csvContent);
    if (rows.length === 0) {
      throw new Error("Revolut CSV content is empty.");
    }

    const [headerRow, ...dataRows] = rows;
    const headers = headerRow.map((header) => normalizeCell(header));
    const missingColumns = REVOLUT_EXPECTED_COLUMNS.filter((column) => !headers.includes(column));
    if (missingColumns.length > 0) {
      throw new Error(`Revolut CSV is missing expected columns: ${missingColumns.join(", ")}`);
    }

    const headerIndices = indexHeaders(headers);
    const warnings: string[] = [];
    const transactions: NormalizedTransaction[] = [];

    dataRows.forEach((row, index) => {
      const rowNumber = index + 2;
      if (row.every((cell) => normalizeCell(cell).length === 0)) {
        return;
      }

      const raw = toRawRecord(headers, row);
      const completedDate = readCell(row, headerIndices["Completed Date"]);
      const startedDate = readCell(row, headerIndices["Started Date"]);
      const bookingDate = parseRevolutDate(completedDate) ?? parseRevolutDate(startedDate);

      if (!bookingDate) {
        warnings.push(
          `Row ${rowNumber}: invalid completed/started date "${completedDate}" / "${startedDate}".`
        );
        return;
      }

      const amountValueCents = parseAmountToCents(readCell(row, headerIndices["Amount"]));
      const feeValueCents = parseAmountToCents(readCell(row, headerIndices["Fee"]));
      const netSignedAmountCents = resolveNetSignedAmountCents(amountValueCents, feeValueCents);

      if (netSignedAmountCents === 0) {
        return;
      }

      const direction = netSignedAmountCents > 0 ? "in" : "out";
      const currencyColumnIndex = headerIndices["Currency"];
      const currencyCell = readCell(row, currencyColumnIndex);
      const currency = currencyCell || inferFallbackCurrency(input.fileName);

      const description = readCell(row, headerIndices["Description"]);
      const type = readCell(row, headerIndices["Type"]);
      const amountCents = Math.abs(netSignedAmountCents);

      transactions.push({
        id: buildTransactionId({
          rowNumber,
          bookingDate,
          description,
          amountCents,
          direction,
          currency,
          type,
          product: readCell(row, headerIndices["Product"]),
        }),
        provider: this.provider,
        bookingDate,
        amountCents,
        currency,
        direction,
        description,
        reference: inferReference(description),
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

function parseRevolutDate(value: string): string | null {
  if (!value) {
    return null;
  }

  const datePart = value.split(" ")[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return null;
  }

  const [yearText, monthText, dayText] = datePart.split("-");
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);

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

function resolveNetSignedAmountCents(amountValueCents: number, feeValueCents: number): number {
  const normalizedFeeCents = Math.abs(feeValueCents);
  return amountValueCents - normalizedFeeCents;
}

function inferFallbackCurrency(fileName?: string): string {
  const normalizedName = (fileName ?? "").toLowerCase();
  if (normalizedName.includes("dollar") || normalizedName.includes("usd")) {
    return "USD";
  }

  return "EUR";
}

function buildTransactionId(params: {
  rowNumber: number;
  bookingDate: string;
  description: string;
  amountCents: number;
  direction: "in" | "out";
  currency: string;
  type: string;
  product: string;
}): string {
  const typeToken = sanitizeToken(params.type, 16);
  const productToken = sanitizeToken(params.product, 16);
  const descriptionToken = sanitizeToken(params.description, 28);
  const currencyToken = sanitizeToken(params.currency, 8);
  const amountToken = String(params.amountCents);

  return `revolut-${params.bookingDate}-${params.rowNumber}-${typeToken}-${productToken}-${params.direction}-${amountToken}-${currencyToken}-${descriptionToken}`;
}

function sanitizeToken(value: string, maxLength: number): string {
  const token = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);

  return token || "na";
}

function inferReference(description: string): string | undefined {
  const normalized = description.replace(/\s+/g, "");
  if (/^[-A-Za-z0-9*]{10,}$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}
