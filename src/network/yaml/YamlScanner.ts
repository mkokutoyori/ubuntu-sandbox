import { YamlReader } from './YamlReader';
import { YamlFailure, type ScalarStyle, type YamlMark } from './YamlTypes';

export type PlainTokenType =
  | 'stream-start' | 'stream-end' | 'document-start' | 'document-end'
  | 'block-sequence-start' | 'block-mapping-start' | 'block-end'
  | 'flow-sequence-start' | 'flow-sequence-end' | 'flow-mapping-start' | 'flow-mapping-end'
  | 'block-entry' | 'flow-entry' | 'key' | 'value';

interface TokenSpan {
  readonly start: YamlMark;
  readonly end: YamlMark;
}

export type YamlToken =
  | (TokenSpan & { readonly type: PlainTokenType })
  | (TokenSpan & { readonly type: 'version-directive'; readonly major: number; readonly minor: number })
  | (TokenSpan & { readonly type: 'tag-directive'; readonly handle: string; readonly prefix: string })
  | (TokenSpan & { readonly type: 'alias' | 'anchor'; readonly value: string })
  | (TokenSpan & { readonly type: 'tag'; readonly handle: string; readonly suffix: string })
  | (TokenSpan & { readonly type: 'scalar'; readonly value: string; readonly style: ScalarStyle });

interface SimpleKey {
  possible: boolean;
  required: boolean;
  tokenNumber: number;
  mark: YamlMark;
}

const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const NEXT_LINE = 0x85;
const MAX_VERSION_NUMBER_LENGTH = 9;
const SIMPLE_KEY_MAX_DISTANCE = 1024;

const code = (symbol: string): number => symbol.charCodeAt(0);
const SPACE = code(' ');
const TAB = code('\t');
const CR = code('\r');
const LF = code('\n');

const oneOf = (set: string, value: number): boolean => value > 0 && value < 0x80 && set.includes(String.fromCharCode(value));
const isDigit = (value: number): boolean => value >= 0x30 && value <= 0x39;
const isHex = (value: number): boolean => isDigit(value) || (value >= 0x41 && value <= 0x46) || (value >= 0x61 && value <= 0x66);
const isAlpha = (value: number): boolean => isDigit(value) || (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a) || value === code('_') || value === code('-');
const isBreak = (value: number): boolean => value === CR || value === LF || value === NEXT_LINE || value === LINE_SEPARATOR || value === PARAGRAPH_SEPARATOR;
const isBreakOrEnd = (value: number): boolean => isBreak(value) || value === 0;
const isBlank = (value: number): boolean => value === SPACE || value === TAB;
const isBlankOrEnd = (value: number): boolean => isBlank(value) || isBreakOrEnd(value);

function hexValue(value: number): number {
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return value - 0x30;
}

const EMPTY_MARK: YamlMark = { index: 0, line: 0, column: 0 };

export class YamlScanner {
  private readonly reader: YamlReader;
  private mark: YamlMark = { index: 0, line: 0, column: 0 };
  private streamStartProduced = false;
  private flowLevel = 0;
  private indent = -1;
  private readonly indents: number[] = [];
  private simpleKeyAllowed = false;
  private readonly simpleKeys: SimpleKey[] = [];
  private readonly queue: YamlToken[] = [];
  private tokensParsed = 0;
  private tokenAvailable = false;
  private streamEndProduced = false;

  constructor(text: string) {
    this.reader = new YamlReader(text);
  }

  peek(): YamlToken {
    if (!this.tokenAvailable) this.fetchMoreTokens();
    return this.queue[0];
  }

  skip(): void {
    this.tokenAvailable = false;
    this.tokensParsed++;
    this.streamEndProduced = this.queue[0].type === 'stream-end';
    this.queue.shift();
  }

  get finished(): boolean {
    return this.streamEndProduced;
  }

  private fail(context: string | null, contextMark: YamlMark | null, problem: string): never {
    throw new YamlFailure({
      kind: 'scanner', problem, context, contextMark, problemMark: this.mark, problemOffset: null, problemValue: null,
    });
  }

  private ch(offset = 0): number {
    return this.reader.at(offset);
  }

  private is(symbol: string, offset = 0): boolean {
    return this.reader.at(offset) === symbol.charCodeAt(0);
  }

  private cache(length: number): void {
    this.reader.cache(length);
  }

  private skipChar(): void {
    this.mark = { index: this.mark.index + 1, line: this.mark.line, column: this.mark.column + 1 };
    this.reader.advance(1);
  }

  private skipLine(): void {
    if (this.ch() === CR && this.ch(1) === LF) {
      this.mark = { index: this.mark.index + 2, line: this.mark.line + 1, column: 0 };
      this.reader.advance(2);
    } else if (isBreak(this.ch())) {
      this.mark = { index: this.mark.index + 1, line: this.mark.line + 1, column: 0 };
      this.reader.advance(1);
    }
  }

  private readChar(): string {
    const symbol = String.fromCodePoint(this.ch());
    this.skipChar();
    return symbol;
  }

  private readLine(): string {
    const first = this.ch();
    if (first === CR && this.ch(1) === LF) {
      this.mark = { index: this.mark.index + 2, line: this.mark.line + 1, column: 0 };
      this.reader.advance(2);
      return '\n';
    }
    if (first === CR || first === LF || first === NEXT_LINE) {
      this.mark = { index: this.mark.index + 1, line: this.mark.line + 1, column: 0 };
      this.reader.advance(1);
      return '\n';
    }
    if (first === LINE_SEPARATOR || first === PARAGRAPH_SEPARATOR) {
      this.mark = { index: this.mark.index + 1, line: this.mark.line + 1, column: 0 };
      this.reader.advance(1);
      return String.fromCodePoint(first);
    }
    return '';
  }

  private fetchMoreTokens(): void {
    for (;;) {
      let needMore = false;
      if (this.queue.length === 0) needMore = true;
      else {
        this.staleSimpleKeys();
        needMore = this.simpleKeys.some((key) => key.possible && key.tokenNumber === this.tokensParsed);
      }
      if (!needMore) break;
      this.fetchNextToken();
    }
    this.tokenAvailable = true;
  }

  private enqueue(token: YamlToken): void {
    this.queue.push(token);
  }

  private fetchNextToken(): void {
    this.cache(1);
    if (!this.streamStartProduced) {
      this.fetchStreamStart();
      return;
    }
    this.scanToNextToken();
    this.staleSimpleKeys();
    this.unrollIndent(this.mark.column);
    this.cache(4);
    const first = this.ch();
    if (first === 0) return this.fetchStreamEnd();
    if (this.mark.column === 0 && this.is('%')) return this.fetchDirective();
    if (this.mark.column === 0 && this.is('-') && this.is('-', 1) && this.is('-', 2) && isBlankOrEnd(this.ch(3))) {
      return this.fetchDocumentIndicator('document-start');
    }
    if (this.mark.column === 0 && this.is('.') && this.is('.', 1) && this.is('.', 2) && isBlankOrEnd(this.ch(3))) {
      return this.fetchDocumentIndicator('document-end');
    }
    if (this.is('[')) return this.fetchFlowCollectionStart('flow-sequence-start');
    if (this.is('{')) return this.fetchFlowCollectionStart('flow-mapping-start');
    if (this.is(']')) return this.fetchFlowCollectionEnd('flow-sequence-end');
    if (this.is('}')) return this.fetchFlowCollectionEnd('flow-mapping-end');
    if (this.is(',')) return this.fetchFlowEntry();
    if (this.is('-') && isBlankOrEnd(this.ch(1))) return this.fetchBlockEntry();
    if (this.is('?') && (this.flowLevel > 0 || isBlankOrEnd(this.ch(1)))) return this.fetchKey();
    if (this.is(':') && (this.flowLevel > 0 || isBlankOrEnd(this.ch(1)))) return this.fetchValue();
    if (this.is('*')) return this.fetchAnchor('alias');
    if (this.is('&')) return this.fetchAnchor('anchor');
    if (this.is('!')) return this.fetchTag();
    if (this.is('|') && this.flowLevel === 0) return this.fetchBlockScalar(true);
    if (this.is('>') && this.flowLevel === 0) return this.fetchBlockScalar(false);
    if (this.is("'")) return this.fetchFlowScalar(true);
    if (this.is('"')) return this.fetchFlowScalar(false);
    const indicators = "-?:,[]{}#&*!|>'\"%@`";
    const startsPlain = !(isBlankOrEnd(first) || oneOf(indicators, first))
      || (this.is('-') && !isBlank(this.ch(1)))
      || (this.flowLevel === 0 && (this.is('?') || this.is(':')) && !isBlankOrEnd(this.ch(1)));
    if (startsPlain) return this.fetchPlainScalar();
    return this.fail('while scanning for the next token', this.mark, 'found character that cannot start any token');
  }

  private staleSimpleKeys(): void {
    for (const key of this.simpleKeys) {
      if (key.possible && (key.mark.line < this.mark.line || key.mark.index + SIMPLE_KEY_MAX_DISTANCE < this.mark.index)) {
        if (key.required) this.fail('while scanning a simple key', key.mark, "could not find expected ':'");
        key.possible = false;
      }
    }
  }

  private saveSimpleKey(): void {
    const required = this.flowLevel === 0 && this.indent === this.mark.column;
    if (this.simpleKeyAllowed) {
      this.removeSimpleKey();
      this.simpleKeys[this.simpleKeys.length - 1] = {
        possible: true, required, tokenNumber: this.tokensParsed + this.queue.length, mark: this.mark,
      };
    }
  }

  private removeSimpleKey(): void {
    const key = this.simpleKeys[this.simpleKeys.length - 1];
    if (key.possible && key.required) this.fail('while scanning a simple key', key.mark, "could not find expected ':'");
    key.possible = false;
  }

  private increaseFlowLevel(): void {
    this.simpleKeys.push({ possible: false, required: false, tokenNumber: 0, mark: EMPTY_MARK });
    this.flowLevel++;
  }

  private decreaseFlowLevel(): void {
    if (this.flowLevel > 0) {
      this.flowLevel--;
      this.simpleKeys.pop();
    }
  }

  private rollIndent(column: number, number: number, type: PlainTokenType, mark: YamlMark): void {
    if (this.flowLevel > 0) return;
    if (this.indent < column) {
      this.indents.push(this.indent);
      this.indent = column;
      const token: YamlToken = { type, start: mark, end: mark };
      if (number === -1) this.enqueue(token);
      else this.queue.splice(number - this.tokensParsed, 0, token);
    }
  }

  private unrollIndent(column: number): void {
    if (this.flowLevel > 0) return;
    while (this.indent > column) {
      this.enqueue({ type: 'block-end', start: this.mark, end: this.mark });
      this.indent = this.indents.pop() as number;
    }
  }

  private fetchStreamStart(): void {
    this.indent = -1;
    this.simpleKeys.push({ possible: false, required: false, tokenNumber: 0, mark: EMPTY_MARK });
    this.simpleKeyAllowed = true;
    this.streamStartProduced = true;
    this.enqueue({ type: 'stream-start', start: this.mark, end: this.mark });
  }

  private fetchStreamEnd(): void {
    if (this.mark.column !== 0) this.mark = { index: this.mark.index, line: this.mark.line + 1, column: 0 };
    this.unrollIndent(-1);
    this.removeSimpleKey();
    this.simpleKeyAllowed = false;
    this.enqueue({ type: 'stream-end', start: this.mark, end: this.mark });
  }

  private fetchDirective(): void {
    this.unrollIndent(-1);
    this.removeSimpleKey();
    this.simpleKeyAllowed = false;
    this.enqueue(this.scanDirective());
  }

  private fetchDocumentIndicator(type: 'document-start' | 'document-end'): void {
    this.unrollIndent(-1);
    this.removeSimpleKey();
    this.simpleKeyAllowed = false;
    const start = this.mark;
    this.skipChar();
    this.skipChar();
    this.skipChar();
    this.enqueue({ type, start, end: this.mark });
  }

  private fetchFlowCollectionStart(type: PlainTokenType): void {
    this.saveSimpleKey();
    this.increaseFlowLevel();
    this.simpleKeyAllowed = true;
    const start = this.mark;
    this.skipChar();
    this.enqueue({ type, start, end: this.mark });
  }

  private fetchFlowCollectionEnd(type: PlainTokenType): void {
    this.removeSimpleKey();
    this.decreaseFlowLevel();
    this.simpleKeyAllowed = false;
    const start = this.mark;
    this.skipChar();
    this.enqueue({ type, start, end: this.mark });
  }

  private fetchFlowEntry(): void {
    this.removeSimpleKey();
    this.simpleKeyAllowed = true;
    const start = this.mark;
    this.skipChar();
    this.enqueue({ type: 'flow-entry', start, end: this.mark });
  }

  private fetchBlockEntry(): void {
    if (this.flowLevel === 0) {
      if (!this.simpleKeyAllowed) this.fail(null, this.mark, 'block sequence entries are not allowed in this context');
      this.rollIndent(this.mark.column, -1, 'block-sequence-start', this.mark);
    }
    this.removeSimpleKey();
    this.simpleKeyAllowed = true;
    const start = this.mark;
    this.skipChar();
    this.enqueue({ type: 'block-entry', start, end: this.mark });
  }

  private fetchKey(): void {
    if (this.flowLevel === 0) {
      if (!this.simpleKeyAllowed) this.fail(null, this.mark, 'mapping keys are not allowed in this context');
      this.rollIndent(this.mark.column, -1, 'block-mapping-start', this.mark);
    }
    this.removeSimpleKey();
    this.simpleKeyAllowed = this.flowLevel === 0;
    const start = this.mark;
    this.skipChar();
    this.enqueue({ type: 'key', start, end: this.mark });
  }

  private fetchValue(): void {
    const key = this.simpleKeys[this.simpleKeys.length - 1];
    if (key.possible) {
      this.queue.splice(key.tokenNumber - this.tokensParsed, 0, { type: 'key', start: key.mark, end: key.mark });
      this.rollIndent(key.mark.column, key.tokenNumber, 'block-mapping-start', key.mark);
      key.possible = false;
      this.simpleKeyAllowed = false;
    } else {
      if (this.flowLevel === 0) {
        if (!this.simpleKeyAllowed) this.fail(null, this.mark, 'mapping values are not allowed in this context');
        this.rollIndent(this.mark.column, -1, 'block-mapping-start', this.mark);
      }
      this.simpleKeyAllowed = this.flowLevel === 0;
    }
    const start = this.mark;
    this.skipChar();
    this.enqueue({ type: 'value', start, end: this.mark });
  }

  private fetchAnchor(type: 'alias' | 'anchor'): void {
    this.saveSimpleKey();
    this.simpleKeyAllowed = false;
    this.enqueue(this.scanAnchor(type));
  }

  private fetchTag(): void {
    this.saveSimpleKey();
    this.simpleKeyAllowed = false;
    this.enqueue(this.scanTag());
  }

  private fetchBlockScalar(literal: boolean): void {
    this.removeSimpleKey();
    this.simpleKeyAllowed = true;
    this.enqueue(this.scanBlockScalar(literal));
  }

  private fetchFlowScalar(single: boolean): void {
    this.saveSimpleKey();
    this.simpleKeyAllowed = false;
    this.enqueue(this.scanFlowScalar(single));
  }

  private fetchPlainScalar(): void {
    this.saveSimpleKey();
    this.simpleKeyAllowed = false;
    this.enqueue(this.scanPlainScalar());
  }

  private scanToNextToken(): void {
    for (;;) {
      this.cache(1);
      if (this.mark.column === 0 && this.ch() === 0xfeff) this.skipChar();
      this.cache(1);
      while (this.is(' ') || ((this.flowLevel > 0 || !this.simpleKeyAllowed) && this.ch() === TAB)) {
        this.skipChar();
        this.cache(1);
      }
      if (this.is('#')) {
        while (!isBreakOrEnd(this.ch())) {
          this.skipChar();
          this.cache(1);
        }
      }
      if (isBreak(this.ch())) {
        this.cache(2);
        this.skipLine();
        if (this.flowLevel === 0) this.simpleKeyAllowed = true;
      } else break;
    }
  }

  private scanDirective(): YamlToken {
    const start = this.mark;
    this.skipChar();
    const name = this.scanDirectiveName(start);
    let token: YamlToken;
    if (name === 'YAML') {
      const { major, minor } = this.scanVersionDirectiveValue(start);
      token = { type: 'version-directive', major, minor, start, end: this.mark };
    } else if (name === 'TAG') {
      const { handle, prefix } = this.scanTagDirectiveValue(start);
      token = { type: 'tag-directive', handle, prefix, start, end: this.mark };
    } else return this.fail('while scanning a directive', start, 'found unknown directive name');
    this.cache(1);
    while (isBlank(this.ch())) {
      this.skipChar();
      this.cache(1);
    }
    if (this.is('#')) {
      while (!isBreakOrEnd(this.ch())) {
        this.skipChar();
        this.cache(1);
      }
    }
    if (!isBreakOrEnd(this.ch())) this.fail('while scanning a directive', start, 'did not find expected comment or line break');
    if (isBreak(this.ch())) {
      this.cache(2);
      this.skipLine();
    }
    return token;
  }

  private scanDirectiveName(start: YamlMark): string {
    let name = '';
    this.cache(1);
    while (isAlpha(this.ch())) {
      name += this.readChar();
      this.cache(1);
    }
    if (name.length === 0) this.fail('while scanning a directive', start, 'could not find expected directive name');
    if (!isBlankOrEnd(this.ch())) this.fail('while scanning a directive', start, 'found unexpected non-alphabetical character');
    return name;
  }

  private scanVersionDirectiveValue(start: YamlMark): { major: number; minor: number } {
    this.cache(1);
    while (isBlank(this.ch())) {
      this.skipChar();
      this.cache(1);
    }
    const major = this.scanVersionDirectiveNumber(start);
    if (!this.is('.')) this.fail('while scanning a %YAML directive', start, "did not find expected digit or '.' character");
    this.skipChar();
    const minor = this.scanVersionDirectiveNumber(start);
    return { major, minor };
  }

  private scanVersionDirectiveNumber(start: YamlMark): number {
    let value = 0;
    let length = 0;
    this.cache(1);
    while (isDigit(this.ch())) {
      if (++length > MAX_VERSION_NUMBER_LENGTH) this.fail('while scanning a %YAML directive', start, 'found extremely long version number');
      value = value * 10 + (this.ch() - 0x30);
      this.skipChar();
      this.cache(1);
    }
    if (length === 0) this.fail('while scanning a %YAML directive', start, 'did not find expected version number');
    return value;
  }

  private scanTagDirectiveValue(start: YamlMark): { handle: string; prefix: string } {
    this.cache(1);
    while (isBlank(this.ch())) {
      this.skipChar();
      this.cache(1);
    }
    const handle = this.scanTagHandle(true, start);
    this.cache(1);
    if (!isBlank(this.ch())) this.fail('while scanning a %TAG directive', start, 'did not find expected whitespace');
    while (isBlank(this.ch())) {
      this.skipChar();
      this.cache(1);
    }
    const prefix = this.scanTagUri(true, true, null, start);
    this.cache(1);
    if (!isBlankOrEnd(this.ch())) this.fail('while scanning a %TAG directive', start, 'did not find expected whitespace or line break');
    return { handle, prefix };
  }

  private scanAnchor(type: 'alias' | 'anchor'): YamlToken {
    let value = '';
    const start = this.mark;
    this.skipChar();
    this.cache(1);
    while (isAlpha(this.ch())) {
      value += this.readChar();
      this.cache(1);
    }
    const end = this.mark;
    const terminators = '?:,]}%@`';
    if (value.length === 0 || !(isBlankOrEnd(this.ch()) || oneOf(terminators, this.ch()))) {
      this.fail(type === 'anchor' ? 'while scanning an anchor' : 'while scanning an alias', start, 'did not find expected alphabetic or numeric character');
    }
    return { type, value, start, end };
  }

  private scanTag(): YamlToken {
    let handle: string;
    let suffix: string;
    const start = this.mark;
    this.cache(2);
    if (this.is('<', 1)) {
      handle = '';
      this.skipChar();
      this.skipChar();
      suffix = this.scanTagUri(true, false, null, start);
      if (!this.is('>')) this.fail('while scanning a tag', start, "did not find the expected '>'");
      this.skipChar();
    } else {
      handle = this.scanTagHandle(false, start);
      if (handle[0] === '!' && handle.length > 1 && handle[handle.length - 1] === '!') {
        suffix = this.scanTagUri(false, false, null, start);
      } else {
        suffix = this.scanTagUri(false, false, handle, start);
        handle = '!';
        if (suffix === '') {
          handle = suffix;
          suffix = '!';
        }
      }
    }
    this.cache(1);
    if (!isBlankOrEnd(this.ch()) && !(this.flowLevel > 0 && this.is(','))) {
      this.fail('while scanning a tag', start, 'did not find expected whitespace or line break');
    }
    return { type: 'tag', handle, suffix, start, end: this.mark };
  }

  private scanTagHandle(directive: boolean, start: YamlMark): string {
    let handle = '';
    this.cache(1);
    if (!this.is('!')) this.fail(directive ? 'while scanning a tag directive' : 'while scanning a tag', start, "did not find expected '!'");
    handle += this.readChar();
    this.cache(1);
    while (isAlpha(this.ch())) {
      handle += this.readChar();
      this.cache(1);
    }
    if (this.is('!')) handle += this.readChar();
    else if (directive && handle !== '!') this.fail('while parsing a tag directive', start, "did not find expected '!'");
    return handle;
  }

  private scanTagUri(uriChar: boolean, directive: boolean, head: string | null, start: YamlMark): string {
    let length = head === null ? 0 : head.length;
    let uri = head !== null && length > 1 ? head.slice(1) : '';
    this.cache(1);
    const punctuation = ";/?:@&=+$.%!~*'()";
    const flowPunctuation = ',[]';
    for (;;) {
      const current = this.ch();
      const belongs = isAlpha(current) || oneOf(punctuation, current) || (uriChar && oneOf(flowPunctuation, current));
      if (!belongs) break;
      if (this.is('%')) uri += this.scanUriEscapes(directive, start);
      else uri += this.readChar();
      length++;
      this.cache(1);
    }
    if (length === 0) this.fail(directive ? 'while parsing a %TAG directive' : 'while parsing a tag', start, 'did not find expected tag URI');
    return uri;
  }

  private scanUriEscapes(directive: boolean, start: YamlMark): string {
    const context = directive ? 'while parsing a %TAG directive' : 'while parsing a tag';
    const octets: number[] = [];
    let width = 0;
    do {
      this.cache(3);
      if (!(this.is('%') && isHex(this.ch(1)) && isHex(this.ch(2)))) this.fail(context, start, 'did not find URI escaped octet');
      const octet = (hexValue(this.ch(1)) << 4) + hexValue(this.ch(2));
      if (width === 0) {
        width = (octet & 0x80) === 0 ? 1 : (octet & 0xe0) === 0xc0 ? 2 : (octet & 0xf0) === 0xe0 ? 3 : (octet & 0xf8) === 0xf0 ? 4 : 0;
        if (width === 0) this.fail(context, start, 'found an incorrect leading UTF-8 octet');
      } else if ((octet & 0xc0) !== 0x80) this.fail(context, start, 'found an incorrect trailing UTF-8 octet');
      octets.push(octet);
      this.skipChar();
      this.skipChar();
      this.skipChar();
    } while (--width > 0);
    return new TextDecoder().decode(Uint8Array.from(octets));
  }

  private scanBlockScalar(literal: boolean): YamlToken {
    let text = '';
    let leadingBreak = '';
    let trailingBreaks = '';
    let chomping = 0;
    let increment = 0;
    let indent = 0;
    let leadingBlank = false;
    let trailingBlank = false;
    const start = this.mark;
    this.skipChar();
    this.cache(1);
    const zeroIndicator = (): never => this.fail('while scanning a block scalar', start, 'found an indentation indicator equal to 0');
    if (this.is('+') || this.is('-')) {
      chomping = this.is('+') ? 1 : -1;
      this.skipChar();
      this.cache(1);
      if (isDigit(this.ch())) {
        if (this.is('0')) zeroIndicator();
        increment = this.ch() - 0x30;
        this.skipChar();
      }
    } else if (isDigit(this.ch())) {
      if (this.is('0')) zeroIndicator();
      increment = this.ch() - 0x30;
      this.skipChar();
      this.cache(1);
      if (this.is('+') || this.is('-')) {
        chomping = this.is('+') ? 1 : -1;
        this.skipChar();
      }
    }
    this.cache(1);
    while (isBlank(this.ch())) {
      this.skipChar();
      this.cache(1);
    }
    if (this.is('#')) {
      while (!isBreakOrEnd(this.ch())) {
        this.skipChar();
        this.cache(1);
      }
    }
    if (!isBreakOrEnd(this.ch())) this.fail('while scanning a block scalar', start, 'did not find expected comment or line break');
    if (isBreak(this.ch())) {
      this.cache(2);
      this.skipLine();
    }
    let end = this.mark;
    if (increment > 0) indent = this.indent >= 0 ? this.indent + increment : increment;
    const breaks = { indent, text: trailingBreaks, end };
    this.scanBlockScalarBreaks(breaks, start);
    indent = breaks.indent;
    trailingBreaks = breaks.text;
    end = breaks.end;
    this.cache(1);
    while (this.mark.column === indent && this.ch() !== 0) {
      trailingBlank = isBlank(this.ch());
      if (!literal && leadingBreak[0] === '\n' && !leadingBlank && !trailingBlank) {
        if (trailingBreaks.length === 0) text += ' ';
        leadingBreak = '';
      } else {
        text += leadingBreak;
        leadingBreak = '';
      }
      text += trailingBreaks;
      trailingBreaks = '';
      leadingBlank = isBlank(this.ch());
      while (!isBreakOrEnd(this.ch())) {
        text += this.readChar();
        this.cache(1);
      }
      this.cache(2);
      leadingBreak += this.readLine();
      breaks.indent = indent;
      breaks.text = trailingBreaks;
      this.scanBlockScalarBreaks(breaks, start);
      indent = breaks.indent;
      trailingBreaks = breaks.text;
      end = breaks.end;
    }
    if (chomping !== -1) text += leadingBreak;
    if (chomping === 1) text += trailingBreaks;
    return { type: 'scalar', value: text, style: literal ? 'literal' : 'folded', start, end };
  }

  private scanBlockScalarBreaks(state: { indent: number; text: string; end: YamlMark }, start: YamlMark): void {
    let maxIndent = 0;
    state.end = this.mark;
    for (;;) {
      this.cache(1);
      while ((state.indent === 0 || this.mark.column < state.indent) && this.is(' ')) {
        this.skipChar();
        this.cache(1);
      }
      if (this.mark.column > maxIndent) maxIndent = this.mark.column;
      if ((state.indent === 0 || this.mark.column < state.indent) && this.ch() === TAB) {
        this.fail('while scanning a block scalar', start, 'found a tab character where an indentation space is expected');
      }
      if (!isBreak(this.ch())) break;
      this.cache(2);
      state.text += this.readLine();
      state.end = this.mark;
    }
    if (state.indent === 0) {
      state.indent = Math.max(maxIndent, this.indent + 1, 1);
    }
  }

  private scanFlowScalar(single: boolean): YamlToken {
    let text = '';
    let leadingBreak = '';
    let trailingBreaks = '';
    let whitespaces = '';
    const start = this.mark;
    const quote = single ? "'" : '"';
    this.skipChar();
    for (;;) {
      this.cache(4);
      if (this.mark.column === 0
        && ((this.is('-') && this.is('-', 1) && this.is('-', 2)) || (this.is('.') && this.is('.', 1) && this.is('.', 2)))
        && isBlankOrEnd(this.ch(3))) {
        this.fail('while scanning a quoted scalar', start, 'found unexpected document indicator');
      }
      if (this.ch() === 0) this.fail('while scanning a quoted scalar', start, 'found unexpected end of stream');
      this.cache(2);
      let leadingBlanks = false;
      while (!isBlankOrEnd(this.ch())) {
        if (single && this.is("'") && this.is("'", 1)) {
          text += "'";
          this.skipChar();
          this.skipChar();
        } else if (this.is(quote)) {
          break;
        } else if (!single && this.is('\\') && isBreak(this.ch(1))) {
          this.cache(3);
          this.skipChar();
          this.skipLine();
          leadingBlanks = true;
          break;
        } else if (!single && this.is('\\')) {
          text += this.scanEscape(start);
        } else {
          text += this.readChar();
        }
        this.cache(2);
      }
      this.cache(1);
      if (this.is(quote)) break;
      this.cache(1);
      while (isBlank(this.ch()) || isBreak(this.ch())) {
        if (isBlank(this.ch())) {
          if (!leadingBlanks) whitespaces += this.readChar();
          else this.skipChar();
        } else {
          this.cache(2);
          if (!leadingBlanks) {
            whitespaces = '';
            leadingBreak = this.readLine();
            leadingBlanks = true;
          } else trailingBreaks += this.readLine();
        }
        this.cache(1);
      }
      if (leadingBlanks) {
        if (leadingBreak[0] === '\n') {
          if (trailingBreaks.length === 0) text += ' ';
          else {
            text += trailingBreaks;
            trailingBreaks = '';
          }
          leadingBreak = '';
        } else {
          text += leadingBreak + trailingBreaks;
          leadingBreak = '';
          trailingBreaks = '';
        }
      } else {
        text += whitespaces;
        whitespaces = '';
      }
    }
    this.skipChar();
    return { type: 'scalar', value: text, style: single ? 'single-quoted' : 'double-quoted', start, end: this.mark };
  }

  private scanEscape(start: YamlMark): string {
    const simple: Readonly<Record<string, string>> = {
      '0': '\0', a: '\x07', b: '\x08', t: '\x09', '\t': '\x09', n: '\x0a', v: '\x0b', f: '\x0c', r: '\x0d', e: '\x1b',
      ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: ' ', L: ' ', P: ' ',
    };
    const lengths: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };
    const selector = String.fromCodePoint(this.ch(1));
    let decoded = '';
    let codeLength = 0;
    if (selector in simple) decoded = simple[selector];
    else if (selector in lengths) codeLength = lengths[selector];
    else this.fail('while parsing a quoted scalar', start, 'found unknown escape character');
    this.skipChar();
    this.skipChar();
    if (codeLength > 0) {
      let value = 0;
      this.cache(codeLength);
      for (let k = 0; k < codeLength; k++) {
        if (!isHex(this.ch(k))) this.fail('while parsing a quoted scalar', start, 'did not find expected hexdecimal number');
        value = value * 16 + hexValue(this.ch(k));
      }
      if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
        this.fail('while parsing a quoted scalar', start, 'found invalid Unicode character escape code');
      }
      decoded = String.fromCodePoint(value);
      for (let k = 0; k < codeLength; k++) this.skipChar();
    }
    return decoded;
  }

  private scanPlainScalar(): YamlToken {
    let text = '';
    let leadingBreak = '';
    let trailingBreaks = '';
    let whitespaces = '';
    let leadingBlanks = false;
    const indent = this.indent + 1;
    const start = this.mark;
    let end = this.mark;
    for (;;) {
      this.cache(4);
      if (this.mark.column === 0
        && ((this.is('-') && this.is('-', 1) && this.is('-', 2)) || (this.is('.') && this.is('.', 1) && this.is('.', 2)))
        && isBlankOrEnd(this.ch(3))) break;
      if (this.is('#')) break;
      while (!isBlankOrEnd(this.ch())) {
        if (this.flowLevel > 0 && this.is(':') && oneOf(',?[]{}', this.ch(1))) {
          this.fail('while scanning a plain scalar', start, "found unexpected ':'");
        }
        if ((this.is(':') && isBlankOrEnd(this.ch(1)))
          || (this.flowLevel > 0 && oneOf(',[]{}', this.ch()))) break;
        if (leadingBlanks || whitespaces.length > 0) {
          if (leadingBlanks) {
            if (leadingBreak[0] === '\n') {
              if (trailingBreaks.length === 0) text += ' ';
              else {
                text += trailingBreaks;
                trailingBreaks = '';
              }
              leadingBreak = '';
            } else {
              text += leadingBreak + trailingBreaks;
              leadingBreak = '';
              trailingBreaks = '';
            }
            leadingBlanks = false;
          } else {
            text += whitespaces;
            whitespaces = '';
          }
        }
        text += this.readChar();
        end = this.mark;
        this.cache(2);
      }
      if (!(isBlank(this.ch()) || isBreak(this.ch()))) break;
      this.cache(1);
      while (isBlank(this.ch()) || isBreak(this.ch())) {
        if (isBlank(this.ch())) {
          if (leadingBlanks && this.mark.column < indent && this.ch() === TAB) {
            this.fail('while scanning a plain scalar', start, 'found a tab character that violates indentation');
          }
          if (!leadingBlanks) whitespaces += this.readChar();
          else this.skipChar();
        } else {
          this.cache(2);
          if (!leadingBlanks) {
            whitespaces = '';
            leadingBreak = this.readLine();
            leadingBlanks = true;
          } else trailingBreaks += this.readLine();
        }
        this.cache(1);
      }
      if (this.flowLevel === 0 && this.mark.column < indent) break;
    }
    if (leadingBlanks) this.simpleKeyAllowed = true;
    return { type: 'scalar', value: text, style: 'plain', start, end };
  }
}
