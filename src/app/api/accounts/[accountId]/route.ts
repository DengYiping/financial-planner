import { NextResponse } from "next/server";
import { deleteAccountById } from "@/lib/finance/persistence";
import { jsonError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ accountId: string }> | { accountId: string };
};

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { accountId } = await context.params;
  const normalizedAccountId = Number.parseInt(accountId?.trim() ?? "", 10);

  if (!Number.isInteger(normalizedAccountId) || normalizedAccountId <= 0) {
    return jsonError(400, "invalid_account_id", "accountId path parameter must be a positive integer.");
  }

  try {
    const deleted = await deleteAccountById(normalizedAccountId);
    if (!deleted) {
      return jsonError(404, "account_not_found", "Account was not found.");
    }

    return NextResponse.json({ accountId: normalizedAccountId, deleted: true });
  } catch {
    return jsonError(500, "account_delete_failed", "Failed to delete account.");
  }
}
