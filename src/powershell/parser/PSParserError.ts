import type { SourcePosition } from '@/powershell/lexer/PSToken';

export class PSParserError extends Error {
  constructor(
    message: string,
    public readonly position?: SourcePosition,
  ) {
    const loc = position ? ` at line ${position.line}, col ${position.column}` : '';
    super(`PSParserError${loc}: ${message}`);
    this.name = 'PSParserError';
  }
}
