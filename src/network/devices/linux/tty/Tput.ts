import { getoptDiagnostic, shortOptions } from '../commands/Getopt';
import type { TtyCommandResult } from './Stty';
import type { WindowSize } from './TtyDevice';
import {
  TERMINFO_BOOLEAN_NAMES, TERMINFO_ENTRIES, TERMINFO_NUMBER_NAMES, TERMINFO_STRING_NAMES, type TerminfoEntry,
} from './TerminfoDatabase';

const USAGE = `Usage: tput [options] [command]

Options:
  -S <<       read commands from standard input
  -T TERM     use this instead of $TERM
  -V          print curses-version
  -v          verbose, show warnings
  -x          do not try to clear scrollback

Commands:
  clear       clear the screen
  init        initialize the terminal
  reset       reinitialize the terminal
  capname     unlike clear/init/reset, print value for capability "capname"
`;

const VERSION = 'ncurses 6.3.20211021';

const NAMED_PARAMETER_LIMIT = 9;

type Parameter = number | string;

function lookupTerminal(name: string): TerminfoEntry | undefined {
  return TERMINFO_ENTRIES.find((entry) => entry.names.includes(name));
}

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  E: '\x1b', e: '\x1b', n: '\n', l: '\n', r: '\r', t: '\t', b: '\b', f: '\f', s: ' ', '0': '\x00',
};

export function decodeTerminfoString(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      const n = text[i + 1];
      const octal = /^[0-7]{3}/.exec(text.slice(i + 1));
      if (octal !== null) { out += String.fromCharCode(parseInt(octal[0], 8)); i += 3; continue; }
      out += NAMED_ESCAPES[n] ?? n;
      i++;
    } else if (c === '^' && i + 1 < text.length) {
      const n = text[i + 1];
      out += n === '?' ? '\x7f' : String.fromCharCode(n.charCodeAt(0) & 31);
      i++;
    } else out += c;
  }
  return out;
}

function skipConditional(source: string, from: number, stopAtElse: boolean): number {
  let depth = 0;
  for (let i = from; i < source.length - 1; i++) {
    if (source[i] !== '%') continue;
    const n = source[i + 1];
    if (n === '?') depth++;
    else if (n === ';') { if (depth === 0) return i + 2; depth--; }
    else if (n === 'e' && depth === 0 && stopAtElse) return i + 2;
    i++;
  }
  return source.length;
}

export function expandParameters(source: string, given: readonly Parameter[]): string {
  const params: Parameter[] = Array.from({ length: NAMED_PARAMETER_LIMIT }, (_, index) => given[index] ?? 0);
  const variables = new Map<string, Parameter>();
  const stack: Parameter[] = [];
  const pop = (): Parameter => stack.pop() ?? 0;
  const popNumber = (): number => { const v = pop(); return typeof v === 'number' ? v : Number.parseInt(v, 10) || 0; };
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c !== '%') { out += c; continue; }
    i++;
    const code = source[i];
    switch (code) {
      case '%': out += '%'; break;
      case 'i': if (typeof params[0] === 'number') params[0]++; if (typeof params[1] === 'number') params[1]++; break;
      case 'p': stack.push(params[Number(source[++i]) - 1] ?? 0); break;
      case 'P': variables.set(source[++i], pop()); break;
      case 'g': stack.push(variables.get(source[++i]) ?? 0); break;
      case "'": stack.push(source.charCodeAt(i + 1)); i += 2; break;
      case '{': { const end = source.indexOf('}', i); stack.push(Number.parseInt(source.slice(i + 1, end), 10)); i = end; break; }
      case 'l': stack.push(String(pop()).length); break;
      case '+': { const b = popNumber(); stack.push(popNumber() + b); break; }
      case '-': { const b = popNumber(); stack.push(popNumber() - b); break; }
      case '*': { const b = popNumber(); stack.push(popNumber() * b); break; }
      case '/': { const b = popNumber(); const a = popNumber(); stack.push(b === 0 ? 0 : Math.trunc(a / b)); break; }
      case 'm': { const b = popNumber(); const a = popNumber(); stack.push(b === 0 ? 0 : a % b); break; }
      case '&': { const b = popNumber(); stack.push(popNumber() & b); break; }
      case '|': { const b = popNumber(); stack.push(popNumber() | b); break; }
      case '^': { const b = popNumber(); stack.push(popNumber() ^ b); break; }
      case '=': { const b = popNumber(); stack.push(popNumber() === b ? 1 : 0); break; }
      case '>': { const b = popNumber(); stack.push(popNumber() > b ? 1 : 0); break; }
      case '<': { const b = popNumber(); stack.push(popNumber() < b ? 1 : 0); break; }
      case 'A': { const b = popNumber(); stack.push(popNumber() !== 0 && b !== 0 ? 1 : 0); break; }
      case 'O': { const b = popNumber(); stack.push(popNumber() !== 0 || b !== 0 ? 1 : 0); break; }
      case '!': stack.push(popNumber() === 0 ? 1 : 0); break;
      case '~': stack.push(~popNumber()); break;
      case '?': break;
      case ';': break;
      case 't': if (popNumber() === 0) i = skipConditional(source, i + 1, true) - 1; break;
      case 'e': i = skipConditional(source, i + 1, false) - 1; break;
      case 'c': out += String.fromCharCode(popNumber()); break;
      case 's': out += String(pop()); break;
      default: {
        const spec = /^[-+# :]*[0-9]*(?:\.[0-9]+)?[doxXs]/.exec(source.slice(i));
        if (spec === null) { out += `%${code ?? ''}`; break; }
        const text = spec[0];
        const kind = text[text.length - 1];
        const flags = text.slice(0, -1).replace(':', '');
        const left = flags.includes('-');
        const zero = /^[-+# ]*0/.test(flags);
        const width = Number(/([0-9]+)(?:\.|$)/.exec(flags.replace(/^[-+# ]*/, ''))?.[1] ?? 0);
        const precision = Number(/\.([0-9]+)/.exec(flags)?.[1] ?? 0);
        const value = popNumber();
        let digits = kind === 'd' ? String(Math.abs(value)) : kind === 'o' ? Math.abs(value).toString(8) : kind === 'x' ? Math.abs(value).toString(16) : kind === 'X' ? Math.abs(value).toString(16).toUpperCase() : String(value);
        digits = digits.padStart(precision, '0');
        const sign = kind === 'd' && value < 0 ? '-' : kind === 'd' && flags.includes('+') ? '+' : '';
        const pad = Math.max(0, width - digits.length - sign.length);
        digits = left ? `${sign}${digits}${' '.repeat(pad)}` : zero ? `${sign}${'0'.repeat(pad)}${digits}` : `${' '.repeat(pad)}${sign}${digits}`;
        out += digits;
        i += text.length - 1;
      }
    }
  }
  return out;
}

function withoutPadding(text: string): string {
  return text.replace(/\$<[0-9]+(?:\.[0-9])?[*/]*>/g, '');
}

const STRING_PARAMETER_CAPABILITIES = new Set(['pfkey', 'pfloc', 'pfx', 'pfxl']);

interface Context {
  readonly entry: TerminfoEntry;
  readonly size: WindowSize;
  readonly clearScrollback: boolean;
  readonly explicitTerminal: boolean;
}

interface Outcome { stdout: string; stderr: string; exitCode: number; consumed: number }

function capability(context: Context, name: string, rest: readonly string[]): Outcome {
  const { entry } = context;
  if (name === 'longname') return { stdout: entry.description, stderr: '', exitCode: 0, consumed: 0 };
  if ((name === 'cols' || name === 'lines') && !context.explicitTerminal) {
    const value = name === 'cols' ? context.size.cols : context.size.rows;
    return { stdout: `${value}\n`, stderr: '', exitCode: 0, consumed: 0 };
  }
  if (TERMINFO_BOOLEAN_NAMES.includes(name)) {
    return { stdout: '', stderr: '', exitCode: entry.booleans.includes(name) ? 0 : 1, consumed: 0 };
  }
  if (TERMINFO_NUMBER_NAMES.includes(name)) {
    return { stdout: `${entry.numbers[name] ?? -1}\n`, stderr: '', exitCode: 0, consumed: 0 };
  }
  if (TERMINFO_STRING_NAMES.includes(name)) {
    const raw = entry.strings[name];
    if (raw === undefined) return { stdout: '', stderr: '', exitCode: 1, consumed: 0 };
    const decoded = decodeTerminfoString(raw);
    if (rest.length === 0) return { stdout: withoutPadding(decoded), stderr: '', exitCode: 0, consumed: 0 };
    const params: Parameter[] = [];
    if (STRING_PARAMETER_CAPABILITIES.has(name)) params.push(...rest.slice(0, NAMED_PARAMETER_LIMIT));
    else {
      for (const word of rest) {
        if (params.length === NAMED_PARAMETER_LIMIT || !/^-?\d+$/.test(word)) break;
        params.push(Number(word));
      }
    }
    if (params.some((value) => typeof value === 'number' && value < 0)) return { stdout: '', stderr: '', exitCode: 0, consumed: params.length };
    return { stdout: withoutPadding(expandParameters(decoded, params)), stderr: '', exitCode: 0, consumed: params.length };
  }
  return { stdout: '', stderr: `tput: unknown terminfo capability '${name}'\n`, exitCode: 4, consumed: 0 };
}

function named(entry: TerminfoEntry, name: string): string {
  const raw = entry.strings[name];
  return raw === undefined ? '' : withoutPadding(decodeTerminfoString(raw));
}

function command(context: Context, name: string, rest: readonly string[]): Outcome {
  const { entry } = context;
  if (name === 'clear') {
    const base = named(entry, 'clear');
    const scrollback = context.clearScrollback ? named(entry, 'E3') : '';
    return { stdout: `${base}${scrollback}`, stderr: '', exitCode: base === '' ? 1 : 0, consumed: 0 };
  }
  if (name === 'init') return { stdout: `${named(entry, 'is1')}${named(entry, 'is2')}${named(entry, 'is3')}`, stderr: '', exitCode: 0, consumed: 0 };
  if (name === 'reset') return { stdout: `${named(entry, 'rs1')}${named(entry, 'rs2')}${named(entry, 'rs3')}`, stderr: '', exitCode: 0, consumed: 0 };
  return capability(context, name, rest);
}

export function runTput(args: readonly string[], size: WindowSize, terminal: string | undefined, stdin: string | undefined): TtyCommandResult {
  let selected = terminal;
  let explicitTerminal = false;
  let clearScrollback = true;
  let fromInput = false;
  const words: string[] = [];
  for (const item of shortOptions(args, '+T:VSvx', [])) {
    if (item.kind === 'operand') { words.push(item.value); continue; }
    if (item.kind !== 'option') {
      return { stdout: '', stderr: `${getoptDiagnostic('tput', item)}\n${USAGE}`, exitCode: 2 };
    }
    if (item.letter === 'T') { selected = item.argument; explicitTerminal = true; }
    else if (item.letter === 'V') return { stdout: `${VERSION}\n`, stderr: '', exitCode: 0 };
    else if (item.letter === 'S') fromInput = true;
    else if (item.letter === 'x') clearScrollback = false;
  }
  if (!fromInput && words.length === 0) return { stdout: '', stderr: USAGE, exitCode: 2 };
  if (selected === undefined || selected === '') return { stdout: '', stderr: 'tput: No value for $TERM and no -T specified\n', exitCode: 2 };
  const entry = lookupTerminal(selected);
  if (entry === undefined) return { stdout: '', stderr: `tput: unknown terminal "${selected}"\n`, exitCode: 3 };
  const context: Context = { entry, size, clearScrollback, explicitTerminal };
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  const batches: string[][] = fromInput
    ? (stdin ?? '').split('\n').filter((line) => line.trim() !== '').map((line) => line.trim().split(/\s+/))
    : [words];
  for (const batch of batches) {
    for (let index = 0; index < batch.length; index++) {
      const outcome = command(context, batch[index], batch.slice(index + 1));
      stdout += outcome.stdout;
      stderr += outcome.stderr;
      exitCode = outcome.exitCode;
      if (outcome.exitCode === 4) return { stdout, stderr, exitCode };
      index += outcome.consumed;
    }
  }
  return { stdout, stderr, exitCode };
}
