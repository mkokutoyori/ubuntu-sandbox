import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import {
  Streams, docsResult, fromBytes, quoteLocale, quotef, readFailureText, toBytes, usageFailure,
  type CoreutilsIO, type CoreutilsRun,
} from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'bytes', letter: 'b', takesArgument: true },
  { name: 'characters', letter: 'c', takesArgument: true },
  { name: 'fields', letter: 'f', takesArgument: true },
  { name: 'delimiter', letter: 'd', takesArgument: true },
  { name: 'only-delimited', letter: 's', takesArgument: false },
  { name: 'output-delimiter', letter: 'O', takesArgument: true },
  { name: 'complement', letter: 'C', takesArgument: false },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

type Mode = 'bytes' | 'characters' | 'fields';
type Range = readonly [number, number];

class ListError extends Error {}

function parseList(list: string, mode: Mode): Range[] {
  const fields = mode === 'fields';
  const numbered = fields ? 'fields are numbered from 1' : 'byte/character positions are numbered from 1';
  const invalidValue = (text: string): ListError => new ListError(`invalid ${fields ? 'field value' : 'byte/character position'} ${quoteLocale(text)}`);
  const tooLarge = (text: string): ListError => new ListError(`${fields ? 'field number' : 'byte/character offset'} ${quoteLocale(text)} is too large`);
  const number = (digits: string): number => {
    if (digits.length > 15) throw tooLarge(digits);
    return Number(digits);
  };
  const ranges: Range[] = [];
  if (list === '') throw new ListError(numbered);
  for (const item of list.split(/[,\s]/)) {
    if (item === '') throw new ListError(numbered);
    const match = /^(\d*)(-?)([^]*)$/.exec(item) as RegExpExecArray;
    const [, low, dash, tail] = match;
    if (dash === '') {
      if (low === '') throw invalidValue(item);
      if (tail !== '') throw invalidValue(tail);
      const n = number(low);
      if (n === 0) throw new ListError(numbered);
      ranges.push([n, n]);
      continue;
    }
    const high = /^(\d*)([^]*)$/.exec(tail) as RegExpExecArray;
    if (high[2] !== '') {
      if (high[2].startsWith('-')) throw new ListError(fields ? 'invalid field range' : 'invalid byte or character range');
      throw invalidValue(high[2]);
    }
    if (low === '' && high[1] === '') throw new ListError('invalid range with no endpoint: -');
    const start = low === '' ? 1 : number(low);
    const end = high[1] === '' ? Infinity : number(high[1]);
    if (start === 0 || (low === '' && end === 0)) throw new ListError(numbered);
    if (end < start) throw new ListError('invalid decreasing range');
    ranges.push([start, end]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1] + 1) merged[merged.length - 1] = [last[0], Math.max(last[1], range[1])];
    else merged.push(range);
  }
  return merged;
}

function complementOf(ranges: readonly Range[]): Range[] {
  const out: Range[] = [];
  let next = 1;
  for (const [start, end] of ranges) {
    if (start > next) out.push([next, start - 1]);
    next = end === Infinity ? Infinity : end + 1;
    if (next === Infinity) return out;
  }
  out.push([next, Infinity]);
  return out;
}

function selectUnits(units: readonly string[], ranges: readonly Range[], separator: string | null): string {
  let out = '';
  let first = true;
  for (const [start, end] of ranges) {
    if (start > units.length) break;
    const slice = units.slice(start - 1, Math.min(end, units.length)).join('');
    if (!first && separator !== null) out += separator;
    out += slice;
    first = false;
  }
  return out;
}

export function runCut(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let mode: Mode | null = null;
  let list = '';
  let delimiter: string | null = null;
  let onlyDelimited = false;
  let complement = false;
  let outputDelimiter: string | null = null;
  let zero = false;
  let conflicting = false;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'b:c:d:f:nsz', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('cut', getoptDiagnostic('cut', item));
    switch (item.letter) {
      case 'H': return docsResult('cut', 'help');
      case 'V': return docsResult('cut', 'version');
      case 'b': case 'c': case 'f': {
        const next: Mode = item.letter === 'b' ? 'bytes' : item.letter === 'c' ? 'characters' : 'fields';
        if (mode !== null) conflicting = true;
        mode = next;
        list = item.argument ?? '';
        break;
      }
      case 'd': delimiter = item.argument ?? ''; break;
      case 's': onlyDelimited = true; break;
      case 'O': outputDelimiter = item.argument ?? ''; break;
      case 'C': complement = true; break;
      case 'z': zero = true; break;
      default: break;
    }
  }
  if (conflicting) return usageFailure('cut', 'cut: only one list may be specified');
  if (mode === null) return usageFailure('cut', 'cut: you must specify a list of bytes, characters, or fields');
  if (delimiter !== null && mode !== 'fields') return usageFailure('cut', 'cut: an input delimiter may be specified only when operating on fields');
  if (onlyDelimited && mode !== 'fields') return usageFailure('cut', 'cut: suppressing non-delimited lines makes sense\n\tonly when operating on fields');
  if (delimiter !== null && [...delimiter].length > 1) return usageFailure('cut', 'cut: the delimiter must be a single character');
  let ranges: Range[];
  try { ranges = parseList(list, mode); } catch (error) {
    if (error instanceof ListError) return usageFailure('cut', `cut: ${error.message}`);
    throw error;
  }
  if (complement) ranges = complementOf(ranges);

  const fieldDelimiter = delimiter === null ? '\t' : delimiter === '' ? '\0' : delimiter;
  const joiner = outputDelimiter === null ? (mode === 'fields' ? fieldDelimiter : null) : outputDelimiter === '' ? '\0' : outputDelimiter;
  const terminator = zero ? '\0' : '\n';
  const streams = new Streams();
  const names = operands.length === 0 ? ['-'] : operands;
  for (const name of names) {
    const read = name === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : io.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`cut: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      continue;
    }
    const records = read.text.split(terminator);
    if (records[records.length - 1] === '') records.pop();
    for (const record of records) {
      if (mode === 'fields') {
        if (!record.includes(fieldDelimiter)) {
          if (!onlyDelimited) streams.stdout(record + terminator);
          continue;
        }
        const fields = record.split(fieldDelimiter);
        const kept: string[] = [];
        for (const [start, end] of ranges) {
          if (start > fields.length) break;
          kept.push(...fields.slice(start - 1, Math.min(end, fields.length)));
        }
        streams.stdout(kept.join(joiner ?? fieldDelimiter) + terminator);
        continue;
      }
      const bytes = [...toBytes(record)].map((byte) => String.fromCharCode(byte));
      const picked = selectUnits(bytes, ranges, joiner);
      streams.stdout(fromBytes(Buffer.from(picked, 'latin1')) + terminator);
    }
  }
  return streams.result();
}
