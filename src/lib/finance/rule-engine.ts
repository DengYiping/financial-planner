export type RuleEngineTransaction = {
  accountId: string | number;
  description: string;
  amountCents: number;
  categoryHint?: string;
  counterparty?: string;
  [key: string]: unknown;
};

export type RuleCondition = Record<string, unknown>;
export type RuleAction = Record<string, unknown>;

export type RuleDefinition = {
  id?: string | number;
  priority?: number;
  conditions?: RuleCondition[];
  actions?: RuleAction[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function asConditionType(condition: RuleCondition): string {
  const candidate =
    asString(condition.kind) ??
    asString(condition.type) ??
    asString(condition.operator) ??
    "";

  return candidate.toLocaleLowerCase();
}

function asActionType(action: RuleAction): string {
  const candidate = asString(action.kind) ?? asString(action.type) ?? asString(action.action) ?? "";
  return candidate.toLocaleLowerCase();
}

function getRegex(pattern: string, flags?: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function getAccountIdValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === "string" && entry.length > 0) {
        return entry;
      }

      if (typeof entry === "number" && Number.isFinite(entry)) {
        return String(entry);
      }

      return undefined;
    })
    .filter((entry): entry is string => typeof entry === "string");
}

export function matchCondition(transaction: RuleEngineTransaction, condition: RuleCondition): boolean {
  const normalizedCondition = asObject(condition);
  if (!normalizedCondition) {
    return false;
  }

  const conditionType = asConditionType(normalizedCondition);

  if (conditionType === "description_contains" || conditionType === "contains") {
    const needle =
      asString(normalizedCondition.value) ??
      asString(normalizedCondition.needle) ??
      asString(normalizedCondition.text);
    if (!needle) {
      return false;
    }

    return transaction.description.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
  }

  if (conditionType === "description_regex" || conditionType === "regex") {
    const pattern =
      asString(normalizedCondition.pattern) ??
      asString(normalizedCondition.regex) ??
      asString(normalizedCondition.value);
    if (!pattern) {
      return false;
    }

    const flags = asString(normalizedCondition.flags) ?? "";
    const regex = getRegex(pattern, flags);
    if (!regex) {
      return false;
    }

    regex.lastIndex = 0;
    return regex.test(transaction.description);
  }

  if (conditionType === "amount_range" || conditionType === "range") {
    const min =
      asNumber(normalizedCondition.minCents) ??
      asNumber(normalizedCondition.minAmountCents) ??
      asNumber(normalizedCondition.min);
    const max =
      asNumber(normalizedCondition.maxCents) ??
      asNumber(normalizedCondition.maxAmountCents) ??
      asNumber(normalizedCondition.max);

    if (typeof min !== "number" && typeof max !== "number") {
      return false;
    }

    if (typeof min === "number" && transaction.amountCents < min) {
      return false;
    }

    if (typeof max === "number" && transaction.amountCents > max) {
      return false;
    }

    return true;
  }

  if (conditionType === "amount_exact" || conditionType === "exact") {
    const expected =
      asNumber(normalizedCondition.amountCents) ??
      asNumber(normalizedCondition.amount) ??
      asNumber(normalizedCondition.value);
    return typeof expected === "number" && transaction.amountCents === expected;
  }

  if (conditionType === "account_set" || conditionType === "in") {
    const accountIds = Array.from(
      new Set([
        ...getAccountIdValues(normalizedCondition.accountIds),
        ...getAccountIdValues(normalizedCondition.accounts),
        ...getAccountIdValues(normalizedCondition.values),
      ])
    );

    if (accountIds.length === 0) {
      return false;
    }

    return accountIds.includes(String(transaction.accountId));
  }

  return false;
}

export function matchAllConditions(
  transaction: RuleEngineTransaction,
  conditions: RuleCondition[]
): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return false;
  }

  return conditions.every((condition) => matchCondition(transaction, condition));
}

export function applyActions(
  transaction: RuleEngineTransaction,
  actions: RuleAction[]
): RuleEngineTransaction {
  const result: RuleEngineTransaction = {
    ...transaction,
  };

  actions.forEach((action) => {
    const normalizedAction = asObject(action);
    if (!normalizedAction) {
      return;
    }

    const actionType = asActionType(normalizedAction);

    if (actionType === "set_category" || actionType === "set") {
      const category = asString(normalizedAction.category) ?? asString(normalizedAction.value);
      if (category) {
        result.categoryHint = category;
      }
      return;
    }

    if (actionType === "set_counterparty_from_regex_group" || actionType === "regex_group") {
      const pattern =
        asString(normalizedAction.pattern) ??
        asString(normalizedAction.regex) ??
        asString(normalizedAction.value);
      if (!pattern) {
        return;
      }

      const flags = asString(normalizedAction.flags) ?? "";
      const regex = getRegex(pattern, flags);
      if (!regex) {
        return;
      }

      const groupIndexRaw =
        asNumber(normalizedAction.group) ??
        asNumber(normalizedAction.captureGroup) ??
        asNumber(normalizedAction.groupIndex) ??
        1;
      const groupIndex = Math.max(0, Math.trunc(groupIndexRaw));

      regex.lastIndex = 0;
      const match = regex.exec(result.description);
      if (!match) {
        return;
      }

      const extracted = asString(match[groupIndex]);
      if (extracted) {
        result.counterparty = extracted;
      }
    }
  });

  return result;
}

export function applyRules(
  transaction: RuleEngineTransaction,
  rules: RuleDefinition[]
): RuleEngineTransaction {
  const sortedRules = [...rules]
    .map((rule, index) => ({
      rule,
      index,
    }))
    .sort((left, right) => {
      const leftPriority = typeof left.rule.priority === "number" ? left.rule.priority : 0;
      const rightPriority = typeof right.rule.priority === "number" ? right.rule.priority : 0;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return left.index - right.index;
    });

  return sortedRules.reduce((current, item) => {
    const conditions = Array.isArray(item.rule.conditions) ? item.rule.conditions : [];
    const actions = Array.isArray(item.rule.actions) ? item.rule.actions : [];

    if (!matchAllConditions(current, conditions)) {
      return current;
    }

    return applyActions(current, actions);
  }, {
    ...transaction,
  });
}

export const applyTransactionRules = applyRules;
