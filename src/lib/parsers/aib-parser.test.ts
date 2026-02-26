import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseStatement } from "@/lib/parsers";

const AIB_CSV = `Posted Transactions Date,Description,Debit Amount,Credit Amount,Balance,Transaction Type,Posted Account
31/01/2026,MORTGAGE PAYMENT,1200.00,,5000.00,Debit,Current
01/02/2026,12345678,,900.00,5900.00,Credit,Current`;

test("aib parser parses core fields and does not infer category/counterparty", () => {
  const result = parseStatement("aib", {
    csvContent: AIB_CSV,
    fileName: "aib.csv",
  });

  assert.equal(result.provider, "aib");
  assert.equal(result.warnings.length, 0);
  assert.equal(result.transactions.length, 2);

  const [first, second] = result.transactions;

  assert.equal(first.description, "MORTGAGE PAYMENT");
  assert.equal(first.direction, "out");
  assert.equal(first.amountCents, 120000);
  assert.equal(first.categoryHint, undefined);
  assert.equal(first.counterparty, undefined);

  assert.equal(second.description, "12345678");
  assert.equal(second.direction, "in");
  assert.equal(second.amountCents, 90000);
  assert.equal(second.categoryHint, undefined);
  assert.equal(second.counterparty, undefined);
  assert.equal(second.reference, "12345678");
});
