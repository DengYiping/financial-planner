export type StatementProvider = "aib" | "revolut";

export type TransactionDirection = "in" | "out";

export type NormalizedTransaction = {
  id: string;
  provider: StatementProvider;
  bookingDate: string;
  amount: number;
  currency: string;
  direction: TransactionDirection;
  description: string;
  categoryHint?: string;
  counterparty?: string;
  reference?: string;
  raw: Record<string, string>;
};

export type ParseStatementInput = {
  csvContent: string;
  fileName?: string;
};

export type ParseStatementResult = {
  provider: StatementProvider;
  transactions: NormalizedTransaction[];
  warnings: string[];
};
