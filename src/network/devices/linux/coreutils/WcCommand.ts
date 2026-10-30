import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import {
  Streams, docsResult, quoteLocale, quoteShell, quotef, usageFailure, utf8Bytes,
  type CoreutilsIO, type CoreutilsRun,
} from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'bytes', letter: 'c', takesArgument: false },
  { name: 'chars', letter: 'm', takesArgument: false },
  { name: 'files0-from', letter: 'F', takesArgument: true },
  { name: 'lines', letter: 'l', takesArgument: false },
  { name: 'max-line-length', letter: 'L', takesArgument: false },
  { name: 'total', letter: 'T', takesArgument: true },
  { name: 'words', letter: 'w', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const TOTAL_CHOICES = ['auto', 'always', 'only', 'never'] as const;

interface Counts {
  lines: number;
  words: number;
  chars: number;
  bytes: number;
  maxLine: number;
}

const SPACE = new RegExp('[\\t\\n\\v\\f\\r \\u1680\\u2000-\\u2006\\u2008-\\u200a\\u2028\\u2029\\u205f\\u3000]');

function displayWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  if ((code >= 0x300 && code <= 0x36f) || code === 0x200b) return 0;
  return 1;
}

export function countText(text: string): Counts {
  let lines = 0;
  let words = 0;
  let chars = 0;
  let inWord = false;
  let maxLine = 0;
  let width = 0;
  for (const character of text) {
    chars++;
    if (character === '\n') {
      lines++;
      maxLine = Math.max(maxLine, width);
      width = 0;
    } else if (character === '\t') {
      width += 8 - (width % 8);
    } else if (character === '\r' || character === '\f') {
      maxLine = Math.max(maxLine, width);
      width = 0;
    } else {
      width += displayWidth(character);
    }
    if (SPACE.test(character)) inWord = false;
    else if (!inWord) { inWord = true; words++; }
  }
  maxLine = Math.max(maxLine, width);
  return { lines, words, chars, bytes: utf8Bytes(text), maxLine };
}

export function runWc(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const want = { lines: false, words: false, chars: false, bytes: false, maxLine: false };
  let total: (typeof TOTAL_CHOICES)[number] = 'auto';
  let filesFrom: string | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'clLmw', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('wc', getoptDiagnostic('wc', item));
    switch (item.letter) {
      case 'H': return docsResult('wc', 'help');
      case 'V': return docsResult('wc', 'version');
      case 'c': want.bytes = true; break;
      case 'm': want.chars = true; break;
      case 'l': want.lines = true; break;
      case 'w': want.words = true; break;
      case 'L': want.maxLine = true; break;
      case 'F': filesFrom = item.argument ?? ''; break;
      case 'T': {
        const given = item.argument ?? '';
        const matches = TOTAL_CHOICES.filter((choice) => choice.startsWith(given));
        if (given === '' || matches.length !== 1) {
          const failure = new Streams();
          failure.diagnostic(`wc: invalid argument ${quoteLocale(given)} for ${quoteLocale('--total')}`);
          failure.diagnostic('Valid arguments are:');
          for (const choice of TOTAL_CHOICES) failure.diagnostic(`  - ${quoteLocale(choice)}`);
          failure.diagnostic("Try 'wc --help' for more information.");
          failure.exitCode = 1;
          return failure.result();
        }
        total = matches[0];
        break;
      }
      default: break;
    }
  }
  if (!want.lines && !want.words && !want.chars && !want.bytes && !want.maxLine) {
    want.lines = true; want.words = true; want.bytes = true;
  }

  const streams = new Streams();
  let names: string[] = operands;
  if (filesFrom !== null) {
    if (operands.length > 0) {
      streams.diagnostic(`wc: extra operand ${quoteLocale(operands[0])}`);
      streams.diagnostic('file operands cannot be combined with --files0-from');
      streams.diagnostic("Try 'wc --help' for more information.");
      streams.exitCode = 1;
      return streams.result();
    }
    const source = filesFrom === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : io.read(filesFrom);
    if (source.kind !== 'ok') {
      streams.diagnostic(`wc: cannot open ${quoteShell(filesFrom)} for reading: ${source.kind === 'denied' ? 'Permission denied' : 'No such file or directory'}`);
      streams.exitCode = 1;
      return streams.result();
    }
    const pieces = source.text.split('\0');
    if (pieces[pieces.length - 1] === '') pieces.pop();
    names = pieces;
  } else if (operands.length === 0) {
    names = ['-'];
  }

  const rows: Array<{ counts: Counts; label: string | null }> = [];
  const sums: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, maxLine: 0 };
  let regularBytes = 0;
  let usesStdin = false;
  const results: Array<{ name: string; counts: Counts | null; failure: string | null; directory: boolean }> = [];
  names.forEach((name, index) => {
    if (filesFrom !== null && name === '') {
      streams.diagnostic(`wc: ${filesFrom === '-' ? '-' : quoteShell(filesFrom)}:${index + 1}: invalid zero-length file name`);
      streams.exitCode = 1;
      return;
    }
    if (name === '-') {
      usesStdin = true;
      results.push({ name, counts: countText(io.stdin ?? ''), failure: null, directory: false });
      return;
    }
    const read = io.read(name);
    if (read.kind === 'ok') {
      const counts = countText(read.text);
      regularBytes += counts.bytes;
      results.push({ name, counts, failure: null, directory: false });
    } else if (read.kind === 'directory') {
      results.push({ name, counts: { lines: 0, words: 0, chars: 0, bytes: 0, maxLine: 0 }, failure: `wc: ${quotef(name)}: Is a directory`, directory: true });
    } else {
      results.push({ name, counts: null, failure: `wc: ${quotef(name)}: ${read.kind === 'denied' ? 'Permission denied' : 'No such file or directory'}`, directory: false });
    }
  });

  const columns = (['lines', 'words', 'chars', 'bytes', 'maxLine'] as const).filter((key) => want[key]);
  let width = 1;
  if (usesStdin || filesFrom !== null || results.some((r) => r.directory)) width = 7;
  else for (let rest = regularBytes; rest >= 10; rest = Math.floor(rest / 10)) width++;
  if (columns.length === 1 && names.length <= 1 && total !== 'always') width = 1;
  const line = (counts: Counts, label: string | null): string => {
    const cells = columns.map((key) => String(counts[key]).padStart(width));
    return `${cells.join(' ')}${label === null ? '' : ` ${label}`}\n`;
  };

  for (const result of results) {
    if (result.failure !== null) {
      streams.diagnostic(result.failure);
      streams.exitCode = 1;
    }
    if (result.counts === null) continue;
    for (const key of ['lines', 'words', 'chars', 'bytes'] as const) sums[key] += result.counts[key];
    sums.maxLine = Math.max(sums.maxLine, result.counts.maxLine);
    rows.push({ counts: result.counts, label: result.name === '-' && operands.length === 0 && filesFrom === null ? null : result.name });
  }
  if (total !== 'only') for (const row of rows) streams.stdout(line(row.counts, row.label));
  const showTotal = total === 'always' || total === 'only' || (total === 'auto' && names.length > 1);
  if (showTotal) streams.stdout(line(sums, total === 'only' ? null : 'total'));
  return streams.result();
}
