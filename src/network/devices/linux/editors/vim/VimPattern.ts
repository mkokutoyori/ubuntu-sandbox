import { LinearRegExp, starHeight, type PatternMatcher } from './VimLinearRegex';
import { translateVimPattern, VimPatternError, type PatternContext, type PatternLayout } from './VimRegex';

interface IndexedMatch extends RegExpExecArray {
  readonly indices?: ReadonlyArray<readonly [number, number] | undefined>;
}

export interface VimMatch extends RegExpExecArray {
  readonly attemptIndex: number;
  readonly attemptEnd: number;
}

export interface MultiMatch {
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
  readonly groups: readonly (string | undefined)[];
}

export class BufferText {
  private joined: string | null = null;
  private lineStarts: number[] | null = null;

  constructor(readonly lines: readonly string[]) {}

  get text(): string {
    this.joined ??= `${this.lines.join('\n')}\n`;
    return this.joined;
  }

  private get starts(): number[] {
    if (this.lineStarts === null) {
      let offset = 0;
      this.lineStarts = this.lines.map((line) => {
        const start = offset;
        offset += line.length + 1;
        return start;
      });
    }
    return this.lineStarts;
  }

  offsetOf(line: number, col: number): number {
    return this.starts[line] + col;
  }

  positionOf(offset: number): { line: number; col: number } {
    if (offset >= this.text.length) return { line: this.lines.length, col: 0 };
    const starts = this.starts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low, col: offset - starts[low] };
  }
}

export class VimRegExp {
  constructor(
    private readonly regex: PatternMatcher | null,
    private readonly layout: PatternLayout | null,
    readonly error: string | null,
  ) {}

  exec(text: string, from: number): VimMatch | null {
    const { regex, layout } = this;
    if (regex === null || layout === null) return null;
    regex.lastIndex = from;
    const found = regex.exec(text);
    if (found === null) return null;
    const indices = (found as IndexedMatch).indices!;
    let start = found.index;
    for (const group of layout.startMarks) {
      const span = indices[group];
      if (span !== undefined && span[0] >= start) start = span[0];
    }
    let end = found.index + found[0].length;
    const marked = layout.endMarks.map((group) => indices[group]).filter((span) => span !== undefined);
    if (marked.length > 0) end = Math.max(...marked.map((span) => span[0]));
    if (end < start) end = start;
    const captures: (string | undefined)[] = [text.slice(start, end)];
    for (let n = 1; n <= 9; n++) {
      const slot = layout.groupSlots[n];
      captures.push(slot === undefined ? undefined : found[slot]);
    }
    return Object.assign(captures, {
      index: start,
      input: text,
      attemptIndex: found.index,
      attemptEnd: found.index + found[0].length,
    }) as unknown as VimMatch;
  }

  get needsBuffer(): boolean {
    return this.layout?.needsBuffer ?? false;
  }

  execLine(lines: readonly string[], lineIndex: number, col: number): VimMatch | null {
    if (!this.needsBuffer) return this.exec(lines[lineIndex], col);
    let base = 0;
    for (let i = 0; i < lineIndex; i++) base += lines[i].length + 1;
    const lineEnd = base + lines[lineIndex].length;
    const found = this.exec(`${lines.join('\n')}\n`, base + col);
    if (found === null || found.index > lineEnd || found[0].includes('\n')) return null;
    return Object.assign(found, { index: found.index - base, attemptIndex: found.attemptIndex - base, attemptEnd: found.attemptEnd - base });
  }

  get matchesLineBreaks(): boolean {
    return (this.layout?.needsBuffer ?? false) || (this.layout?.matchesNewline ?? false);
  }

  execMulti(buffer: BufferText, lineIndex: number, col: number): MultiMatch | null {
    const lines = buffer.lines;
    if (!this.matchesLineBreaks) {
      const found = this.exec(lines[lineIndex], col);
      if (found === null) return null;
      return { startLine: 0, startCol: found.index, endLine: 0, endCol: found.index + found[0].length, groups: Array.from(found) };
    }
    const base = buffer.offsetOf(lineIndex, 0);
    const found = this.exec(buffer.text, base + col);
    if (found === null || found.attemptIndex > base + lines[lineIndex].length) return null;
    const start = buffer.positionOf(found.index);
    const end = buffer.positionOf(found.index + found[0].length);
    return {
      startLine: start.line - lineIndex, startCol: start.col,
      endLine: end.line - lineIndex, endCol: end.col,
      groups: Array.from(found),
    };
  }

  test(text: string): boolean {
    return this.exec(text, 0) !== null;
  }
}

export function compileVimPattern(pattern: string, ignoreCase: boolean, context: PatternContext | null = null): VimRegExp {
  try {
    const translated = translateVimPattern(pattern, ignoreCase, context);
    const linear = starHeight(translated.source, translated.flags.includes('u')) >= 2 ? LinearRegExp.compile(translated.source, translated.flags) : null;
    return new VimRegExp(linear ?? new RegExp(translated.source, translated.flags), translated, null);
  } catch (failure) {
    if (failure instanceof VimPatternError) return new VimRegExp(null, null, failure.message);
    if (failure instanceof SyntaxError) return new VimRegExp(null, null, `E383: Invalid search string: ${pattern}`);
    throw failure;
  }
}

export function vimPatternError(pattern: string, ignoreCase: boolean, context: PatternContext | null = null): string | null {
  return compileVimPattern(pattern, ignoreCase, context).error;
}
