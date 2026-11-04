import { compilePosix } from '../regex/PosixRegex';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, fromBytes, quotef, quoteShell, readFailureText, toBytes, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'before', letter: 'b', takesArgument: false },
  { name: 'regex', letter: 'r', takesArgument: false },
  { name: 'separator', letter: 's', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

function splitRecords(text: string, separator: string, regex: boolean, before: boolean): string[] {
  const boundaries: { start: number; end: number }[] = [];
  if (regex) {
    const pattern = compilePosix(separator, { extended: true, global: true });
    for (const match of text.matchAll(pattern)) {
      if (match[0].length > 0) boundaries.push({ start: match.index as number, end: (match.index as number) + match[0].length });
    }
  } else {
    for (let at = text.indexOf(separator); at >= 0; at = text.indexOf(separator, at + separator.length)) {
      boundaries.push({ start: at, end: at + separator.length });
    }
  }
  const cuts = boundaries.map((boundary) => (before ? boundary.start : boundary.end));
  const records: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    records.push(text.slice(from, cut));
    from = cut;
  }
  records.push(text.slice(from));
  return records.filter((record) => record !== '');
}

export function runTac(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let before = false;
  let regex = false;
  let separator = '\n';
  const operands: string[] = [];
  for (const item of shortOptions(args, 'brs:', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('tac', getoptDiagnostic('tac', item));
    switch (item.letter) {
      case 'H': return docsResult('tac', 'help');
      case 'V': return docsResult('tac', 'version');
      case 'b': before = true; break;
      case 'r': regex = true; break;
      case 's':
        separator = item.argument === '' ? '\0' : item.argument ?? '\n';
        break;
      default: break;
    }
  }
  const streams = new Streams();
  const queue = new InputQueue(io);
  for (const name of operands.length === 0 ? ['-'] : operands) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(read.kind === 'directory'
        ? `tac: ${quotef(name)}: read error: Is a directory`
        : `tac: failed to open ${quoteShell(name)} for reading: ${readFailureText(read)}`);
      streams.exitCode = 1;
      continue;
    }
    const text = fromBytes(toBytes(read.text));
    streams.stdout(splitRecords(text, separator, regex, before).reverse().join(''));
  }
  return streams.result();
}
