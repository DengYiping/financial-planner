import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createAccount,
  deleteAccountById,
  getAccountById,
  importTransactionsForAccount,
  isUniqueConstraintError,
  listAccounts,
  type AccountRecord,
} from "@/lib/finance/persistence";
import type { StatementProvider } from "@/lib/parsers/types";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";

const ACCOUNT_KIND_VALUES = [
  "aib_current",
  "aib_mortgage",
  "revolut_current",
  "revolut_credit_card",
] as const;
const ACCOUNT_CURRENCY_VALUES = ["EUR", "USD"] as const;

const accountKindSchema = z.enum(ACCOUNT_KIND_VALUES);
const accountCurrencySchema = z.enum(ACCOUNT_CURRENCY_VALUES);
const statementProviderSchema = z.enum(["aib", "revolut"]);
const accountIdSchema = z.number().int().positive();
const bookingDateRegex = /^\d{4}-\d{2}-\d{2}$/;
const hexColorRegex = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

const normalizedTransactionSchema = z.object({
  id: z.string().trim().min(1).max(160),
  provider: statementProviderSchema,
  bookingDate: z.string().trim().regex(bookingDateRegex, "bookingDate must use YYYY-MM-DD format."),
  amountCents: z.number().int().positive(),
  currency: z.string().trim().min(1).max(16),
  direction: z.enum(["in", "out"]),
  description: z.string().trim().min(1).max(500),
  categoryHint: z.string().trim().min(1).max(120).optional(),
  counterparty: z.string().trim().min(1).max(300).optional(),
  reference: z.string().trim().min(1).max(300).optional(),
  raw: z.record(z.string(), z.string()),
});

const persistedAccountSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  kind: accountKindSchema,
  provider: statementProviderSchema,
  currency: accountCurrencySchema.optional(),
  color: z.string(),
  transactionCount: z.number().int().nonnegative(),
  transactions: z.array(normalizedTransactionSchema),
});

type AccountKind = z.infer<typeof accountKindSchema>;

function expectedProviderForKind(kind: AccountKind): StatementProvider {
  if (kind === "aib_current" || kind === "aib_mortgage") {
    return "aib";
  }

  return "revolut";
}

function toPersistedAccountSnapshot(account: AccountRecord): z.infer<typeof persistedAccountSchema> | null {
  const kindResult = accountKindSchema.safeParse(account.kind);
  if (!kindResult.success) {
    return null;
  }

  const currencyResult = account.currency ? accountCurrencySchema.safeParse(account.currency) : null;
  const currency = currencyResult?.success ? currencyResult.data : undefined;

  return {
    id: account.id,
    name: account.name,
    kind: kindResult.data,
    provider: account.provider,
    currency,
    color: account.color,
    transactionCount: Math.max(account.transactionCount, account.transactions.length),
    transactions: account.transactions,
  };
}

export const accountsRouter = createTRPCRouter({
  list: publicProcedure.output(z.array(persistedAccountSchema)).query(async () => {
    try {
      const accounts = await listAccounts();
      return accounts.flatMap((account) => {
        const normalized = toPersistedAccountSnapshot(account);
        return normalized ? [normalized] : [];
      });
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to load accounts.",
      });
    }
  }),

  create: publicProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(120),
        kind: accountKindSchema,
        provider: statementProviderSchema,
        currency: accountCurrencySchema.nullish(),
        color: z.string().trim().regex(hexColorRegex, "color must be a valid hex color."),
      })
    )
    .output(persistedAccountSchema)
    .mutation(async ({ input }) => {
      const expectedProvider = expectedProviderForKind(input.kind);
      if (input.provider !== expectedProvider) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `provider must be ${expectedProvider} for kind ${input.kind}.`,
        });
      }

      try {
        const account = await createAccount({
          id: input.id,
          name: input.name,
          kind: input.kind,
          provider: input.provider,
          currency: input.currency ?? null,
          color: input.color,
        });

        const normalized = toPersistedAccountSnapshot(account);
        if (!normalized) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Created account has an unsupported shape.",
          });
        }

        return normalized;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "An account with this id already exists.",
          });
        }

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create account.",
        });
      }
    }),

  delete: publicProcedure
    .input(
      z.object({
        accountId: accountIdSchema,
      })
    )
    .output(
      z.object({
        accountId: z.number().int().positive(),
        deleted: z.literal(true),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const deleted = await deleteAccountById(input.accountId);
        if (!deleted) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Account was not found.",
          });
        }

        return {
          accountId: input.accountId,
          deleted: true as const,
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete account.",
        });
      }
    }),

  importTransactions: publicProcedure
    .input(
      z.object({
        accountId: accountIdSchema,
        transactions: z.array(normalizedTransactionSchema),
      })
    )
    .output(
      z.object({
        accountId: z.number().int().positive(),
        totalCount: z.number().int().nonnegative(),
        insertedCount: z.number().int().nonnegative(),
        skippedCount: z.number().int().nonnegative(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const account = await getAccountById(input.accountId);
        if (!account) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Account was not found.",
          });
        }

        for (let index = 0; index < input.transactions.length; index += 1) {
          const transaction = input.transactions[index];
          if (transaction.provider !== account.provider) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                `transactions[${index}].provider (${transaction.provider}) does not match ` +
                `account provider (${account.provider}).`,
            });
          }
        }

        const result = await importTransactionsForAccount(input.accountId, input.transactions);
        return {
          accountId: input.accountId,
          ...result,
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to import transactions.",
        });
      }
    }),
});
