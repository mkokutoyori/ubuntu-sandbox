import type { SourcePosition } from '@/powershell/lexer/PSToken';

export class PSParserError extends Error {
  constructor(
    readonly reason: string,
    public readonly position?: SourcePosition,
    readonly length: number = 1,
    readonly errorId: string = 'ParseException',
  ) {
    const loc = position ? ` at line ${position.line}, col ${position.column}` : '';
    super(`PSParserError${loc}: ${reason}`);
    this.name = 'PSParserError';
  }

  render(source: string): string {
    const position = this.position;
    if (position === undefined) return this.reason;
    const lineText = source.split('\n')[position.line - 1]?.replace(/\r$/, '') ?? '';
    const marker = `${' '.repeat(Math.max(0, position.column - 1))}${'~'.repeat(Math.max(1, this.length))}`;
    return [
      `At line:${position.line} char:${position.column}`,
      `+ ${lineText}`,
      `+ ${marker}`,
      this.reason,
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException',
      `    + FullyQualifiedErrorId : ${this.errorId}`,
    ].join('\n');
  }

  renderConcise(source: string): string {
    const position = this.position;
    if (position === undefined) return `ParserError: ${this.reason}`;
    const lineText = (source.split('\n')[position.line - 1] ?? '').replace(/\r$/, '');
    const marker = `${' '.repeat(Math.max(0, position.column - 1))}${'~'.repeat(Math.max(1, this.length))}`;
    const number = String(position.line);
    const gutter = ' '.repeat(Math.max(0, 4 - number.length));
    return [
      'ParserError:',
      'Line |',
      `${gutter}${number} | ${lineText}`,
      `     | ${marker}`,
      `     | ${this.reason}`,
    ].join('\n');
  }
}
