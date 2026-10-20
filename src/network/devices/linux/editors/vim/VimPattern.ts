import { translateVimPattern, VimPatternError, type PatternContext, type PatternLayout } from './VimRegex';

interface IndexedMatch extends RegExpExecArray {
  readonly indices?: ReadonlyArray<readonly [number, number] | undefined>;
}

export interface VimMatch extends RegExpExecArray {
  readonly attemptIndex: number;
  readonly attemptEnd: number;
}

export class VimRegExp {
  constructor(
    private readonly regex: RegExp | null,
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

  test(text: string): boolean {
    return this.exec(text, 0) !== null;
  }
}

export function compileVimPattern(pattern: string, ignoreCase: boolean, context: PatternContext | null = null): VimRegExp {
  try {
    const translated = translateVimPattern(pattern, ignoreCase, context);
    return new VimRegExp(new RegExp(translated.source, translated.flags), translated, null);
  } catch (failure) {
    if (failure instanceof VimPatternError) return new VimRegExp(null, null, failure.message);
    if (failure instanceof SyntaxError) return new VimRegExp(null, null, `E383: Invalid search string: ${pattern}`);
    throw failure;
  }
}

export function vimPatternError(pattern: string, ignoreCase: boolean, context: PatternContext | null = null): string | null {
  return compileVimPattern(pattern, ignoreCase, context).error;
}
