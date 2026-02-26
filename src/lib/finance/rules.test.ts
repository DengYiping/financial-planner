import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TransactionRuleRow } from "@/lib/server/db/schema";
import {
  TransactionRuleValidationError,
  applyPreparedTransactionRules,
  mapTransactionRuleRow,
  prepareTransactionRules,
  validateAndNormalizeTransactionRuleInput,
} from "@/lib/finance/rules";

test("validateAndNormalizeTransactionRuleInput enforces required conditions and actions", () => {
  assert.throws(
    () =>
      validateAndNormalizeTransactionRuleInput({
        priority: 1,
      }),
    (error) =>
      error instanceof TransactionRuleValidationError &&
      error.message === "At least one condition is required."
  );

  assert.throws(
    () =>
      validateAndNormalizeTransactionRuleInput({
        descriptionContains: "uber",
        priority: 1,
      }),
    (error) =>
      error instanceof TransactionRuleValidationError &&
      error.message === "At least one action is required."
  );
});

test("validateAndNormalizeTransactionRuleInput enforces regex requirement for counterparty capture action", () => {
  assert.throws(
    () =>
      validateAndNormalizeTransactionRuleInput({
        descriptionContains: "transfer",
        assignCounterpartyFromRegexGroup: true,
        priority: 10,
      }),
    (error) =>
      error instanceof TransactionRuleValidationError &&
      error.message === "assignCounterpartyFromRegexGroup requires a descriptionRegex condition."
  );
});

test("validateAndNormalizeTransactionRuleInput normalizes fields", () => {
  const normalized = validateAndNormalizeTransactionRuleInput({
    descriptionContains: "  Uber  ",
    descriptionRegex: "^Payment to (.+)$",
    amountMinCents: 100,
    amountMaxCents: 5000,
    accountIds: [3, 1, 3, 2],
    applyCategoryId: 7,
    assignCounterpartyFromRegexGroup: true,
    priority: 9,
  });

  assert.equal(normalized.descriptionContains, "Uber");
  assert.equal(normalized.applyCategoryId, 7);
  assert.deepEqual(normalized.accountIds, [1, 2, 3]);
  assert.equal(normalized.assignCounterpartyFromRegexGroup, true);
});

test("mapTransactionRuleRow parses persisted account id set", () => {
  const row: TransactionRuleRow = {
    id: 7,
    descriptionContains: "fuel",
    descriptionRegex: null,
    amountMinCents: null,
    amountMaxCents: null,
    amountExactCents: null,
    accountIdsJson: "[3,2,2,1,0,-5,\"bad\"]",
    applyCategoryId: 9,
    assignCounterpartyFromRegexGroup: false,
    priority: 4,
    createdAt: "2026-02-26T00:00:00Z",
    updatedAt: "2026-02-26T00:00:00Z",
  };

  const mapped = mapTransactionRuleRow(row);
  assert.deepEqual(mapped.accountIds, [1, 2, 3]);
});

test("prepareTransactionRules rejects invalid regex patterns", () => {
  assert.throws(
    () =>
      prepareTransactionRules([
        {
          id: 1,
          descriptionRegex: "[invalid",
          assignCounterpartyFromRegexGroup: false,
          priority: 0,
          createdAt: "",
          updatedAt: "",
        },
      ]),
    (error) =>
      error instanceof TransactionRuleValidationError &&
      error.message === "descriptionRegex must be a valid regular expression."
  );
});

test("applyPreparedTransactionRules evaluates conditions with AND semantics", () => {
  const preparedRules = prepareTransactionRules([
    {
      id: 1,
      descriptionContains: "uber",
      amountMinCents: 1000,
      amountMaxCents: 3000,
      accountIds: [2],
      applyCategoryId: 3,
      assignCounterpartyFromRegexGroup: false,
      priority: 10,
      createdAt: "",
      updatedAt: "",
    },
  ]);

  const match = applyPreparedTransactionRules(preparedRules, {
    accountId: 2,
    description: "Uber Trip Dublin",
    amountCents: 1500,
  });
  assert.equal(match.categoryId, 3);

  const noMatchAmount = applyPreparedTransactionRules(preparedRules, {
    accountId: 2,
    description: "Uber Trip Dublin",
    amountCents: 800,
  });
  assert.equal(noMatchAmount.categoryId, undefined);

  const noMatchAccount = applyPreparedTransactionRules(preparedRules, {
    accountId: 1,
    description: "Uber Trip Dublin",
    amountCents: 1500,
  });
  assert.equal(noMatchAccount.categoryId, undefined);
});

test("applyPreparedTransactionRules applies higher priority rules last", () => {
  const preparedRules = prepareTransactionRules([
    {
      id: 10,
      descriptionContains: "payment",
      applyCategoryId: 4,
      assignCounterpartyFromRegexGroup: false,
      priority: 10,
      createdAt: "",
      updatedAt: "",
    },
    {
      id: 11,
      descriptionContains: "payment",
      applyCategoryId: 12,
      assignCounterpartyFromRegexGroup: false,
      priority: 100,
      createdAt: "",
      updatedAt: "",
    },
  ]);

  const result = applyPreparedTransactionRules(preparedRules, {
    accountId: 1,
    description: "Card payment",
    amountCents: 1200,
  });

  assert.equal(result.categoryId, 12);
});

test("applyPreparedTransactionRules extracts counterparty from first regex group", () => {
  const preparedRules = prepareTransactionRules([
    {
      id: 1,
      descriptionRegex: "^Transfer to\\s+(.+)$",
      assignCounterpartyFromRegexGroup: true,
      priority: 1,
      createdAt: "",
      updatedAt: "",
    },
  ]);

  const withCapture = applyPreparedTransactionRules(preparedRules, {
    accountId: 1,
    description: "Transfer to Alice",
    amountCents: 5000,
  });
  assert.equal(withCapture.counterparty, "Alice");

  const noCapture = applyPreparedTransactionRules(
    prepareTransactionRules([
      {
        id: 2,
        descriptionRegex: "^Transfer to .+$",
        assignCounterpartyFromRegexGroup: true,
        priority: 1,
        createdAt: "",
        updatedAt: "",
      },
    ]),
    {
      accountId: 1,
      description: "Transfer to Bob",
      amountCents: 5000,
      counterparty: "Existing",
    }
  );
  assert.equal(noCapture.counterparty, "Existing");
});
