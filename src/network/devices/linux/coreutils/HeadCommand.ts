import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import {
  Streams, docsResult, parseSizeWithSuffix, quoteLocale, quoteShell, takeBytes, usageFailure, utf8Bytes,
  type CoreutilsIO, type CoreutilsRun,
} from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'bytes', letter: 'c', takesArgument: true },
  { name: 'lines', letter: 'n', takesArgument: true },
  { name: 'quiet', letter: 'q', takesArgument: false },
  { name: 'silent', letter: 'q', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

interface HeadOptions {
  unit: 'lines' | 'bytes';
  count: number;
  allButLast: boolean;
  quiet: boolean;
  verbose: boolean;
  delimiter: string;
}

function obsoleteCount(args: readonly string[]): { rest: string[]; apply: (options: HeadOptions) => void } | null {
  const match = /^-(\d+)([bkm]?)([cqv]*)$/.exec(args[0] ?? '');
  if (match === null) return null;
  const factor = match[2] === 'b' ? 512 : match[2] === 'k' ? 1024 : match[2] === 'm' ? 1024 ** 2 : 1;
  return {
    rest: args.slice(1),
    apply: (options) => {
      options.count = Number(match[1]) * factor;
      options.allButLast = false;
      options.unit = match[3].includes('c') ? 'bytes' : 'lines';
      if (match[3].includes('q')) { options.quiet = true; options.verbose = false; }
      if (match[3].includes('v')) { options.verbose = true; options.quiet = false; }
    },
  };
}

function headText(text: string, options: HeadOptions): string {
  if (options.unit === 'bytes') {
    if (!options.allButLast) return takeBytes(text, options.count);
    const total = utf8Bytes(text);
    return takeBytes(text, Math.max(0, total - options.count));
  }
  const lines: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(options.delimiter, from);
    if (at < 0) { if (from < text.length) lines.push(text.slice(from)); break; }
    lines.push(text.slice(from, at + 1));
    from = at + 1;
  }
  const keep = options.allButLast ? Math.max(0, lines.length - options.count) : Math.min(lines.length, options.count);
  return lines.slice(0, keep).join('');
}

export function runHead(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const options: HeadOptions = { unit: 'lines', count: 10, allButLast: false, quiet: false, verbose: false, delimiter: '\n' };
  const obsolete = obsoleteCount(args);
  if (obsolete !== null) obsolete.apply(options);
  const operands: string[] = [];
  for (const item of shortOptions(obsolete?.rest ?? args, 'c:n:qvz', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('head', getoptDiagnostic('head', item));
    switch (item.letter) {
      case 'H': return docsResult('head', 'help');
      case 'V': return docsResult('head', 'version');
      case 'q': options.quiet = true; options.verbose = false; break;
      case 'v': options.verbose = true; options.quiet = false; break;
      case 'z': options.delimiter = '\0'; break;
      case 'c': case 'n': {
        const raw = item.argument ?? '';
        const negative = raw.startsWith('-');
        const parsed = parseSizeWithSuffix(raw.replace(/^[-+]/, ''));
        if (parsed === null) {
          const failure = new Streams();
          failure.diagnostic(`head: invalid number of ${item.letter === 'c' ? 'bytes' : 'lines'}: ${quoteLocale(raw)}`);
          failure.exitCode = 1;
          return failure.result();
        }
        options.unit = item.letter === 'c' ? 'bytes' : 'lines';
        options.count = parsed;
        options.allButLast = negative;
        break;
      }
      default: break;
    }
  }

  const streams = new Streams();
  const names = operands.length === 0 ? ['-'] : operands;
  const showHeaders = options.verbose || (!options.quiet && names.length > 1);
  let first = true;
  for (const name of names) {
    const label = name === '-' ? 'standard input' : name;
    const quick = name !== '-' && options.unit === 'bytes' && !options.allButLast ? io.readBytes?.(name, options.count) ?? null : null;
    const read = name === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : quick !== null ? { kind: 'ok' as const, text: quick } : io.read(name);
    if (read.kind === 'missing' || read.kind === 'denied') {
      streams.diagnostic(`head: cannot open ${quoteShell(name)} for reading: ${read.kind === 'missing' ? 'No such file or directory' : 'Permission denied'}`);
      streams.exitCode = 1;
      continue;
    }
    if (showHeaders) {
      streams.stdout(`${first ? '' : '\n'}==> ${label} <==\n`);
    }
    first = false;
    if (read.kind === 'directory') {
      streams.diagnostic(`head: error reading ${quoteShell(name)}: Is a directory`);
      streams.exitCode = 1;
      continue;
    }
    streams.stdout(headText(read.text, options));
  }
  return streams.result();
}
