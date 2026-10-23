import { EMOJI_INTERVALS, WORD_CLASS_INTERVALS } from './VimCharClassData';

export const DEFAULT_ISKEYWORD = '@,48-57,_,192-255';

export interface WordClasses {
  readonly spec: string;
  classOf(character: string): number;
  isKeyword(character: string): boolean;
  keywordBody(excludeDigits: boolean): string;
  wordClassBodies(): readonly string[];
}

const LATIN1_LIMIT = 0x100;
const LAST_CODE_POINT = 0x10ffff;

function isLowerLatin1(code: number): boolean {
  const character = String.fromCodePoint(code);
  return code === 0xdf || (character.toUpperCase() !== character && [...character.toUpperCase()].length === 1);
}

function isUpperLatin1(code: number): boolean {
  const character = String.fromCodePoint(code);
  return character.toLowerCase() !== character && [...character.toLowerCase()].length === 1;
}

function isAlphaLatin1(code: number): boolean {
  return code > 0x40 && (isLowerLatin1(code) || isUpperLatin1(code));
}

function inIntervals(table: readonly number[], code: number, width: number): boolean {
  if (code < table[0]) return false;
  let bottom = 0;
  let top = table.length / width - 1;
  while (top >= bottom) {
    const middle = (bottom + top) >> 1;
    if (table[middle * width + 1] < code) bottom = middle + 1;
    else if (table[middle * width] > code) top = middle - 1;
    else return true;
  }
  return false;
}

function intervalClass(code: number): number {
  if (inIntervals(EMOJI_INTERVALS, code, 2)) return 3;
  let bottom = 0;
  let top = WORD_CLASS_INTERVALS.length / 3 - 1;
  while (top >= bottom) {
    const middle = (bottom + top) >> 1;
    if (WORD_CLASS_INTERVALS[middle * 3 + 1] < code) bottom = middle + 1;
    else if (WORD_CLASS_INTERVALS[middle * 3] > code) top = middle - 1;
    else return WORD_CLASS_INTERVALS[middle * 3 + 2];
  }
  return 2;
}

interface ItemEnd {
  readonly value: number;
  readonly next: number;
}

function readNumberOrCharacter(spec: string, from: number): ItemEnd {
  if (spec[from] >= '0' && spec[from] <= '9') {
    let at = from;
    while (spec[at] >= '0' && spec[at] <= '9') at++;
    return { value: Number(spec.slice(from, at)), next: at };
  }
  const code = spec.codePointAt(from)!;
  return { value: code, next: from + (code > 0xffff ? 2 : 1) };
}

export function parseIsKeyword(spec: string): Uint8Array | null {
  const table = new Uint8Array(LATIN1_LIMIT);
  let at = 0;
  while (at < spec.length) {
    let excluded = false;
    if (spec[at] === '^' && at + 1 < spec.length) {
      excluded = true;
      at++;
    }
    const first = readNumberOrCharacter(spec, at);
    at = first.next;
    let low = first.value;
    let high = -1;
    if (spec[at] === '-' && at + 1 < spec.length) {
      const second = readNumberOrCharacter(spec, at + 1);
      high = second.value;
      at = second.next;
    }
    if (low <= 0 || low >= LATIN1_LIMIT || (high < low && high !== -1) || high >= LATIN1_LIMIT || !(at >= spec.length || spec[at] === ',')) return null;
    let onlyLetters = false;
    if (high === -1) {
      if (low === 0x40) {
        onlyLetters = true;
        low = 1;
        high = 255;
      } else {
        high = low;
      }
    }
    for (let code = low; code <= high; code++) {
      if (!onlyLetters || isAlphaLatin1(code)) table[code] = excluded ? 0 : 1;
    }
    if (spec[at] === ',') at++;
    while (spec[at] === ' ') at++;
  }
  return table;
}

function rangeBody(ranges: readonly (readonly [number, number])[]): string {
  const hex = (code: number): string => `\\u{${code.toString(16)}}`;
  return ranges.map(([low, high]) => (low === high ? hex(low) : `${hex(low)}-${hex(high)}`)).join('');
}

function boundaries(): number[] {
  const points = new Set<number>([LATIN1_LIMIT, LAST_CODE_POINT + 1]);
  for (let at = 0; at < WORD_CLASS_INTERVALS.length; at += 3) {
    points.add(WORD_CLASS_INTERVALS[at]);
    points.add(WORD_CLASS_INTERVALS[at + 1] + 1);
  }
  for (let at = 0; at < EMOJI_INTERVALS.length; at += 2) {
    points.add(EMOJI_INTERVALS[at]);
    points.add(EMOJI_INTERVALS[at + 1] + 1);
  }
  return [...points].filter((point) => point >= LATIN1_LIMIT).sort((a, b) => a - b);
}

const HIGH_CLASS_RANGES: ReadonlyMap<number, readonly (readonly [number, number])[]> = (() => {
  const points = boundaries();
  const byClass = new Map<number, [number, number][]>();
  for (let at = 0; at + 1 < points.length; at++) {
    const cls = intervalClass(points[at]);
    if (cls < 2) continue;
    const ranges = byClass.get(cls) ?? [];
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[1] + 1 === points[at]) last[1] = points[at + 1] - 1;
    else ranges.push([points[at], points[at + 1] - 1]);
    byClass.set(cls, ranges);
  }
  return byClass;
})();

const HIGH_KEYWORD_RANGES: readonly (readonly [number, number])[] = (() => {
  const points = boundaries();
  const ranges: [number, number][] = [];
  for (let at = 0; at + 1 < points.length; at++) {
    if (intervalClass(points[at]) < 2) continue;
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[1] + 1 === points[at]) last[1] = points[at + 1] - 1;
    else ranges.push([points[at], points[at + 1] - 1]);
  }
  return ranges;
})();

class TableWordClasses implements WordClasses {
  private readonly bodies = new Map<boolean, string>();
  private classBodies: string[] | null = null;

  constructor(readonly spec: string, private readonly table: Uint8Array) {}

  classOf(character: string): number {
    const code = character.codePointAt(0)!;
    if (code < LATIN1_LIMIT) {
      if (code === 0x20 || code === 0x09 || code === 0 || code === 0xa0) return 0;
      return this.table[code] !== 0 ? 2 : 1;
    }
    return intervalClass(code);
  }

  isKeyword(character: string): boolean {
    const code = character.codePointAt(0)!;
    if (code < LATIN1_LIMIT) return code > 0 && this.table[code] !== 0;
    return intervalClass(code) >= 2;
  }

  keywordBody(excludeDigits: boolean): string {
    const cached = this.bodies.get(excludeDigits);
    if (cached !== undefined) return cached;
    const ranges: [number, number][] = [];
    for (let code = 1; code < LATIN1_LIMIT; code++) {
      if (this.table[code] === 0 || (excludeDigits && code >= 0x30 && code <= 0x39)) continue;
      const last = ranges[ranges.length - 1];
      if (last !== undefined && last[1] + 1 === code) last[1] = code;
      else ranges.push([code, code]);
    }
    const body = rangeBody([...ranges, ...HIGH_KEYWORD_RANGES]);
    this.bodies.set(excludeDigits, body);
    return body;
  }

  wordClassBodies(): readonly string[] {
    if (this.classBodies !== null) return this.classBodies;
    const latin1: [number, number][] = [];
    for (let code = 1; code < LATIN1_LIMIT; code++) {
      if (this.table[code] === 0 || code === 0x20 || code === 0x09 || code === 0xa0) continue;
      const last = latin1[latin1.length - 1];
      if (last !== undefined && last[1] + 1 === code) last[1] = code;
      else latin1.push([code, code]);
    }
    const bodies: string[] = [];
    for (const [cls, ranges] of HIGH_CLASS_RANGES) {
      bodies.push(rangeBody(cls === 2 ? [...latin1, ...ranges] : ranges));
    }
    this.classBodies = bodies;
    return bodies;
  }
}

const CACHE = new Map<string, WordClasses>();

export function wordClasses(spec: string): WordClasses | null {
  const cached = CACHE.get(spec);
  if (cached !== undefined) return cached;
  const table = parseIsKeyword(spec);
  if (table === null) return null;
  const classes = new TableWordClasses(spec, table);
  CACHE.set(spec, classes);
  return classes;
}

export const DEFAULT_WORD_CLASSES: WordClasses = wordClasses(DEFAULT_ISKEYWORD)!;
