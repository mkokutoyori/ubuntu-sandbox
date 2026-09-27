import { getoptDiagnostic, shortOptions } from '../commands/Getopt';

const OPTSTRING = '+0a:E:e::i::I:l::L:n:oprs:txP:d:';
const DEFAULT_REPLACE = '{}';
const EXIT_NONZERO = 123;
const EXIT_255 = 124;
const EXIT_CANNOT_RUN = 126;
const EXIT_NOT_FOUND = 127;
const MAX_PROC_MAX = 2147483647;

const LONG_OPTIONS: Readonly<Record<string, { short: string; argument: 'none' | 'required' | 'optional' }>> = {
  'null': { short: '0', argument: 'none' },
  'arg-file': { short: 'a', argument: 'required' },
  'delimiter': { short: 'd', argument: 'required' },
  'eof': { short: 'e', argument: 'optional' },
  'replace': { short: 'I', argument: 'optional' },
  'max-lines': { short: 'l', argument: 'optional' },
  'max-args': { short: 'n', argument: 'required' },
  'open-tty': { short: 'o', argument: 'none' },
  'interactive': { short: 'p', argument: 'none' },
  'no-run-if-empty': { short: 'r', argument: 'none' },
  'max-chars': { short: 's', argument: 'required' },
  'verbose': { short: 't', argument: 'none' },
  'exit': { short: 'x', argument: 'none' },
  'max-procs': { short: 'P', argument: 'required' },
};

export interface XargsHost {
  run(argv: string[]): { output: string; exitCode: number };
  readFile(path: string): string | null;
}

export interface XargsResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

class XargsExit extends Error {
  constructor(readonly stderr: string[], readonly exitCode: number) {
    super(stderr.join('\n'));
  }
}

interface XargsOptions {
  delimiter: string | null;
  eofString: string | null;
  replace: string | null;
  linesPerExec: number;
  argsPerExec: number;
  runIfEmpty: boolean;
  printCommand: boolean;
  inputFile: string | null;
  command: string[];
}

const TRY_HELP = "Try 'xargs --help' for more information.";

function parseNum(text: string, option: string, min: number, max: number, fatal: boolean, warnings: string[]): number {
  if (!/^\s*[+-]?\d+$/.test(text)) {
    throw new XargsExit([`xargs: invalid number "${text}" for -${option} option`, TRY_HELP], 1);
  }
  const value = Number(text.trim());
  if (value < min) {
    if (fatal) throw new XargsExit([`xargs: value ${text} for -${option} option should be >= ${min}`, TRY_HELP], 1);
    warnings.push(`xargs: value ${text} for -${option} option should be >= ${min}`);
    return min;
  }
  if (max >= 0 && value > max) {
    if (fatal) throw new XargsExit([`xargs: value ${text} for -${option} option should be <= ${max}`, TRY_HELP], 1);
    warnings.push(`xargs: value ${text} for -${option} option should be <= ${max}`);
    return max;
  }
  return value;
}

function inputDelimiter(spec: string): string {
  if (spec.length === 1) return spec;
  const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
  if (spec.length === 2 && spec[0] === '\\' && spec[1] in escapes) return escapes[spec[1]];
  const hex = /^\\x([0-9a-fA-F]{1,2})$/.exec(spec);
  if (hex) return String.fromCharCode(parseInt(hex[1], 16));
  const octal = /^\\([0-7]{1,3})$/.exec(spec);
  if (octal) return String.fromCharCode(parseInt(octal[1], 8));
  throw new XargsExit([
    `xargs: invalid input delimiter specification ${spec}: the delimiter must be either a single character or an escape sequence starting with \\.`,
  ], 1);
}

function expandLongOptions(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--' || !token.startsWith('--')) {
      out.push(...args.slice(i));
      break;
    }
    const eq = token.indexOf('=');
    const name = token.slice(2, eq < 0 ? undefined : eq);
    const matches = Object.keys(LONG_OPTIONS).filter((k) => k.startsWith(name));
    const exact = LONG_OPTIONS[name] ? name : matches.length === 1 ? matches[0] : null;
    if (name === 'help' || name === 'version' || name === 'show-limits' || name === 'process-slot-var') {
      throw new XargsExit([`xargs: option --${name}: this simulator cannot build the findutils ${name === 'help' || name === 'version' ? 'help and version texts' : name}`], 1);
    }
    if (!exact) {
      throw new XargsExit([matches.length > 1
        ? `xargs: option '--${name}' is ambiguous`
        : `xargs: unrecognized option '${token}'`, TRY_HELP], 1);
    }
    const spec = LONG_OPTIONS[exact];
    const value = eq < 0 ? undefined : token.slice(eq + 1);
    if (spec.argument === 'none') {
      if (value !== undefined) throw new XargsExit([`xargs: option '--${exact}' doesn't allow an argument`, TRY_HELP], 1);
      out.push(`-${spec.short}`);
    } else if (spec.argument === 'optional') {
      out.push(value === undefined ? `-${spec.short}` : `-${spec.short}${value}`);
    } else if (value !== undefined) {
      out.push(`-${spec.short}`, value);
    } else if (i + 1 < args.length) {
      out.push(`-${spec.short}`, args[++i]);
    } else {
      throw new XargsExit([`xargs: option '--${exact}' requires an argument`, TRY_HELP], 1);
    }
  }
  return out;
}

function parseXargsArgs(args: readonly string[], warnings: string[]): XargsOptions {
  const opts: XargsOptions = {
    delimiter: null, eofString: null, replace: null, linesPerExec: 0, argsPerExec: 0,
    runIfEmpty: true, printCommand: false, inputFile: null, command: [],
  };
  for (const token of shortOptions(expandLongOptions(args), OPTSTRING)) {
    if (token.kind === 'operand') { opts.command.push(token.value); continue; }
    if (token.kind !== 'option') throw new XargsExit([getoptDiagnostic('xargs', token), TRY_HELP], 1);
    const arg = token.argument;
    switch (token.letter) {
      case '0': opts.delimiter = '\0'; break;
      case 'd': opts.delimiter = inputDelimiter(arg!); break;
      case 'E': case 'e': opts.eofString = arg !== undefined && arg !== '' ? arg : null; break;
      case 'I': case 'i':
        opts.replace = arg ?? DEFAULT_REPLACE;
        opts.argsPerExec = 0;
        opts.linesPerExec = 0;
        break;
      case 'L':
        opts.linesPerExec = parseNum(arg!, 'L', 1, -1, true, warnings);
        opts.argsPerExec = 0;
        opts.replace = null;
        break;
      case 'l':
        opts.linesPerExec = arg !== undefined ? parseNum(arg, 'l', 1, -1, true, warnings) : 1;
        opts.argsPerExec = 0;
        opts.replace = null;
        break;
      case 'n':
        opts.argsPerExec = parseNum(arg!, 'n', 1, -1, true, warnings);
        opts.linesPerExec = 0;
        if (opts.replace !== null) {
          if (opts.argsPerExec === 1) opts.argsPerExec = 0;
          else opts.replace = null;
        }
        break;
      case 's': parseNum(arg!, 's', 1, -1, false, warnings); break;
      case 'P': parseNum(arg!, 'P', 0, MAX_PROC_MAX, true, warnings); break;
      case 'a': opts.inputFile = arg!; break;
      case 'r': opts.runIfEmpty = false; break;
      case 't': opts.printCommand = true; break;
      case 'o': case 'x': break;
      case 'p': throw new XargsExit(['xargs: option -p: this simulator cannot build an interactive /dev/tty prompt'], 1);
      default: throw new XargsExit([TRY_HELP], 1);
    }
  }
  if (opts.eofString !== null && opts.delimiter !== null) {
    warnings.push('xargs: warning: the -E option has no effect if -0 or -d is used.\n');
  }
  if (opts.command.length === 0) opts.command = ['echo'];
  return opts;
}

interface InputItem {
  readonly value: string;
  readonly endsLine: boolean;
}

function readDelimited(input: string, delimiter: string): InputItem[] {
  const parts = input.split(delimiter);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((value) => ({ value, endsLine: true }));
}

function readLines(input: string, opts: XargsOptions): InputItem[] {
  const items: InputItem[] = [];
  const lineMode = opts.replace !== null;
  let arg = '';
  let inArg = false;
  let quote: string | null = null;
  let escaped = false;
  let lineHasArgs = false;
  const push = (endsLine: boolean): boolean => {
    if (opts.eofString !== null && arg === opts.eofString) return false;
    items.push({ value: arg, endsLine });
    arg = '';
    inArg = false;
    return true;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (escaped) { arg += c; escaped = false; inArg = true; continue; }
    if (quote !== null) {
      if (c === '\n') throw new XargsExit([unmatched(quote)], 1);
      if (c === quote) { quote = null; continue; }
      arg += c;
      continue;
    }
    if (c === '\n') {
      if (inArg || (lineMode && arg !== '')) {
        if (!push(true)) return items;
      } else if (lineHasArgs && items.length > 0) {
        items[items.length - 1] = { ...items[items.length - 1], endsLine: input[i - 1] !== ' ' && input[i - 1] !== '\t' };
      }
      lineHasArgs = false;
      continue;
    }
    if ((c === ' ' || c === '\t') && !inArg) continue;
    if ((c === ' ' || c === '\t') && !lineMode) {
      if (!push(false)) return items;
      lineHasArgs = true;
      continue;
    }
    if (c === '\\') { escaped = true; inArg = true; continue; }
    if (c === '\'' || c === '"') { quote = c; inArg = true; continue; }
    arg += c;
    inArg = true;
  }
  if (quote !== null) throw new XargsExit([unmatched(quote)], 1);
  if (inArg) push(true);
  return items;
}

function unmatched(quote: string): string {
  return `xargs: unmatched ${quote === '"' ? 'double' : 'single'} quote; by default quotes are special to xargs unless you use the -0 option`;
}

function shellQuote(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function runXargs(args: string[], stdin: string | undefined, host: XargsHost): XargsResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let childError = 0;
  try {
    const opts = parseXargsArgs(args, stderr);
    let input = stdin ?? '';
    if (opts.inputFile !== null && opts.inputFile !== '-') {
      const content = host.readFile(opts.inputFile);
      if (content === null) {
        throw new XargsExit([`xargs: Cannot open input file '${opts.inputFile}': No such file or directory`], 1);
      }
      input = content;
    }
    const items = opts.delimiter !== null ? readDelimited(input, opts.delimiter) : readLines(input, opts);

    const exec = (argv: string[]): void => {
      if (opts.printCommand) stderr.push(argv.map(shellQuote).join(' '));
      const result = host.run(argv);
      if (result.exitCode === EXIT_NOT_FOUND && /command not found/.test(result.output)) {
        throw new XargsExit([`xargs: ${argv[0]}: No such file or directory`], EXIT_NOT_FOUND);
      }
      if (result.output !== '') stdout.push(result.output);
      if (result.exitCode === EXIT_CANNOT_RUN) {
        throw new XargsExit([`xargs: ${argv[0]}: Permission denied`], EXIT_CANNOT_RUN);
      }
      if (result.exitCode === 255) {
        throw new XargsExit([`xargs: ${argv[0]}: exited with status 255; aborting`], EXIT_255);
      }
      if (result.exitCode !== 0) childError = EXIT_NONZERO;
    };

    if (opts.replace !== null) {
      const [cmd, ...initial] = opts.command;
      for (const item of items) exec([cmd, ...initial.map((a) => a.split(opts.replace!).join(item.value))]);
    } else {
      let pending: string[] = [];
      let lines = 0;
      let executed = 0;
      for (const item of items) {
        pending.push(item.value);
        if (item.endsLine) lines++;
        const full = (opts.argsPerExec > 0 && pending.length >= opts.argsPerExec)
          || (opts.linesPerExec > 0 && lines >= opts.linesPerExec);
        if (full) {
          exec([...opts.command, ...pending]);
          executed++;
          pending = [];
          lines = 0;
        }
      }
      if (pending.length > 0 || (opts.runIfEmpty && executed === 0)) exec([...opts.command, ...pending]);
    }
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: childError };
  } catch (e) {
    if (!(e instanceof XargsExit)) throw e;
    return { stdout: stdout.join('\n'), stderr: [...stderr, ...e.stderr].join('\n'), exitCode: e.exitCode };
  }
}
