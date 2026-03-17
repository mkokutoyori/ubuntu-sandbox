/**
 * ParserError — Thrown when the parser encounters invalid SQL syntax.
 */

import type { SourcePosition } from '../lexer/Token';

export class ParserError extends Error {
  readonly position: SourcePosition;
  readonly expected?: string;
  readonly found?: string;

  constructor(message: string, position: SourcePosition, expected?: string, found?: string) {
    super(message);
    this.name = 'ParserError';
    this.position = position;
    this.expected = expected;
    this.found = found;
  }

  format(): string {
    return `ERROR at line ${this.position.line}, column ${this.position.column}:\n${this.message}`;
  }
}
