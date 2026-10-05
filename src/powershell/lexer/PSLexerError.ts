import type { SourcePosition } from './PSToken';

export class PSLexerError extends Error {
  constructor(
    public readonly reason: string,
    public readonly position: SourcePosition,
  ) {
    super(`PSLexerError at line ${position.line}, col ${position.column}: ${reason}`);
    this.name = 'PSLexerError';
  }
}
