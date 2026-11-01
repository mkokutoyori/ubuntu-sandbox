import { byteOffset, charCells, cursorVcol, type Pos } from './VimCursor';
import { DEFAULT_WORD_CLASSES, type WordClasses } from './VimCharClass';

export class VimPatternError extends Error {}

export interface VisualArea {
  readonly mode: 'visual' | 'visual-line' | 'visual-block';
  readonly anchor: Pos;
  readonly cursor: Pos;
}

export interface PatternContext {
  readonly lines: readonly string[];
  readonly tabstop: number;
  readonly cursor: Pos;
  readonly mark: (name: string) => Pos | null;
  readonly visual: VisualArea | null;
  readonly lastSubstitute?: string | null;
  readonly words?: WordClasses;
}

export interface PatternLayout {
  readonly needsBuffer: boolean;
  readonly matchesNewline: boolean;
  readonly groupSlots: readonly (number | undefined)[];
  readonly startMarks: readonly number[];
  readonly endMarks: readonly number[];
}

export interface TranslatedPattern extends PatternLayout {
  readonly source: string;
  readonly flags: string;
}

type MagicLevel = 'v' | 'm' | 'M' | 'V';

interface Tok {
  readonly ch: string;
  readonly magic: boolean;
}

interface Atom {
  readonly source: string;
  readonly unit: boolean;
  readonly group?: boolean;
  readonly literal?: string;
  readonly plain?: boolean;
}

interface Range {
  readonly lo: number;
  readonly hi: number;
}

const END: Tok = { ch: '', magic: false };

const INT_MAX = 0x7fffffff;

const NFA = '(NFA regexp)';

const META = '%&()*+.123456789<=>?@ACDFHIKLMOPSUVWXZ[_acdfhiklmnopsuvwxz{|~';

const BACKSLASH_ABBREVIATIONS: Readonly<Record<string, string>> = { r: '\r', t: '\t', e: '\u001b', b: '\b' };

const VERY_MAGIC_ONLY = '(){%+=?@!&|<>#"\',-:;`/';

const ANYTHING = '[^]';
const MARKS = '\\p{M}';
const INSIDE_CHARACTER = `(?!(?<=[^\\n])${MARKS})`;
const MARK_CHARACTER = /^\p{M}$/u;

const START_OF_LINE = '(?<![^\\n])';
const END_OF_LINE = '(?![^\\n])';
const START_OF_TEXT = '(?<![^])';
const END_OF_TEXT = '(?=\\n(?![^]))';

const CLASS_BODIES: Readonly<Record<string, string>> = {
  s: ' \\t',
  d: '0-9',
  w: '0-9A-Za-z_',
  a: 'A-Za-z',
  l: 'a-z',
  u: 'A-Z',
  x: '0-9A-Fa-f',
  o: '0-7',
  h: 'A-Za-z_',
  i: 'A-Za-z0-9_\\u00C0-\\u00FF',
  I: 'A-Za-z_\\u00C0-\\u00FF',
  f: 'A-Za-z0-9/.\\-_+,#$%~=\\u00C0-\\u00FF\\u{100}-\\u{10FFFF}',
  F: 'A-Za-z/.\\-_+,#$%~=\\u00C0-\\u00FF\\u{100}-\\u{10FFFF}',
  p: '\\u0020-\\u007E\\u00A1-\\u00FF\\u{100}-\\u{10FFFF}',
  P: '\\u0020-\\u002F\\u003A-\\u007E\\u00A1-\\u00FF\\u{100}-\\u{10FFFF}',
};

function isClassLetter(character: string): boolean {
  return character in CLASS_BODIES || character in NEGATED_CLASSES || character === 'k' || character === 'K';
}

const NEGATED_CLASSES: Readonly<Record<string, string>> = {
  S: 's', D: 'd', W: 'w', A: 'a', L: 'l', U: 'u', X: 'x', O: 'o', H: 'h',
};

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  lower: '\\p{Ll}',
  upper: '\\p{Lu}',
  space: ' \\t\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  cntrl: '\\u0000-\\u0009\\u000B-\\u001F\\u007F',
  graph: '!-~',
  print: ' -~\\u00A1-\\u00FF\\u{100}-\\u{10FFFF}',
  xdigit: '0-9A-Fa-f',
  return: '\\r',
  tab: '\\t',
  escape: '\\u001B',
  backspace: '\\b',
  ident: CLASS_BODIES.i,
  fname: CLASS_BODIES.f,
};

const RANGE_ESCAPES = ']^-n\\';

const ABBREVIATION_ESCAPES = 'nrtebdoxuU';

const COLLECTION_ESCAPES: Readonly<Record<string, number>> = {
  e: 0x1b, t: 0x09, r: 0x0d, b: 0x08, '\\': 0x5c, ']': 0x5d, '^': 0x5e, '-': 0x2d,
};

function hex(code: number): string {
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
}

function escapeLiteral(character: string): string {
  if (/[\^$\\.*+?()[\]{}|/]/.test(character)) return `\\${character}`;
  const code = character.codePointAt(0)!;
  if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return hex(code);
  return character;
}

function escapeInClass(code: number): string {
  const character = String.fromCodePoint(code);
  if (/[\\\]^\-[]/.test(character)) return `\\${character}`;
  if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return hex(code);
  return character;
}

const CASE_FAMILIES: readonly string[] = ['\u01C4\u01C5\u01C6', '\u01C7\u01C8\u01C9', '\u01CA\u01CB\u01CC', '\u01F1\u01F2\u01F3'];

function caseVariants(character: string): string[] {
  const variants = new Set<string>([character]);
  for (let round = 0; round < 2; round++) {
    for (const member of [...variants]) {
      for (const candidate of [member.toLowerCase(), member.toUpperCase()]) {
        if ([...candidate].length === 1) variants.add(candidate);
      }
      for (const family of CASE_FAMILIES) {
        if (family.includes(member)) for (const sibling of family) variants.add(sibling);
      }
    }
  }
  return [...variants];
}

function equivalentRanges(code: number): Range[] {
  const base = String.fromCodePoint(code).normalize('NFD')[0];
  const out: Range[] = [{ lo: base.codePointAt(0)!, hi: base.codePointAt(0)! }];
  for (let candidate = 0xc0; candidate <= 0x24f; candidate++) {
    if (String.fromCodePoint(candidate).normalize('NFD')[0] === base) out.push({ lo: candidate, hi: candidate });
  }
  return out;
}

function toggled(token: Tok): Tok {
  return { ch: token.ch, magic: !token.magic };
}

function plain(ch: string): Tok {
  return { ch, magic: false };
}

function special(ch: string, isMagic: boolean): Tok {
  return { ch, magic: isMagic };
}

function numberGroups(source: string): Map<string, number> {
  const indexes = new Map<string, number>();
  let count = 0;
  for (let at = 0; at < source.length; at++) {
    const character = source[at];
    if (character === '\\') {
      at++;
    } else if (character === '[') {
      at++;
      while (at < source.length && source[at] !== ']') {
        if (source[at] === '\\') at++;
        at++;
      }
    } else if (character === '(' && source[at + 1] === '?' && source[at + 2] === '<' && source[at + 3] !== '=' && source[at + 3] !== '!') {
      const close = source.indexOf('>', at);
      count++;
      indexes.set(source.slice(at + 3, close), count);
    }
  }
  return indexes;
}

function classAt(text: string, at: number): { name: string; next: number } | null {
  if (text[at] !== '[' || text[at + 1] !== ':') return null;
  const end = text.indexOf(':]', at + 2);
  if (end < 0) return null;
  const name = text.slice(at + 2, end);
  return name in POSIX_CLASSES || name === 'keyword' ? { name, next: end + 2 } : null;
}

function elementAt(text: string, at: number, marker: '=' | '.'): { code: number; next: number } | null {
  if (text[at] !== '[' || text[at + 1] !== marker) return null;
  const code = text.codePointAt(at + 2);
  if (code === undefined) return null;
  const width = String.fromCodePoint(code).length;
  if (text[at + 2 + width] !== marker || text[at + 3 + width] !== ']') return null;
  return { code, next: at + 4 + width };
}

function skipAnyof(text: string, from: number): number {
  let at = from;
  if (text[at] === '^') at++;
  if (text[at] === ']' || text[at] === '-') at++;
  while (at < text.length && text[at] !== ']') {
    const character = text[at];
    if (character === '-') {
      at++;
      if (at < text.length && text[at] !== ']') at += String.fromCodePoint(text.codePointAt(at)!).length;
    } else if (character === '\\' && at + 1 < text.length && (RANGE_ESCAPES.includes(text[at + 1]) || ABBREVIATION_ESCAPES.includes(text[at + 1]))) {
      at += 2;
    } else if (character === '[') {
      at = (classAt(text, at) ?? elementAt(text, at, '=') ?? elementAt(text, at, '.'))?.next ?? at + 1;
    } else {
      at += String.fromCodePoint(text.codePointAt(at)!).length;
    }
  }
  return at;
}

export function skipRegexp(text: string, from: number, delimiter: string): number {
  let at = from;
  let noMagic = false;
  for (; at < text.length; at++) {
    const character = text[at];
    if (character === delimiter) break;
    const collection = (character === '[' && !noMagic) || (character === '\\' && text[at + 1] === '[' && noMagic);
    if (collection) {
      at = skipAnyof(text, at + 1);
      if (at >= text.length) break;
    } else if (character === '\\' && at + 1 < text.length) {
      at++;
      if (text[at] === 'v') noMagic = false;
      else if (text[at] === 'V') noMagic = true;
    }
  }
  return at;
}

function patternMagicLevel(pattern: string): number {
  let magic = 3;
  for (let at = 0; at < pattern.length; at++) {
    const character = pattern[at];
    if ((character === '[' && magic >= 3) || (character === '\\' && pattern[at + 1] === '[' && magic <= 2)) {
      at = skipAnyof(pattern, at + 1);
      if (at >= pattern.length) break;
    } else if (character === '\\' && at + 1 < pattern.length) {
      at++;
      if (pattern[at] === 'v') magic = 4;
      else if (pattern[at] === 'V') magic = 1;
    }
  }
  return magic;
}

export function patternHasUppercase(pattern: string): boolean {
  const magic = patternMagicLevel(pattern);
  let at = 0;
  while (at < pattern.length) {
    const code = pattern.codePointAt(at)!;
    if (code >= 0x80) {
      const character = String.fromCodePoint(code);
      if (character.toLowerCase() !== character) return true;
      at += character.length;
      continue;
    }
    const character = pattern[at];
    if (character === '\\' && magic <= 3) {
      const next = pattern[at + 1];
      if ((next === '_' || next === '%') && at + 2 < pattern.length) at += 3;
      else at += next === undefined ? 1 : 2;
    } else if ((character === '%' || character === '_') && magic === 4) {
      at += pattern[at + 1] === undefined ? 1 : 2;
    } else if (character >= 'A' && character <= 'Z') {
      return true;
    } else {
      at++;
    }
  }
  return false;
}

class Translator {
  private position = 0;
  private level: MagicLevel = 'm';
  private atStart = true;
  private previousAtStart = false;
  private previous: Tok = END;
  private beforePrevious: Tok = END;
  private current: Tok | null = null;
  private currentLength = 0;
  private sawIgnoreCase = false;
  private sawMatchCase = false;
  private userGroups = 0;
  private readonly closedGroups = new Set<number>();
  private internalGroups = 0;
  private readonly startMarks: string[] = [];
  private readonly endMarks: string[] = [];
  private usesBackReference = false;
  private needsBuffer = false;
  private matchesNewline = false;
  private emptyTilde = false;
  private readonly ignoreComposing: boolean;

  constructor(private readonly pattern: string, private readonly ignoreCase: boolean, private readonly context: PatternContext | null) {
    this.ignoreComposing = /(^|[^\\])(\\\\)*\\Z/.test(pattern);
  }

  static run(pattern: string, ignoreCase: boolean, context: PatternContext | null): TranslatedPattern {
    const first = new Translator(pattern, ignoreCase, context);
    const result = first.translate();
    const decided = first.sawIgnoreCase ? true : first.sawMatchCase ? false : ignoreCase;
    return decided === ignoreCase ? result : new Translator(pattern, decided, context).translate();
  }

  private translate(): TranslatedPattern {
    const source = this.parseAlternatives();
    if (this.peek() !== END) {
      throw new VimPatternError(this.level === 'v' ? 'E55: Unmatched )' : 'E55: Unmatched \\)');
    }
    const indexes = numberGroups(source);
    const bounded = `${INSIDE_CHARACTER}(?:${source})${INSIDE_CHARACTER}`;
    const slots: (number | undefined)[] = [undefined];
    for (let n = 1; n <= 9; n++) slots.push(indexes.get(`v${n}`));
    const marks = (names: readonly string[]): number[] => names.map((name) => indexes.get(name)!);
    return {
      source: bounded,
      flags: `dgu${this.ignoreCase && this.usesBackReference ? 'i' : ''}`,
      needsBuffer: this.needsBuffer,
      matchesNewline: this.matchesNewline,
      groupSlots: slots,
      startMarks: marks(this.startMarks),
      endMarks: marks(this.endMarks),
    };
  }

  private fail(message: string): never {
    throw new VimPatternError(message);
  }

  private peek(): Tok {
    if (this.current === null) this.current = this.read(this.position, false);
    return this.current;
  }

  private isMagic(character: string): boolean {
    const token = this.peek();
    return token.magic && token.ch === character;
  }

  private skip(keepStart = false): void {
    const token = this.peek();
    const savedAtStart = this.previousAtStart;
    const savedPrevious = this.previous;
    const savedBeforePrevious = this.beforePrevious;
    this.previousAtStart = this.atStart;
    this.atStart = false;
    this.beforePrevious = this.previous;
    this.previous = token;
    this.position += this.currentLength;
    this.current = null;
    if (keepStart) {
      this.atStart = savedAtStart;
      this.previous = savedPrevious;
      this.beforePrevious = savedBeforePrevious;
    }
  }

  private read(at: number, afterSlash: boolean): Tok {
    const text = this.pattern;
    if (at >= text.length) {
      this.currentLength = 0;
      return END;
    }
    const ch = String.fromCodePoint(text.codePointAt(at)!);
    this.currentLength = ch.length;
    const level = this.level;
    const magicOn = level === 'm' || level === 'v';
    const veryMagic = level === 'v';
    if (ch === '.' || ch === '[' || ch === '~') return special(ch, magicOn);
    if (VERY_MAGIC_ONLY.includes(ch)) return special(ch, veryMagic);
    if (ch === '*') {
      const operator =
        magicOn &&
        !this.atStart &&
        !(this.previousAtStart && this.previous.magic && this.previous.ch === '^') &&
        (afterSlash || !(this.previous.magic && '(&|'.includes(this.previous.ch)));
      return special(ch, operator);
    }
    if (ch === '^') {
      const before = this.previous;
      const anchored =
        level !== 'V' &&
        (this.atStart ||
          veryMagic ||
          (before.magic && '(|&n'.includes(before.ch)) ||
          (!before.magic && before.ch === '(' && this.beforePrevious.magic && this.beforePrevious.ch === '%'));
      if (anchored) this.atStart = true;
      return special(ch, anchored);
    }
    if (ch === '$') return special(ch, level !== 'V' && this.dollarAnchors(at + 1));
    if (ch !== '\\') return plain(ch);
    if (at + 1 >= text.length) return plain('\\');
    const next = String.fromCodePoint(text.codePointAt(at + 1)!);
    if (META.includes(next)) {
      this.previousAtStart = this.atStart;
      this.atStart = false;
      const inner = this.read(at + 1, true);
      this.currentLength += 1;
      return toggled(inner);
    }
    this.currentLength = 1 + next.length;
    if (next in BACKSLASH_ABBREVIATIONS) return plain(BACKSLASH_ABBREVIATIONS[next]);
    if (level === 'V' && (next === '$' || next === '^')) return special(next, true);
    return plain(next);
  }

  private dollarAnchors(from: number): boolean {
    const text = this.pattern;
    let at = from;
    let all = this.level === 'v';
    while (text[at] === '\\' && 'cCmMvVZ'.includes(text[at + 1] ?? ' ')) {
      if (text[at + 1] === 'v') all = true;
      else if ('mMV'.includes(text[at + 1])) all = false;
      at += 2;
    }
    if (at >= text.length) return true;
    if (text[at] === '\\' && '|&)n'.includes(text[at + 1] ?? ' ')) return true;
    return this.level === 'v' || (all && '|&)'.includes(text[at]));
  }

  private changeLevel(level: MagicLevel): void {
    this.level = level;
    this.skip(true);
    this.current = null;
  }

  private parseAlternatives(): string {
    const branches = [this.parseBranch()];
    while (this.isMagic('|')) {
      this.skip();
      branches.push(this.parseBranch());
    }
    return branches.join('|');
  }

  private parseBranch(): string {
    const concats = [this.parseConcat()];
    while (this.isMagic('&')) {
      this.skip();
      concats.push(this.parseConcat());
    }
    const last = concats.pop()!;
    return concats.map((concat) => `(?=${concat})`).join('') + last;
  }

  private parseConcat(): string {
    let out = '';
    let pieces = 0;
    let emptyPieces = 0;
    for (;;) {
      const token = this.peek();
      if (token === END) break;
      if (token.magic && (token.ch === '|' || token.ch === '&' || token.ch === ')')) break;
      if (token.magic && token.ch === 'Z') { this.skip(true); continue; }
      if (token.magic && token.ch === 'c') { this.sawIgnoreCase = true; this.skip(true); continue; }
      if (token.magic && token.ch === 'C') { this.sawMatchCase = true; this.skip(true); continue; }
      if (token.magic && token.ch === 'v') { this.changeLevel('v'); continue; }
      if (token.magic && token.ch === 'm') { this.changeLevel('m'); continue; }
      if (token.magic && token.ch === 'M') { this.changeLevel('M'); continue; }
      if (token.magic && token.ch === 'V') { this.changeLevel('V'); continue; }
      this.emptyTilde = false;
      const piece = this.parsePiece();
      pieces++;
      if (this.emptyTilde) emptyPieces++;
      out += piece;
    }
    if (emptyPieces > 0 && pieces > 1) this.fail(`E874: ${NFA} Could not pop the stack!`);
    this.emptyTilde = false;
    return out;
  }

  private isMulti(token: Tok): boolean {
    return token.magic && '*+=?@{'.includes(token.ch);
  }

  private composing(atom: Atom): Atom {
    if (!atom.unit || atom.plain === true || atom.group === true) return atom;
    if (atom.literal === undefined) return { ...atom, source: `(?:${atom.source}${MARKS}*(?!${MARKS}))` };
    if (MARK_CHARACTER.test(atom.literal)) return { ...atom, source: this.ignoreComposing ? '(?:)' : `(?:${atom.source}${MARKS}*)` };
    if (this.ignoreComposing) return { ...atom, source: `(?:${atom.source}${MARKS}*)` };
    return atom;
  }

  private parsePiece(): string {
    const atom = this.composing(this.parseAtom());
    if (!this.isMulti(this.peek())) return atom.source;
    if (this.emptyTilde) this.fail(`E874: ${NFA} Could not pop the stack!`);
    const operator = this.peek().ch;
    this.skip();
    const wrapped = atom.unit ? atom.source : `(?:${atom.source})`;
    let result: string;
    switch (operator) {
      case '*': result = `${wrapped}*`; break;
      case '+': result = `${wrapped}+`; break;
      case '=':
      case '?': result = atom.group ? `(?:${atom.source}|)` : `${wrapped}?`; break;
      case '{': result = this.braces(wrapped); break;
      default: result = this.lookAround(atom.source);
    }
    if (this.isMulti(this.peek())) this.fail(`E871: ${NFA} Can't have a multi follow a multi`);
    return result;
  }

  private braces(wrapped: string): string {
    const text = this.pattern;
    let at = this.position;
    let lazy = false;
    if (text[at] === '-') { lazy = true; at++; }
    const digits = (): string => {
      let out = '';
      while (/[0-9]/.test(text[at] ?? '')) out += text[at++];
      return out;
    };
    const first = digits();
    let min = first === '' ? 0 : Number(first);
    let max: number;
    if (text[at] === ',') {
      at++;
      const second = digits();
      max = second === '' ? Infinity : Number(second);
    } else {
      max = first === '' ? Infinity : min;
    }
    if (text[at] === '\\') at++;
    if (text[at] !== '}') this.fail(`E554: Syntax error in ${this.level === 'v' ? '' : '\\'}{...}`);
    this.position = at + 1;
    this.current = null;
    if (min > max) [min, max] = [max, min];
    const suffix = lazy ? '?' : '';
    if (min === max) return `${wrapped}{${min}}${suffix}`;
    return `${wrapped}{${min},${max === Infinity ? '' : max}}${suffix}`;
  }

  private lookAround(source: string): string {
    const text = this.pattern;
    let at = this.position;
    while (/[0-9]/.test(text[at] ?? '')) at++;
    const limit = at > this.position ? Number(text.slice(this.position, at)) : 0;
    const rest = text.slice(at);
    const forms: readonly string[] = ['<=', '<!', '=', '!', '>'];
    for (const kind of forms) {
      if (!rest.startsWith(kind)) continue;
      if (limit > 0 && !kind.startsWith('<')) this.fail(`E869: ${NFA} Unknown operator '\\@${text.slice(this.position, at)}${kind}'`);
      this.position = at + kind.length;
      this.current = null;
      if (kind === '=') return `(?=${source})`;
      if (kind === '!') return `(?!${source})`;
      if (kind === '>') {
        const name = `a${this.internalGroups++}`;
        return `(?=(?<${name}>${source}))\\k<${name}>`;
      }
      if (limit === 0) return kind === '<=' ? `(?<=${source})` : `(?<!${source})`;
      const name = `lb${this.internalGroups++}`;
      const body = `(?=[^]{0,${limit}}\\k<${name}>(?![^]))${source}`;
      return `(?=(?<${name}>[^]*))${kind === '<=' ? `(?<=${body})` : `(?<!${body})`}`;
    }
    return this.fail(`E869: ${NFA} Unknown operator '\\@${rest[0] ?? ''}'`);
  }

  private parseAtom(): Atom {
    const token = this.peek();
    if (!token.magic) {
      this.skip();
      return this.literal(token.ch);
    }
    switch (token.ch) {
      case '^': this.skip(); return { source: START_OF_LINE, unit: false };
      case '$': this.skip(); return { source: END_OF_LINE, unit: false };
      case '<': this.skip(); return { source: `(?:${this.wordClassBodies().map((body) => `(?<![${body}])(?=[${body}])`).join('|')})`, unit: false };
      case '>': this.skip(); return { source: `(?:${this.wordClassBodies().map((body) => `(?<=[${body}])(?![${body}])`).join('|')})`, unit: false };
      case '.': this.skip(); return { source: '[^\\n]', unit: true };
      case 'n': this.skip(); this.matchesNewline = true; return { source: '\\n', unit: true, plain: true };
      case '(': this.skip(); return this.group(true);
      case '_': this.skip(); return this.underscore();
      case '[': return this.collection(false);
      case '%': this.skip(); return this.percent();
      case 'z': this.skip(); return this.zeroWidthMark();
      case '~': {
        const previous = this.context?.lastSubstitute ?? null;
        if (previous === null) return this.fail('E33: No previous substitute regular expression');
        this.skip();
        if (previous === '') {
          this.emptyTilde = true;
          return { source: '', unit: false };
        }
        return { source: `(?:${[...previous].map((character) => this.literal(character).source).join('')})`, unit: true, group: true };
      }
      case '*':
      case '+':
      case '=':
      case '?':
      case '@':
      case '{': return this.fail(`E866: ${NFA} Misplaced ${token.ch}`);
      default:
    }
    if (token.ch >= '1' && token.ch <= '9') {
      this.skip();
      return this.backReference(Number(token.ch));
    }
    if (isClassLetter(token.ch)) {
      this.skip();
      return { source: this.classSource(token.ch, false), unit: true };
    }
    this.skip();
    return this.literal(token.ch);
  }

  private literal(character: string): Atom {
    if (this.ignoreCase) {
      const variants = caseVariants(character);
      if (variants.length > 1) return { source: `[${variants.map((variant) => escapeInClass(variant.codePointAt(0)!)).join('')}]`, unit: true, literal: character };
    }
    return { source: escapeLiteral(character), unit: true, literal: character };
  }

  private wordClassBodies(): readonly string[] {
    return (this.context?.words ?? DEFAULT_WORD_CLASSES).wordClassBodies();
  }

  private keywordBody(excludeDigits: boolean): string {
    return (this.context?.words ?? DEFAULT_WORD_CLASSES).keywordBody(excludeDigits);
  }

  private classBody(name: string): string {
    if (name === 'k') return this.keywordBody(false);
    if (name === 'K') return this.keywordBody(true);
    return CLASS_BODIES[name];
  }

  private classSource(name: string, withNewline: boolean): string {
    const negated = name in NEGATED_CLASSES;
    const body = this.classBody(negated ? NEGATED_CLASSES[name] : name);
    if (negated) return withNewline ? `[^${body}]` : `[^${body}\\n]`;
    return withNewline ? `[${body}\\n]` : `[${body}]`;
  }

  private underscore(): Atom {
    const text = this.pattern;
    if (this.position >= text.length) return this.fail('E865: (NFA) Regexp end encountered prematurely');
    const next = String.fromCodePoint(text.codePointAt(this.position)!);
    this.position += next.length;
    this.current = null;
    if (next === '^') return { source: START_OF_LINE, unit: false };
    if (next === '$') return { source: END_OF_LINE, unit: false };
    this.matchesNewline = true;
    if (next === '.') return { source: ANYTHING, unit: true };
    if (next === '[') return this.collection(true);
    if (isClassLetter(next)) return { source: this.classSource(next, true), unit: true };
    return this.fail(`E877: ${NFA} Invalid character class: ${next.codePointAt(0)}`);
  }

  private group(capture: boolean): Atom {
    let name = '';
    if (capture) {
      if (this.userGroups >= 9) this.fail(`E872: ${NFA} Too many '('`);
      this.userGroups++;
      name = `v${this.userGroups}`;
    }
    const slot = this.userGroups;
    const inner = this.parseAlternatives();
    if (!this.isMagic(')')) {
      this.fail(capture ? (this.level === 'v' ? 'E54: Unmatched (' : 'E54: Unmatched \\(') : (this.level === 'v' ? 'E53: Unmatched %(' : 'E53: Unmatched \\%('));
    }
    this.skip();
    if (capture) this.closedGroups.add(slot);
    return { source: capture ? `(?<${name}>${inner})` : `(?:${inner})`, unit: true, group: true };
  }

  private backReference(n: number): Atom {
    if (!this.closedGroups.has(n)) this.fail('E65: Illegal back reference');
    this.usesBackReference = true;
    return { source: `\\k<v${n}>`, unit: true };
  }

  private zeroWidthMark(): Atom {
    const next = this.pattern[this.position];
    if (next === 's' || next === 'e') {
      this.position++;
      this.current = null;
      const marks = next === 's' ? this.startMarks : this.endMarks;
      const name = `z${next}${marks.length}`;
      marks.push(name);
      return { source: `(?<${name}>)`, unit: false };
    }
    if (next === '(') return this.fail('E66: \\z( not allowed here');
    if (next !== undefined && next >= '1' && next <= '9') return this.fail('E67: \\z1 - \\z9 not allowed here');
    return this.fail(next === undefined ? `E867: ${NFA} Unknown operator '\\z` : `E867: ${NFA} Unknown operator '\\z${next}'`);
  }

  private readNumber(radix: number, width: number): number | null {
    const allowed = radix === 10 ? /[0-9]/ : radix === 8 ? /[0-7]/ : /[0-9a-fA-F]/;
    let digits = '';
    while (digits.length < width && allowed.test(this.pattern[this.position + digits.length] ?? '')) {
      digits += this.pattern[this.position + digits.length];
    }
    if (digits === '') return null;
    this.position += digits.length;
    return parseInt(digits, radix);
  }

  private percent(): Atom {
    const text = this.pattern;
    const next = text[this.position];
    if (next === undefined) return this.fail(`E867: ${NFA} Unknown operator '\\%`);
    this.position++;
    this.current = null;
    if (next === '(') {
      this.beforePrevious = this.previous;
      this.previous = plain('(');
      return this.group(false);
    }
    if (next === '^') { this.needsBuffer = true; return { source: START_OF_TEXT, unit: false }; }
    if (next === '$') { this.needsBuffer = true; return { source: END_OF_TEXT, unit: false }; }
    if (next === '[') return this.optionalSequence();
    if (next === 'C') return { source: '\\p{M}*', unit: false };
    const widths: Readonly<Record<string, readonly [number, number]>> = {
      d: [10, 10], o: [8, 4], x: [16, 2], u: [16, 4], U: [16, 8],
    };
    if (next in widths) {
      const [radix, width] = widths[next];
      const code = this.readNumber(radix, width);
      if (code === null || code > INT_MAX) return this.fail('E678: Invalid character after \\%[dxouU]');
      return code > 0x10ffff ? { source: '(?!)', unit: false } : this.literal(String.fromCodePoint(code));
    }
    if (next === '#') return { source: this.exactPosition(this.context?.cursor ?? null), unit: false };
    if (next === 'V') return { source: this.visualArea(), unit: false };
    if (/[0-9<>.']/.test(next) || next === 'c' || next === 'l' || next === 'v') {
      this.position--;
      return this.positionAtom();
    }
    return this.fail(`E867: ${NFA} Unknown operator '\\%${next}'`);
  }

  private count(low: number, high: number): string {
    if (low === high) return `{${low}}`;
    return Number.isFinite(high) ? `{${low},${high}}` : `{${low},}`;
  }

  private band(firstLine: number, lastLine: number, firstColumn: number, lastColumn: number): string {
    if (firstLine > lastLine || firstColumn > lastColumn) return '(?!)';
    this.needsBuffer = true;
    return `(?<=${START_OF_TEXT}(?:[^\\n]*\\n)${this.count(firstLine, lastLine)}[^\\n]${this.count(firstColumn, lastColumn)})`;
  }

  private codePointColumn(position: Pos): number {
    const line = this.context?.lines[position.line];
    return line === undefined ? position.col : [...line.slice(0, position.col)].length;
  }

  private exactPosition(position: Pos | null): string {
    if (position === null) return '(?!)';
    const column = this.codePointColumn(position);
    return this.band(position.line, position.line, column, column);
  }

  private beforePosition(position: Pos | null): string {
    if (position === null) return '(?!)';
    return `(?:${this.band(0, position.line - 1, 0, Infinity)}|${this.band(position.line, position.line, 0, this.codePointColumn(position) - 1)})`;
  }

  private afterPosition(position: Pos | null): string {
    if (position === null) return '(?!)';
    return `(?:${this.band(position.line + 1, Infinity, 0, Infinity)}|${this.band(position.line, position.line, this.codePointColumn(position) + 1, Infinity)})`;
  }

  private visualArea(): string {
    const area = this.context?.visual ?? null;
    if (area === null) return '(?!)';
    const before = area.anchor.line < area.cursor.line || (area.anchor.line === area.cursor.line && area.anchor.col <= area.cursor.col);
    const first = before ? area.anchor : area.cursor;
    const last = before ? area.cursor : area.anchor;
    const firstColumn = this.codePointColumn(first);
    const lastColumn = this.codePointColumn(last);
    if (area.mode === 'visual-line') return this.band(first.line, last.line, 0, Infinity);
    if (area.mode === 'visual-block') {
      const left = Math.min(this.codePointColumn(area.anchor), this.codePointColumn(area.cursor));
      const right = Math.max(this.codePointColumn(area.anchor), this.codePointColumn(area.cursor));
      return this.band(first.line, last.line, left, right);
    }
    if (first.line === last.line) return this.band(first.line, first.line, firstColumn, lastColumn);
    const parts = [
      this.band(first.line, first.line, firstColumn, Infinity),
      this.band(first.line + 1, last.line - 1, 0, Infinity),
      this.band(last.line, last.line, 0, lastColumn),
    ];
    return `(?:${parts.join('|')})`;
  }

  private cursorNumber(kind: 'l' | 'c' | 'v'): number {
    const cursor = this.context?.cursor;
    if (cursor === undefined || this.context === null) return 0;
    if (kind === 'l') return cursor.line + 1;
    const line = this.context.lines[cursor.line] ?? '';
    return kind === 'c' ? byteOffset(line, cursor.col) + 1 : cursorVcol(line, cursor.col, this.context.tabstop, false) + 1;
  }

  private positionAtom(): Atom {
    const text = this.pattern;
    let comparison: '' | '<' | '>' = '';
    if (text[this.position] === '<' || text[this.position] === '>') comparison = text[this.position++] as '<' | '>';
    if (text[this.position] === "'") {
      const name = text[this.position + 1];
      this.position += name === undefined ? 1 : 2;
      this.current = null;
      if (name === undefined) return { source: '(?!)', unit: false };
      const mark = this.context?.mark(name) ?? null;
      const source = comparison === '<' ? this.beforePosition(mark) : comparison === '>' ? this.afterPosition(mark) : this.exactPosition(mark);
      return { source, unit: false };
    }
    let number: number | null;
    if (text[this.position] === '.') {
      this.position++;
      const kind = text[this.position];
      if (kind !== 'l' && kind !== 'c' && kind !== 'v') return this.fail(`E867: ${NFA} Unknown operator '\\%`);
      number = this.cursorNumber(kind);
    } else {
      number = this.readNumber(10, 10);
      if (number !== null && number > INT_MAX) this.fail('E951: \\% value too large');
    }
    const kind = text[this.position];
    if (kind !== 'l' && kind !== 'c' && kind !== 'v') {
      return this.fail(`E867: ${NFA} Unknown operator '\\%${comparison}${number ?? ''}${kind ?? ''}'`);
    }
    this.position++;
    this.current = null;
    if (number === null) return this.fail(`E1273: ${NFA} missing value in '\\%${kind}'`);
    if (number === 0) return { source: comparison === '>' ? '(?:)' : '(?!)', unit: false };
    if (kind === 'l') {
      if (comparison === '') return { source: this.band(number - 1, number - 1, 0, Infinity), unit: false };
      return { source: comparison === '<' ? this.band(0, number - 2, 0, Infinity) : this.band(number, Infinity, 0, Infinity), unit: false };
    }
    return { source: this.columnTest(kind, comparison, number), unit: false };
  }

  private columnTest(kind: 'c' | 'v', comparison: '' | '<' | '>', number: number): string {
    const simple = kind === 'c' ? '[\\x00-\\x09\\x0b-\\x7f]' : '[\\x20-\\x7e]';
    const alternatives: string[] = [];
    if (comparison === '') alternatives.push(`(?<=${START_OF_LINE}${simple}${this.count(number - 1, number - 1)})`);
    else if (comparison === '>') alternatives.push(`(?<=${START_OF_LINE}${simple}${this.count(number, Infinity)})`);
    else if (number > 1) alternatives.push(`(?<=${START_OF_LINE}${simple}${this.count(0, number - 2)})`);
    const context = this.context;
    if (context !== null) {
      const widest = kind === 'c' ? 0x7f : 0x7e;
      const narrowest = kind === 'c' ? 0 : 0x20;
      context.lines.forEach((line, index) => {
        if ([...line].every((character) => character.codePointAt(0)! >= narrowest && character.codePointAt(0)! <= widest)) return;
        const columns = this.columnsOf(line, kind, context.tabstop);
        const matching = columns.map((column, offset) => (comparison === '' ? column === number : comparison === '<' ? column < number : column > number) ? offset : -1).filter((offset) => offset >= 0);
        if (matching.length > 0) alternatives.push(this.band(index, index, matching[0], matching[matching.length - 1]));
      });
    }
    return alternatives.length === 0 ? '(?!)' : `(?:${alternatives.join('|')})`;
  }

  private columnsOf(line: string, kind: 'c' | 'v', tabstop: number): number[] {
    const columns: number[] = [];
    let bytes = 0;
    let cells = 0;
    for (const character of line) {
      columns.push(kind === 'c' ? bytes + 1 : cells + 1);
      bytes += byteOffset(character, character.length);
      cells += charCells(character, cells, tabstop);
    }
    columns.push(kind === 'c' ? bytes + 1 : cells + 1);
    return columns;
  }

  private optionalSequence(): Atom {
    const text = this.pattern;
    const atoms: string[] = [];
    for (;;) {
      if (this.position >= text.length) return this.fail('E69: Missing ] after \\%[');
      if (text[this.position] === ']') break;
      atoms.push(this.parseAtom().source);
    }
    this.position++;
    this.current = null;
    if (atoms.length === 0) return this.fail('E70: Empty \\%[]');
    let out = '';
    for (let i = atoms.length - 1; i >= 0; i--) out = `(?:${atoms[i]}${out})?`;
    return { source: out, unit: false };
  }

  private collection(afterUnderscore: boolean): Atom {
    const opening = this.peek();
    const parsed = this.parseCollection(afterUnderscore ? this.position : this.position + this.currentLength, afterUnderscore);
    if (parsed === null) {
      if (afterUnderscore) return this.fail('E769: Missing ] after \\_[');
      this.skip();
      return this.literal('[');
    }
    this.previousAtStart = this.atStart;
    this.atStart = false;
    this.beforePrevious = this.previous;
    this.previous = afterUnderscore ? this.previous : opening;
    this.position = parsed.next;
    this.current = null;
    return { source: this.collectionSource(parsed), unit: true };
  }

  private parseCollection(from: number, withNewline: boolean): CollectionParse | null {
    const text = this.pattern;
    const end = skipAnyof(text, from);
    if (text[end] !== ']') return null;
    let at = from;
    let negate = false;
    if (text[at] === '^') { negate = true; at++; }
    const ranges: Range[] = [];
    const classes: string[] = [];
    let newline = withNewline;
    let startCode: number | null = null;
    let pendingRange = false;
    const single = (code: number): void => { ranges.push({ lo: code, hi: code }); };
    if (text[at] === '-') { single(0x2d); startCode = 0x2d; at++; }
    while (at < end) {
      const previousCode: number | null = startCode;
      startCode = null;
      const posixClass = classAt(this.pattern, at);
      const equivalence = posixClass === null ? elementAt(this.pattern, at, '=') : null;
      if (posixClass !== null || equivalence !== null) {
        if (posixClass !== null) {
          classes.push(posixClass.name === 'keyword' ? this.keywordBody(false) : POSIX_CLASSES[posixClass.name]);
          at = posixClass.next;
        } else {
          ranges.push(...equivalentRanges(equivalence!.code));
          at = equivalence!.next;
        }
        pendingRange = false;
        continue;
      }
      const collating = elementAt(this.pattern, at, '.');
      if (collating !== null) {
        startCode = collating.code;
        at = collating.next;
      } else {
        if (text[at] === '-' && previousCode !== null) {
          pendingRange = true;
          startCode = previousCode;
          at++;
          continue;
        }
        const item = this.collectionChar(at)!;
        at = item.next;
        if (item.newline) { newline = true; continue; }
        startCode = item.code;
      }
      if (pendingRange) {
        if (previousCode! > startCode) this.fail('E944: Reverse range in character class');
        ranges.push({ lo: previousCode!, hi: startCode });
        pendingRange = false;
        startCode = null;
      } else {
        single(startCode);
      }
    }
    if (pendingRange) single(0x2d);
    return { negate, newline, ranges, classes, next: end + 1 };
  }

  private collectionChar(at: number): { code: number; next: number; newline: boolean } | null {
    const text = this.pattern;
    if (at >= text.length) return null;
    if (text[at] !== '\\') {
      const code = text.codePointAt(at)!;
      return { code, next: at + String.fromCodePoint(code).length, newline: false };
    }
    const next = text[at + 1];
    if (next === undefined) return { code: 0x5c, next: at + 1, newline: false };
    if (next in COLLECTION_ESCAPES) return { code: COLLECTION_ESCAPES[next], next: at + 2, newline: false };
    if (next === 'n') return { code: 0x0a, next: at + 2, newline: true };
    const forms: Readonly<Record<string, readonly [number, number]>> = {
      d: [10, 10], o: [8, 4], x: [16, 2], u: [16, 4], U: [16, 8],
    };
    if (next in forms) {
      const [radix, width] = forms[next];
      const allowed = radix === 10 ? /[0-9]/ : radix === 8 ? /[0-7]/ : /[0-9a-fA-F]/;
      let digits = '';
      while (digits.length < width && allowed.test(text[at + 2 + digits.length] ?? '')) digits += text[at + 2 + digits.length];
      if (digits !== '') return { code: parseInt(digits, radix), next: at + 2 + digits.length, newline: false };
    }
    return { code: 0x5c, next: at + 1, newline: false };
  }

  private collectionSource(parsed: CollectionParse): string {
    if (parsed.newline) this.matchesNewline = true;
    const pieces: string[] = [];
    for (const range of parsed.ranges) {
      pieces.push(range.lo === range.hi ? escapeInClass(range.lo) : `${escapeInClass(range.lo)}-${escapeInClass(range.hi)}`);
      if (this.ignoreCase) pieces.push(...this.foldedRanges(range));
    }
    pieces.push(...parsed.classes);
    const body = pieces.join('');
    if (parsed.negate) {
      return `[^${body}${parsed.newline ? '' : '\\n'}]`;
    }
    if (body === '') return parsed.newline ? '\\n' : '(?!)';
    return parsed.newline ? `[${body}\\n]` : `[${body}]`;
  }

  private foldedRanges(range: Range): string[] {
    const out: string[] = [];
    const lowerLo = Math.max(range.lo, 0x61);
    const lowerHi = Math.min(range.hi, 0x7a);
    if (lowerLo <= lowerHi) out.push(`${escapeInClass(lowerLo - 32)}-${escapeInClass(lowerHi - 32)}`);
    const upperLo = Math.max(range.lo, 0x41);
    const upperHi = Math.min(range.hi, 0x5a);
    if (upperLo <= upperHi) out.push(`${escapeInClass(upperLo + 32)}-${escapeInClass(upperHi + 32)}`);
    if (range.hi > 0x7f && range.hi - Math.max(range.lo, 0x80) <= 0x1000) {
      for (let code = Math.max(range.lo, 0x80); code <= range.hi; code++) {
        for (const variant of caseVariants(String.fromCodePoint(code))) {
          const variantCode = variant.codePointAt(0)!;
          if (variantCode < range.lo || variantCode > range.hi) out.push(escapeInClass(variantCode));
        }
      }
    }
    return out;
  }
}

interface CollectionParse {
  readonly negate: boolean;
  readonly newline: boolean;
  readonly ranges: readonly Range[];
  readonly classes: readonly string[];
  readonly next: number;
}

export function translateVimPattern(pattern: string, ignoreCase: boolean, context: PatternContext | null = null): TranslatedPattern {
  return Translator.run(pattern, ignoreCase, context);
}
