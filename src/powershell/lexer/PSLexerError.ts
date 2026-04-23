import type { SourcePosition } from './PSToken';

export class PSLexerError extends Error {
  constructor(
    message: string,
    public readonly position: SourcePosition,
  ) {
    super(`PSLexerError at line ${position.line}, col ${position.column}: ${message}`);
    this.name = 'PSLexerError';
  }
}
