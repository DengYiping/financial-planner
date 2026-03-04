import { z } from "zod";

export const ACCOUNT_KIND_VALUES = [
  "aib_current",
  "aib_mortgage",
  "revolut_current",
  "revolut_credit_card",
] as const;
export const ACCOUNT_CURRENCY_VALUES = ["EUR", "USD"] as const;

const BOOKING_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

export const accountKindSchema = z.enum(ACCOUNT_KIND_VALUES);
export const accountCurrencySchema = z.enum(ACCOUNT_CURRENCY_VALUES);
export const statementProviderSchema = z.enum(["aib", "revolut"]);
export const accountIdSchema = z.number().int().positive();

const tagNameSchema = z.string().trim().min(1).max(120);
const tagReferenceSchema = z.object({
  id: accountIdSchema,
  name: tagNameSchema,
});

export const normalizedTransactionSchema = z.object({
  id: z.string().trim().min(1).max(160),
  provider: statementProviderSchema,
  bookingDate: z.string().trim().regex(BOOKING_DATE_REGEX, "bookingDate must use YYYY-MM-DD format."),
  deemedDate: z.string().trim().regex(BOOKING_DATE_REGEX, "deemedDate must use YYYY-MM-DD format.").optional(),
  amountCents: z.number().int().positive(),
  currency: z.string().trim().min(1).max(16),
  direction: z.enum(["in", "out"]),
  description: z.string().trim().min(1).max(500),
  categoryId: accountIdSchema.optional(),
  categoryHint: z.string().trim().min(1).max(120).optional(),
  tags: z.array(tagReferenceSchema).max(500).optional(),
  tagIds: z.array(accountIdSchema).max(500).optional(),
  tagHints: z.array(tagNameSchema).max(500).optional(),
  counterparty: z.string().trim().min(1).max(300).optional(),
  reference: z.string().trim().min(1).max(300).optional(),
  raw: z.record(z.string(), z.string()),
});

const importTransactionsPayloadBaseSchema = z.object({
  transactions: z.array(normalizedTransactionSchema),
  forceImportIndexes: z.array(z.number().int().nonnegative()).optional(),
});

export const importTransactionsPayloadSchema = importTransactionsPayloadBaseSchema.superRefine((value, ctx) => {
  if (!value.forceImportIndexes) {
    return;
  }

  const seenIndexes = new Set<number>();
  for (let index = 0; index < value.forceImportIndexes.length; index += 1) {
    const forceImportIndex = value.forceImportIndexes[index];
    if (seenIndexes.has(forceImportIndex)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forceImportIndexes", index],
        message: `forceImportIndexes[${index}] must be unique.`,
      });
    } else {
      seenIndexes.add(forceImportIndex);
    }

    if (forceImportIndex >= value.transactions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forceImportIndexes", index],
        message: `forceImportIndexes[${index}] must be less than transactions.length (${value.transactions.length}).`,
      });
    }
  }
});

export const importTransactionsInputSchema = importTransactionsPayloadSchema.extend({
  accountId: accountIdSchema,
});

type AccountKind = z.infer<typeof accountKindSchema>;
type StatementProvider = z.infer<typeof statementProviderSchema>;

function expectedProviderForKind(kind: AccountKind): StatementProvider {
  if (kind === "aib_current" || kind === "aib_mortgage") {
    return "aib";
  }

  return "revolut";
}

export const createAccountInputSchema = z
  .object({
    id: accountIdSchema.optional(),
    name: z.string().trim().min(1).max(120),
    kind: accountKindSchema,
    provider: statementProviderSchema,
    currency: accountCurrencySchema.nullish(),
    color: z.string().trim().regex(HEX_COLOR_REGEX, "color must be a valid hex color."),
  })
  .superRefine((value, ctx) => {
    const expectedProvider = expectedProviderForKind(value.kind);
    if (value.provider !== expectedProvider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: `provider must be ${expectedProvider} for kind ${value.kind}.`,
      });
    }
  });
