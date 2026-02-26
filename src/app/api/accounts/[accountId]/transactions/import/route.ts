import { NextResponse } from "next/server";
import {
  getAccountById,
  importTransactionsForAccount,
  type AccountRecord,
} from "@/lib/finance/persistence";
import type { NormalizedTransaction, StatementProvider } from "@/lib/parsers/types";
import { isRecord, jsonError, readJsonBody } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = new Set<StatementProvider>(["aib", "revolut"]);
const VALID_DIRECTIONS = new Set(["in", "out"]);
const BOOKING_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

type RouteContext = {
  params: Promise<{ accountId: string }> | { accountId: string };
};

type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      message: string;
    };

function parseRequiredString(value: unknown, fieldName: string, maxLength = 300): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, message: `${fieldName} must be a string.` };
  }

  const normalized = value.trim();
  if (!normalized) {
    return { ok: false, message: `${fieldName} is required.` };
  }

  if (normalized.length > maxLength) {
    return { ok: false, message: `${fieldName} cannot exceed ${maxLength} characters.` };
  }

  return { ok: true, value: normalized };
}

function parseOptionalString(value: unknown, fieldName: string, maxLength = 300): ValidationResult<string | undefined> {
  if (typeof value === "undefined" || value === null) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== "string") {
    return { ok: false, message: `${fieldName} must be a string when provided.` };
  }

  const normalized = value.trim();
  if (!normalized) {
    return { ok: true, value: undefined };
  }

  if (normalized.length > maxLength) {
    return { ok: false, message: `${fieldName} cannot exceed ${maxLength} characters.` };
  }

  return { ok: true, value: normalized };
}

function parseRawFields(value: unknown, fieldName: string): ValidationResult<Record<string, string>> {
  if (!isRecord(value)) {
    return { ok: false, message: `${fieldName} must be an object map of string values.` };
  }

  const output: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      return { ok: false, message: `${fieldName}.${key} must be a string.` };
    }

    output[key] = entryValue;
  }

  return { ok: true, value: output };
}

function parseTransaction(value: unknown, index: number): ValidationResult<NormalizedTransaction> {
  if (!isRecord(value)) {
    return { ok: false, message: `transactions[${index}] must be an object.` };
  }

  const id = parseRequiredString(value.id, `transactions[${index}].id`, 160);
  if (!id.ok) {
    return id;
  }

  const provider = parseRequiredString(value.provider, `transactions[${index}].provider`, 24);
  if (!provider.ok) {
    return provider;
  }
  if (!VALID_PROVIDERS.has(provider.value as StatementProvider)) {
    return { ok: false, message: `transactions[${index}].provider must be one of: aib, revolut.` };
  }

  const bookingDate = parseRequiredString(value.bookingDate, `transactions[${index}].bookingDate`, 24);
  if (!bookingDate.ok) {
    return bookingDate;
  }
  if (!BOOKING_DATE_REGEX.test(bookingDate.value)) {
    return { ok: false, message: `transactions[${index}].bookingDate must use YYYY-MM-DD format.` };
  }

  if (
    typeof value.amountCents !== "number" ||
    !Number.isInteger(value.amountCents) ||
    value.amountCents <= 0
  ) {
    return { ok: false, message: `transactions[${index}].amountCents must be a positive integer.` };
  }

  const currency = parseRequiredString(value.currency, `transactions[${index}].currency`, 16);
  if (!currency.ok) {
    return currency;
  }

  const direction = parseRequiredString(value.direction, `transactions[${index}].direction`, 8);
  if (!direction.ok) {
    return direction;
  }
  if (!VALID_DIRECTIONS.has(direction.value)) {
    return { ok: false, message: `transactions[${index}].direction must be one of: in, out.` };
  }

  const description = parseRequiredString(value.description, `transactions[${index}].description`, 500);
  if (!description.ok) {
    return description;
  }

  const categoryHint = parseOptionalString(value.categoryHint, `transactions[${index}].categoryHint`, 120);
  if (!categoryHint.ok) {
    return categoryHint;
  }

  const counterparty = parseOptionalString(value.counterparty, `transactions[${index}].counterparty`, 300);
  if (!counterparty.ok) {
    return counterparty;
  }

  const reference = parseOptionalString(value.reference, `transactions[${index}].reference`, 300);
  if (!reference.ok) {
    return reference;
  }

  const raw = parseRawFields(value.raw, `transactions[${index}].raw`);
  if (!raw.ok) {
    return raw;
  }

  return {
    ok: true,
    value: {
      id: id.value,
      provider: provider.value as StatementProvider,
      bookingDate: bookingDate.value,
      amountCents: value.amountCents,
      currency: currency.value,
      direction: direction.value as NormalizedTransaction["direction"],
      description: description.value,
      categoryHint: categoryHint.value,
      counterparty: counterparty.value,
      reference: reference.value,
      raw: raw.value,
    },
  };
}

function validateImportPayload(payload: unknown): ValidationResult<NormalizedTransaction[]> {
  if (!isRecord(payload)) {
    return { ok: false, message: "Body must be a JSON object." };
  }

  if (!Array.isArray(payload.transactions)) {
    return { ok: false, message: "transactions must be an array." };
  }

  const transactions: NormalizedTransaction[] = [];
  for (let index = 0; index < payload.transactions.length; index += 1) {
    const parsed = parseTransaction(payload.transactions[index], index);
    if (!parsed.ok) {
      return parsed;
    }

    transactions.push(parsed.value);
  }

  return { ok: true, value: transactions };
}

function validateProviderConsistency(
  account: AccountRecord,
  transactions: NormalizedTransaction[]
): ValidationResult<NormalizedTransaction[]> {
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = transactions[index];
    if (transaction.provider !== account.provider) {
      return {
        ok: false,
        message:
          `transactions[${index}].provider (${transaction.provider}) does not match ` +
          `account provider (${account.provider}).`,
      };
    }
  }

  return { ok: true, value: transactions };
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const { accountId } = await context.params;
  const normalizedAccountId = Number.parseInt(accountId?.trim() ?? "", 10);

  if (!Number.isInteger(normalizedAccountId) || normalizedAccountId <= 0) {
    return jsonError(400, "invalid_account_id", "accountId path parameter must be a positive integer.");
  }

  const parsedJson = await readJsonBody(request);
  if (!parsedJson.ok) {
    return jsonError(400, "invalid_json", parsedJson.message);
  }

  const validatedPayload = validateImportPayload(parsedJson.value);
  if (!validatedPayload.ok) {
    return jsonError(400, "invalid_request", validatedPayload.message);
  }

  try {
    const account = await getAccountById(normalizedAccountId);
    if (!account) {
      return jsonError(404, "account_not_found", "Account was not found.");
    }

    const validatedProviders = validateProviderConsistency(account, validatedPayload.value);
    if (!validatedProviders.ok) {
      return jsonError(400, "provider_mismatch", validatedProviders.message);
    }

    const result = await importTransactionsForAccount(normalizedAccountId, validatedProviders.value);
    return NextResponse.json({
      accountId: normalizedAccountId,
      ...result,
    });
  } catch {
    return jsonError(500, "transaction_import_failed", "Failed to import transactions.");
  }
}
