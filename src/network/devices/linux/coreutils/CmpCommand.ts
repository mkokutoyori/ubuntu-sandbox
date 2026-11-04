import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, parseSizeWithSuffix, quoteLocale, toBytes, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'print-bytes', letter: 'b', takesArgument: false },
  { name: 'ignore-initial', letter: 'i', takesArgument: true },
  { name: 'verbose', letter: 'l', takesArgument: false },
  { name: 'bytes', letter: 'n', takesArgument: true },
  { name: 'quiet', letter: 's', takesArgument: false },
  { name: 'silent', letter: 's', takesArgument: false },
  { name: 'version', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
];

const TROUBLE = 2;

function printable(byte: number): string {
  if (byte >= 128) {
    const low = byte - 128;
    return low === 127 ? 'M-^?' : low < 32 ? `M-^${String.fromCharCode(low + 64)}` : `M-${String.fromCharCode(low)}`;
  }
  if (byte < 32) return `^${String.fromCharCode(byte + 64)}`;
  return byte === 127 ? '^?' : String.fromCharCode(byte);
}

const octal = (byte: number): string => byte.toString(8).padStart(3, ' ');

function parseCount(text: string): number | null {
  if (!/^\d+/.test(text)) return null;
  const value = parseSizeWithSuffix(text);
  return value !== null && Number.isSafeInteger(value) ? value : null;
}

function trouble(streams: Streams, message: string, withTry: boolean): CoreutilsRun {
  streams.diagnostic(message);
  if (withTry) streams.diagnostic("cmp: Try 'cmp --help' for more information.");
  streams.exitCode = TROUBLE;
  return streams.result();
}

export function runCmp(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const streams = new Streams();
  let printBytes = false;
  let verbose = false;
  let quiet = false;
  let limit: number | null = null;
  let skip: [number, number] = [0, 0];
  const operands: string[] = [];
  for (const item of shortOptions(args, 'bi:ln:sv', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') {
      streams.diagnostic(getoptDiagnostic('cmp', item));
      streams.diagnostic("cmp: Try 'cmp --help' for more information.");
      streams.exitCode = TROUBLE;
      return streams.result();
    }
    const value = item.argument ?? '';
    switch (item.letter) {
      case 'H': return docsResult('cmp', 'help');
      case 'v': return docsResult('cmp', 'version');
      case 'b': printBytes = true; break;
      case 'l': verbose = true; break;
      case 's': quiet = true; break;
      case 'n': {
        const parsed = parseCount(value);
        if (parsed === null) return trouble(streams, `cmp: invalid --bytes value ${quoteLocale(value)}`, true);
        limit = parsed;
        break;
      }
      case 'i': {
        const [first, second] = value.split(':');
        const one = parseCount(first);
        const two = second === undefined ? one : parseCount(second);
        if (one === null || two === null) return trouble(streams, `cmp: invalid --ignore-initial value ${quoteLocale(value)}`, true);
        skip = [one, two];
        break;
      }
      default: break;
    }
  }
  if (verbose && quiet) return trouble(streams, 'cmp: options -l and -s are incompatible', true);
  if (operands.length === 0) return trouble(streams, `cmp: missing operand after ${quoteLocale('cmp')}`, true);
  if (operands.length > 4) return trouble(streams, `cmp: extra operand ${quoteLocale(operands[4])}`, true);
  for (const [index, operand] of operands.slice(2).entries()) {
    const parsed = parseCount(operand);
    if (parsed === null) return trouble(streams, `cmp: invalid --ignore-initial value ${quoteLocale(operand)}`, true);
    skip[index] = parsed;
  }
  const names = [operands[0], operands[1] ?? '-'];
  const contents: Uint8Array[] = [];
  let stdinUsed = false;
  for (const name of names) {
    if (name === '-') {
      contents.push(stdinUsed ? new Uint8Array() : toBytes(io.stdin ?? ''));
      stdinUsed = true;
      continue;
    }
    const read = io.read(name);
    if (read.kind !== 'ok') {
      if (quiet) { streams.exitCode = TROUBLE; return streams.result(); }
      const reason = read.kind === 'directory' ? 'Is a directory' : read.kind === 'denied' ? 'Permission denied' : read.kind === 'loop' ? 'Too many levels of symbolic links' : 'No such file or directory';
      return trouble(streams, `cmp: ${name}: ${reason}`, false);
    }
    contents.push(toBytes(read.text));
  }
  if (names[0] === names[1] && skip[0] === skip[1]) return streams.result();
  const first = contents[0].subarray(Math.min(skip[0], contents[0].length));
  const second = contents[1].subarray(Math.min(skip[1], contents[1].length));
  const compared = Math.min(first.length, second.length, limit ?? Infinity);
  const width = String(Math.min(contents[0].length, contents[1].length)).length;
  let line = 1;
  let differences = false;
  for (let at = 0; at < compared; at++) {
    const left = first[at];
    const right = second[at];
    if (left !== right) {
      differences = true;
      if (!quiet) {
        if (verbose) {
          streams.stdout(printBytes
            ? `${String(at + 1).padStart(width)} ${octal(left)} ${printable(left).padEnd(4)} ${octal(right)} ${printable(right)}\n`
            : `${String(at + 1).padStart(width)} ${octal(left)} ${octal(right)}\n`);
        } else {
          const detail = printBytes ? ` is ${octal(left)} ${printable(left)} ${octal(right)} ${printable(right)}` : '';
          streams.stdout(`${names[0]} ${names[1]} differ: byte ${at + 1}, line ${line}${detail}\n`);
        }
      }
      if (!verbose) { streams.exitCode = 1; return streams.result(); }
    }
    if (left === 10) line += 1;
  }
  if (limit === null || limit > compared) {
    const shorter = first.length < second.length ? 0 : second.length < first.length ? 1 : -1;
    if (shorter >= 0) {
      if (!quiet) {
        const data = shorter === 0 ? first : second;
        if (data.length === 0) streams.diagnostic(`cmp: EOF on ${names[shorter]} which is empty`);
        else if (verbose) streams.diagnostic(`cmp: EOF on ${names[shorter]} after byte ${data.length}`);
        else {
          const endsLine = data[data.length - 1] === 10;
          streams.diagnostic(`cmp: EOF on ${names[shorter]} after byte ${data.length}, ${endsLine ? 'line' : 'in line'} ${endsLine ? line - 1 : line}`);
        }
      }
      streams.exitCode = 1;
      return streams.result();
    }
  }
  if (differences) streams.exitCode = 1;
  return streams.result();
}
