import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { COREUTILS_DOCS } from './CoreutilsDocs';
import { InputQueue, Streams, docsResult, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'print-file-name', letter: 'f', takesArgument: false },
  { name: 'bytes', letter: 'n', takesArgument: true },
  { name: 'radix', letter: 't', takesArgument: true },
  { name: 'include-all-whitespace', letter: 'w', takesArgument: false },
  { name: 'encoding', letter: 'e', takesArgument: true },
  { name: 'output-separator', letter: 's', takesArgument: true },
  { name: 'target', letter: 'T', takesArgument: true },
  { name: 'data', letter: 'd', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const WHITESPACE = new Set([9, 10, 11, 12, 13, 32]);

function usageResult(message: string | null): CoreutilsRun {
  const streams = new Streams();
  if (message !== null) streams.diagnostic(message);
  streams.diagnostic(COREUTILS_DOCS.strings.help.replace(/\nReport bugs to .*$/s, ''));
  streams.exitCode = 1;
  return streams.result();
}

export function runStrings(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let minimum = 4;
  let numericMinimum: number | null = null;
  let radix: 'o' | 'd' | 'x' | null = null;
  let printNames = false;
  let includeWhitespace = false;
  let encoding = 's';
  let separator = '\n';
  let digits = '';
  let previousDigit = false;
  const operands: string[] = [];
  const expanded: string[] = [];
  for (const arg of args) expanded.push(/^-\d+$/.test(arg) ? `-${arg.slice(1)}` : arg);
  for (const item of shortOptions(expanded, 'adfhVn:t:ows:e:T:0123456789', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') {
      const text = getoptDiagnostic('strings', item).replace(/\nTry .*$/s, '');
      return usageResult(text);
    }
    switch (item.letter) {
      case 'h': return docsResult('strings', 'help');
      case 'V': return docsResult('strings', 'version');
      case 'f': printNames = true; break;
      case 'w': includeWhitespace = true; break;
      case 'o': radix = 'o'; break;
      case 't':
        if (item.argument !== 'o' && item.argument !== 'd' && item.argument !== 'x') return usageResult(null);
        radix = item.argument;
        break;
      case 'e':
        if (!['s', 'S', 'b', 'l', 'B', 'L'].includes(item.argument ?? '')) return usageResult(null);
        encoding = item.argument as string;
        break;
      case 's': separator = item.argument ?? '\n'; break;
      case 'n': {
        const text = item.argument ?? '';
        if (!/^\d+$/.test(text)) {
          const streams = new Streams();
          streams.diagnostic(`strings: invalid integer argument ${text}`);
          streams.exitCode = 1;
          return streams.result();
        }
        if (Number(text) < 1) {
          const streams = new Streams();
          streams.diagnostic(`strings: minimum string length is too small: ${text}`);
          streams.exitCode = 1;
          return streams.result();
        }
        minimum = Number(text);
        break;
      }
      default:
        if (/^\d$/.test(item.letter)) {
          digits = previousDigit ? digits + item.letter : item.letter;
          numericMinimum = Number(digits);
        }
    }
    previousDigit = /^\d$/.test(item.kind === 'option' ? item.letter : '');
  }
  if (numericMinimum !== null && numericMinimum >= 1) minimum = numericMinimum;
  if (operands.includes('-')) return usageResult(null);
  const streams = new Streams();
  const queue = new InputQueue(io);
  const width = encoding === 'b' || encoding === 'l' ? 2 : encoding === 'B' || encoding === 'L' ? 4 : 1;
  const bigEndian = encoding === 'b' || encoding === 'B';
  const printable = (code: number): boolean => {
    if (code === 9 || (code >= 32 && code < 127)) return true;
    if (includeWhitespace && WHITESPACE.has(code)) return true;
    return encoding === 'S' && code > 127;
  };
  for (const name of operands.length === 0 ? ['-'] : operands) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`strings: '${name}': No such file`);
      streams.exitCode = 1;
      continue;
    }
    const bytes = fileTextToBytes(read.text);
    let current: number[] = [];
    let start = 0;
    const flush = (): void => {
      if (current.length >= minimum) {
        const offset = radix === null ? '' : `${(radix === 'o' ? start.toString(8) : radix === 'd' ? String(start) : start.toString(16)).padStart(7)} `;
        streams.stdout(`${printNames ? `${name === '-' ? '{standard input}' : name}: ` : ''}${offset}${bytesToFileText(Uint8Array.from(current))}${separator}`);
      }
      current = [];
    };
    for (let at = 0; at + width <= bytes.length;) {
      let code = 0;
      for (let part = 0; part < width; part++) {
        const byte = bytes[at + (bigEndian ? part : width - 1 - part)];
        code = code * 256 + byte;
      }
      const wide = width > 1 && code > 255;
      if (!wide && printable(code)) {
        if (current.length === 0) start = at;
        current.push(code);
        at += width;
      } else {
        flush();
        at += 1;
      }
    }
    flush();
  }
  return streams.result();
}
