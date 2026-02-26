import { ParseStatementInput, ParseStatementResult, StatementProvider } from "@/lib/parsers/types";

export interface StatementParser {
  readonly provider: StatementProvider;
  parse(input: ParseStatementInput): ParseStatementResult;
}

export class ParserNotImplementedError extends Error {
  constructor(provider: StatementProvider, details?: string) {
    const suffix = details ? ` ${details}` : "";
    super(`Parser for "${provider}" is not implemented yet.${suffix}`);
    this.name = "ParserNotImplementedError";
  }
}
