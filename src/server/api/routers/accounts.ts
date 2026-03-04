import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createTransactionForAccount,
  clearTransactionsForAccount,
  createAccount,
  createCategory,
  createTag,
  createTransactionRule,
  deleteCategory,
  deleteAccountById,
  getCategorySpendingTrend,
  deleteTransactionRule,
  deleteTransactionForAccount,
  getDashboardBudgetPlannerView,
  getDashboardSpendingStatsView,
  getDashboardSummaryView,
  getDashboardTransactionsView,
  getAccountById,
  importTransactionsForAccount,
  previewImportTransactionsForAccount,
  isUniqueConstraintError,
  listAccounts,
  listCategories,
  listTags,
  listTransactionRules,
  reapplyTransactionRulesForAllTransactions,
  updateCategory,
  updateTag,
  updateTransactionRule,
  updateTransactionForAccount,
  deleteTag,
  type AccountRecord,
} from "@/lib/finance/persistence";
import {
  accountCurrencySchema,
  accountIdSchema,
  accountKindSchema,
  createAccountInputSchema,
  importTransactionsInputSchema,
  normalizedTransactionSchema,
  statementProviderSchema,
} from "@/lib/finance/request-schemas";
import {
  TransactionRuleValidationError,
  type TransactionRuleWriteInput,
} from "@/lib/finance/rules";
import type { StatementProvider } from "@/lib/parsers/types";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";

const bookingDateRegex = /^\d{4}-\d{2}-\d{2}$/;
const monthKeyRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthKeySchema = z.string().regex(monthKeyRegex);
const categoryNameSchema = z.string().trim().min(1).max(120);
const tagNameSchema = z.string().trim().min(1).max(120);
const tagReferenceSchema = z.object({
  id: accountIdSchema,
  name: tagNameSchema,
});

const importTransactionsResultSchema = z
  .object({
    accountId: z.number().int().positive(),
    totalCount: z.number().int().nonnegative(),
    insertedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
  })
  .passthrough();

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
  selectedStartMonth: monthKeySchema.optional(),
  selectedEndMonth: monthKeySchema.optional(),
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

const budgetPlannerRowSchema = z.object({
  categoryName: z.string(),
  currency: z.string().min(1),
  spentCents: z.number().int().nonnegative(),
  transactionCount: z.number().int().nonnegative(),
});

const tagSpendingRowSchema = z.object({
  tagName: z.string(),
  currency: z.string().min(1),
  spentCents: z.number().int().nonnegative(),
  transactionCount: z.number().int().nonnegative(),
});

const incomeMonthlyRowSchema = z.object({
  month: monthKeySchema,
  currency: z.string().min(1),
  incomeCents: z.number().int().nonnegative(),
  transactionCount: z.number().int().nonnegative(),
});

const budgetPlannerViewSchema = z.object({
  month: monthKeySchema,
  rows: z.array(budgetPlannerRowSchema),
});

const spendingStatsViewSchema = z.object({
  monthOptions: z.array(monthKeySchema),
  selectedMonth: monthKeySchema.optional(),
  rows: z.array(budgetPlannerRowSchema),
  tagRows: z.array(tagSpendingRowSchema),
  incomeRows: z.array(incomeMonthlyRowSchema),
  selectedIncomeCents: z.number().int().nonnegative(),
  selectedIncomeTransactionCount: z.number().int().nonnegative(),
  compareIncomeMonth: monthKeySchema.optional(),
  compareIncomeCents: z.number().int().nonnegative(),
  compareIncomeTransactionCount: z.number().int().nonnegative(),
});

const trendFrequencySchema = z.enum(["day", "week", "month"]);
const categorySpendingTrendPointSchema = z.object({
  period: z.string().trim().min(1),
  spentCents: z.number().int().nonnegative(),
});
const categorySpendingTrendSeriesSchema = z.object({
  categoryName: z.string().trim().min(1),
  points: z.array(categorySpendingTrendPointSchema),
});
const categorySpendingTrendViewSchema = z.object({
  frequency: trendFrequencySchema,
  startDate: z.string().trim().regex(bookingDateRegex, "startDate must use YYYY-MM-DD format."),
  endDate: z.string().trim().regex(bookingDateRegex, "endDate must use YYYY-MM-DD format."),
  periods: z.array(z.string().trim().min(1)),
  series: z.array(categorySpendingTrendSeriesSchema),
});

const transactionRuleSchema = z.object({
  id: z.number().int().positive(),
  descriptionContains: z.string().min(1).max(500).optional(),
  descriptionRegex: z.string().min(1).max(500).optional(),
  amountMinCents: z.number().int().nonnegative().optional(),
  amountMaxCents: z.number().int().nonnegative().optional(),
  amountExactCents: z.number().int().nonnegative().optional(),
  accountIds: z.array(accountIdSchema).min(1).optional(),
  applyCategoryId: accountIdSchema.optional(),
  applyCategoryName: z.string().min(1).max(120).optional(),
  applyTags: z.array(tagReferenceSchema).min(1).optional(),
  applyTagIds: z.array(accountIdSchema).min(1).optional(),
  applyTagNames: z.array(tagNameSchema).min(1).optional(),
  assignCounterpartyFromRegexGroup: z.boolean(),
  priority: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const transactionRuleInputSchema = z
  .object({
    descriptionContains: z.string().trim().max(500).nullish(),
    descriptionRegex: z.string().trim().max(500).nullish(),
    amountMinCents: z.number().int().nonnegative().nullish(),
    amountMaxCents: z.number().int().nonnegative().nullish(),
    amountExactCents: z.number().int().nonnegative().nullish(),
    accountIds: z.array(accountIdSchema).max(500).nullish(),
    applyCategoryId: accountIdSchema.nullish(),
    applyTagIds: z.array(accountIdSchema).max(500).nullish(),
    assignCounterpartyFromRegexGroup: z.boolean().optional(),
    priority: z.number().int(),
  })
  .superRefine((value, ctx) => {
    const descriptionContains = normalizeOptionalText(value.descriptionContains);
    const descriptionRegex = normalizeOptionalText(value.descriptionRegex);
    const hasAccountIdCondition = Array.isArray(value.accountIds) && value.accountIds.length > 0;

    if (descriptionRegex) {
      try {
        // Validate regex syntax at the API boundary.
        new RegExp(descriptionRegex);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["descriptionRegex"],
          message: "descriptionRegex must be a valid regular expression.",
        });
      }
    }

    if (
      typeof value.amountMinCents === "number" &&
      typeof value.amountMaxCents === "number" &&
      value.amountMinCents > value.amountMaxCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountMinCents"],
        message: "amountMinCents must be less than or equal to amountMaxCents.",
      });
    }

    if (
      typeof value.amountExactCents === "number" &&
      typeof value.amountMinCents === "number" &&
      value.amountExactCents < value.amountMinCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountExactCents"],
        message: "amountExactCents must be greater than or equal to amountMinCents.",
      });
    }

    if (
      typeof value.amountExactCents === "number" &&
      typeof value.amountMaxCents === "number" &&
      value.amountExactCents > value.amountMaxCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountExactCents"],
        message: "amountExactCents must be less than or equal to amountMaxCents.",
      });
    }

    if (value.assignCounterpartyFromRegexGroup === true && !descriptionRegex) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assignCounterpartyFromRegexGroup"],
        message: "assignCounterpartyFromRegexGroup requires descriptionRegex.",
      });
    }

    const hasCondition =
      typeof descriptionContains === "string" ||
      typeof descriptionRegex === "string" ||
      typeof value.amountMinCents === "number" ||
      typeof value.amountMaxCents === "number" ||
      typeof value.amountExactCents === "number" ||
      hasAccountIdCondition;

    if (!hasCondition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one condition is required.",
      });
    }

    const hasAction =
      typeof value.applyCategoryId === "number" ||
      (Array.isArray(value.applyTagIds) && value.applyTagIds.length > 0) ||
      value.assignCounterpartyFromRegexGroup === true;
    if (!hasAction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one action is required.",
      });
    }
  });

const categorySchema = z.object({
  id: accountIdSchema,
  name: categoryNameSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const tagSchema = z.object({
  id: accountIdSchema,
  name: tagNameSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

type TransactionRuleInput = z.infer<typeof transactionRuleInputSchema>;
type ImportTransactionsInput = z.infer<typeof importTransactionsInputSchema>;

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toTransactionRuleWriteInput(input: TransactionRuleInput): TransactionRuleWriteInput {
  return {
    descriptionContains: normalizeOptionalText(input.descriptionContains),
    descriptionRegex: normalizeOptionalText(input.descriptionRegex),
    amountMinCents: input.amountMinCents ?? undefined,
    amountMaxCents: input.amountMaxCents ?? undefined,
    amountExactCents: input.amountExactCents ?? undefined,
    accountIds: input.accountIds ?? undefined,
    applyCategoryId: input.applyCategoryId ?? undefined,
    applyTagIds: input.applyTagIds ?? undefined,
    assignCounterpartyFromRegexGroup: input.assignCounterpartyFromRegexGroup ?? false,
    priority: input.priority,
  };
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

function assertTransactionProvidersMatchAccount(
  transactions: ImportTransactionsInput["transactions"],
  accountProvider: StatementProvider
): void {
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = transactions[index];
    if (transaction.provider !== accountProvider) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `transactions[${index}].provider (${transaction.provider}) does not match ` +
          `account provider (${accountProvider}).`,
      });
    }
  }
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
    .input(createAccountInputSchema)
    .output(persistedAccountSchema)
    .mutation(async ({ input }) => {
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

  clearAccount: publicProcedure
    .input(
      z.object({
        accountId: accountIdSchema,
      })
    )
    .output(
      z.object({
        accountId: z.number().int().positive(),
        deletedCount: z.number().int().nonnegative(),
        cleared: z.literal(true),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const cleared = await clearTransactionsForAccount(input.accountId);
        if (!cleared) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Account was not found.",
          });
        }

        return cleared;
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to clear account transactions.",
        });
      }
    }),

  listCategories: publicProcedure.output(z.array(categorySchema)).query(async () => {
    try {
      return await listCategories();
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to load categories.",
      });
    }
  }),

  createCategory: publicProcedure
    .input(
      z.object({
        name: categoryNameSchema,
      })
    )
    .output(categorySchema)
    .mutation(async ({ input }) => {
      try {
        return await createCategory({
          name: input.name,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A category with this name already exists.",
          });
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create category.",
        });
      }
    }),

  updateCategory: publicProcedure
    .input(
      z.object({
        categoryId: accountIdSchema,
        name: categoryNameSchema,
      })
    )
    .output(categorySchema)
    .mutation(async ({ input }) => {
      try {
        const updated = await updateCategory(input.categoryId, {
          name: input.name,
        });

        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Category was not found.",
          });
        }

        return updated;
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        if (isUniqueConstraintError(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A category with this name already exists.",
          });
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update category.",
        });
      }
    }),

  deleteCategory: publicProcedure
    .input(
      z.object({
        categoryId: accountIdSchema,
      })
    )
    .output(
      z.object({
        categoryId: accountIdSchema,
        deleted: z.literal(true),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const deleted = await deleteCategory(input.categoryId);
        if (!deleted) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Category was not found.",
          });
        }

        return {
          categoryId: input.categoryId,
          deleted: true as const,
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete category.",
        });
      }
    }),

  listTags: publicProcedure.output(z.array(tagSchema)).query(async () => {
    try {
      return await listTags();
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to load tags.",
      });
    }
  }),

  createTag: publicProcedure
    .input(
      z.object({
        name: tagNameSchema,
      })
    )
    .output(tagSchema)
    .mutation(async ({ input }) => {
      try {
        return await createTag({
          name: input.name,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A tag with this name already exists.",
          });
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create tag.",
        });
      }
    }),

  updateTag: publicProcedure
    .input(
      z.object({
        tagId: accountIdSchema,
        name: tagNameSchema,
      })
    )
    .output(tagSchema)
    .mutation(async ({ input }) => {
      try {
        const updated = await updateTag(input.tagId, {
          name: input.name,
        });

        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Tag was not found.",
          });
        }

        return updated;
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        if (isUniqueConstraintError(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A tag with this name already exists.",
          });
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update tag.",
        });
      }
    }),

  deleteTag: publicProcedure
    .input(
      z.object({
        tagId: accountIdSchema,
      })
    )
    .output(
      z.object({
        tagId: accountIdSchema,
        deleted: z.literal(true),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const deleted = await deleteTag(input.tagId);
        if (!deleted) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Tag was not found.",
          });
        }

        return {
          tagId: input.tagId,
          deleted: true as const,
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete tag.",
        });
      }
    }),

  listRules: publicProcedure.output(z.array(transactionRuleSchema)).query(async () => {
    try {
      return await listTransactionRules();
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to load transaction rules.",
      });
    }
  }),

  createRule: publicProcedure
    .input(transactionRuleInputSchema)
    .output(transactionRuleSchema)
    .mutation(async ({ input }) => {
      try {
        return await createTransactionRule(toTransactionRuleWriteInput(input));
      } catch (error) {
        if (error instanceof TransactionRuleValidationError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.message,
          });
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create transaction rule.",
        });
      }
    }),

  updateRule: publicProcedure
    .input(
      z.object({
        ruleId: z.number().int().positive(),
        rule: transactionRuleInputSchema,
      })
    )
    .output(transactionRuleSchema)
    .mutation(async ({ input }) => {
      try {
        const updatedRule = await updateTransactionRule(
          input.ruleId,
          toTransactionRuleWriteInput(input.rule)
        );

        if (!updatedRule) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Transaction rule was not found.",
          });
        }

        return updatedRule;
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        if (error instanceof TransactionRuleValidationError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.message,
          });
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update transaction rule.",
        });
      }
    }),

  deleteRule: publicProcedure
    .input(
      z.object({
        ruleId: z.number().int().positive(),
      })
    )
    .output(
      z.object({
        ruleId: z.number().int().positive(),
        deleted: z.literal(true),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const deleted = await deleteTransactionRule(input.ruleId);
        if (!deleted) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Transaction rule was not found.",
          });
        }

        return {
          ruleId: input.ruleId,
          deleted: true as const,
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete transaction rule.",
        });
      }
    }),

  reapplyRules: publicProcedure
    .output(
      z.object({
        totalCount: z.number().int().nonnegative(),
        updatedCount: z.number().int().nonnegative(),
      })
    )
    .mutation(async () => {
      try {
        return await reapplyTransactionRulesForAllTransactions();
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to re-apply transaction rules.",
        });
      }
    }),

  transactionsView: publicProcedure
    .input(
      z.object({
        startMonth: monthKeySchema.optional(),
        endMonth: monthKeySchema.optional(),
      })
    )
    .output(transactionsViewSchema)
    .query(async ({ input }) => {
      try {
        const view = await getDashboardTransactionsView({
          startMonth: input.startMonth,
          endMonth: input.endMonth,
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

  budgetPlannerView: publicProcedure.output(budgetPlannerViewSchema).query(async () => {
    try {
      return await getDashboardBudgetPlannerView();
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to load budget planner data.",
      });
    }
  }),

  spendingStatsView: publicProcedure
    .input(
      z.object({
        month: monthKeySchema.optional(),
      })
    )
    .output(spendingStatsViewSchema)
    .query(async ({ input }) => {
      try {
        return await getDashboardSpendingStatsView({
          month: input.month,
        });
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to load spending statistics.",
        });
      }
    }),

  spendingTrendView: publicProcedure
    .input(
      z.object({
        frequency: trendFrequencySchema,
        startDate: z.string().trim().regex(bookingDateRegex, "startDate must use YYYY-MM-DD format."),
        endDate: z.string().trim().regex(bookingDateRegex, "endDate must use YYYY-MM-DD format."),
      })
    )
    .output(categorySpendingTrendViewSchema)
    .query(async ({ input }) => {
      try {
        return await getCategorySpendingTrend({
          frequency: input.frequency,
          startDate: input.startDate,
          endDate: input.endDate,
        });
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        if (
          error instanceof Error &&
          (error.message.includes("must use YYYY-MM-DD format.") ||
            error.message.includes("must be less than or equal to endDate"))
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.message,
          });
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to load spending trend data.",
        });
      }
    }),

  previewImportTransactions: publicProcedure
    .input(importTransactionsInputSchema)
    .output(
      z
        .object({
          accountId: z.number().int().positive(),
        })
        .passthrough()
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

        assertTransactionProvidersMatchAccount(input.transactions, account.provider);

        const result = await previewImportTransactionsForAccount(input.accountId, input.transactions, {
          forceImportIndexes: input.forceImportIndexes,
        });

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
          message: "Failed to preview import transactions.",
        });
      }
    }),

  importTransactions: publicProcedure
    .input(importTransactionsInputSchema)
    .output(importTransactionsResultSchema)
    .mutation(async ({ input }) => {
      try {
        const account = await getAccountById(input.accountId);
        if (!account) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Account was not found.",
          });
        }

        assertTransactionProvidersMatchAccount(input.transactions, account.provider);

        const result = await importTransactionsForAccount(input.accountId, input.transactions, {
          forceImportIndexes: input.forceImportIndexes,
        });
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
        deemedDate: z.string().trim().regex(bookingDateRegex, "deemedDate must use YYYY-MM-DD format.").nullish(),
        amountCents: z.number().int().positive(),
        currency: z.string().trim().min(1).max(16),
        direction: z.enum(["in", "out"]),
        description: z.string().trim().min(1).max(500),
        categoryId: accountIdSchema.nullish(),
        tagIds: z.array(accountIdSchema).max(500).nullish(),
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
          deemedDate: input.deemedDate ?? undefined,
          amountCents: input.amountCents,
          currency: input.currency,
          direction: input.direction,
          description: input.description,
          categoryId: input.categoryId ?? undefined,
          tagIds: input.tagIds ?? undefined,
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

  createTransaction: publicProcedure
    .input(
      z.object({
        accountId: accountIdSchema,
        bookingDate: z.string().trim().regex(bookingDateRegex, "bookingDate must use YYYY-MM-DD format."),
        deemedDate: z.string().trim().regex(bookingDateRegex, "deemedDate must use YYYY-MM-DD format.").nullish(),
        amountCents: z.number().int().positive(),
        currency: z.string().trim().min(1).max(16),
        direction: z.enum(["in", "out"]),
        description: z.string().trim().min(1).max(500),
        categoryId: accountIdSchema.nullish(),
        tagIds: z.array(accountIdSchema).max(500).nullish(),
        counterparty: z.string().trim().max(300).nullish(),
        reference: z.string().trim().max(300).nullish(),
      })
    )
    .output(
      z.object({
        accountId: accountIdSchema,
        transactionId: z.string().trim().min(1).max(160),
        created: z.literal(true),
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

        const result = await createTransactionForAccount(input.accountId, {
          provider: account.provider,
          bookingDate: input.bookingDate,
          deemedDate: input.deemedDate ?? undefined,
          amountCents: input.amountCents,
          currency: input.currency,
          direction: input.direction,
          description: input.description,
          categoryId: input.categoryId ?? undefined,
          tagIds: input.tagIds ?? undefined,
          counterparty: normalizeOptionalText(input.counterparty),
          reference: normalizeOptionalText(input.reference),
        });

        return {
          accountId: input.accountId,
          transactionId: result.transactionId,
          created: true as const,
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create transaction.",
        });
      }
    }),

  deleteTransaction: publicProcedure
    .input(
      z.object({
        accountId: accountIdSchema,
        transactionId: z.string().trim().min(1).max(160),
      })
    )
    .output(
      z.object({
        accountId: accountIdSchema,
        transactionId: z.string().trim().min(1).max(160),
        deleted: z.literal(true),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const deleted = await deleteTransactionForAccount(input.accountId, input.transactionId);
        if (!deleted) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Transaction was not found for this account.",
          });
        }

        return {
          accountId: input.accountId,
          transactionId: input.transactionId,
          deleted: true as const,
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete transaction.",
        });
      }
    }),
});
