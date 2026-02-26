import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createAccount,
  deleteAccountById,
  getDashboardSummaryView,
  getDashboardTransactionsView,
  getAccountById,
  importTransactionsForAccount,
  isUniqueConstraintError,
  listAccounts,
  updateTransactionForAccount,
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
const monthKeyRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
const hexColorRegex = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
const transactionTabSchema = z.enum(["recent", "aggregated"]);
const monthKeySchema = z.string().regex(monthKeyRegex);
const monthFilterSchema = z.union([z.literal("all"), monthKeySchema]);

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

const transactionsViewRowSchema = z.object({
  accountId: z.number().int().positive(),
  accountName: z.string(),
  accountColor: z.string(),
  transaction: normalizedTransactionSchema,
});

const transactionsViewSchema = z.object({
  monthOptions: z.array(monthKeySchema),
  selectedMonth: monthFilterSchema,
  importedTransactionCount: z.number().int().nonnegative(),
  transactions: z.array(transactionsViewRowSchema),
});

const summaryRowSchema = z.object({
  accountId: z.number().int().positive(),
  accountName: z.string(),
  accountKind: accountKindSchema,
  accountCurrency: accountCurrencySchema.optional(),
  accountColor: z.string(),
  currency: z.string(),
  transactionCount: z.number().int().nonnegative(),
  inflowCents: z.number().int().nonnegative(),
  outflowCents: z.number().int().nonnegative(),
  netCents: z.number().int(),
});

const summaryViewSchema = z.object({
  monthOptions: z.array(monthKeySchema),
  selectedMonth: monthKeySchema.optional(),
  accountCount: z.number().int().nonnegative(),
  importedTransactionCount: z.number().int().nonnegative(),
  rows: z.array(summaryRowSchema),
});

type AccountKind = z.infer<typeof accountKindSchema>;

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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

  transactionsView: publicProcedure
    .input(
      z.object({
        month: monthFilterSchema.optional().default("all"),
        transactionTab: transactionTabSchema.optional().default("recent"),
      })
    )
    .output(transactionsViewSchema)
    .query(async ({ input }) => {
      try {
        const view = await getDashboardTransactionsView({
          month: input.month,
          transactionTab: input.transactionTab,
        });

        return view;
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to load filtered transactions.",
        });
      }
    }),

  summaryView: publicProcedure
    .input(
      z.object({
        month: monthKeySchema.optional(),
      })
    )
    .output(summaryViewSchema)
    .query(async ({ input }) => {
      try {
        const summary = await getDashboardSummaryView({
          month: input.month,
        });

        const rows = summary.rows.flatMap((row) => {
          const kindResult = accountKindSchema.safeParse(row.accountKind);
          if (!kindResult.success) {
            return [];
          }

          const accountCurrencyResult = row.accountCurrency
            ? accountCurrencySchema.safeParse(row.accountCurrency)
            : null;

          return [
            {
              accountId: row.accountId,
              accountName: row.accountName,
              accountKind: kindResult.data,
              accountCurrency: accountCurrencyResult?.success ? accountCurrencyResult.data : undefined,
              accountColor: row.accountColor,
              currency: row.currency,
              transactionCount: row.transactionCount,
              inflowCents: row.inflowCents,
              outflowCents: row.outflowCents,
              netCents: row.netCents,
            },
          ];
        });

        return {
          monthOptions: summary.monthOptions,
          selectedMonth: summary.selectedMonth,
          accountCount: summary.accountCount,
          importedTransactionCount: summary.importedTransactionCount,
          rows,
        };
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to load account summary view.",
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

  updateTransaction: publicProcedure
    .input(
      z.object({
        accountId: accountIdSchema,
        transactionId: z.string().trim().min(1).max(160),
        bookingDate: z.string().trim().regex(bookingDateRegex, "bookingDate must use YYYY-MM-DD format."),
        amountCents: z.number().int().positive(),
        currency: z.string().trim().min(1).max(16),
        direction: z.enum(["in", "out"]),
        description: z.string().trim().min(1).max(500),
        categoryHint: z.string().trim().max(120).nullish(),
        counterparty: z.string().trim().max(300).nullish(),
        reference: z.string().trim().max(300).nullish(),
      })
    )
    .output(
      z.object({
        accountId: accountIdSchema,
        transactionId: z.string().trim().min(1).max(160),
        updated: z.literal(true),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const updated = await updateTransactionForAccount(input.accountId, input.transactionId, {
          bookingDate: input.bookingDate,
          amountCents: input.amountCents,
          currency: input.currency,
          direction: input.direction,
          description: input.description,
          categoryHint: normalizeOptionalText(input.categoryHint),
          counterparty: normalizeOptionalText(input.counterparty),
          reference: normalizeOptionalText(input.reference),
        });

        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Transaction was not found for this account.",
          });
        }

        return {
          accountId: input.accountId,
          transactionId: input.transactionId,
          updated: true as const,
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update transaction.",
        });
      }
    }),
});
