/**
 * LexerError — Error thrown during bash tokenization.
 */

import type { SourcePosition } from './Token';

export class LexerError extends Error {
  readonly position: SourcePosition;
  readonly source: string;

  constructor(message: string, position: SourcePosition, source: string = '') {
    super(`Lexer error at line ${position.line}:${position.column}: ${message}`);
    this.name = 'LexerError';
    this.position = position;
    this.source = source;
  }
}
