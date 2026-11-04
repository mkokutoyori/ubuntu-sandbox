import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'zero', letter: '0', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const HELP = 'Usage: rev [options] [file ...]\n\nReverse lines characterwise.\n\nOptions:\n -h, --help     display this help\n -V, --version  display version\n\nFor more details see rev(1).\n';
const VERSION = 'rev from util-linux 2.37.2\n';

function reverseLine(line: string): string {
  return Array.from(line).reverse().join('');
}

export function runRev(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const operands: string[] = [];
  let terminator = '\n';
  const streams = new Streams();
  for (const item of shortOptions(args, '0hV', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('rev', getoptDiagnostic('rev', item));
    if (item.letter === '0') { terminator = '\0'; continue; }
    streams.stdout(item.letter === 'h' ? HELP : VERSION);
    return streams.result();
  }
  const queue = new InputQueue(io);
  for (const name of operands.length === 0 ? ['-'] : operands) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`rev: cannot open ${name}: ${read.kind === 'directory' ? 'Is a directory' : read.kind === 'denied' ? 'Permission denied' : 'No such file or directory'}`);
      streams.exitCode = 1;
      continue;
    }
    const text = read.text;
    const endsWithTerminator = text.endsWith(terminator);
    const body = endsWithTerminator ? text.slice(0, -1) : text;
    if (text === '') continue;
    streams.stdout(body.split(terminator).map(reverseLine).join(terminator) + (endsWithTerminator ? terminator : ''));
  }
  return streams.result();
}
