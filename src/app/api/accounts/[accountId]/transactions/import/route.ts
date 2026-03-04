import { NextResponse } from "next/server";
import {
  getAccountById,
  importTransactionsForAccount,
  type AccountRecord,
} from "@/lib/finance/persistence";
import {
  accountIdSchema,
  importTransactionsPayloadSchema,
} from "@/lib/finance/request-schemas";
import { jsonError, readJsonBody } from "@/lib/server/http";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

type ImportPayload = z.infer<typeof importTransactionsPayloadSchema>;

function firstIssueMessage(error: z.ZodError, fallbackMessage: string): string {
  return error.issues[0]?.message ?? fallbackMessage;
}

function validateProviderConsistency(
  account: AccountRecord,
  transactions: ImportPayload["transactions"]
): ValidationResult<ImportPayload["transactions"]> {
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
  const parsedAccountId = Number.parseInt(accountId?.trim() ?? "", 10);
  const normalizedAccountId = accountIdSchema.safeParse(parsedAccountId);

  if (!normalizedAccountId.success) {
    return jsonError(400, "invalid_account_id", "accountId path parameter must be a positive integer.");
  }

  const parsedJson = await readJsonBody(request);
  if (!parsedJson.ok) {
    return jsonError(400, "invalid_json", parsedJson.message);
  }

  const validatedPayload = importTransactionsPayloadSchema.safeParse(parsedJson.value);
  if (!validatedPayload.success) {
    return jsonError(
      400,
      "invalid_request",
      firstIssueMessage(validatedPayload.error, "Body must be a JSON object.")
    );
  }

  try {
    const account = await getAccountById(normalizedAccountId.data);
    if (!account) {
      return jsonError(404, "account_not_found", "Account was not found.");
    }

    const validatedProviders = validateProviderConsistency(account, validatedPayload.data.transactions);
    if (!validatedProviders.ok) {
      return jsonError(400, "provider_mismatch", validatedProviders.message);
    }

    const result = await importTransactionsForAccount(
      normalizedAccountId.data,
      validatedProviders.value,
      {
        forceImportIndexes: validatedPayload.data.forceImportIndexes,
      }
    );
    return NextResponse.json({
      accountId: normalizedAccountId.data,
      ...result,
    });
  } catch {
    return jsonError(500, "transaction_import_failed", "Failed to import transactions.");
  }
}
