import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, quoteLocale, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'check-order', letter: 'C', takesArgument: false },
  { name: 'nocheck-order', letter: 'N', takesArgument: false },
  { name: 'output-delimiter', letter: 'D', takesArgument: true },
  { name: 'total', letter: 'T', takesArgument: false },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

function splitRecords(text: string, terminator: string): string[] {
  if (text === '') return [];
  const records = text.split(terminator);
  if (records[records.length - 1] === '') records.pop();
  return records;
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export function runComm(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const suppressed = new Set<number>();
  const operands: string[] = [];
  let delimiter: string | null = null;
  let checkOrder: 'default' | 'enabled' | 'disabled' = 'default';
  let total = false;
  let terminator = '\n';
  for (const item of shortOptions(args, '123z', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('comm', getoptDiagnostic('comm', item));
    switch (item.letter) {
      case 'H': return docsResult('comm', 'help');
      case 'V': return docsResult('comm', 'version');
      case '1': case '2': case '3': suppressed.add(Number(item.letter)); break;
      case 'C': checkOrder = 'enabled'; break;
      case 'N': checkOrder = 'disabled'; break;
      case 'T': total = true; break;
      case 'z': terminator = '\0'; break;
      case 'D': {
        const value = item.argument === '' ? '\0' : item.argument ?? '\t';
        if (delimiter !== null && delimiter !== value) return usageFailure('comm', 'comm: multiple output delimiters specified');
        delimiter = value;
        break;
      }
      default: break;
    }
  }
  if (operands.length < 2) {
    return usageFailure('comm', operands.length === 0 ? 'comm: missing operand' : `comm: missing operand after ${quoteLocale(operands[0])}`);
  }
  if (operands.length > 2) return usageFailure('comm', `comm: extra operand ${quoteLocale(operands[2])}`);
  const separator = delimiter ?? '\t';
  const streams = new Streams();
  const queue = new InputQueue(io);
  const files: string[][] = [];
  for (const name of operands) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`comm: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      return streams.result();
    }
    files.push(splitRecords(read.text, terminator));
  }
  const [first, second] = files;
  const counts = [0, 0, 0];
  const warned = [false, false];
  let seenUnpairable = false;
  let stopped = false;
  const check = (lines: string[], index: number, fileNumber: number): void => {
    if (checkOrder === 'disabled' || stopped) return;
    if (checkOrder !== 'enabled' && !seenUnpairable) return;
    if (index === 0 || compare(lines[index - 1], lines[index]) <= 0) return;
    if (!warned[fileNumber - 1]) {
      streams.diagnostic(`comm: file ${fileNumber} is not in sorted order`);
      warned[fileNumber - 1] = true;
      if (checkOrder === 'enabled') { streams.exitCode = 1; stopped = true; }
    }
  };
  const emit = (column: 1 | 2 | 3, value: string): void => {
    counts[column - 1]++;
    if (suppressed.has(column)) return;
    let indent = 0;
    for (let before = 1; before < column; before++) if (!suppressed.has(before)) indent++;
    streams.stdout(`${separator.repeat(indent)}${value}${terminator}`);
  };
  let a = 0;
  let b = 0;
  check(first, 0, 1);
  check(second, 0, 2);
  while ((a < first.length || b < second.length) && !stopped) {
    const order = a >= first.length ? 1 : b >= second.length ? -1 : compare(first[a], second[b]);
    if (order === 0) {
      emit(3, first[a]);
      a++; b++;
      if (a < first.length) check(first, a, 1);
      if (b < second.length) check(second, b, 2);
    } else if (order < 0) {
      emit(1, first[a]);
      seenUnpairable = true;
      a++;
      if (a < first.length) check(first, a, 1);
    } else {
      emit(2, second[b]);
      seenUnpairable = true;
      b++;
      if (b < second.length) check(second, b, 2);
    }
  }
  if (total && !stopped) streams.stdout(`${counts[0]}${separator}${counts[1]}${separator}${counts[2]}${separator}total${terminator}`);
  if (warned[0] || warned[1]) {
    if (!stopped) streams.diagnostic('comm: input is not in sorted order');
    streams.exitCode = 1;
  }
  return streams.result();
}
