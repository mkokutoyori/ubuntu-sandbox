import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'delimiters', letter: 'd', takesArgument: true },
  { name: 'serial', letter: 's', takesArgument: false },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', '\\': '\\', b: '\b', f: '\f', r: '\r', v: '\v', '0': '' };

function parseDelimiters(list: string): string[] | string {
  const delimiters: string[] = [];
  for (let index = 0; index < list.length; index++) {
    const ch = list[index];
    if (ch !== '\\') { delimiters.push(ch); continue; }
    const next = list[index + 1];
    if (next === undefined) return `paste: delimiter list ends with an unescaped backslash: ${list}`;
    delimiters.push(ESCAPES[next] ?? next);
    index++;
  }
  return delimiters.length === 0 ? [''] : delimiters;
}

function splitRecords(text: string, terminator: string): string[] {
  if (text === '') return [];
  const records = text.split(terminator);
  if (records[records.length - 1] === '') records.pop();
  return records;
}

export function runPaste(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let delimiterSpec = '\t';
  let serial = false;
  let terminator = '\n';
  const operands: string[] = [];
  for (const item of shortOptions(args, 'd:sz', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('paste', getoptDiagnostic('paste', item));
    switch (item.letter) {
      case 'H': return docsResult('paste', 'help');
      case 'V': return docsResult('paste', 'version');
      case 'd': delimiterSpec = item.argument ?? '\t'; break;
      case 's': serial = true; break;
      case 'z': terminator = '\0'; break;
      default: break;
    }
  }
  const streams = new Streams();
  const delimiters = parseDelimiters(delimiterSpec);
  if (typeof delimiters === 'string') {
    streams.diagnostic(delimiters);
    streams.exitCode = 1;
    return streams.result();
  }
  const queue = new InputQueue(io);
  const names = operands.length === 0 ? ['-'] : operands;
  const sources: string[][] = [];
  const shared: { records: string[] | null } = { records: null };
  for (const name of names) {
    if (name === '-') {
      if (shared.records === null) shared.records = splitRecords(io.stdin ?? '', terminator);
      sources.push(shared.records);
      continue;
    }
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`paste: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      return streams.result();
    }
    sources.push(splitRecords(read.text, terminator));
  }
  const delimiterAt = (position: number): string => delimiters[position % delimiters.length];
  if (serial) {
    const seen = new Set<string[]>();
    for (const records of sources) {
      const all = records === shared.records ? (seen.has(records) ? [] : records) : records;
      seen.add(records);
      let line = '';
      all.forEach((record, index) => { line += (index === 0 ? '' : delimiterAt(index - 1)) + record; });
      streams.stdout(`${line}${terminator}`);
    }
    return streams.result();
  }
  const cursors = new Map<string[], number>();
  const take = (records: string[]): string | null => {
    const at = cursors.get(records) ?? 0;
    if (at >= records.length) return null;
    cursors.set(records, at + 1);
    return records[at];
  };
  while (true) {
    const cells = sources.map(take);
    if (cells.every((cell) => cell === null)) break;
    let line = '';
    cells.forEach((cell, index) => { line += (index === 0 ? '' : delimiterAt(index - 1)) + (cell ?? ''); });
    streams.stdout(`${line}${terminator}`);
  }
  return streams.result();
}
