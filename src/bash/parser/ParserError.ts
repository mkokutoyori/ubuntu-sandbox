/**
 * ParserError — Error thrown during bash parsing.
 */

import type { SourcePosition } from '@/bash/lexer/Token';

export class ParserError extends Error {
  readonly position: SourcePosition;

  constructor(message: string, position: SourcePosition) {
    super(`Parse error at line ${position.line}:${position.column}: ${message}`);
    this.name = 'ParserError';
    this.position = position;
  }
}
