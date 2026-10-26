export class PosixRegexError extends Error {}

const MESSAGES = {
  pattern: 'Invalid regular expression',
  collate: 'Invalid collation character',
  ctype: 'Invalid character class name',
  escape: 'Trailing backslash',
  subreg: 'Invalid back reference',
  bracket: 'Unmatched [, [^, [:, [., or [=',
  paren: 'Unmatched ( or \\(',
  brace: 'Unmatched \\{',
  badBrace: 'Invalid content of \\{\\}',
  range: 'Invalid range end',
  repeat: 'Invalid preceding regular expression',
  size: 'Regular expression too big',
} as const;

const DUP_MAX = 0x7fff;
const WORD = '\\p{L}\\p{N}_';
const SPACE = ' \\t\\n\\v\\f\\r';

const CLASS_BODIES: Readonly<Record<string, string>> = {
  alpha: '\\p{L}',
  digit: '0-9',
  alnum: '\\p{L}\\p{N}',
  upper: '\\p{Lu}',
  lower: '\\p{Ll}',
  space: SPACE,
  blank: ' \\t',
  punct: '\\p{P}\\p{S}',
  print: '\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}\\p{Zs}',
  graph: '\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}',
  cntrl: '\\p{Cc}',
  xdigit: '0-9A-Fa-f',
};

const NOT_AT_WORD_START = `(?<![${WORD}])(?=[${WORD}])`;
const NOT_AT_WORD_END = `(?<=[${WORD}])(?![${WORD}])`;

const ANCHORS: Readonly<Record<string, string>> = {
  '<': NOT_AT_WORD_START,
  '>': NOT_AT_WORD_END,
  b: `(?:${NOT_AT_WORD_START}|${NOT_AT_WORD_END})`,
  B: `(?:(?<![${WORD}])(?![${WORD}])|(?<=[${WORD}])(?=[${WORD}]))`,
  '`': '(?<![^])',
  "'": '(?![^])',
};

const WORD_OPERATORS: Readonly<Record<string, string>> = {
  w: `[${WORD}]`,
  W: `[^${WORD}]`,
  s: `[${SPACE}]`,
  S: `[^${SPACE}]`,
};

const SYNTAX_CHARACTERS = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);

function literal(character: string): string {
  return SYNTAX_CHARACTERS.has(character) ? `\\${character}` : character;
}

function classLiteral(character: string): string {
  return character === '\\' || character === ']' || character === '^' || character === '-' || character === '[' ? `\\${character}` : character;
}

interface BracketElement {
  readonly kind: 'char' | 'class' | 'equivalence';
  readonly text: string;
}

class EreParser {
  private readonly chars: string[];
  private position = 0;
  private opened = 0;
  private completed = new Set<number>();
  hasAlternation = false;
  hasQuantifier = false;

  constructor(pattern: string, private readonly ignoreCase = false, private readonly directCompile: { readonly notBol?: boolean } | null = null) {
    this.chars = Array.from(pattern);
  }

  get groupCount(): number {
    return this.opened;
  }

  parse(): string {
    const source = this.parseAlternatives(0);
    return source;
  }

  private peek(offset = 0): string | undefined {
    return this.chars[this.position + offset];
  }

  private parseAlternatives(depth: number): string {
    const initial = new Set(this.completed);
    const branches = [this.parseBranch(depth)];
    while (this.peek() === '|') {
      this.hasAlternation = true;
      this.position++;
      const next = this.peek();
      if (next === '|' || next === undefined || (depth > 0 && next === ')')) {
        branches.push('');
        continue;
      }
      const accumulated = this.completed;
      this.completed = new Set(initial);
      branches.push(this.parseBranch(depth));
      for (const index of accumulated) this.completed.add(index);
    }
    return branches.join('|');
  }

  private parseBranch(depth: number): string {
    let source = '';
    for (;;) {
      const next = this.peek();
      if (next === undefined || next === '|' || (depth > 0 && next === ')')) return source;
      source += this.parseExpression(depth);
    }
  }

  private parseExpression(depth: number): string {
    const character = this.chars[this.position++];
    switch (character) {
      case '*': case '+': case '?': case '{':
        throw new PosixRegexError(MESSAGES.repeat);
      case '^': return this.directCompile?.notBol ? '(?!)' : '^';
      case '$': return '$';
      case '\\': {
        const escaped = this.chars[this.position++];
        if (escaped === undefined) throw new PosixRegexError(MESSAGES.escape);
        if (escaped in ANCHORS) return ANCHORS[escaped];
        return this.parseDuplications(this.parseEscapedAtom(escaped));
      }
      case '(': return this.parseDuplications(this.parseGroup(depth));
      case '[': return this.parseDuplications(this.parseBracket());
      case '.': return this.parseDuplications('[^]');
      default: return this.parseDuplications(literal(character));
    }
  }

  private parseEscapedAtom(escaped: string): string {
    if (escaped >= '1' && escaped <= '9') {
      const index = Number(escaped);
      if (!this.completed.has(index)) throw new PosixRegexError(MESSAGES.subreg);
      return `(?:\\${escaped})`;
    }
    if (escaped in WORD_OPERATORS) return WORD_OPERATORS[escaped];
    if (this.ignoreCase && this.directCompile !== null && escaped >= 'a' && escaped <= 'z') return '(?!)';
    return literal(escaped);
  }

  private parseGroup(depth: number): string {
    this.opened++;
    const index = this.opened;
    if (this.peek() === ')') {
      this.position++;
      this.completed.add(index);
      return '()';
    }
    const inner = this.parseAlternatives(depth + 1);
    if (this.peek() !== ')') throw new PosixRegexError(MESSAGES.paren);
    this.position++;
    this.completed.add(index);
    return `(${inner})`;
  }

  private parseDuplications(atom: string): string {
    let source = atom;
    for (;;) {
      const next = this.peek();
      if (next === '*' || next === '+' || next === '?') {
        this.position++;
        this.hasQuantifier = true;
        source = `(?:${source})${next}`;
      } else if (next === '{') {
        this.position++;
        this.hasQuantifier = true;
        source = this.parseInterval(source);
      } else return source;
    }
  }

  private fetchNumber(): { value: number | 'missing' | 'error'; stop: string | undefined } {
    let value: number | 'missing' | 'error' = 'missing';
    for (;;) {
      const character = this.chars[this.position++];
      if (character === undefined) return { value: 'error', stop: undefined };
      if (character === '}' || character === ',') return { value, stop: character };
      if (character < '0' || character > '9' || value === 'error') value = 'error';
      else value = value === 'missing' ? Number(character) : Math.min(DUP_MAX + 1, value * 10 + Number(character));
    }
  }

  private parseInterval(atom: string): string {
    const first = this.fetchNumber();
    let start = first.value;
    let stop = first.stop;
    if (start === 'missing') {
      if (stop !== ',') throw new PosixRegexError(MESSAGES.badBrace);
      start = 0;
    }
    let end: number | 'missing' | 'error' = 'error';
    if (start !== 'error') {
      if (stop === '}') end = start;
      else {
        const second = this.fetchNumber();
        end = second.value;
        stop = second.stop;
      }
    }
    if (start === 'error' || end === 'error') {
      throw new PosixRegexError(stop === undefined ? MESSAGES.brace : MESSAGES.badBrace);
    }
    if ((end !== 'missing' && start > end) || stop !== '}') throw new PosixRegexError(MESSAGES.badBrace);
    if ((end === 'missing' ? start : end) > DUP_MAX) throw new PosixRegexError(MESSAGES.size);
    if (end === 'missing') return `(?:${atom}){${start},}`;
    return `(?:${atom}){${start},${end}}`;
  }

  private parseBracket(): string {
    let negated = false;
    if (this.peek() === '^') {
      negated = true;
      this.position++;
    }
    if (this.peek() === undefined) throw new PosixRegexError(MESSAGES.pattern);
    const items: string[] = [];
    let firstRound = true;
    for (;;) {
      if (this.peek() === undefined) throw new PosixRegexError(MESSAGES.bracket);
      if (this.peek() === ']' && !firstRound) {
        this.position++;
        break;
      }
      const start = this.parseBracketElement(firstRound);
      firstRound = false;
      let rangeEnd: BracketElement | null = null;
      if (start.kind !== 'class' && start.kind !== 'equivalence' && this.peek() === '-' && this.peek(1) !== ']') {
        this.position++;
        rangeEnd = this.parseBracketElement(true);
      }
      if (rangeEnd !== null) {
        if (rangeEnd.kind !== 'char' || start.kind !== 'char') throw new PosixRegexError(MESSAGES.range);
        if (start.text.codePointAt(0)! > rangeEnd.text.codePointAt(0)!) throw new PosixRegexError(MESSAGES.range);
        items.push(`${classLiteral(start.text)}-${classLiteral(rangeEnd.text)}`);
      } else if (start.kind === 'class') {
        const folded = this.ignoreCase && (start.text === 'upper' || start.text === 'lower');
        items.push(CLASS_BODIES[folded ? 'alpha' : start.text]);
      } else {
        items.push(classLiteral(start.text));
      }
    }
    if (items.length === 0) return negated ? '[^]' : '[]';
    return `[${negated ? '^' : ''}${items.join('')}]`;
  }

  private parseBracketElement(acceptHyphen: boolean): BracketElement {
    const character = this.chars[this.position];
    if (character === undefined) throw new PosixRegexError(MESSAGES.bracket);
    if (character === '[' && (this.peek(1) === '.' || this.peek(1) === '=' || this.peek(1) === ':')) {
      return this.parseBracketSymbol(this.chars[this.position + 1]);
    }
    this.position++;
    if (character === '-' && !acceptHyphen && this.peek() !== ']') throw new PosixRegexError(MESSAGES.range);
    return { kind: 'char', text: character };
  }

  private parseBracketSymbol(delimiter: string): BracketElement {
    this.position += 2;
    let name = '';
    for (;;) {
      const character = this.chars[this.position++];
      if (character === undefined || this.position >= this.chars.length) throw new PosixRegexError(MESSAGES.bracket);
      if (character === delimiter && this.chars[this.position] === ']') break;
      name += character;
    }
    this.position++;
    if (delimiter === ':') {
      if (!(name in CLASS_BODIES)) throw new PosixRegexError(MESSAGES.ctype);
      return { kind: 'class', text: name };
    }
    if (Array.from(name).length !== 1) throw new PosixRegexError(MESSAGES.collate);
    return { kind: delimiter === '=' ? 'equivalence' : 'char', text: name };
  }
}

export interface EreMatch {
  readonly index: number;
  readonly end: number;
  readonly groups: ReadonlyArray<readonly [number, number] | null>;
}

const LONGEST_SEARCH_LIMIT = 2000;

interface EreVariant {
  readonly source: string;
  readonly scanner: RegExp;
}

export class CompiledEre {
  readonly source: string;
  readonly groupCount: number;
  private readonly flags: string;
  private readonly variants: { readonly normal: EreVariant; withoutLineStart: EreVariant | null };
  private readonly ambiguous: boolean;

  constructor(private readonly pattern: string, private readonly ignoreCase: boolean) {
    const parser = new EreParser(pattern, ignoreCase, {});
    this.source = parser.parse();
    this.groupCount = parser.groupCount;
    this.ambiguous = parser.hasAlternation || parser.hasQuantifier;
    this.flags = `du${ignoreCase ? 'i' : ''}`;
    this.variants = { normal: { source: this.source, scanner: new RegExp(this.source, `g${this.flags}`) }, withoutLineStart: null };
  }

  private variant(notBol: boolean): EreVariant {
    if (!notBol) return this.variants.normal;
    if (this.variants.withoutLineStart === null) {
      const source = new EreParser(this.pattern, this.ignoreCase, { notBol: true }).parse();
      this.variants.withoutLineStart = { source, scanner: new RegExp(source, `g${this.flags}`) };
    }
    return this.variants.withoutLineStart;
  }

  exec(text: string, from: number, notBol = false): EreMatch | null {
    const variant = this.variant(notBol);
    variant.scanner.lastIndex = from;
    const found = variant.scanner.exec(text);
    if (found === null) return null;
    let match = this.describe(found);
    if (this.ambiguous && text.length <= LONGEST_SEARCH_LIMIT) match = this.lengthen(text, match, variant.source);
    return match;
  }

  private describe(found: RegExpExecArray): EreMatch {
    const indices = (found as RegExpExecArray & { indices: Array<[number, number] | undefined> }).indices;
    const groups: Array<readonly [number, number] | null> = [];
    for (let group = 1; group <= this.groupCount; group++) groups.push(indices[group] ?? null);
    return { index: found.index, end: found.index + found[0].length, groups };
  }

  private lengthen(text: string, match: EreMatch, source: string): EreMatch {
    for (let end = text.length; end > match.end; end--) {
      if (end < text.length && /[\udc00-\udfff]/.test(text[end]) && /[\ud800-\udbff]/.test(text[end - 1])) continue;
      const remaining = Array.from(text.slice(end)).length;
      const forced = new RegExp(`(?:${source})(?=[^]{${remaining}}$)`, `y${this.flags}`);
      forced.lastIndex = match.index;
      const found = forced.exec(text);
      if (found !== null) return this.describe(found);
    }
    return match;
  }
}

export function compileEre(pattern: string, ignoreCase: boolean): CompiledEre {
  return new CompiledEre(pattern, ignoreCase);
}

export function ereToJsSource(pattern: string, ignoreCase = false): string {
  return new EreParser(pattern, ignoreCase).parse();
}
