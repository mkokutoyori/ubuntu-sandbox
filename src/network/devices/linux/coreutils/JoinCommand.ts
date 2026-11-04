import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, quoteLocale, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'ignore-case', letter: 'i', takesArgument: false },
  { name: 'check-order', letter: 'C', takesArgument: false },
  { name: 'nocheck-order', letter: 'N', takesArgument: false },
  { name: 'header', letter: 'h', takesArgument: false },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

type CheckOrder = 'default' | 'enabled' | 'disabled';

interface FieldSpec {
  readonly file: 0 | 1 | 2;
  readonly field: number;
}

interface JoinOptions {
  fieldOne: number;
  fieldTwo: number;
  unpairedOne: boolean;
  unpairedTwo: boolean;
  paired: boolean;
  filler: string | null;
  ignoreCase: boolean;
  tab: string | null;
  checkOrder: CheckOrder;
  header: boolean;
  recordEnd: string;
  autoFormat: boolean;
  format: FieldSpec[] | null;
}

interface Line {
  readonly text: string;
  readonly fields: readonly string[];
}

class JoinFailure extends Error {
  constructor(readonly lines: readonly string[]) {
    super(lines.join('\n'));
  }
}

const isBlank = (ch: string, recordEnd: string): boolean => ch === ' ' || ch === '\t' || (recordEnd === '\0' && ch === '\n');

function splitFields(text: string, options: JoinOptions): string[] {
  if (options.tab !== null) return text === '' ? [] : text.split(options.tab);
  const fields: string[] = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && isBlank(text[at], options.recordEnd) && !(options.recordEnd === '\0' && text[at] === '\n')) at++;
    if (at >= text.length) break;
    const start = at;
    while (at < text.length && !isBlank(text[at], options.recordEnd)) at++;
    fields.push(text.slice(start, at));
    if (options.recordEnd === '\0' && text[at] === '\n') {
      at++;
      if (at >= text.length) fields.push('');
    }
  }
  return fields;
}

function fieldNumber(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new JoinFailure([`join: invalid field number: ${quoteLocale(text)}`]);
  return Number(text);
}

function parseFormat(spec: string, options: JoinOptions): void {
  if (spec === 'auto') {
    options.autoFormat = true;
    return;
  }
  const list: FieldSpec[] = options.format ?? [];
  for (const token of spec.split(/[,\t ]/)) {
    if (token === '0') { list.push({ file: 0, field: 0 }); continue; }
    const file = token[0];
    if (file !== '1' && file !== '2') throw new JoinFailure([`join: invalid file number in field spec: ${quoteLocale(token)}`]);
    if (token[1] !== '.') throw new JoinFailure([`join: invalid field specifier: ${quoteLocale(token)}`]);
    list.push({ file: file === '1' ? 1 : 2, field: fieldNumber(token.slice(2)) });
  }
  options.format = list;
}

function defaults(): JoinOptions {
  return {
    fieldOne: 1, fieldTwo: 1, unpairedOne: false, unpairedTwo: false, paired: true, filler: null, ignoreCase: false, tab: null,
    checkOrder: 'default', header: false, recordEnd: '\n', autoFormat: false, format: null,
  };
}

function parse(args: readonly string[]): { options: JoinOptions; operands: string[] } | CoreutilsRun {
  const options = defaults();
  const operands: string[] = [];
  const tokens = [...args];
  try {
    for (const item of shortOptions(tokens, 'a:e:i1:2:j:o:t:v:z', LONG_OPTIONS)) {
      if (item.kind === 'operand') { operands.push(item.value); continue; }
      if (item.kind !== 'option') return usageFailure('join', getoptDiagnostic('join', item));
      const value = item.argument ?? '';
      switch (item.letter) {
        case 'H': return docsResult('join', 'help');
        case 'V': return docsResult('join', 'version');
        case 'a': case 'v': {
          if (value !== '1' && value !== '2') throw new JoinFailure([`join: invalid field number: ${quoteLocale(value)}`]);
          if (value === '1') options.unpairedOne = true; else options.unpairedTwo = true;
          if (item.letter === 'v') options.paired = false;
          break;
        }
        case 'e': options.filler = value; break;
        case 'i': options.ignoreCase = true; break;
        case '1': options.fieldOne = fieldNumber(value); break;
        case '2': options.fieldTwo = fieldNumber(value); break;
        case 'j': {
          options.fieldOne = fieldNumber(value);
          options.fieldTwo = options.fieldOne;
          break;
        }
        case 'o': parseFormat(value, options); break;
        case 't': {
          let next = value;
          if (next === '') next = '\n';
          else if (next.length > 1) {
            if (next !== '\\0') throw new JoinFailure([`join: multi-character tab ${quoteLocale(next)}`]);
            next = '\0';
          }
          if (options.tab !== null && options.tab !== next) throw new JoinFailure(['join: incompatible tabs']);
          options.tab = next;
          break;
        }
        case 'C': options.checkOrder = 'enabled'; break;
        case 'N': options.checkOrder = 'disabled'; break;
        case 'h': options.header = true; break;
        case 'z': options.recordEnd = '\0'; break;
        default: break;
      }
    }
  } catch (error) {
    if (!(error instanceof JoinFailure)) throw error;
    const failed = new Streams();
    for (const line of error.lines) failed.diagnostic(line);
    failed.exitCode = 1;
    return failed.result();
  }
  return { options, operands };
}

function splitRecords(text: string, recordEnd: string): string[] {
  if (text === '') return [];
  const records = text.split(recordEnd);
  if (records[records.length - 1] === '') records.pop();
  return records;
}

class DisorderExit extends Error {}

export function runJoin(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const parsed = parse(args);
  if (!('options' in parsed)) return parsed;
  const { options, operands } = parsed;
  const streams = new Streams();
  if (operands.length < 2) {
    return usageFailure('join', operands.length === 0 ? 'join: missing operand' : `join: missing operand after ${quoteLocale(operands[operands.length - 1])}`);
  }
  if (operands.length > 2) return usageFailure('join', `join: extra operand ${quoteLocale(operands[2])}`);
  if (operands[0] === '-' && operands[1] === '-') {
    streams.diagnostic('join: both files cannot be standard input: No such file or directory');
    streams.exitCode = 1;
    return streams.result();
  }
  const queue = new InputQueue(io);
  const texts: string[] = [];
  for (const name of operands) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`join: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      return streams.result();
    }
    texts.push(read.text);
  }
  const eol = options.recordEnd;
  const lineOf = (text: string): Line => ({ text, fields: splitFields(text, options) });
  const records = texts.map((text) => splitRecords(text, eol).map(lineOf));
  const separator = options.tab ?? ' ';
  const filler = options.filler;
  let seenUnpairable = false;
  const warned = [false, false];
  const positions = [0, 0];
  const previous: (Line | null)[] = [null, null];
  const numbers = [0, 0];
  let out = '';

  const keyOf = (line: Line, which: 1 | 2): string => {
    const text = line.fields[(which === 1 ? options.fieldOne : options.fieldTwo) - 1] ?? '';
    return options.ignoreCase ? text.replace(/[a-z]/g, (c) => c.toUpperCase()) : text;
  };
  const compareKeys = (a: Line, b: Line): number => {
    const left = keyOf(a, 1);
    const right = keyOf(b, 2);
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const read = (which: 1 | 2, verify = true): Line | null => {
    const index = which - 1;
    if (positions[index] >= records[index].length) return null;
    const line = records[index][positions[index]++];
    numbers[index]++;
    const prior = previous[index];
    const checking = verify && options.checkOrder !== 'disabled' && (options.checkOrder === 'enabled' || seenUnpairable);
    if (prior !== null && checking && !warned[index]) {
      const a = keyOf(prior, which);
      const b = keyOf(line, which);
      if (a > b) {
        streams.stdout(out);
        out = '';
        streams.diagnostic(`join: ${quotef(operands[index])}:${numbers[index]}: is not sorted: ${line.text}`);
        if (options.checkOrder === 'enabled') throw new DisorderExit();
        warned[index] = true;
      }
    }
    previous[index] = line;
    return line;
  };

  const emitField = (line: Line | null, index: number): void => {
    const value = line !== null && index < line.fields.length ? line.fields[index] : undefined;
    if (value !== undefined && value !== '') out += value;
    else if (filler !== null) out += filler;
  };
  const autoOne = records[0][0]?.fields.length ?? 0;
  const autoTwo = records[1][0]?.fields.length ?? 0;
  const print = (one: Line | null, two: Line | null): void => {
    const others = (count: number, joinField: number, file: 1 | 2): FieldSpec[] =>
      Array.from({ length: count }, (_, i) => i + 1).filter((field) => field !== joinField).map((field) => ({ file, field }));
    const specs: FieldSpec[] | null = options.format ?? (options.autoFormat
      ? [{ file: 0, field: 0 }, ...others(autoOne, options.fieldOne, 1), ...others(autoTwo, options.fieldTwo, 2)]
      : null);
    const pieces: string[] = [];
    const write = (action: () => void): void => {
      const before = out;
      out = '';
      action();
      pieces.push(out);
      out = before;
    };
    if (specs !== null) {
      for (const spec of specs) {
        if (spec.file === 0) {
          const base = one ?? two;
          const which: 1 | 2 = one !== null ? 1 : 2;
          write(() => emitField(base, (which === 1 ? options.fieldOne : options.fieldTwo) - 1));
        } else {
          write(() => emitField(spec.file === 1 ? one : two, spec.field - 1));
        }
      }
    } else {
      const base = one ?? two;
      const which: 1 | 2 = one !== null ? 1 : 2;
      write(() => emitField(base, (which === 1 ? options.fieldOne : options.fieldTwo) - 1));
      for (const [line, joinField] of [[one, options.fieldOne], [two, options.fieldTwo]] as const) {
        if (line === null) continue;
        line.fields.forEach((_, index) => {
          if (index !== joinField - 1) write(() => emitField(line, index));
        });
      }
    }
    out += `${pieces.join(separator)}${eol}`;
  };

  try {
    let one = read(1);
    let two = read(2);
    if (options.header) {
      if (one !== null || two !== null) print(one, two);
      previous[0] = null;
      previous[1] = null;
      one = read(1);
      two = read(2);
    }
    while (one !== null && two !== null) {
      const order = compareKeys(one, two);
      if (order < 0) {
        if (options.unpairedOne) print(one, null);
        seenUnpairable = true;
        one = read(1);
        continue;
      }
      if (order > 0) {
        if (options.unpairedTwo) print(null, two);
        seenUnpairable = true;
        two = read(2);
        continue;
      }
      const first = [one];
      let next = read(1);
      while (next !== null && keyOf(next, 1) === keyOf(one, 1)) { first.push(next); next = read(1); }
      const second = [two];
      let after = read(2);
      while (after !== null && keyOf(after, 2) === keyOf(two, 2)) { second.push(after); after = read(2); }
      if (options.paired) for (const left of first) for (const right of second) print(left, right);
      one = next;
      two = after;
    }
    if (one !== null || two !== null) seenUnpairable = true;
    while (one !== null) {
      if (options.unpairedOne) print(one, null);
      one = read(1, options.checkOrder === 'enabled');
    }
    while (two !== null) {
      if (options.unpairedTwo) print(null, two);
      two = read(2, options.checkOrder === 'enabled');
    }
  } catch (error) {
    if (!(error instanceof DisorderExit)) throw error;
    streams.stdout(out);
    streams.exitCode = 1;
    return streams.result();
  }
  streams.stdout(out);
  if (warned[0] || warned[1]) {
    streams.diagnostic('join: input is not in sorted order');
    streams.exitCode = 1;
  }
  return streams.result();
}
