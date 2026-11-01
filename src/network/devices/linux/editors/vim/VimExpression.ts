import { byteOffset, charCells, colAtByte, cursorVcol } from './VimCursor';
import { lowerCaseChar, upperCaseChar } from './VimEditing';
import { formatExponentialSafe, formatFixedSafe, formatFloatDefault, formatVimGeneral } from './VimFloat';
import { compileVimPattern, type VimRegExp } from './VimPattern';
import { expandReplacement } from './VimSubstitute';
import { inVimOrder, TrackedEntries } from './VimHashOrder';
import { formatLocalTime } from '@/network/devices/linux/system/SystemInfo';
import { simulationNowMs } from '@/network/core/SystemClock';
import { sha256 } from '@/crypto/hash/sha256';
import { globPaths, hasWildcard } from './VimGlob';

interface CallFrame {
  readonly locals: Map<string, VimValue>;
  readonly args: Map<string, VimValue>;
}

export class VimVariables {
  private readonly stored = new Map<string, VimValue>();
  private readonly frames: CallFrame[] = [];
  private readonly locks = new WeakMap<Map<string, VimValue>, Set<string>>();

  static key(name: string): string | null {
    if (/^[gbwtlsav]:[A-Za-z_][\w#]*$/.test(name) || /^a:\d+$/.test(name)) return name;
    if (/^[A-Za-z_][\w#]*$/.test(name)) return `g:${name}`;
    return null;
  }

  resolveKey(name: string): string | null {
    if (this.frames.length > 0 && /^[A-Za-z_][\w#]*$/.test(name)) return `l:${name}`;
    return VimVariables.key(name);
  }

  enter(args: Map<string, VimValue>): void {
    this.frames.push({ locals: new Map(), args });
  }

  leave(): void {
    this.frames.pop();
  }

  get depth(): number {
    return this.frames.length;
  }

  frameScopes(): Map<string, VimValue>[] {
    const frame = this.frames[this.frames.length - 1];
    return frame === undefined ? [] : [frame.locals, frame.args];
  }

  scopeEntries(letter: string): Map<string, VimValue> {
    const frame = this.frames[this.frames.length - 1];
    const entries = new Map<string, VimValue>();
    if (letter === 'l') return frame === undefined ? this.prefixed('g:', entries) : new Map(frame.locals);
    if (letter === 'a') {
      if (frame === undefined) return entries;
      for (const [key, value] of frame.args) entries.set(key.slice(2), value);
      return entries;
    }
    return this.prefixed(`${letter}:`, entries);
  }

  private prefixed(prefix: string, entries: Map<string, VimValue>): Map<string, VimValue> {
    for (const [key, value] of this.stored) if (key.startsWith(prefix)) entries.set(key.slice(prefix.length), value);
    return entries;
  }

  isReadOnly(name: string): boolean {
    return this.frames.length > 0 && /^a:/.test(name);
  }

  private slot(key: string): { store: Map<string, VimValue>; at: string } {
    const frame = this.frames[this.frames.length - 1];
    if (frame !== undefined && key.startsWith('l:')) return { store: frame.locals, at: key.slice(2) };
    if (frame !== undefined && key.startsWith('a:')) return { store: frame.args, at: key };
    return { store: this.stored, at: key };
  }

  lookup(name: string): VimValue | undefined {
    const key = this.resolveKey(name);
    if (key === null) return undefined;
    const { store, at } = this.slot(key);
    return store.get(at);
  }

  assign(key: string, value: VimValue): void {
    const { store, at } = this.slot(key);
    store.set(at, value);
  }

  remove(name: string): boolean {
    const key = this.resolveKey(name);
    if (key === null) return false;
    const { store, at } = this.slot(key);
    this.locks.get(store)?.delete(at);
    return store.delete(at);
  }

  lock(key: string): void {
    const { store, at } = this.slot(key);
    const held = this.locks.get(store) ?? new Set<string>();
    held.add(at);
    this.locks.set(store, held);
  }

  isLocked(key: string): boolean {
    const { store, at } = this.slot(key);
    return this.locks.get(store)?.has(at) === true;
  }
}

export interface UserFunctions {
  has(name: string): boolean;
  call(name: string, args: VimValue[], session: ExpressionSession, self: VimDict | null): VimValue;
}

export interface ExpressionHost {
  readonly variables: VimVariables;
  readonly lines: readonly string[];
  readonly lineNumber: number;
  readonly columnIndex: number;
  readonly tabstop: number;
  readonly ignoreCase: boolean;
  readonly searchForward: boolean;
  readonly highlightSearch: boolean;
  readonly windowTop: number;
  readonly windowBottom: number;
  readonly lambdaCounter: { next: number };
  readonly functions?: UserFunctions;
  submatch(index: number): string | undefined;
  mark(name: string): { line: number; col: number } | null;
  register(name: string): string | null;
  expressionText(): string;
  setRegister(name: string, lines: string[], linewise: boolean, append: boolean, fromList: boolean): void;
  option(name: string, scope: 'effective' | 'local' | 'global'): boolean | number | string | undefined;
  environment(name: string): string;
  environmentOrNull(name: string): string | null;
  environmentNames(): string[];
  assignEnvironment(name: string, value: string | null): void;
  shellStatus(): number;
  pathKind(path: string): 'missing' | 'file' | 'directory' | 'device' | 'fifo';
  readText(path: string): string | null;
  directoryEntries(path: string): string[] | null;
  workingDirectory(): string;
  hostName(): string;
  executableAt(path: string): boolean;
  linkInfo(path: string): { type: string; permissions: number; target?: string } | null;
  writeText(path: string, text: string): boolean;
  makeDirectory(path: string, mode: number): string | null;
  removeEntry(path: string, kind: 'file' | 'directory' | 'tree'): boolean;
  renameEntry(from: string, to: string): boolean;
  homeDirectory(): string | null;
  bufferName(): string;
  temporaryName(): string;
  wordUnderCursor(big: boolean): string;
  resolvePath(path: string): string;
  processId(): number;
  shell(command: string, input: string | null): string;
  assignOption(name: string, value: string | number): string | null;
  assignRegister(name: string, text: string): void;
}

export interface ExpressionResult {
  readonly text: string;
  readonly errors: readonly string[];
}

type SpecialName = 'true' | 'false' | 'null' | 'none';

interface VimList {
  readonly kind: 'list';
  locked?: boolean;
  items: VimValue[];
}

interface VimDict {
  readonly kind: 'dict';
  locked?: boolean;
  entries: Map<string, VimValue>;
}

interface VimFuncref {
  readonly kind: 'funcref';
  readonly name: string;
  readonly params: readonly string[] | null;
  readonly body: string;
  readonly scopes: readonly Map<string, VimValue>[];
  readonly bound: readonly VimValue[];
}

type VimValue =
  | VimFuncref
  | { readonly kind: 'number'; readonly value: bigint }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'special'; readonly name: SpecialName }
  | VimList
  | VimDict;

const NUMBER_MAX = 9223372036854775807n;
const NUMBER_MIN = -9223372036854775808n;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Abort extends Error {}

export function isExpressionAbort(failure: unknown): boolean {
  return failure instanceof Abort;
}

class Invalid extends Error {
  constructor(readonly at: number) {
    super('invalid expression');
  }
}

function num(value: bigint | number): VimValue {
  const wrapped = typeof value === 'bigint' ? BigInt.asIntN(64, value) : BigInt(Math.trunc(value));
  return { kind: 'number', value: wrapped };
}

function flt(value: number): VimValue {
  return { kind: 'float', value };
}

function str(value: string): VimValue {
  return { kind: 'string', value };
}

function list(items: VimValue[]): VimList {
  return { kind: 'list', items };
}

function dict(entries: Map<string, VimValue>): VimDict {
  if (entries instanceof TrackedEntries) return { kind: 'dict', entries };
  const tracked = new TrackedEntries<VimValue>();
  for (const [key, item] of entries) tracked.set(key, item);
  return { kind: 'dict', entries: tracked };
}

function special(name: SpecialName): VimValue {
  return { kind: 'special', name };
}

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function byteSlice(text: string, start: number, end: number): string {
  return decoder.decode(encoder.encode(text).slice(start, end));
}

function clampNumber(magnitude: bigint, negative: boolean): bigint {
  if (magnitude > NUMBER_MAX) return negative ? -NUMBER_MAX : NUMBER_MAX;
  return negative ? -magnitude : magnitude;
}

function digitValue(character: string | undefined): number {
  if (character === undefined) return -1;
  const code = character.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 122) return code - 87;
  if (code >= 65 && code <= 90) return code - 55;
  return -1;
}

function readDigits(text: string, from: number, base: number): { value: bigint; next: number } {
  let at = from;
  let value = 0n;
  while (digitValue(text[at]) >= 0 && digitValue(text[at]) < base) {
    value = value * BigInt(base) + BigInt(digitValue(text[at]));
    at++;
  }
  return { value, next: at };
}

interface ParsedInteger {
  readonly value: bigint;
  readonly next: number;
}

function parseInteger(text: string, from: number, base: 0 | 2 | 8 | 10 | 16, signed: boolean): ParsedInteger {
  let at = from;
  let negative = false;
  if (signed && text[at] === '-') {
    negative = true;
    at++;
  }
  let radix = 10;
  if (text[at] === '0' && at + 1 < text.length) {
    const marker = text[at + 1].toLowerCase();
    if ((marker === 'x' && (base === 0 || base === 16)) && digitValue(text[at + 2]) >= 0 && digitValue(text[at + 2]) < 16) {
      radix = 16;
      at += 2;
    } else if (marker === 'b' && (base === 0 || base === 2) && (text[at + 2] === '0' || text[at + 2] === '1')) {
      radix = 2;
      at += 2;
    } else if (marker === 'o' && (base === 0 || base === 8) && digitValue(text[at + 2]) >= 0 && digitValue(text[at + 2]) < 8) {
      radix = 8;
      at += 2;
    } else if (base === 0 || base === 8) {
      let probe = at + 1;
      while (digitValue(text[probe]) >= 0 && digitValue(text[probe]) < 10) probe++;
      if (probe > at + 1 && readDigits(text, at, 8).next === probe) radix = 8;
    }
  }
  if (base !== 0 && radix === 10) radix = base;
  const digits = readDigits(text, at, radix);
  return { value: clampNumber(digits.value, negative), next: digits.next };
}

function numberFromString(text: string): bigint {
  return parseInteger(text, 0, 0, true).value;
}

function echoString(value: VimValue, quoted: boolean): string {
  switch (value.kind) {
    case 'number': return value.value.toString();
    case 'float': return formatFloatDefault(value.value);
    case 'special': return `v:${value.name}`;
    case 'funcref':
      if (!quoted) return value.name;
      return value.bound.length > 0 ? `function('${value.name}', ${echoString(list([...value.bound]), true)})` : `function('${value.name}')`;
    case 'string': return quoted ? `'${value.value.replace(/'/g, "''")}'` : value.value;
    case 'list': return `[${value.items.map((item) => echoString(item, true)).join(', ')}]`;
    case 'dict': return `{${inVimOrder(value.entries).map(([key, item]) => `'${key.replace(/'/g, "''")}': ${echoString(item, true)}`).join(', ')}}`;
  }
}

function sameValue(left: VimValue, right: VimValue, ignoreCase: boolean): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'number': return left.value === (right as typeof left).value;
    case 'float': return left.value === (right as typeof left).value;
    case 'special': return left.name === (right as typeof left).name;
    case 'funcref': return left.name === (right as typeof left).name;
    case 'string': return compareText(left.value, (right as typeof left).value, ignoreCase) === 0;
    case 'list': {
      const other = right as VimList;
      return left.items.length === other.items.length && left.items.every((item, at) => sameValue(item, other.items[at], ignoreCase));
    }
    case 'dict': {
      const other = right as VimDict;
      if (left.entries.size !== other.entries.size) return false;
      for (const [key, item] of left.entries) {
        const found = other.entries.get(key);
        if (found === undefined || !sameValue(item, found, ignoreCase)) return false;
      }
      return true;
    }
  }
}

function codePointOrder(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const shared = Math.min(a.length, b.length);
  for (let at = 0; at < shared; at++) {
    const difference = a[at].codePointAt(0)! - b[at].codePointAt(0)!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function foldCase(text: string): string {
  return [...text].map(lowerCaseChar).join('');
}

function compareText(left: string, right: string, ignoreCase: boolean): number {
  return ignoreCase ? codePointOrder(foldCase(left), foldCase(right)) : codePointOrder(left, right);
}

class Context {
  readonly errors: string[] = [];
  statement = '';
  readonly loop: { key: VimValue; val: VimValue }[] = [];
  scopes: Map<string, VimValue>[] = [];

  constructor(public host: ExpressionHost) {}

  evaluate(text: string): VimValue {
    return runExpression(text, this);
  }

  evaluateCallback(text: string): VimValue {
    return runExpression(text, this, true);
  }

  invoke(callee: VimValue, args: VimValue[], self: VimDict | null = null): VimValue {
    if (callee.kind !== 'funcref') {
      const name = this.stringOf(callee, false);
      return this.callNamed(name, args, self);
    }
    const all = [...callee.bound, ...args];
    if (callee.params === null) return this.callNamed(callee.name, all, self);
    if (all.length < callee.params.length) this.fail(`E119: Not enough arguments for function: ${callee.name}`);
    const frame = new Map<string, VimValue>();
    callee.params.forEach((parameter, at) => frame.set(parameter, all[at]));
    const saved = this.scopes;
    this.scopes = [...callee.scopes, frame];
    try {
      return this.evaluate(callee.body);
    } finally {
      this.scopes = saved;
    }
  }

  callNamed(name: string, args: VimValue[], self: VimDict | null = null): VimValue {
    const definition = FUNCTIONS.get(name);
    if (definition === undefined) {
      const user = this.host.functions;
      if (user === undefined || !user.has(name)) return this.fail(`E117: Unknown function: ${name}`);
      return user.call(name, args, new ExpressionSession(this), self);
    }
    if (args.length < definition.min) this.fail(`E119: Not enough arguments for function: ${name}`);
    if (args.length > definition.max) this.fail(`E118: Too many arguments for function: ${name}`);
    return definition.run(args, this);
  }

  withHost<T>(host: ExpressionHost, run: () => T): T {
    const saved = this.host;
    this.host = host;
    try {
      return run();
    } finally {
      this.host = saved;
    }
  }

  soft(message: string): void {
    this.errors.push(message);
  }

  fail(message: string): never {
    this.errors.push(message);
    throw new Abort();
  }

  report(message: string, hard: boolean): void {
    if (hard) this.fail(message);
    this.soft(message);
  }

  numberOf(value: VimValue, hard: boolean): bigint {
    switch (value.kind) {
      case 'number': return value.value;
      case 'string': return numberFromString(value.value);
      case 'special': return value.name === 'true' ? 1n : 0n;
      case 'float': this.report('E805: Using a Float as a Number', hard); return 0n;
      case 'funcref': this.report('E703: Using a Funcref as a Number', hard); return 0n;
      case 'list': this.report('E745: Using a List as a Number', hard); return 0n;
      case 'dict': this.report('E728: Using a Dictionary as a Number', hard); return 0n;
    }
  }

  floatOf(value: VimValue, hard: boolean): number {
    if (value.kind === 'float') return value.value;
    return Number(this.numberOf(value, hard));
  }

  stringOf(value: VimValue, hard: boolean): string {
    switch (value.kind) {
      case 'number': return value.value.toString();
      case 'string': return value.value;
      case 'float': return formatFloatDefault(value.value);
      case 'special': return `v:${value.name}`;
      case 'funcref': this.report('E729: Using a Funcref as a String', hard); return '';
      case 'list': this.report('E730: Using a List as a String', hard); return '';
      case 'dict': this.report('E731: Using a Dictionary as a String', hard); return '';
    }
  }

  truth(value: VimValue): boolean {
    return this.numberOf(value, true) !== 0n;
  }

  regexp(pattern: string, ignoreCase: boolean, subject: string): VimRegExp {
    return compileVimPattern(pattern, ignoreCase, {
      lines: [subject], tabstop: this.host.tabstop, cursor: { line: 0, col: 0 }, mark: () => null, visual: null,
    });
  }
}

interface FunctionDefinition {
  readonly min: number;
  readonly max: number;
  readonly base?: number;
  run(args: VimValue[], context: Context): VimValue;
}

const WHITESPACE_MASK = ' \t\n\r\x0b ';

interface FormatSpec {
  readonly left: boolean;
  readonly plus: boolean;
  readonly space: boolean;
  readonly alternate: boolean;
  readonly zero: boolean;
  readonly width: number;
  readonly precision: number | null;
}

function signPrefix(negative: boolean, spec: FormatSpec): string {
  if (negative) return '-';
  if (spec.plus) return '+';
  return spec.space ? ' ' : '';
}

function justify(spec: FormatSpec, prefix: string, body: string, allowZero: boolean): string {
  const length = utf8Length(prefix) + utf8Length(body);
  if (length >= spec.width) return prefix + body;
  if (spec.left) return prefix + body + ' '.repeat(spec.width - length);
  if (spec.zero && allowZero) return prefix + '0'.repeat(spec.width - length) + body;
  return ' '.repeat(spec.width - length) + prefix + body;
}

function formatInteger(value: bigint, conversion: string, spec: FormatSpec): string {
  let magnitude = value < 0n ? -value : value;
  let negative = value < 0n;
  let radix = 10;
  if ('xXobB'.includes(conversion) || conversion === 'u') {
    magnitude = BigInt.asUintN(64, value);
    negative = false;
  }
  if (conversion === 'x' || conversion === 'X') radix = 16;
  if (conversion === 'o') radix = 8;
  if (conversion === 'b' || conversion === 'B') radix = 2;
  let digits = magnitude.toString(radix);
  if (conversion === 'X') digits = digits.toUpperCase();
  if (spec.precision !== null) {
    if (spec.precision === 0 && magnitude === 0n) digits = '';
    else digits = digits.padStart(spec.precision, '0');
  }
  let prefix = signPrefix(negative, spec);
  if (spec.alternate && magnitude !== 0n) {
    if (conversion === 'x') prefix += '0x';
    else if (conversion === 'X') prefix += '0X';
    else if (conversion === 'b') prefix += '0b';
    else if (conversion === 'B') prefix += '0B';
    else if (conversion === 'o' && !digits.startsWith('0')) digits = `0${digits}`;
  }
  return justify(spec, prefix, digits, spec.precision === null);
}

function formatFloating(value: number, conversion: string, spec: FormatSpec): string {
  const upper = conversion === conversion.toUpperCase();
  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  let body: string;
  if (Number.isNaN(value)) body = upper ? 'NAN' : 'nan';
  else if (!Number.isFinite(value)) body = upper ? 'INF' : 'inf';
  else if (conversion === 'f' || conversion === 'F') body = formatFixedSafe(magnitude, spec.precision ?? 6);
  else if (conversion === 'e' || conversion === 'E') body = formatExponentialSafe(magnitude, spec.precision ?? 6, upper);
  else body = formatVimGeneral(magnitude, spec.precision ?? 6, spec.precision === null, upper);
  const finite = Number.isFinite(value);
  return justify(spec, signPrefix(negative && !Number.isNaN(value), spec), body, finite);
}

function printfFormat(args: VimValue[], context: Context): string {
  const format = context.stringOf(args[0], false);
  const values = args.slice(1);
  let out = '';
  let nextArgument = 0;
  let highest = 0;
  let positional = false;
  const characters = [...format];
  const take = (index: number): VimValue | null => {
    highest = Math.max(highest, index + 1);
    return index < values.length ? values[index] : null;
  };
  for (let at = 0; at < characters.length; at++) {
    if (characters[at] !== '%') {
      out += characters[at];
      continue;
    }
    at++;
    let argumentIndex = -1;
    const lookahead = /^(\d+)\$/.exec(characters.slice(at).join(''));
    if (lookahead !== null) {
      argumentIndex = Number(lookahead[1]) - 1;
      positional = true;
      at += lookahead[0].length;
    }
    let left = false;
    let plus = false;
    let space = false;
    let alternate = false;
    let zero = false;
    for (; at < characters.length && '-+ #0'.includes(characters[at]); at++) {
      if (characters[at] === '-') left = true;
      else if (characters[at] === '+') plus = true;
      else if (characters[at] === ' ') space = true;
      else if (characters[at] === '#') alternate = true;
      else zero = true;
    }
    let width = 0;
    if (characters[at] === '*') {
      const supplied = take(nextArgument++);
      width = supplied === null ? 0 : Number(context.numberOf(supplied, false));
      if (width < 0) {
        left = true;
        width = -width;
      }
      at++;
    } else {
      while (characters[at] >= '0' && characters[at] <= '9') width = width * 10 + Number(characters[at++]);
    }
    let precision: number | null = null;
    if (characters[at] === '.') {
      at++;
      precision = 0;
      if (characters[at] === '*') {
        const supplied = take(nextArgument++);
        precision = supplied === null ? 0 : Number(context.numberOf(supplied, false));
        if (precision < 0) precision = null;
        at++;
      } else {
        while (characters[at] >= '0' && characters[at] <= '9') precision = precision * 10 + Number(characters[at++]);
      }
    }
    while (characters[at] === 'h' || characters[at] === 'l') at++;
    const conversion = characters[at];
    if (conversion === undefined) break;
    const spec: FormatSpec = { left, plus, space, alternate, zero, width, precision };
    if (conversion === '%') {
      out += justify(spec, '', '%', true);
      continue;
    }
    if (!'diuoxXbBcsSfFeEgG'.includes(conversion)) {
      out += conversion;
      continue;
    }
    const index = argumentIndex >= 0 ? argumentIndex : nextArgument++;
    const supplied = take(index);
    if (supplied === null) {
      context.soft('E766: Insufficient arguments for printf()');
      if ('sS'.includes(conversion)) out += justify(spec, '', '[NULL]', false);
      else if ('diuoxXbB'.includes(conversion)) out += formatInteger(0n, conversion, spec);
      continue;
    }
    if (conversion === 's' || conversion === 'S') {
      let text = supplied.kind === 'string' ? supplied.value : echoString(supplied, true);
      if (supplied.kind === 'special') text = `v:${supplied.name}`;
      if (spec.precision !== null) {
        let kept = '';
        for (const character of text) {
          if (utf8Length(kept + character) > spec.precision) break;
          kept += character;
        }
        text = kept;
      }
      out += justify(spec, '', text, false);
    } else if (conversion === 'c') {
      out += justify(spec, '', String.fromCodePoint(Math.max(0, Number(context.numberOf(supplied, false)))), false);
    } else if ('fFeEgG'.includes(conversion)) {
      if (supplied.kind !== 'float' && supplied.kind !== 'number') context.soft('E807: Expected Float argument for printf()');
      out += formatFloating(supplied.kind === 'float' || supplied.kind === 'number' ? context.floatOf(supplied, false) : 0, conversion, spec);
    } else {
      out += formatInteger(context.numberOf(supplied, false), conversion, spec);
    }
  }
  if (!positional && highest < values.length) context.soft('E767: Too many arguments for printf()');
  return out;
}

function lineSpec(context: Context, value: VimValue): number {
  if (value.kind === 'number') return Number(value.value);
  const text = context.stringOf(value, false);
  const host = context.host;
  if (text === '.') return host.lineNumber;
  if (text === '$') return host.lines.length;
  if (text.startsWith("'") && text.length === 2) {
    const mark = host.mark(text[1]);
    return mark === null ? 0 : mark.line + 1;
  }
  return Number(numberFromString(text));
}

function virtualColumn(line: string, index: number, tabstop: number): number {
  const before = cursorVcol(line, index, tabstop, false);
  if (index >= line.length) return before + 1;
  return before + charCells(line[index], before, tabstop);
}

function listOf(value: VimValue, context: Context): VimList | null {
  if (value.kind === 'list') return value;
  context.soft('E714: List required');
  return null;
}

function characters(text: string): string[] {
  return [...text];
}

function indexByBytes(haystack: string, needle: string, from: number, last: boolean): number {
  const bytes = encoder.encode(haystack);
  const wanted = encoder.encode(needle);
  const start = Math.max(0, from);
  const fits = (at: number): boolean => wanted.every((byte, offset) => bytes[at + offset] === byte);
  if (!last) {
    for (let at = start; at + wanted.length <= bytes.length; at++) if (fits(at)) return at;
    return -1;
  }
  const begin = Math.min(from, bytes.length - wanted.length);
  for (let at = begin; at >= 0; at--) if (fits(at)) return at;
  return -1;
}

interface MatchHit {
  readonly start: number;
  readonly end: number;
  readonly groups: (string | undefined)[];
}

function searchText(regex: VimRegExp, text: string, startByte: number, count: number): MatchHit | null {
  if (regex.error !== null) return null;
  let from = colAtByte(text, Math.max(0, startByte));
  let hit: MatchHit | null = null;
  for (let found = 0; found < Math.max(1, count); found++) {
    if (from > text.length) return null;
    const match = regex.exec(text, from);
    if (match === null) return null;
    hit = { start: match.index, end: match.index + match[0].length, groups: Array.from(match) };
    from = hit.end > hit.start ? hit.end : hit.end + (text.codePointAt(hit.end)! > 0xffff ? 2 : 1);
  }
  return hit;
}

function substituteText(context: Context, subject: string, pattern: string, replacement: string, flags: string, nested: (hit: MatchHit) => string): string {
  const regex = context.regexp(pattern, context.host.ignoreCase, subject);
  if (regex.error !== null) return subject;
  const global = flags === 'g';
  let out = '';
  let copied = 0;
  let from = 0;
  while (from <= subject.length) {
    const match = regex.exec(subject, from);
    if (match === null) break;
    const hit: MatchHit = { start: match.index, end: match.index + match[0].length, groups: Array.from(match) };
    out += subject.slice(copied, hit.start);
    out += replacement.startsWith('\\=') ? nested(hit) : expandReplacement(replacement, { groups: hit.groups }, true);
    copied = hit.end;
    if (!global) break;
    if (hit.end === hit.start) {
      if (hit.end >= subject.length) break;
      const width = subject.codePointAt(hit.end)! > 0xffff ? 2 : 1;
      out += subject.slice(hit.end, hit.end + width);
      copied = hit.end + width;
      from = copied;
    } else {
      from = hit.end;
    }
  }
  return out + subject.slice(copied);
}

function splitText(context: Context, subject: string, pattern: string | null, keepEmpty: boolean): VimValue {
  const effective = pattern === null || pattern === '' ? '[\\x01- ]\\+' : pattern;
  const regex = context.regexp(effective, false, subject);
  const items: VimValue[] = [];
  if (regex.error !== null) return list([str(subject)]);
  let rest = subject;
  let column = 0;
  while (rest !== '' || keepEmpty) {
    const match = rest === '' ? null : regex.exec(rest, column);
    const end = match === null ? rest.length : match.index;
    const matchEnd = match === null ? rest.length : match.index + match[0].length;
    if (keepEmpty || end > 0 || (items.length > 0 && rest !== '' && match !== null && end < matchEnd)) items.push(str(rest.slice(0, end)));
    if (match === null) break;
    column = matchEnd > 0 ? 0 : (rest.codePointAt(matchEnd) ?? 0) > 0xffff ? 2 : 1;
    rest = rest.slice(matchEnd);
  }
  return list(items);
}

function rangeItems(context: Context, args: VimValue[]): VimValue {
  const first = Number(context.numberOf(args[0], false));
  let start = 0;
  let end = first - 1;
  let stride = 1;
  if (args.length > 1) {
    start = first;
    end = Number(context.numberOf(args[1], false));
    if (args.length > 2) stride = Number(context.numberOf(args[2], false));
  }
  if (stride === 0) {
    context.soft('E726: Stride is zero');
    return list([]);
  }
  if ((stride > 0 && end < start - 1) || (stride < 0 && end > start + 1)) {
    context.soft('E727: Start past end');
    return list([]);
  }
  const items: VimValue[] = [];
  for (let at = start; stride > 0 ? at <= end : at >= end; at += stride) {
    items.push(num(at));
    if (items.length > 100000) break;
  }
  return list(items);
}

function sortList(context: Context, target: VimList, flags: VimValue | undefined): VimValue {
  if (flags !== undefined && flags.kind === 'funcref') {
    const comparator = flags;
    const ordered = target.items.map((item, at) => ({ item, at }));
    ordered.sort((left, right) => {
      const order = Number(context.numberOf(context.invoke(comparator, [left.item, right.item]), false));
      return order !== 0 ? order : left.at - right.at;
    });
    target.items = ordered.map((entry) => entry.item);
    return target;
  }
  const options = flags === undefined ? '' : context.stringOf(flags, false);
  const ignoreCase = options.includes('i');
  const numeric = options.includes('n') || options.includes('N');
  const floating = options.includes('f');
  const key = (item: VimValue): string | number => {
    if (numeric) return Number(context.numberOf(item, false));
    if (floating) return context.floatOf(item, false);
    return item.kind === 'string' ? item.value : echoString(item, false);
  };
  const decorated = target.items.map((item, at) => ({ item, at, key: key(item) }));
  decorated.sort((left, right) => {
    let order: number;
    if (typeof left.key === 'number' && typeof right.key === 'number') order = left.key - right.key;
    else order = compareText(String(left.key), String(right.key), ignoreCase);
    return order !== 0 ? order : left.at - right.at;
  });
  target.items = decorated.map((entry) => entry.item);
  return target;
}

function deepCopy(value: VimValue): VimValue {
  if (value.kind === 'list') return list(value.items.map(deepCopy));
  if (value.kind === 'dict') return dict(new Map(inVimOrder(value.entries).map(([key, item]) => [key, deepCopy(item)] as const)));
  return value;
}

function lengthOf(context: Context, value: VimValue): VimValue {
  switch (value.kind) {
    case 'number': return num(value.value.toString().length);
    case 'string': return num(utf8Length(value.value));
    case 'list': return num(value.items.length);
    case 'dict': return num(value.entries.size);
    default:
      context.soft('E701: Invalid type for len()');
      return num(0);
  }
}

function emptyValue(value: VimValue): boolean {
  switch (value.kind) {
    case 'number': return value.value === 0n;
    case 'float': return value.value === 0;
    case 'string': return value.value === '';
    case 'special': return value.name !== 'true';
    case 'funcref': return false;
    case 'list': return value.items.length === 0;
    case 'dict': return value.entries.size === 0;
  }
}

function typeCode(value: VimValue): number {
  switch (value.kind) {
    case 'number': return 0;
    case 'string': return 1;
    case 'funcref': return 2;
    case 'list': return 3;
    case 'dict': return 4;
    case 'float': return 5;
    case 'special': return value.name === 'true' || value.name === 'false' ? 6 : 7;
  }
}

function trimText(subject: string, mask: string, direction: number): string {
  const members = new Set(characters(mask === '' ? WHITESPACE_MASK : mask));
  const chars = characters(subject);
  let begin = 0;
  let end = chars.length;
  if (direction !== 2) while (begin < end && members.has(chars[begin])) begin++;
  if (direction !== 1) while (end > begin && members.has(chars[end - 1])) end--;
  return chars.slice(begin, end).join('');
}

function strPart(subject: string, startValue: bigint, lengthValue: bigint | null, byCharacter: boolean): string {
  const units = byCharacter ? characters(subject) : Array.from(encoder.encode(subject));
  const size = units.length;
  let start = Number(startValue);
  let length = lengthValue === null ? size - start : Number(lengthValue);
  if (start < 0) {
    length += start;
    start = 0;
  } else if (start > size) {
    start = size;
  }
  if (length < 0) length = 0;
  else if (start + length > size) length = size - start;
  if (byCharacter) return (units as string[]).slice(start, start + length).join('');
  return decoder.decode(Uint8Array.from((units as number[]).slice(start, start + length)));
}

const FUNCTIONS: ReadonlyMap<string, FunctionDefinition> = new Map<string, FunctionDefinition>([
  ['submatch', { min: 1, max: 2, run: (args, context) => {
    const index = Number(context.numberOf(args[0], false));
    if (index < 0 || index > 9) {
      context.soft(`E935: Invalid submatch number: ${index}`);
      return num(0);
    }
    const text = context.host.submatch(index);
    if (args[1] !== undefined && context.numberOf(args[1], false) !== 0n) {
      return text === undefined ? list([]) : list(text.split('\n').map(str));
    }
    return str(text ?? '');
  } }],
  ['line', { min: 1, max: 2, run: (args, context) => {
    const text = context.stringOf(args[0], false);
    if (text === '.') return num(context.host.lineNumber);
    if (text === '$') return num(context.host.lines.length);
    if (text === 'w0') return num(context.host.windowTop);
    if (text === 'w$') return num(context.host.windowBottom);
    if (text.startsWith("'") && text.length === 2) {
      const mark = context.host.mark(text[1]);
      return num(mark === null ? 0 : mark.line + 1);
    }
    return num(0);
  } }],
  ['col', { min: 1, max: 1, run: (args, context) => {
    const text = context.stringOf(args[0], false);
    const host = context.host;
    const current = host.lines[host.lineNumber - 1] ?? '';
    if (text === '.') return num(byteOffset(current, host.columnIndex) + 1);
    if (text === '$') return num(utf8Length(current) + 1);
    if (text.startsWith("'") && text.length === 2) {
      const mark = host.mark(text[1]);
      return num(mark === null ? 0 : byteOffset(host.lines[mark.line] ?? '', mark.col) + 1);
    }
    return num(0);
  } }],
  ['virtcol', { min: 1, max: 1, run: (args, context) => {
    const text = context.stringOf(args[0], false);
    const host = context.host;
    const current = host.lines[host.lineNumber - 1] ?? '';
    if (text === '.') return num(virtualColumn(current, host.columnIndex, host.tabstop));
    if (text === '$') return num(cursorVcol(current, current.length, host.tabstop, false) + 1);
    return num(0);
  } }],
  ['getline', { min: 1, max: 2, run: (args, context) => {
    const host = context.host;
    const first = lineSpec(context, args[0]);
    if (args[1] === undefined) return str(first >= 1 && first <= host.lines.length ? host.lines[first - 1] : '');
    const last = lineSpec(context, args[1]);
    const items: VimValue[] = [];
    for (let at = Math.max(first, 1); at <= Math.min(last, host.lines.length); at++) items.push(str(host.lines[at - 1]));
    return list(items);
  } }],
  ['indent', { min: 1, max: 1, run: (args, context) => {
    const host = context.host;
    const at = lineSpec(context, args[0]);
    if (at < 1 || at > host.lines.length) return num(-1);
    const line = host.lines[at - 1];
    let end = 0;
    while (line[end] === ' ' || line[end] === '\t') end++;
    return num(cursorVcol(line, end, host.tabstop, false));
  } }],
  ['toupper', { min: 1, max: 1, run: (args, context) => str(characters(context.stringOf(args[0], false)).map(upperCaseChar).join('')) }],
  ['tolower', { min: 1, max: 1, run: (args, context) => str(characters(context.stringOf(args[0], false)).map(lowerCaseChar).join('')) }],
  ['strlen', { min: 1, max: 1, run: (args, context) => num(utf8Length(context.stringOf(args[0], false))) }],
  ['strchars', { min: 1, max: 2, run: (args, context) => num(characters(context.stringOf(args[0], false)).length) }],
  ['strwidth', { min: 1, max: 1, run: (args, context) => num(characters(context.stringOf(args[0], false)).reduce((sum, character) => sum + (character === '\t' ? 1 : charCells(character, 0, 8)), 0)) }],
  ['strdisplaywidth', { min: 1, max: 2, run: (args, context) => {
    const start = args[1] === undefined ? 0 : Number(context.numberOf(args[1], false));
    let column = start;
    for (const character of characters(context.stringOf(args[0], false))) column += charCells(character, column, context.host.tabstop);
    return num(column - start);
  } }],
  ['strpart', { min: 2, max: 4, run: (args, context) => str(strPart(
    context.stringOf(args[0], false), context.numberOf(args[1], false), args[2] === undefined ? null : context.numberOf(args[2], false),
    args[3] !== undefined && context.numberOf(args[3], false) !== 0n,
  )) }],
  ['strcharpart', { min: 2, max: 3, run: (args, context) => str(strPart(
    context.stringOf(args[0], false), context.numberOf(args[1], false), args[2] === undefined ? null : context.numberOf(args[2], false), true,
  )) }],
  ['repeat', { min: 2, max: 2, run: (args, context) => {
    const count = Number(context.numberOf(args[1], false));
    if (args[0].kind === 'list') {
      const items: VimValue[] = [];
      for (let at = 0; at < count; at++) items.push(...args[0].items);
      return list(items);
    }
    return str(count > 0 ? context.stringOf(args[0], false).repeat(count) : '');
  } }],
  ['printf', { min: 1, max: Number.MAX_SAFE_INTEGER, base: 2, run: (args, context) => str(printfFormat(args, context)) }],
  ['str2nr', { min: 1, max: 3, run: (args, context) => {
    const base = args[1] === undefined ? 10 : Number(context.numberOf(args[1], false));
    if (![2, 8, 10, 16].includes(base)) {
      context.soft('E474: Invalid argument');
      return num(0);
    }
    const text = context.stringOf(args[0], false);
    let at = 0;
    while (text[at] === ' ' || text[at] === '\t') at++;
    if (text[at] === '+') {
      at++;
      while (text[at] === ' ' || text[at] === '\t') at++;
    }
    return num(parseInteger(text, at, base as 2 | 8 | 10 | 16, true).value);
  } }],
  ['abs', { min: 1, max: 1, run: (args, context) => {
    if (args[0].kind === 'float') return flt(Math.abs(args[0].value));
    const value = context.numberOf(args[0], false);
    return num(value < 0n ? -value : value);
  } }],
  ['max', { min: 1, max: 1, run: (args, context) => extreme(args[0], context, true) }],
  ['min', { min: 1, max: 1, run: (args, context) => extreme(args[0], context, false) }],
  ['trim', { min: 1, max: 3, run: (args, context) => str(trimText(
    context.stringOf(args[0], false), args[1] === undefined ? '' : context.stringOf(args[1], false),
    args[2] === undefined ? 0 : Number(context.numberOf(args[2], false)),
  )) }],
  ['escape', { min: 2, max: 2, run: (args, context) => {
    const members = new Set(characters(context.stringOf(args[1], false)));
    return str(characters(context.stringOf(args[0], false)).map((character) => (members.has(character) ? `\\${character}` : character)).join(''));
  } }],
  ['string', { min: 1, max: 1, run: (args) => str(echoString(args[0], true)) }],
  ['len', { min: 1, max: 1, run: (args, context) => lengthOf(context, args[0]) }],
  ['empty', { min: 1, max: 1, run: (args) => num(emptyValue(args[0]) ? 1 : 0) }],
  ['type', { min: 1, max: 1, run: (args) => num(typeCode(args[0])) }],
  ['nr2char', { min: 1, max: 2, run: (args, context) => {
    const code = Number(context.numberOf(args[0], false));
    return str(code < 0 || code > 0x10ffff ? '�' : String.fromCodePoint(code));
  } }],
  ['char2nr', { min: 1, max: 2, run: (args, context) => {
    const first = characters(context.stringOf(args[0], false))[0];
    return num(first === undefined ? 0 : first.codePointAt(0)!);
  } }],
  ['stridx', { min: 2, max: 3, run: (args, context) => num(indexByBytes(
    context.stringOf(args[0], false), context.stringOf(args[1], false), args[2] === undefined ? 0 : Number(context.numberOf(args[2], false)), false,
  )) }],
  ['strridx', { min: 2, max: 3, run: (args, context) => {
    const haystack = context.stringOf(args[0], false);
    const from = args[2] === undefined ? utf8Length(haystack) : Number(context.numberOf(args[2], false));
    return num(indexByBytes(haystack, context.stringOf(args[1], false), from, true));
  } }],
  ['tr', { min: 3, max: 3, run: (args, context) => {
    const from = characters(context.stringOf(args[1], false));
    const to = characters(context.stringOf(args[2], false));
    if (from.length !== to.length) {
      context.soft(`E475: Invalid argument: ${context.stringOf(args[1], false)}`);
      return str('');
    }
    return str(characters(context.stringOf(args[0], false)).map((character) => {
      const at = from.indexOf(character);
      return at < 0 ? character : to[at];
    }).join(''));
  } }],
  ['substitute', { min: 4, max: 4, run: (args, context) => str(substituteText(
    context, context.stringOf(args[0], false), context.stringOf(args[1], false), context.stringOf(args[2], false), context.stringOf(args[3], false),
    (hit) => context.stringOf(evaluateWithSubmatches(context, args[2], hit), false),
  )) }],
  ['match', { min: 2, max: 4, run: (args, context) => num(matchPosition(context, args, 'start')) }],
  ['matchend', { min: 2, max: 4, run: (args, context) => num(matchPosition(context, args, 'end')) }],
  ['matchstr', { min: 2, max: 4, run: (args, context) => {
    const subject = context.stringOf(args[0], false);
    const hit = searchText(context.regexp(context.stringOf(args[1], false), context.host.ignoreCase, subject), subject,
      args[2] === undefined ? 0 : Number(context.numberOf(args[2], false)), args[3] === undefined ? 1 : Number(context.numberOf(args[3], false)));
    return str(hit === null ? '' : subject.slice(hit.start, hit.end));
  } }],
  ['matchstrpos', { min: 2, max: 4, run: (args, context) => {
    const subject = context.stringOf(args[0], false);
    const hit = searchText(context.regexp(context.stringOf(args[1], false), context.host.ignoreCase, subject), subject,
      args[2] === undefined ? 0 : Number(context.numberOf(args[2], false)), args[3] === undefined ? 1 : Number(context.numberOf(args[3], false)));
    if (hit === null) return list([str(''), num(-1), num(-1)]);
    return list([str(subject.slice(hit.start, hit.end)), num(byteOffset(subject, hit.start)), num(byteOffset(subject, hit.end))]);
  } }],
  ['matchlist', { min: 2, max: 4, run: (args, context) => {
    const subject = context.stringOf(args[0], false);
    const hit = searchText(context.regexp(context.stringOf(args[1], false), context.host.ignoreCase, subject), subject,
      args[2] === undefined ? 0 : Number(context.numberOf(args[2], false)), args[3] === undefined ? 1 : Number(context.numberOf(args[3], false)));
    if (hit === null) return list([]);
    return list(Array.from({ length: 10 }, (_, at) => str(hit.groups[at] ?? '')));
  } }],
  ['split', { min: 1, max: 3, run: (args, context) => splitText(
    context, context.stringOf(args[0], false), args[1] === undefined ? null : context.stringOf(args[1], false),
    args[2] !== undefined && context.numberOf(args[2], false) !== 0n,
  ) }],
  ['join', { min: 1, max: 2, run: (args, context) => {
    const target = listOf(args[0], context);
    if (target === null) return str('');
    const separator = args[1] === undefined ? ' ' : context.stringOf(args[1], false);
    return str(target.items.map((item) => echoString(item, false)).join(separator));
  } }],
  ['reverse', { min: 1, max: 1, run: (args, context) => {
    if (args[0].kind === 'list') {
      args[0].items.reverse();
      return args[0];
    }
    return str(characters(context.stringOf(args[0], false)).reverse().join(''));
  } }],
  ['sort', { min: 1, max: 3, run: (args, context) => {
    const target = listOf(args[0], context);
    return target === null ? num(0) : sortList(context, target, args[1]);
  } }],
  ['uniq', { min: 1, max: 3, run: (args, context) => {
    const target = listOf(args[0], context);
    if (target === null) return num(0);
    target.items = target.items.filter((item, at) => at === 0 || !sameValue(item, target.items[at - 1], false));
    return target;
  } }],
  ['add', { min: 2, max: 2, run: (args, context) => {
    if (args[0].kind !== 'list') {
      context.soft('E897: List or Blob required');
      return num(1);
    }
    args[0].items.push(args[1]);
    return args[0];
  } }],
  ['extend', { min: 2, max: 3, run: (args, context) => extendValue(args, context) }],
  ['insert', { min: 2, max: 3, run: (args, context) => {
    const target = args[0];
    if (target.kind !== 'list') {
      context.soft('E897: List or Blob required');
      return num(0);
    }
    let at = args[2] === undefined ? 0 : Number(context.numberOf(args[2], false));
    if (at < 0) at += target.items.length;
    if (at < 0 || at > target.items.length) {
      context.soft(`E684: List index out of range: ${at}`);
      return num(0);
    }
    target.items.splice(at, 0, args[1]);
    return target;
  } }],
  ['remove', { min: 2, max: 3, run: (args, context) => removeValue(args, context) }],
  ['copy', { min: 1, max: 1, run: (args) => {
    const value = args[0];
    if (value.kind === 'list') return list([...value.items]);
    if (value.kind === 'dict') return dict(new Map(inVimOrder(value.entries)));
    return value;
  } }],
  ['deepcopy', { min: 1, max: 2, run: (args) => deepCopy(args[0]) }],
  ['range', { min: 1, max: 3, run: (args, context) => rangeItems(context, args) }],
  ['count', { min: 2, max: 4, run: (args, context) => {
    const ignoreCase = args[2] !== undefined && context.numberOf(args[2], false) !== 0n;
    const target = args[0];
    if (target.kind === 'string') {
      const needle = context.stringOf(args[1], false);
      if (needle === '') return num(0);
      const subject = ignoreCase ? foldCase(target.value) : target.value;
      const wanted = ignoreCase ? foldCase(needle) : needle;
      return num(subject.split(wanted).length - 1);
    }
    const items = target.kind === 'list' ? target.items : target.kind === 'dict' ? inVimOrder(target.entries).map(([, item]) => item) : [];
    return num(items.filter((item) => sameValue(item, args[1], ignoreCase)).length);
  } }],
  ['index', { min: 2, max: 4, run: (args, context) => {
    const target = listOf(args[0], context);
    if (target === null) return num(-1);
    const ignoreCase = args[3] !== undefined && context.numberOf(args[3], false) !== 0n;
    let start = args[2] === undefined ? 0 : Number(context.numberOf(args[2], false));
    if (start < 0) start = Math.max(0, target.items.length + start);
    for (let at = start; at < target.items.length; at++) if (sameValue(target.items[at], args[1], ignoreCase)) return num(at);
    return num(-1);
  } }],
  ['get', { min: 2, max: 3, run: (args, context) => {
    const fallback = args[2] ?? num(0);
    const target = args[0];
    if (target.kind === 'list') {
      let at = Number(context.numberOf(args[1], false));
      if (at < 0) at += target.items.length;
      return target.items[at] ?? fallback;
    }
    if (target.kind === 'dict') return target.entries.get(context.stringOf(args[1], false)) ?? fallback;
    context.soft('E896: Argument of get() must be a List, Dictionary or Blob');
    return num(0);
  } }],
  ['keys', { min: 1, max: 1, run: (args, context) => args[0].kind === 'dict' ? list(inVimOrder(args[0].entries).map(([key]) => str(key))) : dictRequired(context) }],
  ['values', { min: 1, max: 1, run: (args, context) => args[0].kind === 'dict' ? list(inVimOrder(args[0].entries).map(([, item]) => item)) : dictRequired(context) }],
  ['items', { min: 1, max: 1, run: (args, context) => args[0].kind === 'dict' ? list(inVimOrder(args[0].entries).map(([key, item]) => list([str(key), item]))) : dictRequired(context) }],
  ['has_key', { min: 2, max: 2, run: (args, context) => args[0].kind === 'dict' ? num(args[0].entries.has(context.stringOf(args[1], false)) ? 1 : 0) : dictRequired(context) }],
  ['map', { min: 2, max: 2, run: (args, context) => mapOrFilter(args, context, true) }],
  ['mapnew', { min: 2, max: 2, run: (args, context) => {
    const source = args[0];
    if (source.kind !== 'list' && source.kind !== 'dict') {
      context.soft('E712: Argument of mapnew() must be a List or Dictionary');
      return num(0);
    }
    const copy: VimValue = source.kind === 'list' ? list([...source.items]) : dict(new Map(inVimOrder(source.entries)));
    return mapOrFilter([copy, args[1]], context, true);
  } }],
  ['reduce', { min: 2, max: 3, run: (args, context) => {
    const source = args[0];
    if (source.kind !== 'list' && source.kind !== 'string') {
      context.soft('E1098: String, List or Blob required for argument 1');
      return num(0);
    }
    const items: VimValue[] = source.kind === 'list' ? [...source.items] : characters(source.value).map(str);
    let accumulator: VimValue;
    let at = 0;
    if (args[2] === undefined) {
      if (items.length === 0) {
        context.soft(`E998: Reduce of an empty ${source.kind === 'list' ? 'List' : 'String'} with no initial value`);
        return num(0);
      }
      accumulator = items[0];
      at = 1;
    } else {
      accumulator = args[2];
    }
    for (; at < items.length; at++) {
      try {
        accumulator = context.invoke(args[1], [accumulator, items[at]]);
      } catch (failure) {
        if (!(failure instanceof Abort)) throw failure;
        break;
      }
    }
    return accumulator;
  } }],
  ['environ', { min: 0, max: 0, run: (_args, context) => dict(new Map(context.host.environmentNames().map((name) => [name, str(context.host.environmentOrNull(name) ?? '')] as const))) }],
  ['getenv', { min: 1, max: 1, run: (args, context) => {
    const value = context.host.environmentOrNull(context.stringOf(args[0], false));
    return value === null || value === '' ? special('null') : str(value);
  } }],
  ['filereadable', { min: 1, max: 1, run: (args, context) => num(context.host.pathKind(context.stringOf(args[0], false)) === 'file' && context.host.readText(context.stringOf(args[0], false)) !== null ? 1 : 0) }],
  ['isdirectory', { min: 1, max: 1, run: (args, context) => num(context.host.pathKind(context.stringOf(args[0], false)) === 'directory' ? 1 : 0) }],
  ['getcwd', { min: 0, max: 2, run: (_args, context) => str(context.host.workingDirectory()) }],
  ['getfsize', { min: 1, max: 1, run: (args, context) => {
    const path = context.stringOf(args[0], false);
    const kind = context.host.pathKind(path);
    if (kind === 'missing') return num(-1);
    return num(kind === 'file' ? utf8Length(context.host.readText(path) ?? '') : 0);
  } }],
  ['readfile', { min: 1, max: 3, run: (args, context) => {
    const name = context.stringOf(args[0], false);
    const text = context.host.pathKind(name) === 'file' ? context.host.readText(name) : null;
    if (text === null) {
      return context.fail(`E484: Can't open file ${name}`);
    }
    const binary = args[1] !== undefined && context.stringOf(args[1], false).includes('b');
    const limit = args[2] === undefined ? Number.MAX_SAFE_INTEGER : Number(context.numberOf(args[2], false));
    const pieces = text === '' ? [] : text.split('\n');
    if (!binary && pieces.length > 0 && pieces[pieces.length - 1] === '') pieces.pop();
    const lines = binary ? pieces : pieces.map((piece) => piece.replace(/\r$/, ''));
    const chosen = limit < 0 ? lines.slice(Math.max(0, lines.length + limit)) : lines.slice(0, limit);
    return list(chosen.map(str));
  } }],
  ['readdir', { min: 1, max: 2, run: (args, context) => {
    const entries = context.host.directoryEntries(context.stringOf(args[0], false));
    if (entries === null) return list([]);
    const names = [...entries].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const kept = args[1] === undefined ? names : names.filter((name) => context.numberOf(context.invoke(args[1], [str(name)]), false) !== 0n);
    return list(kept.map(str));
  } }],
  ['mkdir', { min: 1, max: 3, run: (args, context) => {
    const name = context.stringOf(args[0], false);
    const flags = args[1] === undefined ? '' : context.stringOf(args[1], false);
    const mode = args[2] === undefined ? 0o755 : Number(context.numberOf(args[2], false));
    const failure = (): never => context.fail(`E739: Cannot create directory: ${name}`);
    if (name === '' || /[^p]/.test(flags)) return name === '' ? failure() : context.fail('E474: Invalid argument');
    if (flags.includes('p')) {
      const parts = name.replace(/\/+$/, '').split('/');
      for (let at = name.startsWith('/') ? 2 : 1; at <= parts.length; at++) {
        const prefix = parts.slice(0, at).join('/');
        if (prefix === '' || context.host.pathKind(prefix) === 'directory') continue;
        if (context.host.makeDirectory(prefix, mode) !== null) return failure();
      }
      return num(1);
    }
    return context.host.makeDirectory(name, mode) === null ? num(1) : failure();
  } }],
  ['writefile', { min: 2, max: 3, run: (args, context) => {
    const items = listOf(args[0], context)?.items;
    const name = context.stringOf(args[1], false);
    if (items === undefined) return num(-1);
    const flags = args[2] === undefined ? '' : context.stringOf(args[2], false);
    if (/[^bsSa]/.test(flags)) return context.fail('E474: Invalid argument');
    const body = items.map((item) => context.stringOf(item, false)).join('\n') + (flags.includes('b') || items.length === 0 ? '' : '\n');
    const previous = flags.includes('a') && context.host.pathKind(name) === 'file' ? (context.host.readText(name) ?? '') : '';
    if (context.host.writeText(name, previous + body)) return num(0);
    return context.fail(`E482: Can't create file ${name}`);
  } }],
  ['rename', { min: 2, max: 2, run: (args, context) => num(context.host.renameEntry(context.stringOf(args[0], false), context.stringOf(args[1], false)) ? 0 : -1) }],
  ['delete', { min: 1, max: 2, run: (args, context) => {
    const name = context.stringOf(args[0], false);
    const flags = args[1] === undefined ? '' : context.stringOf(args[1], false);
    if (name === '') return context.fail('E474: Invalid argument');
    if (flags !== '' && flags !== 'd' && flags !== 'rf') return context.fail(`E15: Invalid expression: "${flags}"`);
    const kind = flags === 'rf' ? 'tree' : flags === 'd' ? 'directory' : 'file';
    return num(context.host.removeEntry(name, kind) ? 0 : -1);
  } }],
  ['tempname', { min: 0, max: 0, run: (_args, context) => str(context.host.temporaryName()) }],
  ['glob', { min: 1, max: 4, run: (args, context) => {
    const found = globPaths(context.stringOf(args[0], false), globFileSystem(context), (path) => context.host.resolvePath(path));
    return args[2] !== undefined && context.numberOf(args[2], false) !== 0n ? list(found.map(str)) : str(found.join('\n'));
  } }],
  ['globpath', { min: 2, max: 5, run: (args, context) => {
    const pattern = context.stringOf(args[1], false);
    const found = context.stringOf(args[0], false).split(',').filter((directory) => directory !== '')
      .flatMap((directory) => globPaths(`${directory.replace(/\/+$/, '')}/${pattern}`, globFileSystem(context), (path) => context.host.resolvePath(path)));
    return args[3] !== undefined && context.numberOf(args[3], false) !== 0n ? list(found.map(str)) : str(found.join('\n'));
  } }],
  ['expand', { min: 1, max: 3, run: (args, context) => {
    const asList = args[2] !== undefined && context.numberOf(args[2], false) !== 0n;
    const expanded = expandWord(context, context.stringOf(args[0], false), args[1] !== undefined && context.numberOf(args[1], false) !== 0n);
    return asList ? list(expanded.map(str)) : str(expanded.join('\n'));
  } }],
  ['resolve', { min: 1, max: 1, run: (args, context) => str(resolveLinks(context, context.stringOf(args[0], false))) }],
  ['bufname', { min: 0, max: 1, run: (args, context) => str(args[0] === undefined || ['%', ''].includes(context.stringOf(args[0], false)) ? context.host.bufferName() : '') }],
  ['wordcount', { min: 0, max: 0, run: (_args, context) => wordCount(context) }],
  ['reltime', { min: 0, max: 2, run: (args, context) => relativeTime(args, context) }],
  ['reltimestr', { min: 1, max: 1, run: (args, context) => {
    const pair = listOf(args[0], context)?.items;
    if (pair === undefined || pair.length < 2) return str('');
    return str(`${String(context.numberOf(pair[0], false)).padStart(3)}.${String(context.numberOf(pair[1], false)).padStart(9, '0').slice(0, 6)}`);
  } }],
  ['reltimefloat', { min: 1, max: 1, run: (args, context) => {
    const pair = listOf(args[0], context)?.items;
    return pair === undefined || pair.length < 2 ? flt(0) : flt(Number(context.numberOf(pair[0], false)) + Number(context.numberOf(pair[1], false)) / 1e9);
  } }],
  ['strptime', { min: 2, max: 2, run: (args, context) => num(parseTimeText(context.stringOf(args[0], false), context.stringOf(args[1], false))) }],
  ['getreg', { min: 0, max: 3, run: (args, context) => {
    const name = args[0] === undefined || context.stringOf(args[0], false) === '' ? '"' : context.stringOf(args[0], false)[0];
    const asExpression = args[1] !== undefined && context.numberOf(args[1], false) !== 0n;
    const asList = args[2] !== undefined && context.numberOf(args[2], false) !== 0n;
    const content = name === '=' && asExpression ? context.host.expressionText() : context.host.register(name) ?? '';
    if (!asList) return str(content);
    const lines = content === '' ? [] : (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n');
    return list(lines.map(str));
  } }],
  ['getregtype', { min: 0, max: 1, run: (args, context) => {
    const name = args[0] === undefined || context.stringOf(args[0], false) === '' ? '"' : context.stringOf(args[0], false)[0];
    const content = context.host.register(name);
    if (content === null || (content === '' && name !== '=')) return str('');
    return str(content.endsWith('\n') ? 'V' : 'v');
  } }],
  ['setreg', { min: 2, max: 3, run: (args, context) => {
    const name = context.stringOf(args[0], false)[0] ?? '"';
    const options = args[2] === undefined ? '' : context.stringOf(args[2], false);
    if (/[b\u0016]/.test(options)) return context.fail('E475: Invalid value for argument options');
    const value = args[1];
    const text = value.kind === 'list' ? value.items.map((item) => context.stringOf(item, false)).join('\n') : context.stringOf(value, false);
    const forcedLine = /[lV]/.test(options);
    const forcedChar = /[cv]/.test(options);
    const linewise = forcedLine || (!forcedChar && (value.kind === 'list' || text.endsWith('\n')));
    const body = value.kind !== 'list' && text.endsWith('\n') ? text.slice(0, -1) : text;
    context.host.setRegister(name, body.split('\n'), linewise, options.includes('a'), value.kind === 'list');
    return num(0);
  } }],
  ['getftype', { min: 1, max: 1, run: (args, context) => {
    const info = context.host.linkInfo(context.stringOf(args[0], false));
    return str(info === null ? '' : (FILE_TYPE_NAMES[info.type] ?? 'other'));
  } }],
  ['getfperm', { min: 1, max: 1, run: (args, context) => {
    const info = context.host.linkInfo(context.stringOf(args[0], false));
    if (info === null) return str('');
    return str([...'rwxrwxrwx'].map((letter, at) => ((info.permissions >> (8 - at)) & 1) === 1 ? letter : '-').join(''));
  } }],
  ['executable', { min: 1, max: 1, run: (args, context) => num(findExecutable(context, context.stringOf(args[0], false)) === null ? 0 : 1) }],
  ['exepath', { min: 1, max: 1, run: (args, context) => str(findExecutable(context, context.stringOf(args[0], false)) ?? '') }],
  ['localtime', { min: 0, max: 0, run: () => num(Math.floor(simulationNowMs() / 1000)) }],
  ['hostname', { min: 0, max: 0, run: (_args, context) => str(context.host.hostName()) }],
  ['getpid', { min: 0, max: 0, run: (_args, context) => num(context.host.processId()) }],
  ['str2float', { min: 1, max: 1, run: (args, context) => flt(parseFloatPrefix(context.stringOf(args[0], false))) }],
  ['flatten', { min: 1, max: 2, run: (args, context) => flattenList(args, context, true) }],
  ['flattennew', { min: 1, max: 2, run: (args, context) => flattenList(args, context, false) }],
  ['slice', { min: 2, max: 3, run: (args, context) => sliceOf(args, context) }],
  ['fmod', { min: 2, max: 2, run: (args, context) => flt(floatArgument(context, args[0]) % floatArgument(context, args[1])) }],
  ['log10', { min: 1, max: 1, run: (args, context) => flt(Math.log10(floatArgument(context, args[0]))) }],
  ['isnan', { min: 1, max: 1, run: (args, context) => num(args[0].kind === 'float' && Number.isNaN(args[0].value) ? 1 : (args[0].kind === 'number' ? 0 : (context.soft('E808: Number or Float required'), 0))) }],
  ['strgetchar', { min: 2, max: 2, run: (args, context) => {
    const at = Number(context.numberOf(args[1], false));
    const picked = at < 0 ? undefined : characters(context.stringOf(args[0], false))[at];
    return num(picked === undefined ? -1 : picked.codePointAt(0)!);
  } }],
  ['byteidx', { min: 2, max: 2, run: (args, context) => num(byteIndexOfCharacter(context.stringOf(args[0], false), Number(context.numberOf(args[1], false)))) }],
  ['charidx', { min: 2, max: 3, run: (args, context) => num(characterIndexOfByte(context.stringOf(args[0], false), Number(context.numberOf(args[1], false)))) }],
  ['utf16idx', { min: 2, max: 4, run: (args, context) => num(utf16IndexOf(
    context.stringOf(args[0], false), Number(context.numberOf(args[1], false)), args[3] !== undefined && context.numberOf(args[3], false) !== 0n,
  )) }],
  ['indexof', { min: 2, max: 3, run: (args, context) => {
    const items = listOf(args[0], context)?.items;
    if (items === undefined) return num(-1);
    let from = 0;
    const options = args[2];
    if (options !== undefined && options.kind === 'dict') {
      const given = options.entries.get('startidx');
      if (given !== undefined) {
        const wanted = Number(context.numberOf(given, false));
        from = wanted < 0 ? Math.max(0, items.length + wanted) : wanted;
      }
    }
    for (let at = from; at < items.length; at++) {
      if (context.numberOf(evaluateCallback(context, args[1], num(at), items[at]), false) !== 0n) return num(at);
    }
    return num(-1);
  } }],
  ['shellescape', { min: 1, max: 2, run: (args, context) => str(`'${context.stringOf(args[0], false).replace(/'/g, "'\\''")}'`) }],
  ['isabsolutepath', { min: 1, max: 1, run: (args, context) => num(context.stringOf(args[0], false).startsWith('/') ? 1 : 0) }],
  ['simplify', { min: 1, max: 1, run: (args, context) => str(simplifyPath(context.stringOf(args[0], false))) }],
  ['pathshorten', { min: 1, max: 2, run: (args, context) => str(shortenPath(context.stringOf(args[0], false), args[1] === undefined ? 1 : Number(context.numberOf(args[1], false)))) }],
  ['fnamemodify', { min: 2, max: 2, run: (args, context) => str(modifyFileName(context.stringOf(args[0], false), context.stringOf(args[1], false), context)) }],
  ['sha256', { min: 1, max: 1, run: (args, context) => str(Array.from(sha256(new TextEncoder().encode(context.stringOf(args[0], false))), (byte) => byte.toString(16).padStart(2, '0')).join('')) }],
  ['system', { min: 1, max: 2, run: (args, context) => str(context.host.shell(
    context.stringOf(args[0], false),
    args.length > 1 ? context.stringOf(args[1], false) : null,
  )) }],
  ['systemlist', { min: 1, max: 2, run: (args, context) => {
    const output = context.host.shell(context.stringOf(args[0], false), args.length > 1 ? context.stringOf(args[1], false) : null);
    const lines = output.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return list(lines.map(str));
  } }],
  ['strftime', { min: 1, max: 2, run: (args, context) => str(formatLocalTime(
    context.stringOf(args[0], false),
    args.length > 1 ? Number(context.numberOf(args[1], true)) * 1000 : Math.floor(simulationNowMs() / 1000) * 1000,
  )) }],
  ['json_decode', { min: 1, max: 1, run: (args, context) => jsonDecode(context.stringOf(args[0], false), context) }],
  ['json_encode', { min: 1, max: 1, run: (args, context) => str(jsonEncode(args[0], context)) }],
  ['filter', { min: 2, max: 2, run: (args, context) => mapOrFilter(args, context, false) }],
  ['float2nr', { min: 1, max: 1, run: (args, context) => {
    const value = floatArgument(context, args[0]);
    if (Number.isNaN(value)) return num(0);
    if (value >= 9.223372036854776e18) return num(NUMBER_MAX);
    if (value <= -9.223372036854776e18) return num(-NUMBER_MAX);
    return num(BigInt(Math.trunc(value)));
  } }],
  ['round', { min: 1, max: 1, run: (args, context) => {
    const value = floatArgument(context, args[0]);
    return flt(Math.sign(value) * Math.round(Math.abs(value)));
  } }],
  ['ceil', { min: 1, max: 1, run: (args, context) => flt(Math.ceil(floatArgument(context, args[0]))) }],
  ['floor', { min: 1, max: 1, run: (args, context) => flt(Math.floor(floatArgument(context, args[0]))) }],
  ['trunc', { min: 1, max: 1, run: (args, context) => flt(Math.trunc(floatArgument(context, args[0]))) }],
  ['sqrt', { min: 1, max: 1, run: (args, context) => flt(Math.sqrt(floatArgument(context, args[0]))) }],
  ['pow', { min: 2, max: 2, run: (args, context) => flt(Math.pow(floatArgument(context, args[0]), floatArgument(context, args[1]))) }],
  ['and', { min: 2, max: 2, run: (args, context) => num(context.numberOf(args[0], false) & context.numberOf(args[1], false)) }],
  ['or', { min: 2, max: 2, run: (args, context) => num(context.numberOf(args[0], false) | context.numberOf(args[1], false)) }],
  ['xor', { min: 2, max: 2, run: (args, context) => num(context.numberOf(args[0], false) ^ context.numberOf(args[1], false)) }],
  ['invert', { min: 1, max: 1, run: (args, context) => num(~context.numberOf(args[0], false)) }],
  ['function', { min: 1, max: 3, run: (args, context) => makeFuncref(args, context, true) }],
  ['funcref', { min: 1, max: 3, run: (args, context) => makeFuncref(args, context, false) }],
  ['call', { min: 2, max: 3, run: (args, context) => {
    const arguments_ = args[1].kind === 'list' ? args[1].items : [];
    if (args[1].kind !== 'list') context.soft('E714: List required');
    return context.invoke(args[0], arguments_);
  } }],
  ['exists', { min: 1, max: 1, run: (args, context) => {
    const name = context.stringOf(args[0], false);
    if (name.startsWith('&')) return num(context.host.option(name.replace(/^&([lg]:)?/, ''), 'effective') === undefined ? 0 : 1);
    if (name.startsWith('$')) return num(context.host.environmentOrNull(name.slice(1)) === null ? 0 : 1);
    if (name.startsWith('*')) return num(FUNCTIONS.has(name.slice(1)) || context.host.functions?.has(name.slice(1)) === true ? 1 : 0);
    return num(context.host.variables.lookup(name) === undefined ? 0 : 1);
  } }],
  ['has', { min: 1, max: 2, run: (args, context) => num(['unix', 'linux', 'multi_byte', 'eval', 'float'].includes(context.stringOf(args[0], false)) ? 1 : 0) }],
]);

const MUTATORS = new Set(['add', 'insert', 'remove', 'extend', 'sort', 'reverse', 'map', 'filter', 'uniq']);
for (const name of MUTATORS) {
  const original = FUNCTIONS.get(name)!;
  (FUNCTIONS as Map<string, FunctionDefinition>).set(name, {
    ...original,
    run: (args, context) => {
      const target = args[0];
      if ((target.kind === 'list' || target.kind === 'dict') && target.locked === true) context.fail(`E741: Value is locked: ${name}() argument`);
      return original.run(args, context);
    },
  });
}

function extendValue(args: VimValue[], context: Context): VimValue {
  const [target, source] = args;
  if (target.kind === 'list' && source.kind === 'list') {
    let at = args[2] === undefined ? target.items.length : Number(context.numberOf(args[2], false));
    if (at < 0) at += target.items.length;
    if (at < 0 || at > target.items.length) {
      context.soft(`E684: List index out of range: ${at}`);
      return num(0);
    }
    target.items.splice(at, 0, ...source.items);
    return target;
  }
  if (target.kind === 'dict' && source.kind === 'dict') {
    const mode = args[2] === undefined ? 'force' : context.stringOf(args[2], false);
    if (!['force', 'keep', 'error'].includes(mode)) {
      context.soft(`E475: Invalid argument: ${mode}`);
      return num(0);
    }
    for (const [key, item] of inVimOrder(source.entries)) {
      if (target.entries.has(key)) {
        if (mode === 'error') {
          context.soft(`E737: Key already exists: ${key}`);
          return target;
        }
        if (mode === 'keep') continue;
      }
      target.entries.set(key, item);
    }
    return target;
  }
  context.soft('E712: Argument of extend() must be a List or Dictionary');
  return num(0);
}

function removeValue(args: VimValue[], context: Context): VimValue {
  const target = args[0];
  if (target.kind === 'dict') {
    const key = context.stringOf(args[1], false);
    const found = target.entries.get(key);
    if (found === undefined) {
      context.soft(`E716: Key not present in Dictionary: "${key}"`);
      return num(0);
    }
    target.entries.delete(key);
    return found;
  }
  if (target.kind !== 'list') {
    context.soft('E896: Argument of remove() must be a List, Dictionary or Blob');
    return num(0);
  }
  const size = target.items.length;
  let first = Number(context.numberOf(args[1], false));
  const original = first;
  if (first < 0) first += size;
  if (first < 0 || first >= size) {
    context.soft(`E684: List index out of range: ${original}`);
    return num(0);
  }
  if (args[2] === undefined) return target.items.splice(first, 1)[0];
  let last = Number(context.numberOf(args[2], false));
  if (last < 0) last += size;
  if (last < first || last >= size) {
    context.soft('E16: Invalid range');
    return num(0);
  }
  return list(target.items.splice(first, last - first + 1));
}

function makeFuncref(args: VimValue[], context: Context, builtinsAllowed: boolean): VimValue {
  const name = context.stringOf(args[0], false);
  if (!(builtinsAllowed && FUNCTIONS.has(name)) && context.host.functions?.has(name) !== true) {
    context.soft(`E700: Unknown function: ${name}`);
    return num(0);
  }
  const bound = args[1] !== undefined && args[1].kind === 'list' ? args[1].items : [];
  return { kind: 'funcref', name, params: null, body: '', scopes: [], bound };
}

const FILE_TYPE_NAMES: Readonly<Record<string, string>> = {
  file: 'file', directory: 'dir', symlink: 'link', chardev: 'cdev', blockdev: 'bdev', fifo: 'fifo', socket: 'socket',
};

function findExecutable(context: Context, name: string): string | null {
  if (name === '') return null;
  if (name.includes('/')) {
    const resolved = context.host.resolvePath(name);
    return context.host.executableAt(resolved) ? resolved : null;
  }
  const directories = (context.host.environmentOrNull('PATH') ?? '').split(':').filter((directory) => directory !== '');
  for (const directory of directories) {
    const candidate = `${directory.replace(/\/+$/, '')}/${name}`;
    if (context.host.executableAt(candidate)) return candidate;
  }
  return null;
}

function globFileSystem(context: Context): import('./VimGlob').GlobFileSystem {
  return {
    entries: (directory) => context.host.directoryEntries(directory),
    isDirectory: (path) => context.host.pathKind(path) === 'directory',
    exists: (path) => context.host.pathKind(path) !== 'missing',
    home: () => context.host.homeDirectory(),
  };
}

function expandWord(context: Context, text: string, noWildcards: boolean): string[] {
  if (text === '%' || text.startsWith('%:')) return [modifyFileName(context.host.bufferName(), text.slice(1), context)];
  if (text === '#') return [''];
  if (text === '<cword>') return [context.host.wordUnderCursor(false)];
  if (text === '<cWORD>') return [context.host.wordUnderCursor(true)];
  const withVariables = text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, bare: string | undefined, braced: string | undefined) => {
    const value = context.host.environmentOrNull(bare ?? braced ?? '');
    return value === null ? whole : value;
  });
  const home = context.host.homeDirectory();
  const withHome = (withVariables === '~' || withVariables.startsWith('~/')) && home !== null ? home + withVariables.slice(1) : withVariables;
  if (noWildcards || !hasWildcard(withHome)) return [withHome];
  const found = globPaths(withHome, globFileSystem(context), (path) => context.host.resolvePath(path));
  return found.length === 0 ? [withHome] : found;
}

function resolveLinks(context: Context, path: string): string {
  const trailing = path.length > 1 && path.endsWith('/');
  let pending = path.replace(/\/+$/, '').split('/');
  let done: string[] = path.startsWith('/') ? [''] : [];
  let guard = 0;
  while (pending.length > 0 && guard++ < 40) {
    const [part, ...rest] = pending;
    pending = rest;
    if (part === '' || part === '.') { if (part === '.' && done.length === 0) done.push('.'); continue; }
    if (part === '..') { if (done.length > 0 && done[done.length - 1] !== '..' && done[done.length - 1] !== '.') done.pop(); else done.push('..'); continue; }
    const candidate = [...done, part].join('/') || '/';
    const info = context.host.linkInfo(candidate);
    if (info !== null && info.type === 'symlink' && info.target !== undefined) {
      if (info.target.startsWith('/')) done = [''];
      pending = [...info.target.split('/'), ...pending];
      continue;
    }
    done.push(part);
  }
  const joined = done.length === 1 && done[0] === '' ? '/' : done.join('/');
  return `${joined}${trailing && !joined.endsWith('/') ? '/' : ''}`;
}

function wordCount(context: Context): VimValue {
  const lines = context.host.lines;
  const cursorLine = context.host.lineNumber;
  const cursorChars = characters(lines[cursorLine - 1] ?? '');
  const column = context.host.columnIndex;
  let chars = 0, bytes = 0, words = 0, cursorCharCount = 0, cursorByteCount = 0, cursorWordCount = 0;
  lines.forEach((line, index) => {
    const here = index + 1;
    const lineChars = characters(line);
    const reached = here < cursorLine ? lineChars.length : here === cursorLine ? Math.min(column + 1, cursorChars.length) : 0;
    const reachedText = lineChars.slice(0, reached).join('');
    if (here < cursorLine) { cursorCharCount += lineChars.length + 1; cursorByteCount += utf8Length(line) + 1; }
    else if (here === cursorLine) { cursorCharCount += reached; cursorByteCount += utf8Length(reachedText); }
    chars += lineChars.length + 1;
    bytes += utf8Length(line) + 1;
    for (const match of line.matchAll(/\S+/g)) {
      words++;
      const startChars = characters(line.slice(0, match.index)).length;
      if (here < cursorLine || (here === cursorLine && startChars < reached)) cursorWordCount++;
    }
  });
  const entries = new Map<string, VimValue>([
    ['chars', num(chars)], ['cursor_chars', num(cursorCharCount)], ['words', num(words)], ['cursor_words', num(cursorWordCount)],
    ['bytes', num(bytes)], ['cursor_bytes', num(cursorByteCount)],
  ]);
  return dict(entries);
}

function relativeTime(args: VimValue[], context: Context): VimValue {
  const nowNs = BigInt(simulationNowMs()) * 1000000n;
  const toNs = (value: VimValue): bigint => {
    const pair = listOf(value, context)?.items;
    return pair === undefined || pair.length < 2 ? 0n : context.numberOf(pair[0], false) * 1000000000n + context.numberOf(pair[1], false);
  };
  const span = args.length === 0 ? nowNs : args.length === 1 ? nowNs - toNs(args[0]) : toNs(args[1]) - toNs(args[0]);
  return list([num(span / 1000000000n), num(span % 1000000000n)]);
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function parseTimeText(format: string, text: string): number {
  const fields = { year: 1900, month: 0, day: 0, hour: 0, minute: 0, second: 0, pm: null as boolean | null };
  let at = 0;
  const number = (maximum: number): number | null => {
    while (text[at] === ' ') at++;
    const match = new RegExp(`^[0-9]{1,${maximum}}`).exec(text.slice(at));
    if (match === null) return null;
    at += match[0].length;
    return Number(match[0]);
  };
  const name = (names: readonly string[], full: readonly string[]): number | null => {
    const rest = text.slice(at).toLowerCase();
    const wholeIndex = full.findIndex((candidate) => rest.startsWith(candidate));
    if (wholeIndex >= 0) { at += full[wholeIndex].length; return wholeIndex; }
    const shortIndex = names.findIndex((candidate) => rest.startsWith(candidate));
    if (shortIndex >= 0) { at += names[shortIndex].length; return shortIndex; }
    return null;
  };
  const apply = (directive: string): boolean => {
    switch (directive) {
      case 'Y': { const value = number(4); if (value === null) return false; fields.year = value; return true; }
      case 'y': { const value = number(2); if (value === null) return false; fields.year = value < 69 ? 2000 + value : 1900 + value; return true; }
      case 'm': { const value = number(2); if (value === null || value < 1 || value > 12) return false; fields.month = value - 1; return true; }
      case 'd': case 'e': { const value = number(2); if (value === null || value < 1 || value > 31) return false; fields.day = value; return true; }
      case 'H': { const value = number(2); if (value === null || value > 23) return false; fields.hour = value; return true; }
      case 'I': { const value = number(2); if (value === null || value < 1 || value > 12) return false; fields.hour = value % 12; return true; }
      case 'M': { const value = number(2); if (value === null || value > 59) return false; fields.minute = value; return true; }
      case 'S': { const value = number(2); if (value === null || value > 61) return false; fields.second = value; return true; }
      case 'b': case 'B': case 'h': { const value = name(MONTH_NAMES, FULL_MONTHS); if (value === null) return false; fields.month = value; return true; }
      case 'a': case 'A': { const value = name(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']); return value !== null; }
      case 'p': { const rest = text.slice(at).toLowerCase(); if (rest.startsWith('am')) fields.pm = false; else if (rest.startsWith('pm')) fields.pm = true; else return false; at += 2; return true; }
      case 'T': return apply('H') && text[at++] === ':' && apply('M') && text[at++] === ':' && apply('S');
      case 'R': return apply('H') && text[at++] === ':' && apply('M');
      case 'F': return apply('Y') && text[at++] === '-' && apply('m') && text[at++] === '-' && apply('d');
      case 'D': return apply('m') && text[at++] === '/' && apply('d') && text[at++] === '/' && apply('y');
      case '%': return text[at++] === '%';
      case 'n': case 't': while (/\s/.test(text[at] ?? '')) at++; return true;
      default: return false;
    }
  };
  for (let index = 0; index < format.length; index++) {
    const character = format[index];
    if (character === '%') {
      if (!apply(format[++index] ?? '')) return 0;
    } else if (/\s/.test(character)) {
      while (/\s/.test(text[at] ?? '')) at++;
    } else if (text[at++] !== character) return 0;
  }
  if (fields.pm === true) fields.hour += 12;
  const guess = Date.UTC(fields.year, fields.month, fields.day, fields.hour, fields.minute, fields.second) / 1000;
  const zone = /([+-])(\d\d)(\d\d)/.exec(formatLocalTime('%z', guess * 1000));
  const offset = zone === null ? 0 : (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 3600 + Number(zone[3]) * 60);
  return guess - offset;
}

function parseFloatPrefix(text: string): number {
  const trimmed = text.replace(/^[ \t]+/, '');
  const hex = /^([+-]?)0[xX]([0-9a-fA-F]+)/.exec(trimmed);
  if (hex !== null) return (hex[1] === '-' ? -1 : 1) * parseInt(hex[2], 16);
  const word = /^([+-]?)(infinity|inf|nan)/i.exec(trimmed);
  if (word !== null) return word[2].toLowerCase() === 'nan' ? Number.NaN : (word[1] === '-' ? -Infinity : Infinity);
  const decimal = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(trimmed);
  return decimal === null ? 0 : Number(decimal[0]);
}

function flattenList(args: VimValue[], context: Context, inPlace: boolean): VimValue {
  const source = listOf(args[0], context);
  if (source === null) return num(0);
  const depth = args[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(context.numberOf(args[1], false));
  if (depth < 0) {
    context.soft('E900: maxdepth must be non-negative number');
    return num(0);
  }
  const spread = (items: VimValue[], remaining: number): VimValue[] => items.flatMap((item) => (item.kind === 'list' && remaining > 0 ? spread(item.items, remaining - 1) : [item]));
  const flat = spread(source.items, depth);
  if (!inPlace) return list(flat);
  source.items = flat;
  return source;
}

function sliceOf(args: VimValue[], context: Context): VimValue {
  const target = args[0];
  const isString = target.kind !== 'list';
  const items: unknown[] = target.kind === 'list' ? target.items : characters(context.stringOf(target, false));
  const resolve = (value: bigint): number => {
    const at = Number(value);
    return at < 0 ? Math.max(0, items.length + at) : Math.min(at, items.length);
  };
  const start = resolve(context.numberOf(args[1], false));
  const end = args[2] === undefined ? items.length : resolve(context.numberOf(args[2], false));
  const kept = start >= end ? [] : items.slice(start, end);
  return isString ? str((kept as string[]).join('')) : list(kept as VimValue[]);
}

function byteIndexOfCharacter(text: string, wanted: number): number {
  if (wanted < 0) return -1;
  const chars = characters(text);
  if (wanted > chars.length) return -1;
  return utf8Length(chars.slice(0, wanted).join(''));
}

function characterIndexOfByte(text: string, wanted: number): number {
  if (wanted < 0 || wanted > utf8Length(text)) return -1;
  let bytes = 0;
  let count = 0;
  for (const character of characters(text)) {
    const width = utf8Length(character);
    if (bytes + width > wanted) return count;
    bytes += width;
    count++;
  }
  return count;
}

function utf16IndexOf(text: string, wanted: number, byCharacter: boolean): number {
  const chars = characters(text);
  if (byCharacter) {
    if (wanted < 0 || wanted > chars.length) return -1;
    return chars.slice(0, wanted).reduce((total, character) => total + character.length, 0);
  }
  if (wanted < 0 || wanted > utf8Length(text)) return -1;
  const count = characterIndexOfByte(text, wanted);
  return chars.slice(0, count).reduce((total, character) => total + character.length, 0);
}

function simplifyPath(path: string): string {
  if (path === '') return '';
  const absolute = path.startsWith('/');
  const trailing = path.length > 1 && path.endsWith('/');
  const kept: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (kept.length > 0 && kept[kept.length - 1] !== '..') { kept.pop(); continue; }
      if (absolute) continue;
    }
    kept.push(part);
  }
  const joined = kept.join('/');
  if (joined === '') return absolute ? '/' : '.';
  const lead = absolute ? '/' : (path.startsWith('./') && kept[0] !== '..' ? './' : '');
  return `${lead}${joined}${trailing ? '/' : ''}`;
}

function shortenPath(path: string, keep: number): string {
  const parts = path.split('/');
  return parts.map((part, at) => {
    if (at === parts.length - 1 || part === '') return part;
    const chars = characters(part);
    let lead = 0;
    while (lead < chars.length && (chars[lead] === '~' || chars[lead] === '.')) lead++;
    return chars.slice(0, lead + keep).join('');
  }).join('/');
}

function modifyFileName(name: string, modifiers: string, context?: Context): string {
  let result = name;
  let previous = '';
  let extensionSource = name;
  let extensionDepth = 0;
  let at = 0;
  while (at < modifiers.length) {
    if (modifiers[at] !== ':') { at++; continue; }
    at++;
    let modifier = modifiers[at] ?? '';
    let global = false;
    if (modifier === 'g' && modifiers[at + 1] === 's') { global = true; at++; modifier = 's'; }
    at++;
    if (modifier === 's') {
      const delimiter = modifiers[at] ?? '';
      const first = modifiers.indexOf(delimiter, at + 1);
      const second = first < 0 ? -1 : modifiers.indexOf(delimiter, first + 1);
      if (delimiter === '' || second < 0 || context === undefined) { previous = modifier; continue; }
      result = substituteText(context, result, modifiers.slice(at + 1, first), modifiers.slice(first + 1, second), global ? 'g' : '', () => '');
      at = second + 1;
    } else if (modifier === 'p') {
      if (context !== undefined) {
        const absolute = simplifyPath(result.startsWith('/') ? result : `${context.host.workingDirectory().replace(/\/+$/, '')}/${result}`);
        result = context.host.pathKind(absolute) === 'directory' && !absolute.endsWith('/') ? `${absolute}/` : absolute;
        if (result === '') result = '/';
      }
    } else if (modifier === '.') {
      if (context !== undefined) {
        const cwd = `${context.host.workingDirectory().replace(/\/+$/, '')}/`;
        if (result.startsWith(cwd)) result = result.slice(cwd.length);
      }
    } else if (modifier === '~') {
      const home = context?.host.homeDirectory() ?? null;
      if (home !== null && home !== '/' && (result === home || result.startsWith(`${home}/`))) result = `~${result.slice(home.length)}`;
    } else if (modifier === 'S') {
      result = `'${result.replace(/'/g, "'\\''")}'`;
    } else if (modifier === 'h') {
      const cut = result.lastIndexOf('/');
      const head = result.slice(0, Math.max(cut, 0)).replace(/\/+$/, '');
      result = cut < 0 ? '.' : head === '' ? '/' : head;
    } else if (modifier === 't') {
      result = result.slice(result.lastIndexOf('/') + 1);
    } else if (modifier === 'r') {
      const dot = result.lastIndexOf('.');
      if (dot > result.lastIndexOf('/') + 1) result = result.slice(0, dot);
    } else if (modifier === 'e') {
      if (previous !== 'e') { extensionSource = result; extensionDepth = 0; }
      extensionDepth++;
      const base = extensionSource.slice(extensionSource.lastIndexOf('/') + 1);
      const segments = base.replace(/^\.+/, '').split('.');
      result = segments.length <= 1 ? '' : segments.slice(-Math.min(extensionDepth, segments.length - 1)).join('.');
    }
    previous = modifier;
  }
  return result;
}

function floatArgument(context: Context, value: VimValue): number {
  if (value.kind === 'float') return value.value;
  if (value.kind === 'number') return Number(value.value);
  context.soft('E808: Number or Float required');
  return 0;
}

function dictRequired(context: Context): VimValue {
  context.soft('E715: Dictionary required');
  return num(0);
}

function extreme(target: VimValue, context: Context, maximum: boolean): VimValue {
  const items = target.kind === 'list' ? target.items : target.kind === 'dict' ? inVimOrder(target.entries).map(([, item]) => item) : null;
  if (items === null) {
    context.soft('E712: Argument of max() must be a List or Dictionary');
    return num(0);
  }
  if (items.length === 0) return num(0);
  const values = items.map((item) => context.numberOf(item, false));
  return num(values.reduce((best, value) => (maximum ? (value > best ? value : best) : (value < best ? value : best))));
}

function matchPosition(context: Context, args: VimValue[], edge: 'start' | 'end'): number {
  const subject = context.stringOf(args[0], false);
  const hit = searchText(context.regexp(context.stringOf(args[1], false), context.host.ignoreCase, subject), subject,
    args[2] === undefined ? 0 : Number(context.numberOf(args[2], false)), args[3] === undefined ? 1 : Number(context.numberOf(args[3], false)));
  if (hit === null) return -1;
  return byteOffset(subject, edge === 'start' ? hit.start : hit.end);
}

function evaluateWithSubmatches(context: Context, template: VimValue, hit: MatchHit): VimValue {
  const source = context.stringOf(template, false).slice(2);
  const inner: ExpressionHost = { ...context.host, submatch: (index) => hit.groups[index] };
  return context.withHost(inner, () => context.evaluate(source));
}

function evaluateCallback(context: Context, callback: VimValue, key: VimValue, value: VimValue): VimValue {
  if (callback.kind === 'funcref') return context.invoke(callback, [key, value]);
  context.loop.push({ key, val: value });
  try {
    return context.evaluateCallback(context.stringOf(callback, false));
  } finally {
    context.loop.pop();
  }
}

const JSON_ESCAPES: Readonly<Record<string, string>> = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' };

function jsonString(text: string): string {
  let out = '"';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (JSON_ESCAPES[character] !== undefined) out += JSON_ESCAPES[character];
    else if (code < 0x20) out += `\\u00${code.toString(16).padStart(2, '0')}`;
    else out += character;
  }
  return `${out}"`;
}

function jsonToVim(node: unknown, source: string | undefined): VimValue {
  if (node === null) return special('null');
  if (node === true) return special('true');
  if (node === false) return special('false');
  if (typeof node === 'string') return str(node);
  if (typeof node === 'number') {
    if (source !== undefined) return /^-?\d+$/.test(source) ? num(BigInt(source)) : flt(node);
    return Number.isInteger(node) ? num(node) : flt(node);
  }
  if (Array.isArray(node)) return list(node.map((item) => jsonToVim(item, undefined)));
  const entries = new Map<string, VimValue>();
  for (const [key, item] of Object.entries(node as Record<string, unknown>)) entries.set(key, jsonToVim(item, undefined));
  return dict(entries);
}

function jsonDecode(text: string, context: Context): VimValue {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'number') return jsonToVim(parsed, text.trim());
    return jsonToVim(parsed, undefined);
  } catch {
    context.soft(`E491: JSON decode error at '${text}'`);
    return special('none');
  }
}

function jsonEncode(value: VimValue, context: Context): string {
  switch (value.kind) {
    case 'number': return value.value.toString();
    case 'float': return formatFloatDefault(value.value);
    case 'string': return jsonString(value.value);
    case 'special': return value.name === 'true' ? 'true' : value.name === 'false' ? 'false' : 'null';
    case 'list': return `[${value.items.map((item) => jsonEncode(item, context)).join(',')}]`;
    case 'dict': return `{${inVimOrder(value.entries).map(([key, item]) => `${jsonString(key)}:${jsonEncode(item, context)}`).join(',')}}`;
    default:
      context.soft('E474: Invalid argument');
      return '';
  }
}

function mapOrFilter(args: VimValue[], context: Context, mapping: boolean): VimValue {
  const target = args[0];
  if (target.kind !== 'list' && target.kind !== 'dict') {
    context.soft('E712: Argument of map() must be a List or Dictionary');
    return num(0);
  }
  const callback = args[1];
  const keys: VimValue[] = target.kind === 'list' ? target.items.map((_, at) => num(at)) : inVimOrder(target.entries).map(([key]) => str(key));
  const values: VimValue[] = target.kind === 'list' ? [...target.items] : inVimOrder(target.entries).map(([, item]) => item);
  const results: VimValue[] = [];
  for (let at = 0; at < keys.length; at++) {
    try {
      results.push(evaluateCallback(context, callback, keys[at], values[at]));
    } catch (failure) {
      if (!(failure instanceof Abort)) throw failure;
      break;
    }
  }
  while (results.length < keys.length) results.push(mapping ? values[results.length] : num(1));
  const keep = (at: number): boolean => mapping || context.numberOf(results[at], false) !== 0n;
  if (target.kind === 'list') {
    target.items = (mapping ? results : values).filter((_, at) => keep(at));
  } else {
    const names = inVimOrder(target.entries).map(([key]) => key);
    names.forEach((name, at) => {
      if (!keep(at)) target.entries.delete(name);
      else if (mapping) target.entries.set(name, results[at]);
    });
  }
  return target;
}

type Comparison = '==' | '!=' | '>' | '>=' | '<' | '<=' | '=~' | '!~' | 'is' | 'isnot';

function isNameCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function isNameStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

class Parser {
  pos = 0;
  tokenEnd = 0;

  constructor(private readonly text: string, private readonly context: Context) {}

  private white(character: string | undefined): boolean {
    return character === ' ' || character === '\t';
  }

  skipWhite(): void {
    while (this.white(this.text[this.pos])) this.pos++;
  }

  private invalid(): never {
    throw new Invalid(this.pos);
  }

  parseCallback(): VimValue {
    this.skipWhite();
    const value = this.expr1(true);
    if (this.tokenEnd < this.text.length) this.context.fail(`E15: Invalid expression: "${this.text.slice(this.tokenEnd)}"`);
    return value;
  }

  parseSequence(): VimValue[] {
    const values: VimValue[] = [];
    for (;;) {
      this.skipWhite();
      const next = this.text[this.pos];
      if (next === undefined || next === '|' || next === '\n') break;
      values.push(this.expr1(true));
    }
    return values;
  }

  parseTop(): VimValue {
    this.skipWhite();
    const value = this.expr1(true);
    this.skipWhite();
    const next = this.text[this.pos];
    if (next !== undefined && next !== '|' && next !== '"' && next !== '\n') {
      this.context.fail(`E488: Trailing characters: ${this.text.slice(this.pos)}`);
    }
    return value;
  }

  expr1(evaluate: boolean): VimValue {
    const condition = this.expr2(evaluate);
    this.skipWhite();
    if (this.text[this.pos] !== '?') return condition;
    if (this.text[this.pos + 1] === '?') {
      this.pos += 2;
      this.skipWhite();
      const keep = evaluate && this.context.truth(condition);
      const other = this.expr1(evaluate && !keep);
      return keep ? condition : other;
    }
    this.pos++;
    this.skipWhite();
    const branch = evaluate && this.context.truth(condition);
    const yes = this.expr1(evaluate && branch);
    this.skipWhite();
    if (this.text[this.pos] !== ':') this.context.fail("E109: Missing ':' after '?'");
    this.pos++;
    this.skipWhite();
    const no = this.expr1(evaluate && !branch);
    return branch ? yes : no;
  }

  private expr2(evaluate: boolean): VimValue {
    const first = this.expr3(evaluate);
    this.skipWhite();
    if (!this.text.startsWith('||', this.pos)) return first;
    let result = evaluate && this.context.truth(first);
    while (this.text.startsWith('||', this.pos)) {
      this.pos += 2;
      this.skipWhite();
      const next = this.expr3(evaluate && !result);
      if (evaluate && !result && this.context.truth(next)) result = true;
      this.skipWhite();
    }
    return num(result ? 1 : 0);
  }

  private expr3(evaluate: boolean): VimValue {
    const first = this.expr4(evaluate);
    this.skipWhite();
    if (!this.text.startsWith('&&', this.pos)) return first;
    let result = evaluate && this.context.truth(first);
    while (this.text.startsWith('&&', this.pos)) {
      this.pos += 2;
      this.skipWhite();
      const next = this.expr4(evaluate && result);
      if (evaluate && result && !this.context.truth(next)) result = false;
      this.skipWhite();
    }
    return num(result ? 1 : 0);
  }

  private comparisonAt(): { operator: Comparison; length: number } | null {
    const text = this.text;
    const at = this.pos;
    const first = text[at];
    const second = text[at + 1];
    if (first === '=' && second === '=') return { operator: '==', length: 2 };
    if (first === '=' && second === '~') return { operator: '=~', length: 2 };
    if (first === '!' && second === '=') return { operator: '!=', length: 2 };
    if (first === '!' && second === '~') return { operator: '!~', length: 2 };
    if (first === '>') return second === '=' ? { operator: '>=', length: 2 } : { operator: '>', length: 1 };
    if (first === '<') return second === '=' ? { operator: '<=', length: 2 } : { operator: '<', length: 1 };
    if (first === 'i' && second === 's') {
      const length = text.startsWith('isnot', at) ? 5 : 2;
      if (!isNameCharacter(text[at + length])) return { operator: length === 5 ? 'isnot' : 'is', length };
    }
    return null;
  }

  private expr4(evaluate: boolean): VimValue {
    const left = this.expr5(evaluate);
    this.skipWhite();
    const found = this.comparisonAt();
    if (found === null) return left;
    this.pos += found.length;
    let ignoreCase = this.context.host.ignoreCase;
    if (this.text[this.pos] === '?') {
      ignoreCase = true;
      this.pos++;
    } else if (this.text[this.pos] === '#') {
      ignoreCase = false;
      this.pos++;
    }
    this.skipWhite();
    const right = this.expr5(evaluate);
    if (!evaluate) return num(0);
    return num(this.compare(found.operator, left, right, ignoreCase) ? 1 : 0);
  }

  private compare(operator: Comparison, left: VimValue, right: VimValue, ignoreCase: boolean): boolean {
    const context = this.context;
    if (operator === 'is' || operator === 'isnot') {
      let same: boolean;
      if (left.kind !== right.kind) same = false;
      else if (left.kind === 'list' || left.kind === 'dict') same = left === right;
      else same = sameValue(left, right, false);
      return operator === 'is' ? same : !same;
    }
    if (left.kind === 'list' || right.kind === 'list') {
      if (left.kind !== right.kind) context.fail('E691: Can only compare List with List');
      if (operator !== '==' && operator !== '!=') context.fail('E692: Invalid operation for List');
      return sameValue(left, right, ignoreCase) === (operator === '==');
    }
    if (left.kind === 'dict' || right.kind === 'dict') {
      if (left.kind !== right.kind) context.fail('E735: Can only compare Dictionary with Dictionary');
      if (operator !== '==' && operator !== '!=') context.fail('E736: Invalid operation for Dictionary');
      return sameValue(left, right, ignoreCase) === (operator === '==');
    }
    if (operator === '=~' || operator === '!~') {
      const subject = context.stringOf(left, true);
      const regex = context.regexp(context.stringOf(right, true), ignoreCase, subject);
      const matched = regex.error === null && regex.exec(subject, 0) !== null;
      return matched === (operator === '=~');
    }
    let order: number;
    if (left.kind === 'float' || right.kind === 'float') {
      const a = context.floatOf(left, true);
      const b = context.floatOf(right, true);
      order = a === b ? 0 : a < b ? -1 : 1;
      if (Number.isNaN(a) || Number.isNaN(b)) return operator === '!=';
    } else if (left.kind === 'string' && right.kind === 'string') {
      order = compareText(left.value, right.value, ignoreCase);
    } else {
      const a = context.numberOf(left, true);
      const b = context.numberOf(right, true);
      order = a === b ? 0 : a < b ? -1 : 1;
    }
    switch (operator) {
      case '==': return order === 0;
      case '!=': return order !== 0;
      case '>': return order > 0;
      case '>=': return order >= 0;
      case '<': return order < 0;
      default: return order <= 0;
    }
  }

  private expr5(evaluate: boolean): VimValue {
    let left = this.expr6(evaluate, false);
    for (;;) {
      this.skipWhite();
      const operator = this.text[this.pos];
      if (operator !== '+' && operator !== '-' && operator !== '.') return left;
      this.pos++;
      if (operator === '.' && this.text[this.pos] === '.') this.pos++;
      this.skipWhite();
      const right = this.expr6(evaluate, operator === '.');
      if (evaluate) left = this.additive(operator, left, right);
    }
  }

  private additive(operator: string, left: VimValue, right: VimValue): VimValue {
    const context = this.context;
    if (operator === '.') return str(context.stringOf(left, true) + context.stringOf(right, true));
    if (operator === '+' && left.kind === 'list' && right.kind === 'list') return list([...left.items, ...right.items]);
    if (left.kind === 'float' || right.kind === 'float') {
      const a = context.floatOf(left, true);
      const b = context.floatOf(right, true);
      return flt(operator === '+' ? a + b : a - b);
    }
    const a = context.numberOf(left, true);
    const b = context.numberOf(right, true);
    return num(operator === '+' ? a + b : a - b);
  }

  private expr6(evaluate: boolean, wantString: boolean): VimValue {
    let left = this.expr7(evaluate, wantString);
    for (;;) {
      this.skipWhite();
      const operator = this.text[this.pos];
      if (operator !== '*' && operator !== '/' && operator !== '%') return left;
      this.pos++;
      this.skipWhite();
      const right = this.expr7(evaluate, false);
      if (evaluate) left = this.multiplicative(operator, left, right);
    }
  }

  private multiplicative(operator: string, left: VimValue, right: VimValue): VimValue {
    const context = this.context;
    if (left.kind === 'float' || right.kind === 'float') {
      if (operator === '%') context.fail("E804: Cannot use '%' with Float");
      const a = context.floatOf(left, true);
      const b = context.floatOf(right, true);
      return flt(operator === '*' ? a * b : a / b);
    }
    const a = context.numberOf(left, true);
    const b = context.numberOf(right, true);
    if (operator === '*') return num(a * b);
    if (operator === '%') return num(b === 0n ? 0n : a % b);
    if (b === 0n) return num(a > 0n ? NUMBER_MAX : a < 0n ? -NUMBER_MAX : NUMBER_MIN);
    return num(a / b);
  }

  private expr7(evaluate: boolean, wantString: boolean): VimValue {
    const leaders: string[] = [];
    while (this.text[this.pos] === '!' || this.text[this.pos] === '-' || this.text[this.pos] === '+') {
      leaders.push(this.text[this.pos]);
      this.pos++;
      this.skipWhite();
    }
    let value = this.expr8(evaluate, wantString);
    if (!evaluate) return value;
    for (let at = leaders.length - 1; at >= 0; at--) value = this.applyLeader(leaders[at], value);
    return value;
  }

  private applyLeader(leader: string, value: VimValue): VimValue {
    const context = this.context;
    if (leader === '!') {
      if (value.kind === 'float') return flt(value.value === 0 ? 1 : 0);
      return num(context.numberOf(value, true) === 0n ? 1 : 0);
    }
    if (value.kind === 'float') return flt(leader === '-' ? -value.value : value.value);
    const number = context.numberOf(value, true);
    return num(leader === '-' ? -number : number);
  }

  private expr8(evaluate: boolean, wantString: boolean): VimValue {
    let value = this.atom(evaluate, wantString);
    let owner: VimDict | null = null;
    for (;;) {
      const previous = this.text[this.pos - 1];
      const current = this.text[this.pos];
      if (current === '[' && !this.white(previous)) {
        owner = value.kind === 'dict' ? value : null;
        value = this.subscript(value, evaluate);
      } else if (current === '.' && value.kind === 'dict' && isNameCharacter(this.text[this.pos + 1]) && !this.white(previous)) {
        this.pos++;
        const start = this.pos;
        while (isNameCharacter(this.text[this.pos])) this.pos++;
        const key = this.text.slice(start, this.pos);
        owner = value as VimDict;
        value = evaluate ? this.dictLookup(value, key) : num(0);
      } else if (current === '(' && (value.kind === 'funcref' || !evaluate) && !this.white(previous)) {
        value = this.callValue(value, this.pos, evaluate, owner);
        owner = null;
      } else if (current === '-' && this.text[this.pos + 1] === '>') {
        this.pos += 2;
        value = this.methodCall(value, evaluate);
      } else {
        this.tokenEnd = this.pos;
        return value;
      }
    }
  }

  private dictLookup(target: VimValue, key: string): VimValue {
    if (target.kind !== 'dict') this.context.fail('E715: Dictionary required');
    const found = (target as VimDict).entries.get(key);
    if (found === undefined) this.context.fail(`E716: Key not present in Dictionary: "${key}"`);
    return found!;
  }

  private methodCall(receiver: VimValue, evaluate: boolean): VimValue {
    const start = this.pos;
    while (isNameCharacter(this.text[this.pos]) || this.text[this.pos] === ':' || this.text[this.pos] === '#') this.pos++;
    const name = this.text.slice(start, this.pos);
    if (name === '' || this.text[this.pos] !== '(') this.invalid();
    return this.call(name, start, evaluate, [receiver]);
  }

  private subscript(base: VimValue, evaluate: boolean): VimValue {
    this.pos++;
    this.skipWhite();
    let first: VimValue | null = null;
    if (this.text[this.pos] !== ':') first = this.expr1(evaluate);
    this.skipWhite();
    if (this.text[this.pos] === ':') {
      this.pos++;
      this.skipWhite();
      let last: VimValue | null = null;
      if (this.text[this.pos] !== ']') last = this.expr1(evaluate);
      this.skipWhite();
      if (this.text[this.pos] !== ']') this.context.fail("E111: Missing ']'");
      this.pos++;
      return evaluate ? this.slice(base, first, last) : num(0);
    }
    if (this.text[this.pos] !== ']') this.context.fail("E111: Missing ']'");
    this.pos++;
    return evaluate ? this.index(base, first!) : num(0);
  }

  private index(base: VimValue, indexValue: VimValue): VimValue {
    const context = this.context;
    if (base.kind === 'list') {
      let at = Number(context.numberOf(indexValue, true));
      const original = at;
      if (at < 0) at += base.items.length;
      if (at < 0 || at >= base.items.length) context.fail(`E684: List index out of range: ${original}`);
      return base.items[at];
    }
    if (base.kind === 'dict') return this.dictLookup(base, context.stringOf(indexValue, true));
    const text = context.stringOf(base, true);
    const at = Number(context.numberOf(indexValue, true));
    if (at < 0 || at >= utf8Length(text)) return str('');
    return str(byteSlice(text, at, at + 1));
  }

  private slice(base: VimValue, first: VimValue | null, last: VimValue | null): VimValue {
    const context = this.context;
    const isList = base.kind === 'list';
    const text = isList ? '' : context.stringOf(base, true);
    const size = isList ? (base as VimList).items.length : utf8Length(text);
    let from = first === null ? 0 : Number(context.numberOf(first, true));
    let to = last === null ? size - 1 : Number(context.numberOf(last, true));
    if (from < 0) from += size;
    if (to < 0) to += size;
    if (from < 0) from = 0;
    if (to >= size) to = size - 1;
    if (from > to || from >= size) return isList ? list([]) : str('');
    return isList ? list((base as VimList).items.slice(from, to + 1)) : str(byteSlice(text, from, to + 1));
  }

  private atom(evaluate: boolean, wantString: boolean): VimValue {
    const character = this.text[this.pos];
    if (character === undefined) this.invalid();
    if (character >= '0' && character <= '9') return this.numberLiteral(wantString);
    if (character === '"') return this.doubleQuoted();
    if (character === "'") return this.singleQuoted();
    if (character === '[') return this.listLiteral(evaluate);
    if (character === '{') return this.dictLiteral(evaluate, false);
    if (character === '#' && this.text[this.pos + 1] === '{') {
      this.pos++;
      return this.dictLiteral(evaluate, true);
    }
    if (character === '(') {
      this.pos++;
      this.skipWhite();
      const inner = this.expr1(evaluate);
      this.skipWhite();
      if (this.text[this.pos] !== ')') this.context.fail("E110: Missing ')'");
      this.pos++;
      return inner;
    }
    if (character === '&') return this.optionValue(evaluate);
    if (character === '@') return this.registerValue(evaluate);
    if (character === '$') return this.environmentValue(evaluate);
    if (isNameStart(character)) return this.nameValue(evaluate);
    if (character === ':') return this.nameValue(evaluate);
    return this.invalid();
  }

  private numberLiteral(wantString: boolean): VimValue {
    const start = this.pos;
    const rest = this.text.slice(start);
    if (!wantString && !/^0[xXbBoO]/.test(rest)) {
      const literal = /^[0-9]+\.[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(rest);
      if (literal !== null) {
        this.pos = start + literal[0].length;
        return flt(Number(literal[0]));
      }
    }
    const parsed = parseInteger(this.text, start, 0, false);
    if (/[A-Za-z]/.test(this.text[parsed.next] ?? '')) {
      this.pos = start;
      this.invalid();
    }
    this.pos = parsed.next;
    return num(parsed.value);
  }

  private singleQuoted(): VimValue {
    const start = this.pos;
    this.pos++;
    let value = '';
    for (;;) {
      const character = this.text[this.pos];
      if (character === undefined) this.context.fail(`E115: Missing single quote: ${this.text.slice(start)}`);
      if (character === "'") {
        if (this.text[this.pos + 1] === "'") {
          value += "'";
          this.pos += 2;
          continue;
        }
        this.pos++;
        return str(value);
      }
      value += character;
      this.pos++;
    }
  }

  private doubleQuoted(): VimValue {
    const start = this.pos;
    this.pos++;
    let value = '';
    for (;;) {
      const character = this.text[this.pos];
      if (character === undefined) this.context.fail(`E114: Missing double quote: ${this.text.slice(start)}`);
      if (character === '"') {
        this.pos++;
        return str(value);
      }
      if (character !== '\\' || this.pos + 1 >= this.text.length) {
        value += character;
        this.pos++;
        continue;
      }
      this.pos++;
      value += this.escape();
    }
  }

  private escape(): string {
    const text = this.text;
    const code = text[this.pos];
    const simple: Record<string, string> = { b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };
    if (code in simple) {
      this.pos++;
      return simple[code];
    }
    if (code === 'x' || code === 'X' || code === 'u' || code === 'U') {
      const limit = code === 'x' || code === 'X' ? 2 : code === 'u' ? 4 : 8;
      let digits = '';
      let at = this.pos + 1;
      while (digits.length < limit && digitValue(text[at]) >= 0 && digitValue(text[at]) < 16) digits += text[at++];
      if (digits === '') {
        this.pos++;
        return code;
      }
      this.pos = at;
      return String.fromCodePoint(Math.min(parseInt(digits, 16), 0x10ffff));
    }
    if (code >= '0' && code <= '7') {
      let digits = '';
      let at = this.pos;
      while (digits.length < 3 && text[at] >= '0' && text[at] <= '7') digits += text[at++];
      this.pos = at;
      return String.fromCodePoint(parseInt(digits, 8));
    }
    if (code === '<') {
      const close = text.indexOf('>', this.pos);
      const named = close < 0 ? null : specialKey(text.slice(this.pos + 1, close));
      if (named !== null) {
        this.pos = close + 1;
        return named;
      }
    }
    this.pos += code.length;
    return String.fromCodePoint(text.codePointAt(this.pos - code.length)!);
  }

  private listLiteral(evaluate: boolean): VimValue {
    this.pos++;
    const items: VimValue[] = [];
    this.skipWhite();
    while (this.text[this.pos] !== ']' && this.pos < this.text.length) {
      items.push(this.expr1(evaluate));
      this.skipWhite();
      if (this.text[this.pos] === ',') {
        this.pos++;
        this.skipWhite();
      } else if (this.text[this.pos] !== ']') {
        this.context.fail(`E696: Missing comma in List: ${this.text.slice(this.pos)}`);
      }
    }
    if (this.text[this.pos] !== ']') this.context.fail(`E697: Missing end of List ']': ${this.text.slice(this.pos)}`);
    this.pos++;
    return list(items);
  }

  private dictLiteral(evaluate: boolean, literalKeys: boolean): VimValue {
    this.pos++;
    this.skipWhite();
    if (!literalKeys) {
      const header = /^((?:[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)?)\s*->/.exec(this.text.slice(this.pos));
      if (header !== null) return this.lambdaLiteral(header, evaluate);
    }
    const entries = new Map<string, VimValue>();
    while (this.text[this.pos] !== '}' && this.pos < this.text.length) {
      let key: string;
      if (literalKeys) {
        const keyStart = this.pos;
        while (/[A-Za-z0-9_-]/.test(this.text[this.pos] ?? '')) this.pos++;
        key = this.text.slice(keyStart, this.pos);
      } else {
        key = this.context.stringOf(this.expr1(evaluate), true);
      }
      this.skipWhite();
      if (this.text[this.pos] !== ':') this.context.fail(`E720: Missing colon in Dictionary: ${this.text.slice(this.pos)}`);
      this.pos++;
      this.skipWhite();
      const item = this.expr1(evaluate);
      if (evaluate) {
        if (entries.has(key)) this.context.fail(`E721: Duplicate key in Dictionary: "${key}"`);
        entries.set(key, item);
      }
      this.skipWhite();
      if (this.text[this.pos] === ',') {
        this.pos++;
        this.skipWhite();
      } else if (this.text[this.pos] !== '}') {
        this.context.fail(`E722: Missing comma in Dictionary: ${this.text.slice(this.pos)}`);
      }
    }
    if (this.text[this.pos] !== '}') this.context.fail(`E723: Missing end of Dictionary '}': ${this.text.slice(this.pos)}`);
    this.pos++;
    return dict(entries);
  }

  private lambdaLiteral(header: RegExpExecArray, evaluate: boolean): VimValue {
    this.pos += header[0].length;
    const params = header[1] === '' ? [] : header[1].split(',').map((name) => name.trim());
    this.skipWhite();
    const bodyStart = this.pos;
    this.expr1(false);
    const body = this.text.slice(bodyStart, this.pos);
    this.skipWhite();
    if (this.text[this.pos] !== '}') this.context.fail(`E451: Expected }: ${this.text.slice(this.pos)}`);
    this.pos++;
    if (!evaluate) return num(0);
    const counter = this.context.host.lambdaCounter;
    const name = `<lambda>${counter.next++}`;
    return { kind: 'funcref', name, params, body, scopes: [...this.context.scopes, ...this.context.host.variables.frameScopes()], bound: [] };
  }

  private optionValue(evaluate: boolean): VimValue {
    const start = this.pos;
    this.pos++;
    let scope: 'effective' | 'local' | 'global' = 'effective';
    if ((this.text[this.pos] === 'l' || this.text[this.pos] === 'g') && this.text[this.pos + 1] === ':') {
      scope = this.text[this.pos] === 'l' ? 'local' : 'global';
      this.pos += 2;
    }
    const nameStart = this.pos;
    while (/[A-Za-z]/.test(this.text[this.pos] ?? '')) this.pos++;
    const name = this.text.slice(nameStart, this.pos);
    if (name === '') this.context.fail(`E112: Option name missing: ${this.text.slice(start)}`);
    if (!evaluate) return num(0);
    const value = this.context.host.option(name, scope);
    if (value === undefined) this.context.fail(`E113: Unknown option: ${name}`);
    if (typeof value === 'boolean') return num(value ? 1 : 0);
    if (typeof value === 'number') return num(value);
    return str(value as string);
  }

  private registerValue(evaluate: boolean): VimValue {
    this.pos++;
    const name = this.text[this.pos];
    if (name !== undefined && /[A-Za-z0-9"\-*+/.:%#=_@]/.test(name)) this.pos++;
    if (!evaluate) return num(0);
    if (name === '=') return str(this.context.host.expressionText());
    const content = this.context.host.register(name === undefined || name === '@' ? '"' : name);
    return str(content ?? '');
  }

  private environmentValue(evaluate: boolean): VimValue {
    this.pos++;
    const start = this.pos;
    while (isNameCharacter(this.text[this.pos])) this.pos++;
    if (this.pos === start) {
      this.pos = start - 1;
      this.invalid();
    }
    if (!evaluate) return num(0);
    return str(this.context.host.environment(this.text.slice(start, this.pos)));
  }

  private nameValue(evaluate: boolean): VimValue {
    const start = this.pos;
    if (this.text[this.pos] === ':') this.pos++;
    while (isNameCharacter(this.text[this.pos]) || ((this.text[this.pos] === ':' || this.text[this.pos] === '#') && isNameCharacter(this.text[this.pos + 1]) && this.pos > start)) this.pos++;
    const name = this.text.slice(start, this.pos);
    if (/^[gsla]$/.test(name) && this.text[this.pos] === ':' && !isNameCharacter(this.text[this.pos + 1])) {
      this.pos++;
      if (!evaluate) return num(0);
      if (name === 'a' && this.context.host.variables.depth === 0) return this.context.fail('E121: Undefined variable: a:');
      return { kind: 'dict', entries: this.context.host.variables.scopeEntries(name) };
    }
    if (this.text[this.pos] === '(' && !(evaluate && this.holdsFunction(name))) return this.call(name, start, evaluate, []);
    if (!evaluate) return num(0);
    return this.variable(name);
  }

  private holdsFunction(name: string): boolean {
    const context = this.context;
    for (let at = context.scopes.length - 1; at >= 0; at--) {
      const found = context.scopes[at].get(name);
      if (found !== undefined) return found.kind === 'funcref';
    }
    return context.host.variables.lookup(name)?.kind === 'funcref';
  }

  private variable(name: string): VimValue {
    const context = this.context;
    const constants: Record<string, VimValue> = {
      'v:true': special('true'), 'v:false': special('false'), 'v:null': special('null'), 'v:none': special('none'),
      'v:version': num(901), 'v:lnum': num(0), 'v:count': num(0), 'v:count1': num(1), 'v:errmsg': str(''), 'v:register': str('"'),
      'v:numbermax': num(NUMBER_MAX), 'v:numbermin': num(NUMBER_MIN), 'v:numbersize': num(64),
      'v:t_number': num(0), 'v:t_string': num(1), 'v:t_func': num(2), 'v:t_list': num(3), 'v:t_dict': num(4), 'v:t_float': num(5),
      'v:t_bool': num(6), 'v:t_none': num(7), 'v:t_job': num(8), 'v:t_channel': num(9), 'v:t_blob': num(10),
    };
    for (let at = context.scopes.length - 1; at >= 0; at--) {
      const found = context.scopes[at].get(name);
      if (found !== undefined) return found;
    }
    const stored = context.host.variables.lookup(name);
    if (stored !== undefined) return stored;
    if (name === 'v:shell_error') return num(context.host.shellStatus());
    if (name === 'v:hlsearch') return num(context.host.highlightSearch ? 1 : 0);
    if (name === 'v:searchforward') return num(context.host.searchForward ? 1 : 0);
    if (name in constants) return constants[name];
    const frame = context.loop[context.loop.length - 1];
    if (name === 'v:val' && frame !== undefined) return frame.val;
    if (name === 'v:key' && frame !== undefined) return frame.key;
    return context.fail(`E121: Undefined variable: ${name}`);
  }

  private arguments(nameStart: number, evaluate: boolean): VimValue[] {
    this.pos++;
    const args: VimValue[] = [];
    for (;;) {
      this.skipWhite();
      const next = this.text[this.pos];
      if (next === ')' || next === ',' || next === undefined) break;
      args.push(this.expr1(evaluate));
      this.skipWhite();
      if (this.text[this.pos] !== ',') break;
      this.pos++;
    }
    this.skipWhite();
    if (this.text[this.pos] !== ')') this.context.fail(`E116: Invalid arguments for function ${this.text.slice(nameStart)}`);
    this.pos++;
    return args;
  }

  private call(name: string, nameStart: number, evaluate: boolean, receiver: VimValue[]): VimValue {
    const args = this.arguments(nameStart, evaluate);
    if (!evaluate) return num(0);
    if (receiver.length > 0) args.splice(Math.min((FUNCTIONS.get(name)?.base ?? 1) - 1, args.length), 0, receiver[0]);
    return this.context.callNamed(name, args);
  }

  private callValue(callee: VimValue, nameStart: number, evaluate: boolean, self: VimDict | null = null): VimValue {
    const args = this.arguments(nameStart, evaluate);
    if (!evaluate) return num(0);
    return this.context.invoke(callee, args, self);
  }
}

function specialKey(name: string): string | null {
  const keys: Record<string, string> = {
    esc: '\x1b', cr: '\r', return: '\r', enter: '\r', nl: '\n', newline: '\n', tab: '\t', bs: '\b', space: ' ', lt: '<', bar: '|',
    bslash: '\\', del: '\x7f', nul: '\n',
  };
  const lower = name.toLowerCase();
  if (lower in keys) return keys[lower];
  const control = /^c-(.)$/i.exec(name);
  if (control !== null) return String.fromCharCode(control[1].toUpperCase().charCodeAt(0) & 0x1f);
  return null;
}

function resultText(value: VimValue, context: Context): string {
  switch (value.kind) {
    case 'list': {
      const joined = value.items.map((item) => echoString(item, false)).join('\n');
      return value.items.length > 0 ? `${joined}\n` : '';
    }
    case 'dict':
      context.soft('E731: Using a Dictionary as a String');
      return '';
    default:
      return context.stringOf(value, false);
  }
}

function runExpression(source: string, context: Context, callback = false): VimValue {
  try {
    const parser = new Parser(source, context);
    return callback ? parser.parseCallback() : parser.parseTop();
  } catch (failure) {
    if (!(failure instanceof Invalid)) throw failure;
    const rest = source.slice(failure.at);
    return context.fail(`E15: Invalid expression: "${rest.trim() === '' ? source : rest}"`);
  }
}

export type { VimValue };

export class ExpressionSession {
  constructor(private readonly context: Context) {}

  static open(host: ExpressionHost): ExpressionSession {
    return new ExpressionSession(new Context(host));
  }

  get host(): ExpressionHost {
    return this.context.host;
  }

  get errors(): readonly string[] {
    return this.context.errors;
  }

  popError(): string | undefined {
    return this.context.errors.pop();
  }

  matches(pattern: string, subject: string): boolean {
    const regex = this.context.regexp(pattern, this.context.host.ignoreCase, subject);
    if (regex.error !== null) return this.context.fail(regex.error);
    return regex.exec(subject, 0) !== null;
  }

  clearErrors(): void {
    this.context.errors.length = 0;
  }

  fail(message: string): never {
    return this.context.fail(message);
  }

  evaluate(source: string): VimValue {
    return runExpression(source, this.context);
  }

  condition(source: string): boolean {
    return this.context.truth(this.evaluate(source));
  }

  echo(source: string, separator: string): string {
    return this.sequence(source).map((value) => echoString(value, false)).join(separator);
  }

  sequence(source: string): VimValue[] {
    try {
      return new Parser(source, this.context).parseSequence();
    } catch (failure) {
      if (!(failure instanceof Invalid)) throw failure;
      return this.context.fail(`E15: Invalid expression: "${source.slice(failure.at).trim() || source}"`);
    }
  }

  text(value: VimValue): string {
    return this.context.stringOf(value, true);
  }

  truth(value: VimValue): boolean {
    return this.context.truth(value);
  }

  items(value: VimValue): VimValue[] | null {
    if (value.kind === 'list') return [...value.items];
    if (value.kind === 'string') return [...value.value].map((character) => str(character));
    return null;
  }

  declareLoopVariables(target: string, value: VimValue): void {
    const names = target.startsWith('[') ? target.slice(1, -1).split(',').map((piece) => piece.trim()) : [target];
    if (!target.startsWith('[')) return assignTarget(target, '=', value, this.context);
    if (value.kind !== 'list') this.context.fail('E714: List required');
    names.forEach((name, at) => assignTarget(name, '=', (value as VimList).items[at] ?? special('none'), this.context));
  }

  assign(argument: string, constant = false): void {
    letInContext(argument, this.context, constant);
  }

  unassign(names: string, bang: boolean): void {
    unletInContext(names, bang, this.context);
  }

  static number(value: number): VimValue {
    return num(value);
  }

  static fromScalar(value: number | string): VimValue {
    return typeof value === 'number' ? num(value) : str(value);
  }

  static list(items: VimValue[]): VimValue {
    return list(items);
  }

  static dict(entries: Map<string, VimValue>): VimValue {
    return { kind: 'dict', entries };
  }
}

export function evaluateReplacementExpression(source: string, host: ExpressionHost): ExpressionResult {
  const context = new Context(host);
  let text = '';
  try {
    text = resultText(runExpression(source, context), context);
  } catch (failure) {
    if (!(failure instanceof Abort)) throw failure;
  }
  return { text, errors: context.errors };
}

const LET_ASSIGNMENT = /^(\[[^\]]*\]|&(?:[lg]:)?[A-Za-z]+|\$[A-Za-z_][A-Za-z0-9_]*|@[A-Za-z0-9"\-*+_/.:#%=]|[A-Za-z_][\w:#]*(?:\[[^\]]*\]|\.[A-Za-z_]\w*)*)\s*(\+=|-=|\*=|\/=|%=|\.\.=|\.=|=)\s*(.+)$/s;
const LET_OPERATOR: Record<string, string> = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '..=': '..', '.=': '.' };

function splitAccess(target: string): { name: string; accessors: string[] } | null {
  const head = target.match(/^[A-Za-z_][\w:#]*/);
  if (head === null) return null;
  const accessors: string[] = [];
  let rest = target.slice(head[0].length);
  while (rest !== '') {
    const bracket = rest.match(/^\[([^\]]*)\]/);
    const dotted = rest.match(/^\.([A-Za-z_]\w*)/);
    if (bracket !== null) {
      accessors.push(bracket[1]);
      rest = rest.slice(bracket[0].length);
    } else if (dotted !== null) {
      accessors.push(`'${dotted[1]}'`);
      rest = rest.slice(dotted[0].length);
    } else {
      return null;
    }
  }
  return { name: head[0], accessors };
}

function combineWith(current: VimValue | undefined, operator: string, value: VimValue, label: string, context: Context): VimValue {
  if (operator === '=') return value;
  if (operator === '+=' && current?.kind === 'list' && value.kind === 'list') {
    current.items.push(...value.items);
    return current;
  }
  if (current === undefined) return context.fail(`E121: Undefined variable: ${label}`);
  const frame = new Map<string, VimValue>([['lhs_', current], ['rhs_', value]]);
  context.scopes.push(frame);
  try {
    return runExpression(`lhs_ ${LET_OPERATOR[operator]} rhs_`, context);
  } finally {
    context.scopes.pop();
  }
}

function assignTarget(target: string, operator: string, value: VimValue, context: Context): void {
  if (target.startsWith('&')) {
    const current = operator === '=' ? undefined : runExpression(target, context);
    const combined = combineWith(current, operator, value, target, context);
    const failure = context.host.assignOption(target.slice(1), combined.kind === 'number' ? Number(combined.value) : context.stringOf(combined, true));
    if (failure !== null) context.fail(failure);
    return;
  }
  if (target.startsWith('$')) {
    if (operator !== '=' && operator !== '.=' && operator !== '..=') return context.fail(`E734: Wrong variable type for ${operator}`);
    const variable = target.slice(1);
    const current = operator === '=' ? undefined : runExpression(target, context);
    context.host.assignEnvironment(variable, context.stringOf(combineWith(current, operator, value, target, context), true));
    return;
  }
  if (target.startsWith('@')) {
    const register = target.slice(1);
    const current = operator === '=' ? undefined : runExpression(target, context);
    context.host.assignRegister(register, context.stringOf(combineWith(current, operator, value, target, context), true));
    return;
  }
  const access = splitAccess(target);
  if (access === null) context.fail(`E15: Invalid expression: "${target}"`);
  const { name, accessors } = access;
  const key = context.host.variables.resolveKey(name);
  if (key === null) context.fail(`E461: Illegal variable name: ${name}`);
  if (context.host.variables.isReadOnly(key)) context.fail(`E46: Cannot change read-only variable "${key}"`);
  if (context.host.variables.isLocked(key)) context.fail(`E741: Value is locked: ${accessors.length === 0 ? name : context.statement}`);
  const combine = (current: VimValue | undefined): VimValue => combineWith(current, operator, value, name, context);
  if (accessors.length === 0) {
    context.host.variables.assign(key, combine(context.host.variables.lookup(key)));
    return;
  }
  if (context.host.variables.lookup(key) === undefined) context.fail(`E121: Undefined variable: ${name}`);
  const holder = runExpression(`${name}${accessors.slice(0, -1).map((step) => `[${step}]`).join('')}`, context);
  if ((holder.kind === 'list' || holder.kind === 'dict') && holder.locked === true) context.fail(`E741: Value is locked: ${context.statement}`);
  const range = sliceBounds(accessors[accessors.length - 1]);
  if (range !== null) {
    assignRange(holder, range, operator, value, name, context);
    return;
  }
  const last = runExpression(accessors[accessors.length - 1], context);
  if (holder.kind === 'list') {
    let at = Number(context.numberOf(last, true));
    if (at < 0) at += holder.items.length;
    if (at < 0 || at > holder.items.length) context.fail(`E684: List index out of range: ${at}`);
    holder.items[at] = combine(holder.items[at]);
  } else if (holder.kind === 'dict') {
    const field = context.stringOf(last, true);
    holder.entries.set(field, combine(holder.entries.get(field)));
  } else {
    context.fail('E689: Can only index a List, Dictionary or Blob');
  }
}

function sliceBounds(accessor: string): { from: string; to: string } | null {
  let quote = '';
  let depth = 0;
  for (let at = 0; at < accessor.length; at++) {
    const character = accessor[at];
    if (quote !== '') { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") quote = character;
    else if ('([{'.includes(character)) depth++;
    else if (')]}'.includes(character)) depth--;
    else if (character === ':' && depth === 0) return { from: accessor.slice(0, at).trim(), to: accessor.slice(at + 1).trim() };
  }
  return null;
}

function resolveRange(holder: VimList, range: { from: string; to: string }, context: Context): { first: number; last: number } {
  const count = holder.items.length;
  const bound = (text: string, fallback: number): number => {
    if (text === '') return fallback;
    const at = Number(context.numberOf(runExpression(text, context), true));
    return at < 0 ? at + count : at;
  };
  const first = bound(range.from, 0);
  const last = bound(range.to, count - 1);
  if (first < 0 || first > count) context.fail(`E684: List index out of range: ${first}`);
  if (last < first - 1 || last >= count) context.fail(`E684: List index out of range: ${last}`);
  return { first, last };
}

function assignRange(holder: VimValue, range: { from: string; to: string }, operator: string, value: VimValue, name: string, context: Context): void {
  if (holder.kind !== 'list') return context.fail('E689: Can only index a List, Dictionary or Blob');
  if (value.kind !== 'list') return context.fail('E709: [:] requires a List or Blob value');
  const { first, last } = resolveRange(holder, range, context);
  const source = value.items;
  let taken = 0;
  for (let at = first; at <= last; at++) {
    if (taken >= source.length) return context.fail('E711: List value does not have enough items');
    holder.items[at] = combineWith(holder.items[at], operator, source[taken], name, context);
    taken++;
  }
  if (taken < source.length) context.fail('E710: List value has more items than targets');
}

export function executeUnletElement(name: string, host: ExpressionHost, context: Context): void {
  const access = splitAccess(name);
  if (access === null || access.accessors.length === 0) return;
  const key = host.variables.resolveKey(access.name);
  if (key === null || host.variables.lookup(key) === undefined) context.fail(`E121: Undefined variable: ${access.name}`);
  const holder = runExpression(`${access.name}${access.accessors.slice(0, -1).map((step) => `[${step}]`).join('')}`, context);
  const last = access.accessors[access.accessors.length - 1];
  if ((holder.kind === 'list' || holder.kind === 'dict') && holder.locked === true) context.fail(`E741: Value is locked: ${name}`);
  const range = sliceBounds(last);
  if (holder.kind === 'list') {
    if (range !== null) {
      const { first, last: end } = resolveRange(holder, range, context);
      holder.items.splice(first, end - first + 1);
      return;
    }
    let at = Number(context.numberOf(runExpression(last, context), true));
    if (at < 0) at += holder.items.length;
    if (at < 0 || at >= holder.items.length) context.fail(`E684: List index out of range: ${at}`);
    holder.items.splice(at, 1);
  } else if (holder.kind === 'dict') {
    const field = context.stringOf(runExpression(last, context), true);
    if (!holder.entries.delete(field)) context.fail(`E716: Key not present in Dictionary: "${field}"`);
  } else {
    context.fail('E689: Can only index a List, Dictionary or Blob');
  }
}

function lockDeep(value: VimValue): void {
  if (value.kind === 'list') {
    value.locked = true;
    value.items.forEach(lockDeep);
  } else if (value.kind === 'dict') {
    value.locked = true;
    for (const item of value.entries.values()) lockDeep(item);
  }
}

function letInContext(argument: string, context: Context, constant = false): void {
  context.statement = argument.trim();
  const parsed = argument.trim().match(LET_ASSIGNMENT);
  if (parsed === null) {
    const name = argument.trim();
    if (/^[A-Za-z_][\w:#]*$/.test(name)) {
      if (context.host.variables.lookup(name) === undefined) context.fail(`E121: Undefined variable: ${name}`);
      return;
    }
    return context.fail(`E15: Invalid expression: "${name}"`);
  }
  const [, target, operator, source] = parsed;
  const value = runExpression(source, context);
  const bind = (name: string, item: VimValue): void => {
    if (!constant) return assignTarget(name, operator, item, context);
    const key = context.host.variables.resolveKey(name);
    if (key === null) return context.fail(`E461: Illegal variable name: ${name}`);
    if (context.host.variables.lookup(key) !== undefined) return context.fail('E995: Cannot modify existing variable');
    assignTarget(name, operator, item, context);
    lockDeep(item);
    context.host.variables.lock(key);
  };
  if (!target.startsWith('[')) return bind(target, value);
  const names = target.slice(1, -1).split(',').map((piece) => piece.trim());
  if (value.kind !== 'list') return context.fail('E714: List required');
  if (value.items.length < names.length) return context.fail('E688: More targets than List items');
  if (value.items.length > names.length) return context.fail('E687: Less targets than List items');
  names.forEach((name, at) => bind(name, value.items[at]));
}

function unletInContext(names: string, bang: boolean, context: Context): void {
  const host = context.host;
  for (const name of names.split(/\s+/).filter((piece) => piece !== '')) {
    if (name.startsWith('$')) host.assignEnvironment(name.slice(1), null);
    else if (/[[.]/.test(name)) executeUnletElement(name, host, context);
    else if (!host.variables.remove(name) && !bang) context.soft(`E108: No such variable: "${name}"`);
  }
}
