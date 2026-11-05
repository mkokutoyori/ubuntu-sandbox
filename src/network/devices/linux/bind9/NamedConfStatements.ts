import { NamedConfigError } from './NamedConfigError';
import type { NamedConfStatement } from './NamedConfParser';

export function fail(statement: NamedConfStatement, detail: string): never {
  throw new NamedConfigError(statement.file, statement.line, detail);
}

export function keywordOf(statement: NamedConfStatement): string {
  return statement.values[0].text;
}

export function argsOf(statement: NamedConfStatement): string[] {
  return statement.values.slice(1).map((v) => v.text);
}

export function requireBlock(statement: NamedConfStatement): readonly NamedConfStatement[] {
  if (statement.block === null) {
    fail(statement, `expected '{' after '${keywordOf(statement)}'`);
  }
  return statement.block;
}
