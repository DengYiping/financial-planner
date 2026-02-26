import type { TransactionRuleRow } from "@/lib/server/db/schema";

export class TransactionRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionRuleValidationError";
  }
}

export type TransactionRuleWriteInput = {
  descriptionContains?: string | null;
  descriptionRegex?: string | null;
  amountMinCents?: number | null;
  amountMaxCents?: number | null;
  amountExactCents?: number | null;
  accountIds?: number[] | null;
  applyCategoryId?: number | null;
  applyTagIds?: number[] | null;
  assignCounterpartyFromRegexGroup?: boolean | null;
  priority: number;
};

export type ValidatedTransactionRuleWriteInput = {
  descriptionContains?: string;
  descriptionRegex?: string;
  amountMinCents?: number;
  amountMaxCents?: number;
  amountExactCents?: number;
  accountIds?: number[];
  applyCategoryId?: number;
  applyTagIds?: number[];
  assignCounterpartyFromRegexGroup: boolean;
  priority: number;
};

export type TransactionRuleRecord = {
  id: number;
  descriptionContains?: string;
  descriptionRegex?: string;
  amountMinCents?: number;
  amountMaxCents?: number;
  amountExactCents?: number;
  accountIds?: number[];
  applyCategoryId?: number;
  applyCategoryName?: string;
  applyTagIds?: number[];
  applyTagNames?: string[];
  applyTags?: Array<{
    id: number;
    name: string;
  }>;
  assignCounterpartyFromRegexGroup: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
};

export type PreparedTransactionRule = TransactionRuleRecord & {
  compiledDescriptionRegex?: RegExp;
};

export type RuleEvaluationInput = {
  accountId: number;
  description: string;
  amountCents: number;
  categoryId?: number;
  tagIds?: number[];
  counterparty?: string;
};

export type RuleEvaluationResult = {
  categoryId?: number;
  tagIds?: number[];
  counterparty?: string;
};

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalInteger(
  value: number | null | undefined,
  fieldName: string
): number | undefined {
  if (typeof value === "undefined" || value === null) {
    return undefined;
  }

  if (!Number.isInteger(value)) {
    throw new TransactionRuleValidationError(`${fieldName} must be an integer.`);
  }

  if (value < 0) {
    throw new TransactionRuleValidationError(`${fieldName} must be greater than or equal to 0.`);
  }

  return value;
}

function normalizeOptionalPositiveInteger(
  value: number | null | undefined,
  fieldName: string
): number | undefined {
  if (typeof value === "undefined" || value === null) {
    return undefined;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new TransactionRuleValidationError(`${fieldName} must be a positive integer.`);
  }

  return value;
}

function normalizePositiveIntegerSet(
  value: number[] | null | undefined,
  fieldName: string
): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const unique = new Set<number>();
  value.forEach((entry) => {
    if (!Number.isInteger(entry) || entry <= 0) {
      throw new TransactionRuleValidationError(
        `${fieldName} must contain positive integer ${fieldName} values.`
      );
    }

    unique.add(entry);
  });

  const normalized = Array.from(unique.values()).sort((left, right) => left - right);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAccountIds(value: number[] | null | undefined): number[] | undefined {
  return normalizePositiveIntegerSet(value, "accountIds");
}

function normalizeTagIds(value: number[] | null | undefined): number[] | undefined {
  return normalizePositiveIntegerSet(value, "applyTagIds");
}

function compileDescriptionRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    throw new TransactionRuleValidationError("descriptionRegex must be a valid regular expression.");
  }
}

function parsePositiveIntegerSetJson(value: string | null): number[] | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const normalized = parsed
      .filter((entry): entry is number => Number.isInteger(entry) && entry > 0)
      .sort((left, right) => left - right)
      .filter((entry, index, array) => index === 0 || entry !== array[index - 1]);

    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function normalizeInputTagIds(value: number[] | undefined): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  return normalizePositiveIntegerSet(value, "tagIds");
}

export function mapTransactionRuleRow(row: TransactionRuleRow): TransactionRuleRecord {
  return {
    id: row.id,
    descriptionContains: normalizeOptionalText(row.descriptionContains),
    descriptionRegex: normalizeOptionalText(row.descriptionRegex),
    amountMinCents: typeof row.amountMinCents === "number" ? row.amountMinCents : undefined,
    amountMaxCents: typeof row.amountMaxCents === "number" ? row.amountMaxCents : undefined,
    amountExactCents: typeof row.amountExactCents === "number" ? row.amountExactCents : undefined,
    accountIds: parsePositiveIntegerSetJson(row.accountIdsJson),
    applyCategoryId: typeof row.applyCategoryId === "number" ? row.applyCategoryId : undefined,
    assignCounterpartyFromRegexGroup: row.assignCounterpartyFromRegexGroup,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function validateAndNormalizeTransactionRuleInput(
  input: TransactionRuleWriteInput
): ValidatedTransactionRuleWriteInput {
  const descriptionContains = normalizeOptionalText(input.descriptionContains);
  const descriptionRegex = normalizeOptionalText(input.descriptionRegex);
  const amountMinCents = normalizeOptionalInteger(input.amountMinCents, "amountMinCents");
  const amountMaxCents = normalizeOptionalInteger(input.amountMaxCents, "amountMaxCents");
  const amountExactCents = normalizeOptionalInteger(input.amountExactCents, "amountExactCents");
  const accountIds = normalizeAccountIds(input.accountIds);
  const applyCategoryId = normalizeOptionalPositiveInteger(input.applyCategoryId, "applyCategoryId");
  const applyTagIds = normalizeTagIds(input.applyTagIds);
  const assignCounterpartyFromRegexGroup = input.assignCounterpartyFromRegexGroup === true;

  if (!Number.isInteger(input.priority)) {
    throw new TransactionRuleValidationError("priority must be an integer.");
  }

  if (descriptionRegex) {
    compileDescriptionRegex(descriptionRegex);
  }

  if (
    typeof amountMinCents === "number" &&
    typeof amountMaxCents === "number" &&
    amountMinCents > amountMaxCents
  ) {
    throw new TransactionRuleValidationError("amountMinCents must be less than or equal to amountMaxCents.");
  }

  if (
    typeof amountExactCents === "number" &&
    typeof amountMinCents === "number" &&
    amountExactCents < amountMinCents
  ) {
    throw new TransactionRuleValidationError("amountExactCents must be greater than or equal to amountMinCents.");
  }

  if (
    typeof amountExactCents === "number" &&
    typeof amountMaxCents === "number" &&
    amountExactCents > amountMaxCents
  ) {
    throw new TransactionRuleValidationError("amountExactCents must be less than or equal to amountMaxCents.");
  }

  if (assignCounterpartyFromRegexGroup && !descriptionRegex) {
    throw new TransactionRuleValidationError(
      "assignCounterpartyFromRegexGroup requires a descriptionRegex condition."
    );
  }

  const hasCondition =
    typeof descriptionContains === "string" ||
    typeof descriptionRegex === "string" ||
    typeof amountMinCents === "number" ||
    typeof amountMaxCents === "number" ||
    typeof amountExactCents === "number" ||
    (Array.isArray(accountIds) && accountIds.length > 0);

  if (!hasCondition) {
    throw new TransactionRuleValidationError("At least one condition is required.");
  }

  const hasAction =
    typeof applyCategoryId === "number" ||
    (Array.isArray(applyTagIds) && applyTagIds.length > 0) ||
    assignCounterpartyFromRegexGroup;
  if (!hasAction) {
    throw new TransactionRuleValidationError("At least one action is required.");
  }

  return {
    descriptionContains,
    descriptionRegex,
    amountMinCents,
    amountMaxCents,
    amountExactCents,
    accountIds,
    applyCategoryId,
    applyTagIds,
    assignCounterpartyFromRegexGroup,
    priority: input.priority,
  };
}

export function sortTransactionRules(rules: TransactionRuleRecord[]): TransactionRuleRecord[] {
  return [...rules].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return left.id - right.id;
  });
}

export function prepareTransactionRules(rules: TransactionRuleRecord[]): PreparedTransactionRule[] {
  return sortTransactionRules(rules).map((rule) => ({
    ...rule,
    compiledDescriptionRegex: rule.descriptionRegex
      ? compileDescriptionRegex(rule.descriptionRegex)
      : undefined,
  }));
}

function getRegexMatch(regex: RegExp, value: string): RegExpExecArray | null {
  regex.lastIndex = 0;
  return regex.exec(value);
}

type RuleMatchResult = {
  matched: boolean;
  regexMatch?: RegExpExecArray;
};

function ruleMatches(
  rule: PreparedTransactionRule,
  input: Pick<RuleEvaluationInput, "accountId" | "description" | "amountCents">
): RuleMatchResult {
  if (typeof rule.descriptionContains === "string") {
    const description = input.description.toLocaleLowerCase();
    const target = rule.descriptionContains.toLocaleLowerCase();
    if (!description.includes(target)) {
      return {
        matched: false,
      };
    }
  }

  let regexMatch: RegExpExecArray | null = null;
  if (rule.compiledDescriptionRegex) {
    regexMatch = getRegexMatch(rule.compiledDescriptionRegex, input.description);
    if (!regexMatch) {
      return {
        matched: false,
      };
    }
  }

  if (typeof rule.amountMinCents === "number" && input.amountCents < rule.amountMinCents) {
    return {
      matched: false,
    };
  }

  if (typeof rule.amountMaxCents === "number" && input.amountCents > rule.amountMaxCents) {
    return {
      matched: false,
    };
  }

  if (typeof rule.amountExactCents === "number" && input.amountCents !== rule.amountExactCents) {
    return {
      matched: false,
    };
  }

  if (Array.isArray(rule.accountIds) && rule.accountIds.length > 0 && !rule.accountIds.includes(input.accountId)) {
    return {
      matched: false,
    };
  }

  return {
    matched: true,
    ...(regexMatch ? { regexMatch } : {}),
  };
}

export function applyPreparedTransactionRules(
  rules: PreparedTransactionRule[],
  input: RuleEvaluationInput
): RuleEvaluationResult {
  let categoryId = normalizeOptionalPositiveInteger(input.categoryId, "categoryId");
  const tagIdSet = new Set<number>(normalizeInputTagIds(input.tagIds) ?? []);
  let counterparty = normalizeOptionalText(input.counterparty);

  rules.forEach((rule) => {
    const match = ruleMatches(rule, {
      accountId: input.accountId,
      description: input.description,
      amountCents: input.amountCents,
    });

    if (!match.matched) {
      return;
    }

    if (typeof rule.applyCategoryId === "number") {
      categoryId = rule.applyCategoryId;
    }

    if (Array.isArray(rule.applyTagIds)) {
      rule.applyTagIds.forEach((tagId) => {
        tagIdSet.add(tagId);
      });
    }

    if (
      rule.assignCounterpartyFromRegexGroup &&
      match.regexMatch &&
      typeof match.regexMatch[1] === "string"
    ) {
      const extractedCounterparty = normalizeOptionalText(match.regexMatch[1]);
      if (extractedCounterparty) {
        counterparty = extractedCounterparty;
      }
    }
  });

  return {
    categoryId,
    tagIds: tagIdSet.size > 0 ? Array.from(tagIdSet.values()).sort((left, right) => left - right) : undefined,
    counterparty,
  };
}
