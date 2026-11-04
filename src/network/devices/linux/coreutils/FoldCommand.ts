import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, fromBytes, quoteLocale, quotef, readFailureText, toBytes, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'bytes', letter: 'b', takesArgument: false },
  { name: 'spaces', letter: 's', takesArgument: false },
  { name: 'width', letter: 'w', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const TAB_WIDTH = 8;

function advance(column: number, ch: string, bytes: boolean): number {
  if (bytes) return column + 1;
  if (ch === '\b') return column > 0 ? column - 1 : 0;
  if (ch === '\r') return 0;
  if (ch === '\t') return column + TAB_WIDTH - (column % TAB_WIDTH);
  return column + 1;
}

function foldText(text: string, width: number, atSpaces: boolean, bytes: boolean): string {
  const units = bytes ? Array.from(toBytes(text), (byte) => String.fromCharCode(byte)) : Array.from(text);
  const pieces: string[] = [];
  let line: string[] = [];
  let column = 0;
  const writeLine = (count: number): void => { pieces.push(line.slice(0, count).join('')); };
  for (const ch of units) {
    if (ch === '\n') {
      writeLine(line.length);
      pieces.push('\n');
      line = [];
      column = 0;
      continue;
    }
    let next = advance(column, ch, bytes);
    while (next > width) {
      let cut = line.length;
      if (atSpaces) {
        let at = line.length;
        while (at > 0 && line[at - 1] !== ' ' && line[at - 1] !== '\t') at--;
        if (at > 0) cut = at;
      }
      writeLine(cut);
      pieces.push('\n');
      line = line.slice(cut);
      column = 0;
      for (const kept of line) column = advance(column, kept, bytes);
      next = advance(column, ch, bytes);
    }
    line.push(ch);
    column = next;
  }
  writeLine(line.length);
  const joined = pieces.join('');
  return bytes ? fromBytes(Buffer.from(joined, 'latin1')) : joined;
}

export function runFold(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let width = 80;
  let bytes = false;
  let atSpaces = false;
  const operands: string[] = [];
  const failure = new Streams();
  let digits = '';
  for (const item of shortOptions(args, 'bsw:0123456789', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('fold', getoptDiagnostic('fold', item));
    switch (item.letter) {
      case 'H': return docsResult('fold', 'help');
      case 'V': return docsResult('fold', 'version');
      case 'b': bytes = true; break;
      case 's': atSpaces = true; break;
      case 'w': {
        const text = item.argument ?? '';
        if (!/^\d+$/.test(text)) {
          failure.diagnostic(`fold: invalid number of columns: ${quoteLocale(text)}`);
          failure.exitCode = 1;
          return failure.result();
        }
        if (Number(text) < 1) {
          failure.diagnostic(`fold: invalid number of columns: ${quoteLocale(text)}: Numerical result out of range`);
          failure.exitCode = 1;
          return failure.result();
        }
        width = Number(text);
        break;
      }
      default:
        if (/^\d$/.test(item.letter)) digits += item.letter;
    }
  }
  if (digits !== '') width = Math.max(1, Number(digits));
  const streams = new Streams();
  const queue = new InputQueue(io);
  for (const name of operands.length === 0 ? ['-'] : operands) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`fold: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      continue;
    }
    streams.stdout(foldText(read.text, width, atSpaces, bytes));
  }
  return streams.result();
}
