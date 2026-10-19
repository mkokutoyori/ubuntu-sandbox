import { compileEre, type CompiledEre } from '@/network/devices/linux/regex/PosixEre';

export { PosixRegexError } from '@/network/devices/linux/regex/PosixEre';

export interface SearchStyle {
  readonly caseSensitive: boolean;
  readonly regex: boolean;
  readonly backwards: boolean;
}

export type SubmatchRange = readonly [number, number] | null;

export interface PatternMatch {
  readonly index: number;
  readonly length: number;
  readonly groups: readonly SubmatchRange[];
}

export type SearchModus = 'JUSTFIND' | 'REPLACING' | 'INREGION';

export interface SearchSpot {
  line: number;
  col: number;
}

export interface SearchHit {
  readonly line: number;
  readonly col: number;
  readonly length: number;
  readonly groups: readonly SubmatchRange[];
  readonly wrapped: boolean;
}

export interface SearchStep {
  readonly lines: readonly string[];
  readonly modus: SearchModus;
  readonly from: SearchSpot;
  readonly skipOne: boolean;
  readonly begin: SearchSpot;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function stepRight(text: string, index: number): number {
  return index + (isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1)) ? 2 : 1);
}

export function stepLeft(text: string, index: number): number {
  if (index <= 0) return 0;
  return index - (isLowSurrogate(text.charCodeAt(index - 1)) && isHighSurrogate(text.charCodeAt(index - 2)) ? 2 : 1);
}

export class SearchPattern {
  readonly needle: string;
  private readonly style: SearchStyle;
  private readonly ere: CompiledEre | null;
  private readonly foldedNeedle: readonly string[];

  constructor(needle: string, style: SearchStyle) {
    this.needle = needle;
    this.style = style;
    this.ere = style.regex ? compileEre(needle, !style.caseSensitive) : null;
    this.foldedNeedle = Array.from(needle).map((character) => character.toLowerCase());
  }

  get groupCount(): number {
    return this.ere === null ? 0 : this.ere.groupCount;
  }

  get isRegex(): boolean {
    return this.ere !== null;
  }

  find(text: string, from: number): PatternMatch | null {
    if (this.ere !== null) return this.style.backwards ? this.findRegexBackwards(text, from) : this.describe(this.ere.exec(text, from));
    const index = this.style.backwards ? this.findPlainBackwards(text, from) : this.findPlainForwards(text, from);
    return index === null ? null : { index, length: this.needle.length, groups: [] };
  }

  private describe(match: ReturnType<CompiledEre['exec']>): PatternMatch | null {
    return match === null ? null : { index: match.index, length: match.end - match.index, groups: match.groups };
  }

  private findRegexBackwards(text: string, ceiling: number): PatternMatch | null {
    const ere = this.ere!;
    let match = ere.exec(text, 0);
    if (match === null || match.index > ceiling) return null;
    let floor = 0;
    let nextRung = 0;
    while (match !== null && match.index <= ceiling) {
      floor = nextRung;
      if (match.index === ceiling) break;
      nextRung = stepRight(text, match.index);
      match = ere.exec(text, nextRung);
    }
    return this.describe(ere.exec(text, floor));
  }

  private findPlainForwards(text: string, from: number): number | null {
    if (this.style.caseSensitive) {
      const index = text.indexOf(this.needle, from);
      return index < 0 ? null : index;
    }
    for (let at = from; at < text.length; at = stepRight(text, at)) {
      if (this.foldedMatchAt(text, at)) return at;
    }
    return null;
  }

  private findPlainBackwards(text: string, from: number): number | null {
    if (this.style.caseSensitive) {
      let pointer = from;
      if (text.length - from < this.needle.length) pointer -= this.needle.length - (text.length - from);
      if (pointer < 0) return null;
      const index = text.lastIndexOf(this.needle, pointer);
      return index < 0 ? null : index;
    }
    const tail = Array.from(text.slice(from)).length;
    let pointer = from;
    if (tail < this.foldedNeedle.length) pointer -= this.foldedNeedle.length - tail;
    if (pointer < 0) return null;
    for (;;) {
      if (this.foldedMatchAt(text, pointer)) return pointer;
      if (pointer === 0) return null;
      pointer = stepLeft(text, pointer);
    }
  }

  private foldedMatchAt(text: string, at: number): boolean {
    let position = at;
    for (const wanted of this.foldedNeedle) {
      if (position >= text.length) return false;
      const code = text.codePointAt(position)!;
      const character = String.fromCodePoint(code);
      if (character.toLowerCase() !== wanted) return false;
      position += character.length;
    }
    return true;
  }
}

export class SearchCircuit {
  private cameFullCircle = false;

  constructor(private readonly pattern: SearchPattern, private readonly backwards: boolean) {}

  next(step: SearchStep): SearchHit | null {
    const { lines, modus, begin } = step;
    const last = lines.length - 1;
    let line = step.from.line;
    let col = step.from.col;
    let skipOne = step.skipOne;
    let found: PatternMatch | null = null;
    let wrapped = false;
    for (;;) {
      const text = lines[line];
      if (skipOne) {
        skipOne = false;
        if (this.backwards && col !== 0) {
          col = stepLeft(text, col);
          found = this.pattern.find(text, col);
        } else if (!this.backwards && col < text.length) {
          col = stepRight(text, col);
          found = this.pattern.find(text, col);
        }
      } else {
        found = this.pattern.find(text, col);
      }
      if (found !== null && (line < last || text.length > 0)) break;
      if (this.cameFullCircle) return null;
      line += this.backwards ? -1 : 1;
      if (line < 0 || line > last) {
        if (modus === 'INREGION') return null;
        line = this.backwards ? last : 0;
        if (modus === 'JUSTFIND') wrapped = true;
      }
      if (line === begin.line) this.cameFullCircle = true;
      col = this.backwards ? lines[line].length : 0;
      found = null;
    }
    if (this.cameFullCircle && ((!this.backwards && (found.index > begin.col || (modus === 'REPLACING' && found.index === begin.col)))
      || (this.backwards && found.index < begin.col))) return null;
    return { line, col: found.index, length: found.length, groups: found.groups, wrapped };
  }
}

export function expandReplacement(replacement: string, text: string, match: PatternMatch, groupCount: number): string {
  let result = '';
  for (let at = 0; at < replacement.length; at++) {
    const digit = replacement[at] === '\\' ? Number(replacement[at + 1] ?? 'x') : NaN;
    if (digit >= 1 && digit <= 9 && digit <= groupCount) {
      const range = match.groups[digit - 1];
      if (range !== null) result += text.slice(range[0], range[1]);
      at++;
    } else {
      result += replacement[at];
    }
  }
  return result;
}
