import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, fromBytes, parseSizeWithSuffix, quotef, quoteLocale, quoteShell, toBytes, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'ignore-leading-blanks', letter: 'b', takesArgument: false },
  { name: 'check', letter: 'c', takesArgument: false, optionalArgument: true },
  { name: 'dictionary-order', letter: 'd', takesArgument: false },
  { name: 'ignore-case', letter: 'f', takesArgument: false },
  { name: 'general-numeric-sort', letter: 'g', takesArgument: false },
  { name: 'human-numeric-sort', letter: 'h', takesArgument: false },
  { name: 'ignore-nonprinting', letter: 'i', takesArgument: false },
  { name: 'key', letter: 'k', takesArgument: true },
  { name: 'merge', letter: 'm', takesArgument: false },
  { name: 'month-sort', letter: 'M', takesArgument: false },
  { name: 'numeric-sort', letter: 'n', takesArgument: false },
  { name: 'output', letter: 'o', takesArgument: true },
  { name: 'random-sort', letter: 'R', takesArgument: false },
  { name: 'reverse', letter: 'r', takesArgument: false },
  { name: 'stable', letter: 's', takesArgument: false },
  { name: 'sort', letter: 'W', takesArgument: true },
  { name: 'buffer-size', letter: 'S', takesArgument: true },
  { name: 'field-separator', letter: 't', takesArgument: true },
  { name: 'temporary-directory', letter: 'T', takesArgument: true },
  { name: 'unique', letter: 'u', takesArgument: false },
  { name: 'version-sort', letter: 'V', takesArgument: false },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'batch-size', letter: 'B', takesArgument: true },
  { name: 'compress-program', letter: 'Z', takesArgument: true },
  { name: 'debug', letter: 'D', takesArgument: false },
  { name: 'files0-from', letter: 'F', takesArgument: true },
  { name: 'parallel', letter: 'P', takesArgument: true },
  { name: 'random-source', letter: 'A', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'Y', takesArgument: false },
];

const SORT_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['general-numeric', 'g'], ['human-numeric', 'h'], ['month', 'M'], ['numeric', 'n'], ['random', 'R'], ['version', 'V'],
];

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const HUMAN_SUFFIXES = 'kKMGTPEZYRQ';

interface Ordering {
  blanks: boolean;
  dictionary: boolean;
  fold: boolean;
  nonprinting: boolean;
  mode: '' | 'g' | 'h' | 'M' | 'n' | 'R' | 'V';
  reverse: boolean;
}

interface Key {
  readonly startField: number;
  readonly startChar: number;
  readonly startBlanks: boolean;
  readonly endField: number;
  readonly endChar: number;
  readonly endBlanks: boolean;
  readonly ordering: Ordering;
  readonly hasOptions: boolean;
}

class SortUsage extends Error {
  constructor(message: string, readonly tryLine = false, readonly status = 2) { super(message); }
}

const emptyOrdering = (): Ordering => ({ blanks: false, dictionary: false, fold: false, nonprinting: false, mode: '', reverse: false });

function applyLetter(ordering: Ordering, letter: string): boolean {
  switch (letter) {
    case 'b': ordering.blanks = true; return true;
    case 'd': ordering.dictionary = true; return true;
    case 'f': ordering.fold = true; return true;
    case 'i': ordering.nonprinting = true; return true;
    case 'r': ordering.reverse = true; return true;
    case 'g': case 'h': case 'M': case 'n': case 'R': case 'V':
      if (ordering.mode !== '' && ordering.mode !== letter) {
        const letters = ['g', 'h', 'M', 'n', 'R', 'V'].filter((l) => l === ordering.mode || l === letter).join('');
        throw new SortUsage(`options '-${letters}' are incompatible`);
      }
      ordering.mode = letter;
      return true;
    default: return false;
  }
}

function parseKey(spec: string): Key {
  const bad = (reason: string): SortUsage => new SortUsage(`${reason}: invalid field specification ${quoteLocale(spec)}`);
  let rest = spec;
  const number = (): number => {
    const match = /^\d+/.exec(rest);
    if (match === null) throw new SortUsage(`invalid number at field start: invalid count at start of ${quoteLocale(rest)}`);
    rest = rest.slice(match[0].length);
    return Number(match[0]);
  };
  const ordering = emptyOrdering();
  let hasOptions = false;
  const letters = (): boolean => {
    let blanks = false;
    while (rest !== '' && /[bdfgiMhnRrV]/.test(rest[0])) {
      if (rest[0] === 'b') blanks = true;
      else applyLetter(ordering, rest[0]);
      hasOptions = true;
      rest = rest.slice(1);
    }
    return blanks;
  };
  const startField = number();
  if (startField === 0) throw bad('field number is zero');
  let startChar = 1;
  if (rest.startsWith('.')) {
    rest = rest.slice(1);
    startChar = number();
    if (startChar === 0) throw bad('character offset is zero');
  }
  const startBlanks = letters();
  let endField = 0;
  let endChar = 0;
  let endBlanks = false;
  if (rest.startsWith(',')) {
    rest = rest.slice(1);
    endField = number();
    if (endField === 0) throw bad('field number is zero');
    if (rest.startsWith('.')) {
      rest = rest.slice(1);
      endChar = number();
    }
    endBlanks = letters();
  }
  if (rest !== '') throw bad('stray character in field spec');
  return { startField: startField - 1, startChar: startChar - 1, startBlanks, endField, endChar, endBlanks, ordering, hasOptions };
}

const isBlank = (byte: number): boolean => byte === 32 || byte === 9;

function fieldStart(line: Buffer, field: number, separator: number | null): number {
  let at = 0;
  if (separator === null) {
    for (let k = 0; k < field; k++) {
      while (at < line.length && isBlank(line[at])) at++;
      while (at < line.length && !isBlank(line[at])) at++;
    }
  } else {
    for (let k = 0; k < field && at < line.length; k++) {
      while (at < line.length && line[at] !== separator) at++;
      if (at < line.length) at++;
    }
  }
  return at;
}

function keyBytes(line: Buffer, key: Key | null, separator: number | null, global: Ordering): Buffer {
  if (key === null) return line;
  let begin = fieldStart(line, key.startField, separator);
  if (key.startBlanks || (!key.hasOptions && global.blanks)) while (begin < line.length && isBlank(line[begin])) begin++;
  begin = Math.min(line.length, begin + key.startChar);
  let end = line.length;
  if (key.endField !== 0) {
    let eword = key.endField - 1;
    if (key.endChar === 0) eword++;
    let at = 0;
    if (separator === null) {
      for (let k = 0; k < eword && at < line.length; k++) {
        while (at < line.length && isBlank(line[at])) at++;
        while (at < line.length && !isBlank(line[at])) at++;
      }
    } else {
      for (let k = 0; k < eword && at < line.length; k++) {
        while (at < line.length && line[at] !== separator) at++;
        if (at < line.length && (k + 1 < eword || key.endChar !== 0)) at++;
      }
    }
    if (key.endChar !== 0) {
      if (key.endBlanks || (!key.hasOptions && global.blanks)) while (at < line.length && isBlank(line[at])) at++;
      at = Math.min(line.length, at + key.endChar);
    }
    end = at;
  }
  return end > begin ? line.subarray(begin, end) : Buffer.alloc(0);
}

function transform(bytes: Buffer, ordering: Ordering): Buffer {
  if (!ordering.dictionary && !ordering.fold && !ordering.nonprinting && !ordering.blanks) return bytes;
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i];
    if (ordering.dictionary && !(isBlank(b) || (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b >= 128)) continue;
    if (ordering.nonprinting && (b < 32 || b === 127)) continue;
    if (ordering.fold && b >= 97 && b <= 122) b -= 32;
    out.push(b);
  }
  return Buffer.from(out);
}

function compareDecimal(a: string, b: string): number {
  const parse = (text: string): { negative: boolean; integer: string; fraction: string } => {
    const match = /^[ \t]*(-?)(\d*)(?:\.(\d*))?/.exec(text) as RegExpExecArray;
    const integer = match[2].replace(/^0+/, '');
    const fraction = (match[3] ?? '').replace(/0+$/, '');
    const zero = integer === '' && fraction === '';
    return { negative: match[1] === '-' && !zero, integer, fraction };
  };
  const x = parse(a);
  const y = parse(b);
  if (x.negative !== y.negative) return x.negative ? -1 : 1;
  const sign = x.negative ? -1 : 1;
  if (x.integer.length !== y.integer.length) return sign * (x.integer.length < y.integer.length ? -1 : 1);
  if (x.integer !== y.integer) return sign * (x.integer < y.integer ? -1 : 1);
  if (x.fraction !== y.fraction) return sign * (x.fraction < y.fraction ? -1 : 1);
  return 0;
}

function generalValue(text: string): number | null {
  const match = /^[ \t]*([-+]?(?:inf(?:inity)?|nan|0[xX][0-9a-fA-F]*\.?[0-9a-fA-F]*(?:[pP][-+]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?))/i.exec(text);
  if (match === null) return null;
  const token = match[1].toLowerCase();
  if (token.includes('nan')) return null;
  if (token.includes('inf')) return token.startsWith('-') ? -Infinity : Infinity;
  const value = Number(token);
  return Number.isNaN(value) ? null : value;
}

function humanParts(text: string): { value: string; rank: number } {
  const match = /^[ \t]*(-?\d*(?:\.\d*)?)([kKMGTPEZYRQ]?)/.exec(text) as RegExpExecArray;
  const rank = match[2] === '' ? 0 : HUMAN_SUFFIXES.indexOf(match[2]) <= 1 ? 1 : HUMAN_SUFFIXES.indexOf(match[2]) - 0;
  return { value: match[1], rank };
}

function versionOrder(c: number | undefined): number {
  if (c === undefined) return 0;
  if (c >= 48 && c <= 57) return 0;
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return c;
  if (c === 126) return -1;
  return c + 256;
}

function versionCompare(a: Buffer, b: Buffer): number {
  let i = 0;
  let j = 0;
  const digit = (buffer: Buffer, at: number): boolean => at < buffer.length && buffer[at] >= 48 && buffer[at] <= 57;
  while (i < a.length || j < b.length) {
    let firstDifference = 0;
    while ((i < a.length && !digit(a, i)) || (j < b.length && !digit(b, j))) {
      const x = versionOrder(i < a.length ? a[i] : undefined);
      const y = versionOrder(j < b.length ? b[j] : undefined);
      if (x !== y) return x - y;
      i++; j++;
    }
    while (a[i] === 48) i++;
    while (b[j] === 48) j++;
    while (digit(a, i) && digit(b, j)) {
      if (firstDifference === 0) firstDifference = a[i] - b[j];
      i++; j++;
    }
    if (digit(a, i)) return 1;
    if (digit(b, j)) return -1;
    if (firstDifference !== 0) return firstDifference;
  }
  return 0;
}

function compareBytes(a: Buffer, b: Buffer): number {
  return Buffer.compare(a, b);
}

function monthOf(bytes: Buffer): number {
  const text = bytes.toString('latin1').replace(/^[ \t]+/, '').slice(0, 3).toUpperCase();
  const index = MONTHS.indexOf(text);
  return index + 1;
}

function compareByOrdering(left: Buffer, right: Buffer, ordering: Ordering, salt: string): number {
  const a = transform(left, ordering);
  const b = transform(right, ordering);
  let result: number;
  switch (ordering.mode) {
    case 'n': result = compareDecimal(a.toString('latin1'), b.toString('latin1')); break;
    case 'g': {
      const x = generalValue(a.toString('latin1'));
      const y = generalValue(b.toString('latin1'));
      result = x === null && y === null ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : x > y ? 1 : 0;
      break;
    }
    case 'h': {
      const x = humanParts(a.toString('latin1'));
      const y = humanParts(b.toString('latin1'));
      const signX = x.value.startsWith('-') ? -1 : 1;
      const signY = y.value.startsWith('-') ? -1 : 1;
      if (signX !== signY) result = signX < signY ? -1 : 1;
      else if (x.rank !== y.rank) result = signX * (x.rank < y.rank ? -1 : 1);
      else result = compareDecimal(x.value, y.value);
      break;
    }
    case 'M': { const x = monthOf(a); const y = monthOf(b); result = x < y ? -1 : x > y ? 1 : 0; break; }
    case 'V': result = versionCompare(a, b); break;
    case 'R': {
      const hash = (bytes: Buffer): string => {
        let h = 2166136261;
        for (const byte of Buffer.concat([Buffer.from(salt), bytes])) h = Math.imul(h ^ byte, 16777619) >>> 0;
        return h.toString(16).padStart(8, '0');
      };
      const x = hash(a);
      const y = hash(b);
      result = x < y ? -1 : x > y ? 1 : compareBytes(a, b);
      break;
    }
    default: result = compareBytes(a, b);
  }
  return ordering.reverse ? -result : result;
}

export function runSort(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const global = emptyOrdering();
  const keys: Key[] = [];
  let check: '' | 'diagnose' | 'quiet' = '';
  let merge = false;
  let unique = false;
  let stable = false;
  let zero = false;
  let output: string | null = null;
  let separator: number | null = null;
  let filesFrom: string | null = null;
  const operands: string[] = [];
  const streams = new Streams();
  const fail = (error: SortUsage): CoreutilsRun => {
    const failure = new Streams();
    for (const line of `sort: ${error.message}`.split('\n')) failure.diagnostic(line);
    if (error.tryLine) failure.diagnostic("Try 'sort --help' for more information.");
    failure.exitCode = error.status;
    return failure.result();
  };
  try {
    for (const item of shortOptions(args, 'bcCdfghik:mMno:rRsS:t:T:uVyz', LONG_OPTIONS)) {
      if (item.kind === 'operand') { operands.push(item.value); continue; }
      if (item.kind !== 'option') {
        throw new SortUsage(getoptDiagnostic('sort', item).replace(/^sort: /, ''), true);
      }
      switch (item.letter) {
        case 'H': return docsResult('sort', 'help');
        case 'Y': return docsResult('sort', 'version');
        case 'c': {
          const given = item.argument;
          if (given === undefined) { check = 'diagnose'; break; }
          const choices = ['diagnose-first', 'quiet', 'silent'];
          const matches = choices.filter((name) => name.startsWith(given));
          if (given === '' || matches.length !== 1) {
            throw new SortUsage(`invalid argument ${quoteLocale(given)} for ${quoteLocale('--check')}\nValid arguments are:\n  - ${quoteLocale('quiet')}, ${quoteLocale('silent')}\n  - ${quoteLocale('diagnose-first')}\nTry 'sort --help' for more information.`, false, 1);
          }
          check = matches[0] === 'diagnose-first' ? 'diagnose' : 'quiet';
          break;
        }
        case 'C': check = 'quiet'; break;
        case 'm': merge = true; break;
        case 'u': unique = true; break;
        case 's': stable = true; break;
        case 'z': zero = true; break;
        case 'y': break;
        case 'o':
          if (output !== null && output !== item.argument) throw new SortUsage('multiple output files specified');
          output = item.argument ?? '';
          break;
        case 'k': keys.push(parseKey(item.argument ?? '')); break;
        case 't': {
          const given = item.argument ?? '';
          if (given === '') throw new SortUsage('empty tab');
          if (given === '\\0') { separator = 0; break; }
          if (Buffer.byteLength(given, 'utf8') > 1) throw new SortUsage(`multi-character tab ${quoteLocale(given)}`);
          if (separator !== null && separator !== given.charCodeAt(0)) throw new SortUsage('incompatible tabs');
          separator = given.charCodeAt(0);
          break;
        }
        case 'S': {
          const given = item.argument ?? '';
          if (parseSizeWithSuffix(given.replace(/%$/, '')) === null && !/^\d+%$/.test(given)) {
            throw new SortUsage(/^\d/.test(given) ? `invalid suffix in -S argument ${quoteLocale(given)}` : `invalid -S argument ${quoteLocale(given)}`);
          }
          break;
        }
        case 'T': case 'Z': case 'A': case 'D': break;
        case 'B': {
          if (!/^\d+$/.test(item.argument ?? '')) throw new SortUsage(`invalid --batch-size argument ${quoteLocale(item.argument ?? '')}`);
          if (Number(item.argument) < 2) throw new SortUsage(`invalid --batch-size argument ${quoteLocale(item.argument ?? '')}\nsort: minimum --batch-size argument is ${quoteLocale('2')}`);
          break;
        }
        case 'P': {
          if (!/^\d+$/.test(item.argument ?? '')) throw new SortUsage(`invalid --parallel argument ${quoteLocale(item.argument ?? '')}`);
          if (Number(item.argument) === 0) throw new SortUsage('number in parallel must be nonzero');
          break;
        }
        case 'F': filesFrom = item.argument ?? ''; break;
        case 'W': {
          const given = item.argument ?? '';
          const matches = SORT_WORDS.filter(([name]) => name.startsWith(given));
          if (given === '' || matches.length !== 1) {
            const lines = SORT_WORDS.map(([name]) => `  - ${quoteLocale(name)}`).join('\n');
            throw new SortUsage(`invalid argument ${quoteLocale(given)} for ${quoteLocale('--sort')}\nValid arguments are:\n${lines}\nTry 'sort --help' for more information.`, false, 1);
          }
          applyLetter(global, matches[0][1]);
          break;
        }
        default: applyLetter(global, item.letter); break;
      }
    }
  } catch (error) {
    if (error instanceof SortUsage) return fail(error);
    throw error;
  }

  let names = operands;
  if (filesFrom !== null) {
    if (operands.length > 0) {
      return fail(new SortUsage(`extra operand ${quoteLocale(operands[0])}\nfile operands cannot be combined with --files0-from`, true));
    }
    const source = filesFrom === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : io.read(filesFrom);
    if (source.kind !== 'ok') return fail(new SortUsage(`open failed: ${quotef(filesFrom)}: No such file or directory`));
    names = source.text.split('\0');
    if (names[names.length - 1] === '') names.pop();
    if (names.length === 0) return fail(new SortUsage(`no input from ${quoteShell(filesFrom)}`));
  } else if (names.length === 0) names = ['-'];

  if (check !== '' && names.length > 1) return fail(new SortUsage(`extra operand ${quoteShell(names[1])} not allowed with -c`));
  if (check !== '' && output !== null) return fail(new SortUsage("options '-co' are incompatible"));

  const terminator = zero ? '\0' : '\n';
  const perFile: Buffer[][] = [];
  const origin: string[] = [];
  let stdinUsed = false;
  for (const name of names) {
    const read = name === '-' ? { kind: 'ok' as const, text: stdinUsed ? '' : (io.stdin ?? '') } : io.read(name);
    if (name === '-') stdinUsed = true;
    if (read.kind !== 'ok') {
      streams.diagnostic(check !== '' ? `sort: open failed: ${quotef(name)}: No such file or directory` : read.kind === 'directory' ? `sort: read failed: ${quotef(name)}: Is a directory`
        : `sort: cannot read: ${quotef(name)}: ${read.kind === 'denied' ? 'Permission denied' : 'No such file or directory'}`);
      streams.exitCode = 2;
      continue;
    }
    const records = read.text.split(terminator);
    if (records[records.length - 1] === '') records.pop();
    perFile.push(records.map((record) => toBytes(record)));
    origin.push(name);
  }
  if (streams.exitCode === 2 && check === '') return streams.result();

  const salt = String(Math.random());
  const keyOrdering = (key: Key): Ordering => (key.hasOptions ? key.ordering : { ...global, blanks: false });
  const compareKeys = (a: Buffer, b: Buffer): number => {
    if (keys.length === 0) return compareByOrdering(a, b, global, salt);
    for (const key of keys) {
      const ordering = keyOrdering(key);
      const result = compareByOrdering(keyBytes(a, key, separator, global), keyBytes(b, key, separator, global), ordering, salt);
      if (result !== 0) return result;
    }
    return 0;
  };
  const compareFull = (a: Buffer, b: Buffer): number => {
    const result = compareKeys(a, b);
    if (result !== 0 || stable || unique) return result;
    const last = compareBytes(a, b);
    return global.reverse ? -last : last;
  };

  if (check !== '') {
    const lines = perFile[0] ?? [];
    for (let index = 1; index < lines.length; index++) {
      const order = compareKeys(lines[index - 1], lines[index]);
      if (order > 0 || (unique && order === 0) || (!unique && !stable && order === 0 && compareFull(lines[index - 1], lines[index]) > 0)) {
        if (check === 'diagnose') streams.diagnostic(`sort: ${origin[0] === '-' ? '-' : quotef(origin[0])}:${index + 1}: disorder: ${fromBytes(lines[index])}`);
        streams.exitCode = 1;
        return streams.result();
      }
    }
    return streams.result();
  }

  let merged: Buffer[];
  if (merge) {
    merged = [];
    const cursors = perFile.map(() => 0);
    for (;;) {
      let best = -1;
      perFile.forEach((lines, index) => {
        if (cursors[index] >= lines.length) return;
        if (best === -1 || compareFull(lines[cursors[index]], perFile[best][cursors[best]]) < 0) best = index;
      });
      if (best === -1) break;
      merged.push(perFile[best][cursors[best]]);
      cursors[best]++;
    }
  } else {
    merged = perFile.flat();
    const indexed = merged.map((line, index) => ({ line, index }));
    indexed.sort((x, y) => compareFull(x.line, y.line) || x.index - y.index);
    merged = indexed.map((entry) => entry.line);
  }
  if (unique) {
    const kept: Buffer[] = [];
    for (const line of merged) {
      if (kept.length > 0 && compareKeys(kept[kept.length - 1], line) === 0) continue;
      kept.push(line);
    }
    merged = kept;
  }
  const text = merged.map((line) => fromBytes(line) + terminator).join('');
  if (output !== null) {
    if (io.write?.(output, text) !== true) {
      streams.diagnostic(`sort: open failed: ${quotef(output)}: No such file or directory`);
      streams.exitCode = 2;
    }
  } else streams.stdout(text);
  return streams.result();
}
