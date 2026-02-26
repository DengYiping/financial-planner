export type StatementProvider = "aib" | "revolut";

export type TransactionDirection = "in" | "out";

export type TransactionTag = {
  id: number;
  name: string;
};

export type NormalizedTransaction = {
  id: string;
  provider: StatementProvider;
  bookingDate: string;
  amountCents: number;
  currency: string;
  direction: TransactionDirection;
  description: string;
  categoryId?: number;
  categoryHint?: string;
  tags?: TransactionTag[];
  tagIds?: number[];
  tagHints?: string[];
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
