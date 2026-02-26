import { NextResponse } from "next/server";
import {
  createAccount,
  isUniqueConstraintError,
  listAccounts,
  type CreateAccountInput,
} from "@/lib/finance/persistence";
import { isRecord, jsonError, readJsonBody } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = new Set(["aib", "revolut"]);
const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      message: string;
    };

function normalizeRequiredString(value: unknown, fieldName: string, maxLength = 120): ValidationResult<string> {
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

function normalizeOptionalString(
  value: unknown,
  fieldName: string,
  maxLength = 120
): ValidationResult<string | null> {
  if (value === null || typeof value === "undefined") {
    return { ok: true, value: null };
  }

  if (typeof value !== "string") {
    return { ok: false, message: `${fieldName} must be a string when provided.` };
  }

  const normalized = value.trim();
  if (!normalized) {
    return { ok: true, value: null };
  }

  if (normalized.length > maxLength) {
    return { ok: false, message: `${fieldName} cannot exceed ${maxLength} characters.` };
  }

  return { ok: true, value: normalized };
}

function normalizeOptionalPositiveInteger(value: unknown, fieldName: string): ValidationResult<number | undefined> {
  if (value === null || typeof value === "undefined") {
    return { ok: true, value: undefined };
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      return { ok: false, message: `${fieldName} must be a positive integer when provided.` };
    }

    return { ok: true, value };
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return { ok: true, value: undefined };
    }

    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, message: `${fieldName} must be a positive integer when provided.` };
    }

    return { ok: true, value: parsed };
  }

  return { ok: false, message: `${fieldName} must be a positive integer when provided.` };
}

function validateCreateAccountPayload(payload: unknown): ValidationResult<CreateAccountInput> {
  if (!isRecord(payload)) {
    return { ok: false, message: "Body must be a JSON object." };
  }

  const id = normalizeOptionalPositiveInteger(payload.id, "id");
  if (!id.ok) {
    return id;
  }

  const name = normalizeRequiredString(payload.name, "name");
  if (!name.ok) {
    return name;
  }

  const kind = normalizeRequiredString(payload.kind, "kind", 80);
  if (!kind.ok) {
    return kind;
  }

  const provider = normalizeRequiredString(payload.provider, "provider", 24);
  if (!provider.ok) {
    return provider;
  }

  if (!VALID_PROVIDERS.has(provider.value)) {
    return { ok: false, message: "provider must be one of: aib, revolut." };
  }

  const currency = normalizeOptionalString(payload.currency, "currency", 16);
  if (!currency.ok) {
    return currency;
  }

  const color = normalizeRequiredString(payload.color, "color", 16);
  if (!color.ok) {
    return color;
  }

  if (!HEX_COLOR_REGEX.test(color.value)) {
    return { ok: false, message: "color must be a valid hex color (for example #0673A6)." };
  }

  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      kind: kind.value,
      provider: provider.value as CreateAccountInput["provider"],
      currency: currency.value,
      color: color.value,
    },
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const accounts = await listAccounts();
    return NextResponse.json({ accounts });
  } catch {
    return jsonError(500, "accounts_list_failed", "Failed to load accounts.");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const parsedJson = await readJsonBody(request);
  if (!parsedJson.ok) {
    return jsonError(400, "invalid_json", parsedJson.message);
  }

  const validated = validateCreateAccountPayload(parsedJson.value);
  if (!validated.ok) {
    return jsonError(400, "invalid_request", validated.message);
  }

  try {
    const account = await createAccount(validated.value);
    return NextResponse.json({ account }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return jsonError(409, "account_conflict", "An account with this id already exists.");
    }

    return jsonError(500, "account_create_failed", "Failed to create account.");
  }
}
