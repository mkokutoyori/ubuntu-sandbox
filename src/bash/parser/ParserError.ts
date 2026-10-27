/**
 * ParserError — Error thrown during bash parsing.
 */

import type { SourcePosition, Token } from '@/bash/lexer/Token';

export interface ParserErrorDetail {
  readonly token?: Token;
  readonly closer?: string;
  readonly conditional?: 'unary' | 'binary';
}

export class ParserError extends Error {
  readonly position: SourcePosition;
  readonly detail: ParserErrorDetail;

  constructor(message: string, position: SourcePosition, detail: ParserErrorDetail = {}) {
    super(`Parse error at line ${position.line}:${position.column}: ${message}`);
    this.name = 'ParserError';
    this.position = position;
    this.detail = detail;
  }
}
