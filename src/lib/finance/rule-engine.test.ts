import { existsSync } from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";

type UnknownRecord = Record<string, unknown>;

type RuleEngineTransaction = {
  accountId: string | number;
  description: string;
  amountCents: number;
  categoryHint?: string;
  counterparty?: string;
  [key: string]: unknown;
};

type RuleEngineHarness = {
  matchCondition: (transaction: RuleEngineTransaction, condition: UnknownRecord) => boolean;
  matchAllConditions: (transaction: RuleEngineTransaction, conditions: UnknownRecord[]) => boolean;
  applyActions: (transaction: RuleEngineTransaction, actions: UnknownRecord[]) => RuleEngineTransaction;
  applyRules: (transaction: RuleEngineTransaction, rules: UnknownRecord[]) => RuleEngineTransaction;
};

function cloneTransaction(transaction: RuleEngineTransaction): RuleEngineTransaction {
  return {
    ...transaction,
  };
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function resolveFunction(moduleExports: UnknownRecord, names: string[]): ((...args: unknown[]) => unknown) | null {
  for (const name of names) {
    const candidate = moduleExports[name];
    if (typeof candidate === "function") {
      return candidate as (...args: unknown[]) => unknown;
    }
  }

  return null;
}

function createRuleEngineHarness(moduleExports: UnknownRecord): RuleEngineHarness {
  const matchConditionFn = resolveFunction(moduleExports, [
    "matchCondition",
    "matchesCondition",
    "matchesRuleCondition",
    "conditionMatches",
  ]);
  if (!matchConditionFn) {
    throw new Error(
      "Expected rule-engine to export a condition matcher (matchCondition/matchesCondition)."
    );
  }

  const matchAllConditionsFn = resolveFunction(moduleExports, [
    "matchAllConditions",
    "matchesAllConditions",
    "matchConditions",
    "matchesConditions",
  ]);

  const applyActionsFn = resolveFunction(moduleExports, [
    "applyActions",
    "applyRuleActions",
    "applyActionsToTransaction",
  ]);

  const applyRulesFn = resolveFunction(moduleExports, [
    "applyRules",
    "applyTransactionRules",
    "runRuleEngine",
    "evaluateRules",
  ]);

  if (!applyRulesFn) {
    throw new Error("Expected rule-engine to export applyRules/applyTransactionRules.");
  }

  const matchCondition = (transaction: RuleEngineTransaction, condition: UnknownRecord): boolean => {
    const result = matchConditionFn(cloneTransaction(transaction), condition);
    return Boolean(result);
  };

  const matchAllConditions = (
    transaction: RuleEngineTransaction,
    conditions: UnknownRecord[]
  ): boolean => {
    if (matchAllConditionsFn) {
      const result = matchAllConditionsFn(cloneTransaction(transaction), conditions);
      return Boolean(result);
    }

    return conditions.every((condition) => matchCondition(transaction, condition));
  };

  const applyRules = (transaction: RuleEngineTransaction, rules: UnknownRecord[]): RuleEngineTransaction => {
    const workingTransaction = cloneTransaction(transaction);
    const result = applyRulesFn(workingTransaction, rules);
    if (isObject(result)) {
      return result as RuleEngineTransaction;
    }

    return workingTransaction;
  };

  const applyActions = (
    transaction: RuleEngineTransaction,
    actions: UnknownRecord[]
  ): RuleEngineTransaction => {
    if (applyActionsFn) {
      const workingTransaction = cloneTransaction(transaction);
      const result = applyActionsFn(workingTransaction, actions);
      if (isObject(result)) {
        return result as RuleEngineTransaction;
      }

      return workingTransaction;
    }

    return applyRules(transaction, [
      rule({
        priority: 0,
        conditions: [accountSetCondition([transaction.accountId])],
        actions,
      }),
    ]);
  };

  return {
    matchCondition,
    matchAllConditions,
    applyActions,
    applyRules,
  };
}

const RULE_ENGINE_SOURCE = path.resolve(process.cwd(), "src/lib/finance/rule-engine.ts");
const ruleEngineExists = existsSync(RULE_ENGINE_SOURCE);

let ruleEngineHarnessPromise: Promise<RuleEngineHarness> | null = null;

async function loadRuleEngineHarness(): Promise<RuleEngineHarness> {
  if (!ruleEngineExists) {
    throw new Error("Rule engine harness is unavailable.");
  }

  if (!ruleEngineHarnessPromise) {
    ruleEngineHarnessPromise = import("@/lib/finance/rule-engine").then((moduleExports) =>
      createRuleEngineHarness(moduleExports as UnknownRecord)
    );
  }

  return ruleEngineHarnessPromise;
}

function descriptionContainsCondition(value: string): UnknownRecord {
  return {
    kind: "description_contains",
    type: "description_contains",
    operator: "contains",
    field: "description",
    value,
    needle: value,
    text: value,
  };
}

function descriptionRegexCondition(pattern: string, flags = ""): UnknownRecord {
  return {
    kind: "description_regex",
    type: "description_regex",
    operator: "regex",
    field: "description",
    pattern,
    regex: pattern,
    value: pattern,
    flags,
  };
}

function amountRangeCondition(minCents: number | undefined, maxCents: number | undefined): UnknownRecord {
  return {
    kind: "amount_range",
    type: "amount_range",
    operator: "range",
    field: "amountCents",
    minCents,
    maxCents,
    minAmountCents: minCents,
    maxAmountCents: maxCents,
    min: minCents,
    max: maxCents,
  };
}

function amountExactCondition(amountCents: number): UnknownRecord {
  return {
    kind: "amount_exact",
    type: "amount_exact",
    operator: "exact",
    field: "amountCents",
    amountCents,
    amount: amountCents,
    value: amountCents,
  };
}

function accountSetCondition(accountIds: Array<string | number>): UnknownRecord {
  return {
    kind: "account_set",
    type: "account_set",
    operator: "in",
    field: "accountId",
    accountIds,
    accounts: accountIds,
    values: accountIds,
  };
}

function setCategoryAction(category: string): UnknownRecord {
  return {
    kind: "set_category",
    type: "set_category",
    action: "set",
    field: "categoryHint",
    category,
    value: category,
  };
}

function setCounterpartyFromRegexGroupAction(pattern: string, group: number, flags = ""): UnknownRecord {
  return {
    kind: "set_counterparty_from_regex_group",
    type: "set_counterparty_from_regex_group",
    action: "regex_group",
    field: "counterparty",
    sourceField: "description",
    pattern,
    regex: pattern,
    flags,
    group,
    captureGroup: group,
    groupIndex: group,
  };
}

function rule(input: {
  priority: number;
  conditions: UnknownRecord[];
  actions: UnknownRecord[];
  id?: string;
}): UnknownRecord {
  return {
    id: input.id ?? `rule-${input.priority}`,
    priority: input.priority,
    conditions: input.conditions,
    actions: input.actions,
  };
}

function transaction(overrides: Partial<RuleEngineTransaction> = {}): RuleEngineTransaction {
  return {
    accountId: "acc-1",
    description: "Transfer to Alice",
    amountCents: 5000,
    ...overrides,
  };
}

test("rule-engine: matches supported condition types", { skip: !ruleEngineExists }, async () => {
  const engine = await loadRuleEngineHarness();
  const candidate = transaction({
    accountId: "acc-2",
    description: "Deliveroo order #123",
    amountCents: 899,
  });

  assert.equal(engine.matchCondition(candidate, descriptionContainsCondition("deliveroo")), true);
  assert.equal(engine.matchCondition(candidate, descriptionContainsCondition("rent")), false);

  assert.equal(
    engine.matchCondition(candidate, descriptionRegexCondition("^deliveroo\\s+order", "i")),
    true
  );
  assert.equal(engine.matchCondition(candidate, descriptionRegexCondition("^uber", "i")), false);

  assert.equal(engine.matchCondition(candidate, amountRangeCondition(899, 899)), true);
  assert.equal(engine.matchCondition(candidate, amountRangeCondition(900, 999)), false);

  assert.equal(engine.matchCondition(candidate, amountExactCondition(899)), true);
  assert.equal(engine.matchCondition(candidate, amountExactCondition(900)), false);

  assert.equal(engine.matchCondition(candidate, accountSetCondition(["acc-1", "acc-2"])), true);
  assert.equal(engine.matchCondition(candidate, accountSetCondition(["acc-1", "acc-3"])), false);
});

test("rule-engine: uses AND semantics for multiple conditions", { skip: !ruleEngineExists }, async () => {
  const engine = await loadRuleEngineHarness();
  const candidate = transaction({
    accountId: "acc-main",
    description: "Transfer to Bob",
    amountCents: 4200,
  });

  const allMatch = [
    descriptionContainsCondition("transfer"),
    amountRangeCondition(4000, 5000),
    accountSetCondition(["acc-main"]),
  ];
  assert.equal(engine.matchAllConditions(candidate, allMatch), true);

  const oneMismatch = [
    descriptionContainsCondition("transfer"),
    amountRangeCondition(4000, 5000),
    accountSetCondition(["acc-other"]),
  ];
  assert.equal(engine.matchAllConditions(candidate, oneMismatch), false);
});

test("rule-engine: applies category and counterparty actions", { skip: !ruleEngineExists }, async () => {
  const engine = await loadRuleEngineHarness();
  const candidate = transaction({
    description: "Transfer to Charlie",
    amountCents: 1200,
  });

  const result = engine.applyActions(candidate, [
    setCategoryAction("transfer"),
    setCounterpartyFromRegexGroupAction("^Transfer to\\s+(.+)$", 1, "i"),
  ]);

  assert.equal(result.categoryHint, "transfer");
  assert.equal(result.counterparty, "Charlie");
  assert.equal(candidate.categoryHint, undefined);
  assert.equal(candidate.counterparty, undefined);
});

test("rule-engine: applies higher priority rules last", { skip: !ruleEngineExists }, async () => {
  const engine = await loadRuleEngineHarness();
  const candidate = transaction({
    description: "Transfer to Dana",
    amountCents: 2500,
  });

  const lowPriority = rule({
    priority: 10,
    conditions: [descriptionContainsCondition("transfer")],
    actions: [setCategoryAction("low-priority")],
  });

  const highPriority = rule({
    priority: 100,
    conditions: [descriptionContainsCondition("transfer")],
    actions: [setCategoryAction("high-priority")],
  });

  const result = engine.applyRules(candidate, [highPriority, lowPriority]);
  assert.equal(result.categoryHint, "high-priority");
});

test("rule-engine: leaves transaction unchanged when no rules match", { skip: !ruleEngineExists }, async () => {
  const engine = await loadRuleEngineHarness();
  const candidate = transaction({
    description: "Salary",
    amountCents: 400000,
  });

  const result = engine.applyRules(candidate, [
    rule({
      priority: 50,
      conditions: [descriptionContainsCondition("deliveroo")],
      actions: [setCategoryAction("food")],
    }),
  ]);

  assert.equal(result.categoryHint, undefined);
  assert.equal(result.counterparty, undefined);
});

test("rule-engine: handles invalid regex conditions gracefully", { skip: !ruleEngineExists }, async () => {
  const engine = await loadRuleEngineHarness();
  const candidate = transaction({ description: "Transfer to Erin" });
  const invalidRegex = descriptionRegexCondition("[invalid", "");

  assert.doesNotThrow(() => {
    const matched = engine.matchCondition(candidate, invalidRegex);
    assert.equal(matched, false);
  });
});

test(
  "rule-engine: handles missing or invalid regex capture groups",
  { skip: !ruleEngineExists },
  async () => {
    const engine = await loadRuleEngineHarness();

    const missingCaptureGroupResult = engine.applyActions(transaction({ description: "Transfer to Finn" }), [
      setCounterpartyFromRegexGroupAction("^Transfer to .+$", 1, "i"),
    ]);
    assert.equal(missingCaptureGroupResult.counterparty, undefined);

    const invalidRegexResult = engine.applyActions(transaction({ description: "Transfer to Gia" }), [
      setCounterpartyFromRegexGroupAction("[invalid", 1),
    ]);
    assert.equal(invalidRegexResult.counterparty, undefined);
  }
);
