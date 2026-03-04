import { NextResponse } from "next/server";
import {
  createAccount,
  isUniqueConstraintError,
  listAccounts,
} from "@/lib/finance/persistence";
import { createAccountInputSchema } from "@/lib/finance/request-schemas";
import { jsonError, readJsonBody } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const validated = createAccountInputSchema.safeParse(parsedJson.value);
  if (!validated.success) {
    return jsonError(400, "invalid_request", validated.error.issues[0]?.message ?? "Invalid request body.");
  }

  try {
    const account = await createAccount({
      id: validated.data.id,
      name: validated.data.name,
      kind: validated.data.kind,
      provider: validated.data.provider,
      currency: validated.data.currency ?? null,
      color: validated.data.color,
    });
    return NextResponse.json({ account }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return jsonError(409, "account_conflict", "An account with this id already exists.");
    }

    return jsonError(500, "account_create_failed", "Failed to create account.");
  }
}
