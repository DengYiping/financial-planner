import { AibStatementParser } from "@/lib/parsers/aib-parser";
import { RevolutStatementParser } from "@/lib/parsers/revolut-parser";
import { StatementParser } from "@/lib/parsers/statement-parser";
import { ParseStatementInput, ParseStatementResult, StatementProvider } from "@/lib/parsers/types";

const parserRegistry: Record<StatementProvider, StatementParser> = {
  aib: new AibStatementParser(),
  revolut: new RevolutStatementParser(),
};

export function getStatementParser(provider: StatementProvider): StatementParser {
  return parserRegistry[provider];
}

export function parseStatement(
  provider: StatementProvider,
  input: ParseStatementInput
): ParseStatementResult {
  return getStatementParser(provider).parse(input);
}

export type {
  NormalizedTransaction,
  ParseStatementInput,
  ParseStatementResult,
  StatementProvider,
  TransactionDirection,
} from "@/lib/parsers/types";
export { ParserNotImplementedError } from "@/lib/parsers/statement-parser";
export { AIB_EXPECTED_COLUMNS } from "@/lib/parsers/aib-parser";
export { AIB_ACCOUNT_COLUMNS } from "@/lib/parsers/aib-parser";
export { REVOLUT_EXPECTED_COLUMNS } from "@/lib/parsers/revolut-parser";
