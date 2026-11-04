import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { signalNumber } from '../commands/system/fuser/FuserSignals';
import { Streams, docsResult, quoteLocale, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'ignore-environment', letter: 'i', takesArgument: false },
  { name: 'null', letter: '0', takesArgument: false },
  { name: 'unset', letter: 'u', takesArgument: true },
  { name: 'chdir', letter: 'C', takesArgument: true },
  { name: 'default-signal', letter: 'D', takesArgument: false, optionalArgument: true },
  { name: 'ignore-signal', letter: 'I', takesArgument: false, optionalArgument: true },
  { name: 'block-signal', letter: 'B', takesArgument: false, optionalArgument: true },
  { name: 'list-signal-handling', letter: 'L', takesArgument: false },
  { name: 'debug', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export type EnvPlan =
  | { readonly kind: 'docs'; readonly which: 'help' | 'version' }
  | { readonly kind: 'failure'; readonly lines: readonly string[]; readonly exitCode: number }
  | { readonly kind: 'print'; readonly text: string; readonly debug: readonly string[] }
  | { readonly kind: 'run'; readonly env: Record<string, string>; readonly command: readonly string[]; readonly directory: string | null; readonly debug: readonly string[] };

const TRY = "Try 'env --help' for more information.";
const failure = (...lines: string[]): EnvPlan => ({ kind: 'failure', lines, exitCode: 125 });

function splitString(text: string, environment: Record<string, string>): string[] | string {
  const pieces: string[] = [];
  let current = '';
  let started = false;
  let at = 0;
  let quote: '"' | "'" | null = null;
  const flush = (): void => { if (started) pieces.push(current); current = ''; started = false; };
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07', '\\': '\\', '"': '"', "'": "'", '$': '$' };
  while (at < text.length) {
    const character = text[at];
    if (quote === "'") {
      if (character === "'") { quote = null; at++; continue; }
      if (character === '\\' && (text[at + 1] === '\\' || text[at + 1] === "'")) { current += text[at + 1]; at += 2; continue; }
      current += character; at++; continue;
    }
    if (character === '\\') {
      const next = text[at + 1];
      if (next === undefined) return 'invalid backslash at end of string in -S';
      if (next === 'c') { if (quote === '"') return "'\\c' must not appear in double-quoted -S string"; flush(); return pieces; }
      if (next === '_') { if (quote === '"') { current += ' '; started = true; } else flush(); at += 2; continue; }
      if (next === '#' ) { current += '#'; started = true; at += 2; continue; }
      if (next in escapes) { current += escapes[next]; started = true; at += 2; continue; }
      return `invalid sequence '\\${next}' in -S`;
    }
    if (character === '#' && quote === null && !started) break;
    if (character === '"') { quote = quote === '"' ? null : '"'; started = true; at++; continue; }
    if (character === "'" && quote === null) { quote = "'"; started = true; at++; continue; }
    if (character === '$') {
      if (text[at + 1] !== '{') return "only ${VARNAME} expansion is supported, error at: " + text.slice(at);
      const close = text.indexOf('}', at);
      if (close === -1) return "variable name expansion is missing '}' in -S";
      const name = text.slice(at + 2, close);
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) return `only \${VARNAME} expansion is supported, error at: ${text.slice(at)}`;
      current += environment[name] ?? '';
      started = started || (environment[name] ?? '') !== '';
      at = close + 1;
      continue;
    }
    if (quote === null && /\s/.test(character)) { flush(); at++; continue; }
    current += character; started = true; at++;
  }
  if (quote !== null) return `no terminating quote in -S string`;
  flush();
  return pieces;
}

interface Expansion { readonly args: string[]; readonly splits: { readonly input: string; readonly pieces: string[] }[] }

function expandSplits(args: readonly string[], environment: Record<string, string>): Expansion | string {
  const out: string[] = [];
  const splits: Expansion['splits'][number][] = [];
  let at = 0;
  for (; at < args.length; at++) {
    const token = args[at];
    if (token === '--') { out.push(...args.slice(at)); return { args: out, splits }; }
    if (token === '-' || !token.startsWith('-')) {
      if (token.includes('=')) { out.push(token); continue; }
      break;
    }
    let given: string | undefined;
    const cluster = /^-([iv0]*)S(.*)$/.exec(token);
    if (cluster !== null && !token.startsWith('--')) {
      if (cluster[1] !== '') out.push(`-${cluster[1]}`);
      given = cluster[2] !== '' ? cluster[2] : args[++at];
      if (given === undefined) { out.push('-S'); continue; }
    } else if (token.startsWith('--split-string=')) given = token.slice('--split-string='.length);
    else if (token === '--split-string') given = args[++at];
    if (given === undefined) { out.push(token); continue; }
    const pieces = splitString(given, environment);
    if (typeof pieces === 'string') return pieces;
    splits.push({ input: given, pieces });
    out.push(...pieces);
  }
  out.push(...args.slice(at));
  return { args: out, splits };
}

export function planEnv(args: readonly string[], inherited: Record<string, string>): EnvPlan {
  const expanded = expandSplits(args, inherited);
  if (typeof expanded === 'string') return failure(`env: ${expanded}`);
  let ignoreEnvironment = false;
  let nullTerminated = false;
  let verbose = false;
  let directory: string | null = null;
  const unset: string[] = [];
  const operands: string[] = [];
  let seenOperand = false;
  for (const item of shortOptions(expanded.args, '+C:iS:u:v0', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); seenOperand = true; continue; }
    if (seenOperand) continue;
    if (item.kind !== 'option') return failure(getoptDiagnostic('env', item), TRY);
    switch (item.letter) {
      case 'H': return { kind: 'docs', which: 'help' };
      case 'V': return { kind: 'docs', which: 'version' };
      case 'i': ignoreEnvironment = true; break;
      case '0': nullTerminated = true; break;
      case 'v': verbose = true; break;
      case 'u': unset.push(item.argument ?? ''); break;
      case 'C': directory = item.argument ?? ''; break;
      case 'D': case 'I': case 'B':
        for (const entry of (item.argument ?? '').split(',')) {
          if (entry === '') continue;
          const number = signalNumber(entry.toUpperCase());
          if (number === null || number <= 0 || number > 64) return failure(`env: ${quoteLocale(entry)}: invalid signal`, TRY);
        }
        break;
      default: break;
    }
  }
  const debug: string[] = [];
  const note = (line: string): void => { if (verbose) debug.push(line); };
  for (const split of expanded.splits) {
    note(`split -S:  ${quoteLocale(split.input)}`);
    split.pieces.forEach((piece, index) => note(`${index === 0 ? ' into:   ' : '     &   '} ${quoteLocale(piece)}`));
  }
  let rest = operands;
  if (rest[0] === '-') { ignoreEnvironment = true; rest = rest.slice(1); }
  let environment: Record<string, string>;
  if (ignoreEnvironment) {
    note('cleaning environ');
    environment = {};
  } else {
    environment = { ...inherited };
    for (const name of unset) {
      if (name === '' || name.includes('=')) return failure(`env: cannot unset ${quoteLocale(name)}: Invalid argument`);
      note(`unset:    ${name}`);
      delete environment[name];
    }
  }
  let at = 0;
  while (at < rest.length && rest[at].includes('=')) {
    const text = rest[at];
    note(`setenv:   ${text}`);
    environment[text.slice(0, text.indexOf('='))] = text.slice(text.indexOf('=') + 1);
    at++;
  }
  const command = rest.slice(at);
  if (nullTerminated && command.length > 0) return failure('env: cannot specify --null (-0) with command', TRY);
  if (directory !== null && command.length === 0) return failure('env: must specify command with --chdir (-C)', TRY);
  if (command.length === 0) {
    const separator = nullTerminated ? '\0' : '\n';
    return { kind: 'print', text: Object.entries(environment).map(([name, value]) => `${name}=${value}${separator}`).join(''), debug };
  }
  if (directory !== null) note(`chdir:    ${quoteLocale(directory)}`);
  note(`executing: ${command[0]}`);
  command.forEach((word, index) => note(`   arg[${index}]= ${quoteLocale(word)}`));
  return { kind: 'run', env: environment, command, directory, debug };
}

const PRINTENV_OPTIONS: readonly LongOption[] = [
  { name: 'null', letter: '0', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export function runPrintenv(args: readonly string[], environment: Record<string, string>): CoreutilsRun {
  const streams = new Streams();
  let terminator = '\n';
  const names: string[] = [];
  for (const item of shortOptions(args, '0', PRINTENV_OPTIONS)) {
    if (item.kind === 'operand') { names.push(item.value); continue; }
    if (item.kind !== 'option') {
      streams.diagnostic(getoptDiagnostic('printenv', item));
      streams.diagnostic(TRY.replace('env', 'printenv'));
      streams.exitCode = 2;
      return streams.result();
    }
    if (item.letter === 'H') return docsResult('printenv', 'help');
    if (item.letter === 'V') return docsResult('printenv', 'version');
    terminator = '\0';
  }
  if (names.length === 0) {
    for (const [name, value] of Object.entries(environment)) streams.stdout(`${name}=${value}${terminator}`);
    return streams.result();
  }
  for (const name of names) {
    const value = name.includes('=') ? undefined : environment[name];
    if (value === undefined) streams.exitCode = 1;
    else streams.stdout(`${value}${terminator}`);
  }
  return streams.result();
}
