import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseStatement } from "@/lib/parsers";

const CREDIT_CARD_CSV = `Type,Started Date,Completed Date,Description,Amount,Fee,Balance
CARD_PAYMENT,2025-12-31 10:27:11,2026-01-01 16:09:50,Guangzhou Metro,-0.37,0.00,-1288.04
CARD_PAYMENT,2026-01-01 23:23:59,2026-01-02 08:53:50,Deliveroo,-8.99,0.00,-1298.51
CHARGE,2026-01-03 03:16:49,2026-01-03 03:16:49,Credit card Stamp Duty fee,0.00,30.00,-1397.51
CARD_PAYMENT,2026-01-04 13:44:32,2026-01-05 11:07:57,Avoca,-2.95,0.00,-1586.51`;

const DOLLAR_ACCOUNT_CSV = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2025-09-10 06:50:50,2025-09-10 06:50:50,Payment from Fidelity,1183.29,0.00,USD,COMPLETED,1183.29
Card Payment,Current,2025-09-16 14:56:44,2025-09-18 02:26:29,Apple,-13.48,0.00,USD,COMPLETED,11643.93
Exchange,Current,2025-09-26 19:33:34,2025-09-26 19:33:34,Exchanged to EUR,-11631.63,0.00,USD,COMPLETED,0.00
Deposit,Current,2025-12-02 07:50:37,2025-12-02 07:50:38,Payment from Fidelity,1478.82,0.00,USD,COMPLETED,1478.82`;

const EURO_ACCOUNT_CSV = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2025-09-01 14:19:18,2025-09-01 14:19:18,Payment from YIPING DENG&DONGYI ZOU,4000.00,0.00,EUR,COMPLETED,4144.86
Transfer,Current,2025-09-12 14:27:45,2025-09-12 14:27:45,Transfer from YU CAO,235.50,0.00,EUR,COMPLETED,801.29
Transfer,Current,2025-09-14 14:29:46,2025-09-14 14:29:48,Transfer to Yangjia Peng,-50.00,0.00,EUR,COMPLETED,751.29
Card Payment,Current,2025-09-18 08:57:41,2025-09-19 11:10:28,Transport for Ireland - TFI,-20.00,0.00,EUR,COMPLETED,762.79
Exchange,Current,2025-09-26 19:33:34,2025-09-26 19:33:34,Exchanged to EUR,9931.19,0.00,EUR,COMPLETED,10595.57`;

type Fixture = {
  name: string;
  fileName: string;
  csv: string;
  expectedTransactionCount: number;
  expectedCurrency: string;
};

const fixtures: Fixture[] = [
  {
    name: "credit card",
    fileName: "credit_card.csv",
    csv: CREDIT_CARD_CSV,
    expectedTransactionCount: 4,
    expectedCurrency: "EUR",
  },
  {
    name: "dollar account",
    fileName: "dollar account.csv",
    csv: DOLLAR_ACCOUNT_CSV,
    expectedTransactionCount: 4,
    expectedCurrency: "USD",
  },
  {
    name: "euro account",
    fileName: "euro account.csv",
    csv: EURO_ACCOUNT_CSV,
    expectedTransactionCount: 5,
    expectedCurrency: "EUR",
  },
];

test("revolut parser validates supported fixture shapes", () => {
  fixtures.forEach((fixture) => {
    const result = parseStatement("revolut", {
      csvContent: fixture.csv,
      fileName: fixture.fileName,
    });

    assert.equal(result.provider, "revolut");
    assert.equal(result.transactions.length, fixture.expectedTransactionCount, fixture.name);
    assert.equal(result.warnings.length, 0, fixture.name);

    result.transactions.forEach((transaction) => {
      assert.match(transaction.bookingDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(transaction.amountCents > 0, "transaction amount cents should be positive");
      assert.equal(transaction.currency, fixture.expectedCurrency, fixture.name);
      assert.ok(transaction.description.length > 0, "description should not be empty");
      assert.ok(transaction.direction === "in" || transaction.direction === "out");
    });
  });
});

test("revolut parser uses completed date and handles fee-only charges", () => {
  const result = parseStatement("revolut", {
    csvContent: CREDIT_CARD_CSV,
    fileName: "credit_card.csv",
  });

  const firstTransaction = result.transactions[0];
  assert.equal(firstTransaction.description, "Guangzhou Metro");
  assert.equal(firstTransaction.bookingDate, "2026-01-01");
  assert.equal(firstTransaction.direction, "out");
  assert.equal(firstTransaction.amountCents, 37);

  const chargeTransaction = result.transactions.find(
    (transaction) => transaction.description === "Credit card Stamp Duty fee"
  );
  assert.ok(chargeTransaction, "Expected to find stamp duty charge transaction");
  assert.equal(chargeTransaction.direction, "out");
  assert.equal(chargeTransaction.amountCents, 3000);
  assert.equal(chargeTransaction.categoryHint, "fees");
});

test("revolut parser infers counterparty for transfer descriptions", () => {
  const result = parseStatement("revolut", {
    csvContent: EURO_ACCOUNT_CSV,
    fileName: "euro account.csv",
  });

  const fromTransfer = result.transactions.find((transaction) =>
    transaction.description.startsWith("Transfer from ")
  );
  assert.ok(fromTransfer, "Expected at least one transfer-from transaction");
  assert.equal(fromTransfer.counterparty, fromTransfer.description.replace("Transfer from ", ""));

  const toTransfer = result.transactions.find((transaction) =>
    transaction.description.startsWith("Transfer to ")
  );
  assert.ok(toTransfer, "Expected at least one transfer-to transaction");
  assert.equal(toTransfer.counterparty, toTransfer.description.replace("Transfer to ", ""));
});
