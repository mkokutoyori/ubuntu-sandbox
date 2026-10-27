/**
 * Builtins — Built-in shell commands for the bash interpreter.
 *
 * Implements: echo, printf, cd, pwd, export, unset, set, local, read,
 * true, false, exit, return, break, continue, shift, type, source/.,
 * declare, readonly, let.
 *
 * NOTE: test/[ are NOT builtins here — they are delegated to the external
 * command executor (LinuxCommandExecutor) which has VFS access for -f, -d, etc.
 */

import type { Command } from '@/bash/parser/ASTNode';
import { Environment } from './Environment';
import { isShellOptionEnabled } from './ShellOptions';
import {
  ExitSignal, ReturnSignal, BreakSignal, ContinueSignal,
} from '@/bash/errors/BashError';
import { evaluateArithmetic } from './Expansion';
import type { AliasTable } from './AliasTable';
import type { StdinReader } from './StdinSource';
import { decodeBackslashEscapes } from './EscapeSequences';
import { formatPrintf } from './Printf';
import { runDeclaration } from './Declare';
import { runSet, runShopt } from './OptionBuiltins';
import { signalListing, signalName } from './Signals';
import type { OptionResult } from './OptionBuiltins';
import type { DeclarationCommand } from './Declare';

/** Minimal IO interface for builtins that need filesystem access. */
export interface BuiltinIO {
  resolvePath(path: string, cwd?: string): string;
  wallClock?(): { nowMs(): number; format(pattern: string, epochMs: number): string };
  stat?(path: string): { type: 'file' | 'directory' } | null;
}

export interface BuiltinResult {
  output: string;
  exitCode: number;
  stderr?: string;
}

function fail(message: string, exitCode = 1): BuiltinResult {
  return { output: '', stderr: `${message}\n`, exitCode };
}

const BUILTIN_NAMES = new Set([
  'echo', 'printf', 'cd', 'pwd', 'export', 'unset', 'set',
  'local', 'read', 'true', 'false', ':',
  'exit', 'return', 'break', 'continue',
  'shift', 'source', '.', 'declare', 'typeset', 'readonly', 'let', 'shopt', 'builtin', 'hash', 'dirs', 'pushd', 'popd', 'compgen', 'times', 'caller',
  'eval', 'alias', 'unalias', 'getopts', 'trap', 'mapfile', 'readarray',
]);

export function isBuiltin(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

export function executeBuiltin(
  name: string,
  args: string[],
  env: Environment,
  functions: Map<string, Command>,
  io?: BuiltinIO,
  stdin?: StdinReader,
  aliases?: AliasTable,
  readFd?: (fd: number) => StdinReader | undefined,
): BuiltinResult {
  switch (name) {
    case 'echo': return builtinEcho(args);
    case 'printf': return builtinPrintf(args, env, io);
    case 'pwd': return { output: (env.get('PWD') ?? '/') + '\n', exitCode: 0 };
    case 'cd': return builtinCd(args, env, io);
    case 'unset': return builtinUnset(args, env, functions);
    case 'true': return { output: '', exitCode: 0 };
    case 'false': return { output: '', exitCode: 1 };
    // `:` (colon) — the classic no-op; args are already expanded by the
    // time we get here, so any `${VAR:=default}`-style side effect has
    // already happened. Common in `case ... : ;;` no-op branches and
    // `while : ; do` infinite loops.
    case ':': return { output: '', exitCode: 0 };
    case 'exit': return builtinExit(args, env);
    case 'return': return builtinReturn(args, env);
    case 'break': return builtinBreak(args);
    case 'continue': return builtinContinue(args);
    case 'shift': return builtinShift(args, env);
    case 'dirs': return builtinDirs(args, env);
    case 'pushd': return builtinPushd(args, env, io);
    case 'popd': return builtinPopd(args, env, io);
    case 'compgen': return builtinCompgen(args, env, functions, aliases);
    case 'times': return { output: '0m0.000s 0m0.000s\n0m0.000s 0m0.000s\n', exitCode: 0 };
    case 'caller': return builtinCaller(args, env);
    case 'read': return builtinRead(args, env, stdin, readFd);
    case 'type': return builtinType(args, functions, aliases);
    case 'set': return args.length === 0 ? declaration('declare', [], env, functions) : optionResult(runSet(args, env), env);
    case 'shopt': return optionResult(runShopt(args, env), env);
    case 'source': case '.': return { output: '', exitCode: 0 }; // handled at higher level
    case 'declare':
    case 'typeset':
    case 'local':
    case 'export':
    case 'readonly': return declaration(name, args, env, functions);
    case 'let': return builtinLet(args, env);
    case 'getopts': return builtinGetopts(args, env);
    case 'trap': return builtinTrap(args, env);
    case 'mapfile':
    case 'readarray': return builtinMapfile(args, env, stdin, readFd);
    case 'eval': return { output: '', exitCode: 0 }; // handled at higher level
    case 'alias': return builtinAlias(args, aliases);
    case 'unalias': return builtinUnalias(args, aliases);
    default: return { output: '', exitCode: 127 };
  }
}

// ─── alias / unalias ────────────────────────────────────────────

function builtinAlias(args: string[], aliases?: AliasTable): BuiltinResult {
  if (!aliases) return { output: '', exitCode: 0 };
  // No operands (or -p) → list every alias in definition form.
  if (args.length === 0 || (args.length === 1 && args[0] === '-p')) {
    const list = aliases.list();
    return {
      output: list.map(a => a.format()).join('\n') + (list.length ? '\n' : ''),
      exitCode: 0,
    };
  }
  let output = '';
  let errors = '';
  let exitCode = 0;
  for (const arg of args) {
    if (arg === '-p') continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      // `alias name=value` — define (or redefine).
      aliases.define(arg.slice(0, eq), arg.slice(eq + 1));
    } else {
      // `alias name` — print just that binding.
      const a = aliases.get(arg);
      if (a) {
        output += a.format() + '\n';
      } else {
        errors += `bash: alias: ${arg}: not found\n`;
        exitCode = 1;
      }
    }
  }
  return { output, exitCode, ...(errors === '' ? {} : { stderr: errors }) };
}

function builtinUnalias(args: string[], aliases?: AliasTable): BuiltinResult {
  if (!aliases) return { output: '', exitCode: 0 };
  if (args.includes('-a')) {
    aliases.clear();
    return { output: '', exitCode: 0 };
  }
  let output = '';
  let errors = '';
  let exitCode = 0;
  for (const name of args) {
    if (name.startsWith('-')) continue;
    if (!aliases.remove(name)) {
      errors += `bash: unalias: ${name}: not found\n`;
      exitCode = 1;
    }
  }
  return { output, exitCode, ...(errors === '' ? {} : { stderr: errors }) };
}

// ─── echo ───────────────────────────────────────────────────────

function builtinEcho(args: string[]): BuiltinResult {
  let newline = true;
  let escapes = false;
  let start = 0;

  // Parse flags: -n, -e, -E, and combined forms like -ne, -en, -neE
  while (start < args.length) {
    const arg = args[start];
    if (arg.startsWith('-') && arg.length > 1 && /^-[neE]+$/.test(arg)) {
      for (let i = 1; i < arg.length; i++) {
        if (arg[i] === 'n') newline = false;
        else if (arg[i] === 'e') escapes = true;
        else if (arg[i] === 'E') escapes = false;
      }
      start++;
    } else {
      break;
    }
  }

  let text = args.slice(start).join(' ');
  if (escapes) {
    const processed = decodeBackslashEscapes(text, 'echo');
    text = processed.text;
    if (processed.stopped) newline = false;
  }

  return { output: text + (newline ? '\n' : ''), exitCode: 0 };
}

function optionResult(result: OptionResult, env: Environment): BuiltinResult {
  if (result.positional !== undefined) env.setPositionalArgs(result.positional);
  return { output: result.output, exitCode: result.exitCode, ...(result.stderr === '' ? {} : { stderr: result.stderr }) };
}

const BASH_BUILTIN_NAMES = [
  '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete', 'compopt',
  'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'getopts',
  'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read',
  'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type',
  'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
];

export function isShellBuiltinName(name: string): boolean {
  return BASH_BUILTIN_NAMES.includes(name);
}

const BASH_KEYWORD_NAMES = [
  '!', '[[', ']]', 'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'select',
  'then', 'time', 'until', 'while', '{', '}',
];

function abbreviateHome(path: string, env: Environment): string {
  const home = env.get('HOME');
  if (home !== undefined && home !== '/' && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

function directoryListing(env: Environment, mode: string): string {
  const entries = [env.get('PWD') ?? '/', ...(env.getArray('DIRSTACK') ?? [])].map((entry) => (mode.includes('l') ? entry : abbreviateHome(entry, env)));
  if (mode.includes('v')) return entries.map((entry, index) => `${String(index).padStart(2)}  ${entry}\n`).join('');
  if (mode.includes('p')) return entries.map((entry) => `${entry}\n`).join('');
  return `${entries.join(' ')}\n`;
}

function builtinDirs(args: string[], env: Environment): BuiltinResult {
  const flags = args.filter((arg) => arg.startsWith('-')).join('');
  if (flags.includes('c')) {
    env.setArray('DIRSTACK', []);
    return { output: '', exitCode: 0 };
  }
  return { output: directoryListing(env, flags), exitCode: 0 };
}

function builtinPushd(args: string[], env: Environment, io?: BuiltinIO): BuiltinResult {
  const operands = args.filter((arg) => !(arg.startsWith('-') && arg.length > 1 && !/^-\d+$/.test(arg)));
  const stack = [...(env.getArray('DIRSTACK') ?? [])];
  const current = env.get('PWD') ?? '/';
  if (operands.length === 0) {
    if (stack.length === 0) return fail('bash: pushd: no other directory', 1);
    const next = stack[0];
    const moved = builtinCd([next], env, io);
    if (moved.exitCode !== 0) return moved;
    stack[0] = current;
    env.setArray('DIRSTACK', stack);
    return { output: directoryListing(env, ''), exitCode: 0 };
  }
  const moved = builtinCd([operands[0]], env, io);
  if (moved.exitCode !== 0) return moved;
  env.setArray('DIRSTACK', [current, ...stack]);
  return { output: directoryListing(env, ''), exitCode: 0 };
}

function builtinPopd(args: string[], env: Environment, io?: BuiltinIO): BuiltinResult {
  const stack = [...(env.getArray('DIRSTACK') ?? [])];
  if (stack.length === 0) return fail('bash: popd: directory stack empty', 1);
  if (args.includes('-n')) {
    stack.shift();
    env.setArray('DIRSTACK', stack);
    return { output: directoryListing(env, ''), exitCode: 0 };
  }
  const target = stack.shift() as string;
  const moved = builtinCd([target], env, io);
  if (moved.exitCode !== 0) return moved;
  env.setArray('DIRSTACK', stack);
  return { output: directoryListing(env, ''), exitCode: 0 };
}

function builtinCompgen(args: string[], env: Environment, functions: Map<string, Command>, aliases?: AliasTable): BuiltinResult {
  const sources: string[] = [];
  let prefix = '';
  let suffix = '';
  let word = '';
  let words: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') { word = arg; continue; }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if ('AWPSXFCGo'.includes(flag)) {
        const attached = arg.slice(j + 1);
        const value = attached !== '' ? attached : (args[++i] ?? '');
        if (flag === 'A') sources.push(value);
        else if (flag === 'W') words = value;
        else if (flag === 'P') prefix = value;
        else if (flag === 'S') suffix = value;
        break;
      }
      const named: Record<string, string> = { a: 'alias', b: 'builtin', c: 'command', d: 'directory', e: 'export', f: 'file', k: 'keyword', u: 'user', v: 'variable' };
      if (flag in named) sources.push(named[flag]);
    }
  }
  const candidates: string[] = [];
  for (const source of sources) {
    switch (source) {
      case 'builtin': candidates.push(...BASH_BUILTIN_NAMES); break;
      case 'keyword': candidates.push(...BASH_KEYWORD_NAMES); break;
      case 'function': candidates.push(...[...functions.keys()].sort()); break;
      case 'alias': candidates.push(...(aliases?.list().map((alias) => alias.name) ?? [])); break;
      case 'variable': candidates.push(...env.visibleNames()); break;
      case 'export': candidates.push(...Object.keys(env.getExported()).sort()); break;
      case 'command': candidates.push(...BASH_BUILTIN_NAMES, ...BASH_KEYWORD_NAMES, ...functions.keys()); break;
      default: break;
    }
  }
  if (words !== null) candidates.push(...words.split(/\s+/).filter(Boolean));
  const matches = [...new Set(candidates)].filter((candidate) => candidate.startsWith(word));
  return { output: matches.map((match) => `${prefix}${match}${suffix}\n`).join(''), exitCode: matches.length > 0 ? 0 : 1 };
}

function declaration(name: string, args: string[], env: Environment, functions: Map<string, Command>): BuiltinResult {
  const result = runDeclaration(name as DeclarationCommand, args, env, functions);
  return { output: result.output, exitCode: result.exitCode, ...(result.stderr === '' ? {} : { stderr: result.stderr }) };
}

// ─── printf ───────────────────────────────────────────────────

function builtinPrintf(args: string[], env: Environment, io?: BuiltinIO): BuiltinResult {
  let target: string | null = null;
  let index = 0;
  while (index < args.length && args[index].startsWith('-') && args[index] !== '-') {
    if (args[index] === '--') { index++; break; }
    if (args[index] === '-v') {
      target = args[index + 1] ?? null;
      if (target === null) return fail('bash: printf: -v: option requires an argument\nprintf: usage: printf [-v var] format [arguments]', 2);
      index += 2;
      continue;
    }
    return fail(`bash: printf: ${args[index]}: invalid option\nprintf: usage: printf [-v var] format [arguments]`, 2);
  }
  if (index >= args.length) return fail('bash: printf: usage: printf [-v var] format [arguments]', 2);
  const clock = io?.wallClock === undefined ? undefined : {
    nowMs: () => io.wallClock!().nowMs(),
    format: (pattern: string, epochMs: number) => io.wallClock!().format(pattern, epochMs),
  };
  const result = formatPrintf(args[index], args.slice(index + 1), clock);
  const errors = result.errors.map((message) => `bash: printf: ${message}\n`).join('');
  if (target !== null) {
    try { assignScalar(env, target, result.output); } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), 1);
    }
    return { output: '', exitCode: result.status, ...(errors === '' ? {} : { stderr: errors }) };
  }
  return { output: result.output, exitCode: result.status, ...(errors === '' ? {} : { stderr: errors }) };
}

function assignScalar(env: Environment, reference: string, value: string): void {
  const element = /^([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/.exec(reference);
  if (element === null) {
    env.set(reference, value);
    return;
  }
  const [, name, subscript] = element;
  if (env.isAssoc(name)) {
    env.setAssocElement(name, subscript, value);
    return;
  }
  const array = [...(env.getArray(name) ?? [])];
  const position = Number(evaluateArithmetic(subscript, env));
  while (array.length < position) array.push('');
  array[position] = value;
  env.setArray(name, array);
}

// ─── cd ─────────────────────────────────────────────────────────

function builtinCd(args: string[], env: Environment, io?: BuiltinIO): BuiltinResult {
  // cd accepts at most one argument
  if (args.length > 1) {
    return fail(`bash: cd: too many arguments`, 1);
  }

  let target: string;
  if (args.length === 0) {
    const home = env.get('HOME');
    if (!home) {
      return fail(`bash: cd: HOME not set`, 1);
    }
    target = home;
  } else if (args[0] === '-') {
    const oldpwd = env.get('OLDPWD');
    if (!oldpwd) {
      return fail(`bash: cd: OLDPWD not set`, 1);
    }
    target = oldpwd;
  } else {
    target = args[0];
  }

  // Tilde expansion
  if (target === '~') target = env.get('HOME') ?? '/';
  else if (target.startsWith('~/')) target = (env.get('HOME') ?? '/') + target.slice(1);

  // Resolve relative path against current PWD
  const cwd = env.get('PWD') ?? '/';
  let resolved: string;
  if (target.startsWith('/')) {
    resolved = target;
  } else {
    resolved = cwd === '/' ? '/' + target : cwd + '/' + target;
  }

  // Normalize: resolve . and ..
  const parts = resolved.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const p of parts) {
    if (p === '.') continue;
    if (p === '..') { normalized.pop(); continue; }
    normalized.push(p);
  }
  resolved = '/' + normalized.join('/');

  // Validate target directory via IO context if available
  if (io?.stat) {
    const absPath = io.resolvePath(resolved);
    const info = io.stat(absPath);
    if (!info) {
      return fail(`bash: cd: ${args[0] ?? resolved}: No such file or directory`, 1);
    }
    if (info.type !== 'directory') {
      return fail(`bash: cd: ${args[0] ?? resolved}: Not a directory`, 1);
    }
  }

  // Print old directory when using cd -
  const printDir = args[0] === '-';
  env.set('OLDPWD', cwd);
  env.set('PWD', resolved);
  return { output: printDir ? resolved + '\n' : '', exitCode: 0 };
}

// ─── export ─────────────────────────────────────────────────────


// ─── unset ──────────────────────────────────────────────────────

function builtinUnset(args: string[], env: Environment, functions: Map<string, Command>): BuiltinResult {
  let exitCode = 0;
  let errors = '';
  let functionMode = false;
  let explicitVariable = false;
  let parsing = true;
  for (const arg of args) {
    if (parsing && arg === '--') { parsing = false; continue; }
    if (parsing && /^-[fvn]+$/.test(arg)) {
      if (arg.includes('f')) functionMode = true;
      if (arg.includes('v')) { functionMode = false; explicitVariable = true; }
      continue;
    }
    if (functionMode) {
      functions.delete(arg);
      continue;
    }
    const element = /^([A-Za-z_][A-Za-z_0-9]*)\[(.*)\]$/.exec(arg);
    try {
      if (element !== null) {
        const [, name, subscript] = element;
        if (subscript === '@' || subscript === '*') env.unset(name);
        else if (env.isAssoc(name)) env.unsetAssocElement(name, subscript);
        else env.unsetArrayElement(name, Number(evaluateArithmetic(subscript, env)));
        continue;
      }
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(arg)) {
        if (explicitVariable) {
          errors += `bash: unset: \`${arg}': not a valid identifier\n`;
          exitCode = 1;
        }
        continue;
      }
      if (env.describe(arg) === undefined && functions.has(arg)) functions.delete(arg);
      else env.unset(arg);
    } catch (e) {
      errors += `${e instanceof Error ? e.message : String(e)}\n`;
      exitCode = 1;
    }
  }
  return { output: '', exitCode, ...(errors === '' ? {} : { stderr: errors }) };
}

// ─── Flow Control ───────────────────────────────────────────────

function builtinCaller(args: string[], env: Environment): BuiltinResult {
  const functions = env.getArray('FUNCNAME');
  const lines = env.getArray('BASH_LINENO') ?? [];
  const sources = env.getArray('BASH_SOURCE') ?? [];
  const frame = args[0] === undefined ? 0 : Number.parseInt(args[0], 10);
  if (functions === undefined || Number.isNaN(frame) || frame < 0 || frame + 1 >= functions.length) return { output: '', exitCode: 1 };
  const where = `${lines[frame] ?? 0}`;
  const output = args[0] === undefined ? `${where} ${sources[frame + 1] ?? ''}` : `${where} ${functions[frame + 1]} ${sources[frame + 1] ?? ''}`;
  return { output: `${output}\n`, exitCode: 0 };
}

function builtinExit(args: string[], env: Environment): BuiltinResult {
  if (args.length === 0) throw new ExitSignal(env.lastExitCode);
  const parsed = parseInt(args[0]);
  if (isNaN(parsed)) {
    // Non-numeric: exit with code 2 (bash behavior)
    throw new ExitSignal(2);
  }
  throw new ExitSignal(((parsed % 256) + 256) % 256);
}

function builtinReturn(args: string[], env: Environment): BuiltinResult {
  if (args.length === 0) throw new ReturnSignal(env.lastExitCode);
  const parsed = parseInt(args[0]);
  if (isNaN(parsed)) {
    throw new ReturnSignal(2);
  }
  throw new ReturnSignal(((parsed % 256) + 256) % 256);
}

function builtinBreak(args: string[]): BuiltinResult {
  if (args.length === 0) throw new BreakSignal(1);
  const parsed = parseInt(args[0]);
  if (isNaN(parsed)) {
    return fail(`bash: break: ${args[0]}: numeric argument required`, 1);
  }
  if (parsed <= 0) {
    return fail(`bash: break: ${args[0]}: loop count out of range`, 1);
  }
  throw new BreakSignal(parsed);
}

function builtinContinue(args: string[]): BuiltinResult {
  if (args.length === 0) throw new ContinueSignal(1);
  const parsed = parseInt(args[0]);
  if (isNaN(parsed)) {
    return fail(`bash: continue: ${args[0]}: numeric argument required`, 1);
  }
  if (parsed <= 0) {
    return fail(`bash: continue: ${args[0]}: loop count out of range`, 1);
  }
  throw new ContinueSignal(parsed);
}

// ─── shift ──────────────────────────────────────────────────────

function builtinShift(args: string[], env: Environment): BuiltinResult {
  const n = args.length > 0 ? (parseInt(args[0]) ?? 1) : 1;
  if (isNaN(n) || n < 0) {
    return fail(`bash: shift: ${args[0]}: numeric argument required`, 1);
  }
  const current = env.getPositionalArgs();
  if (n > current.length) {
    return isShellOptionEnabled(env, 'shift_verbose') ? fail(`bash: shift: ${args[0]}: shift count out of range`, 1) : { output: '', exitCode: 1 };
  }
  if (n === 0) return { output: '', exitCode: 0 };
  env.setPositionalArgs(current.slice(n));
  return { output: '', exitCode: 0 };
}

// ─── local ──────────────────────────────────────────────────────


// ─── read ───────────────────────────────────────────────────────

interface ReadCharacter {
  readonly character: string;
  readonly escaped: boolean;
}

const IFS_WHITESPACE = ' \t\n';

function splitRecord(characters: readonly ReadCharacter[], ifs: string, names: number): string[] {
  const isDelimiter = (c: ReadCharacter): boolean => !c.escaped && ifs.includes(c.character);
  const isWhitespace = (c: ReadCharacter): boolean => isDelimiter(c) && IFS_WHITESPACE.includes(c.character);
  const text = (from: number, to: number): string => characters.slice(from, to).map((c) => c.character).join('');
  const fields: string[] = [];
  let position = 0;
  while (position < characters.length && isWhitespace(characters[position])) position++;
  for (let index = 0; index < names; index++) {
    if (index === names - 1) {
      let end = characters.length;
      while (end > position && isWhitespace(characters[end - 1])) end--;
      const delimiters = characters.slice(position, end).filter(isDelimiter).length;
      if (delimiters === 1 && end > position && isDelimiter(characters[end - 1]) && !isWhitespace(characters[end - 1])) end--;
      fields.push(text(position, end));
      break;
    }
    const start = position;
    while (position < characters.length && !isDelimiter(characters[position])) position++;
    fields.push(text(start, position));
    while (position < characters.length && isWhitespace(characters[position])) position++;
    if (position < characters.length && isDelimiter(characters[position]) && !isWhitespace(characters[position])) {
      position++;
      while (position < characters.length && isWhitespace(characters[position])) position++;
    }
  }
  return fields;
}

function splitWords(characters: readonly ReadCharacter[], ifs: string): string[] {
  const words: string[] = [];
  const isDelimiter = (c: ReadCharacter): boolean => !c.escaped && ifs.includes(c.character);
  const isWhitespace = (c: ReadCharacter): boolean => isDelimiter(c) && IFS_WHITESPACE.includes(c.character);
  let position = 0;
  while (position < characters.length && isWhitespace(characters[position])) position++;
  while (position < characters.length) {
    let word = '';
    while (position < characters.length && !isDelimiter(characters[position])) word += characters[position++].character;
    words.push(word);
    while (position < characters.length && isWhitespace(characters[position])) position++;
    if (position < characters.length && isDelimiter(characters[position]) && !isWhitespace(characters[position])) {
      position++;
      while (position < characters.length && isWhitespace(characters[position])) position++;
    }
  }
  return words;
}

function builtinRead(args: string[], env: Environment, input?: StdinReader, readFd?: (fd: number) => StdinReader | undefined): BuiltinResult {
  let raw = false;
  let arrayName: string | null = null;
  let delimiter = '\n';
  let limit: number | null = null;
  let exact = false;
  let timeout: number | null = null;
  let fd = 0;
  let prompt = '';
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') { names.push(arg); continue; }
    if (arg === '--') { names.push(...args.slice(i + 1)); break; }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      const takesValue = 'adnNptu'.includes(flag);
      if (!takesValue) {
        if (flag === 'r') raw = true;
        else if (!'sei'.includes(flag)) return fail(`bash: read: -${flag}: invalid option\nread: usage: read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]`, 2);
        continue;
      }
      const attached = arg.slice(j + 1);
      const value = attached !== '' ? attached : args[++i];
      if (value === undefined) return fail(`bash: read: -${flag}: option requires an argument`, 2);
      if (flag === 'a') arrayName = value;
      else if (flag === 'd') delimiter = value === '' ? '\0' : value[0];
      else if (flag === 'n' || flag === 'N') { limit = Number.parseInt(value, 10); exact = flag === 'N'; }
      else if (flag === 't') timeout = Number(value);
      else if (flag === 'u') fd = Number.parseInt(value, 10);
      else if (flag === 'p') prompt = value;
      break;
    }
  }
  const source = fd === 0 ? input : readFd?.(fd);
  if (fd !== 0 && source === undefined) return fail(`bash: read: ${fd}: invalid file descriptor: Bad file descriptor`, 1);
  if (timeout === 0) return { output: '', exitCode: source === undefined ? 1 : 0 };

  const characters: ReadCharacter[] = [];
  let terminated = false;
  let sawInput = false;
  if (source !== undefined && limit !== null) {
    const chunk = source.readCharacters(limit);
    if (chunk !== null) {
      sawInput = true;
      for (const character of chunk) {
        if (!exact && character === delimiter) { terminated = true; break; }
        characters.push({ character, escaped: false });
      }
      terminated = terminated || (chunk.length === limit);
    }
  } else if (source !== undefined) {
    for (;;) {
      const record = source.readRecord(delimiter);
      if (record === null) break;
      sawInput = true;
      let continued = false;
      for (let index = 0; index < record.text.length; index++) {
        const character = record.text[index];
        if (!raw && character === '\\') {
          if (index + 1 < record.text.length) { characters.push({ character: record.text[++index], escaped: true }); continue; }
          if (record.terminated && delimiter === '\n') { continued = true; continue; }
        }
        characters.push({ character, escaped: false });
      }
      terminated = record.terminated;
      if (!continued) break;
    }
  }
  const status = terminated ? 0 : 1;
  const ifs = env.get('IFS') ?? ' \t\n';
  const failures: string[] = [];
  const store = (action: () => void): void => {
    try { action(); } catch (e) { failures.push(e instanceof Error ? e.message : String(e)); }
  };
  if (!sawInput && source === undefined) {
    for (const name of names.length > 0 ? names : ['REPLY']) store(() => env.set(name, ''));
    return { output: prompt, exitCode: 1 };
  }
  if (arrayName !== null) {
    const words = splitWords(characters, ifs);
    store(() => env.setArray(arrayName as string, words));
  } else if (names.length === 0) {
    store(() => env.set('REPLY', characters.map((c) => c.character).join('')));
  } else {
    const fields = splitRecord(characters, ifs, names.length);
    names.forEach((name, index) => store(() => env.set(name, fields[index] ?? '')));
  }
  const errors = failures.map((message) => `${message}\n`).join('');
  return { output: '', exitCode: failures.length > 0 ? 1 : status, ...(errors === '' ? {} : { stderr: errors }) };
}

// ─── type ───────────────────────────────────────────────────────

function builtinType(
  args: string[],
  functions: Map<string, Command>,
  aliases?: AliasTable,
): BuiltinResult {
  // `-t` prints only the one-word type; other flags are accepted as no-ops.
  const terse = args.includes('-t');
  const names = args.filter(a => !a.startsWith('-'));
  const outputs: string[] = [];
  const errors: string[] = [];
  let exitCode = 0;
  for (const name of names) {
    const alias = aliases?.get(name);
    if (alias) {
      outputs.push(terse ? 'alias\n' : `${name} is aliased to \`${alias.value}'\n`);
    } else if (BUILTIN_NAMES.has(name)) {
      outputs.push(terse ? 'builtin\n' : `${name} is a shell builtin\n`);
    } else if (functions.has(name)) {
      outputs.push(terse ? 'function\n' : `${name} is a function\n`);
    } else {
      if (!terse) errors.push(`bash: type: ${name}: not found\n`);
      exitCode = 1;
    }
  }
  return { output: outputs.join(''), exitCode, ...(errors.length === 0 ? {} : { stderr: errors.join('') }) };
}

// ─── set ────────────────────────────────────────────────────────

// ─── declare / readonly ─────────────────────────────────────────


/** Print variable declarations for declare -p / readonly -p. */

// ─── let ────────────────────────────────────────────────────────

function builtinLet(args: string[], env: Environment): BuiltinResult {
  if (args.length === 0) {
    return fail(`bash: let: expression expected`, 1);
  }

  let result = '0';
  for (const expr of args) {
    try {
      result = evaluateArithmetic(expr, env);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`bash: let: ${msg}`, 1);
    }
  }
  // let returns 1 if last expression is 0, else 0
  return { output: '', exitCode: result === '0' ? 1 : 0 };
}

// ─── getopts ────────────────────────────────────────────────────

/**
 * POSIX `getopts` builtin — one call per option, driven by `$OPTIND`
 * (1-based positional pointer). The spec normally reads from the
 * caller's positional args; we honour that by inspecting
 * `env.getPositionalArgs()`. Args after `--` or the first non-flag
 * stop the loop with exit 1, exactly like the spec.
 *
 *   optstring leading `:` ⇒ silent mode: invalid options return
 *                          `?` in `$name` with `OPTARG` set to the bad
 *                          char, and missing args return `:` in `$name`.
 *   trailing `:` after a flag char ⇒ that flag requires an argument.
 *
 * `OPTIND` is advanced after a successful read; the caller's
 * `while getopts … opt; do …; done` loop terminates when we return
 * exit 1 (end of options).
 */
function builtinGetopts(args: string[], env: Environment): BuiltinResult {
  if (args.length < 2) {
    return fail(`getopts: usage: getopts optstring name [args]`, 2);
  }
  const optstring = args[0];
  const name = args[1];
  const explicitArgs = args.slice(2);
  const positional = explicitArgs.length > 0 ? explicitArgs : env.getPositionalArgs();
  const silent = optstring.startsWith(':');
  const spec = silent ? optstring.slice(1) : optstring;

  let optind = Number.parseInt(env.get('OPTIND') ?? '1', 10);
  if (!Number.isFinite(optind) || optind < 1) optind = 1;
  const idx = optind - 1;
  const cur = positional[idx];

  // Reached end / first non-option → stop.
  if (cur === undefined || cur === '--' || !cur.startsWith('-') || cur === '-') {
    if (cur === '--') env.set('OPTIND', String(optind + 1));
    env.set(name, '?');
    env.unset('OPTARG');
    return { output: '', exitCode: 1 };
  }
  // Clustered short flags: `-vh` ⇒ read the next char each call.
  // OPTIND points to the operand position; we track the in-cluster
  // offset via `__OPTSUB`.
  let sub = Number.parseInt(env.get('__OPTSUB') ?? '1', 10);
  if (!Number.isFinite(sub) || sub < 1) sub = 1;
  const flag = cur[sub];
  if (!flag) {
    env.set('OPTIND', String(optind + 1));
    env.unset('__OPTSUB');
    return builtinGetopts(args, env);                  // tail-call into next arg
  }
  const specPos = spec.indexOf(flag);
  if (specPos < 0) {
    // Invalid option.
    env.set(name, '?');
    if (silent) env.set('OPTARG', flag);
    else env.set('OPTARG', '');
    if (sub + 1 < cur.length) env.set('__OPTSUB', String(sub + 1));
    else { env.set('OPTIND', String(optind + 1)); env.unset('__OPTSUB'); }
    return { output: '', exitCode: 0, ...(silent ? {} : { stderr: `bash: illegal option -- ${flag}\n` }) };
  }
  const needsArg = spec[specPos + 1] === ':';
  if (!needsArg) {
    env.set(name, flag);
    env.unset('OPTARG');
    if (sub + 1 < cur.length) env.set('__OPTSUB', String(sub + 1));
    else { env.set('OPTIND', String(optind + 1)); env.unset('__OPTSUB'); }
    return { output: '', exitCode: 0 };
  }
  // Flag requires an argument.
  let optarg: string | undefined;
  if (sub + 1 < cur.length) {                          // `-fconf.yaml`
    optarg = cur.slice(sub + 1);
    env.set('OPTIND', String(optind + 1));
    env.unset('__OPTSUB');
  } else {
    optarg = positional[idx + 1];
    if (optarg === undefined) {
      // Missing required argument.
      env.set(name, silent ? ':' : '?');
      env.set('OPTARG', silent ? flag : '');
      env.set('OPTIND', String(optind + 1));
      env.unset('__OPTSUB');
      return { output: '', exitCode: 0, ...(silent ? {} : { stderr: `bash: option requires an argument -- ${flag}\n` }) };
    }
    env.set('OPTIND', String(optind + 2));
    env.unset('__OPTSUB');
  }
  env.set(name, flag);
  env.set('OPTARG', optarg);
  return { output: '', exitCode: 0 };
}


// ─── trap ───────────────────────────────────────────────────────

/**
 * `trap [-l] [[ACTION] SIGNAL …]` — register a shell-level handler.
 *
 *   trap            → list every active handler
 *   trap -l         → list known signal names
 *   trap - SIG …    → clear handlers for SIG…
 *   trap '' SIG …   → ignore SIG (handler does nothing)
 *   trap ACTION SIG → install ACTION for each SIG (re-parsed by the
 *                     interpreter at firing time, exactly like real
 *                     bash)
 *
 * EXIT is the synchronous pseudo-signal real bash fires at the end of
 * the script / function / sourced file. The interpreter calls
 * `Environment.fireTrap('EXIT')` from `execute()` after the main
 * command list has finished (or been short-circuited by `exit`).
 */
function builtinTrap(args: string[], env: Environment): BuiltinResult {
  const listing = (names?: readonly string[]): string => env.listTraps()
    .filter(([signal]) => names === undefined || names.includes(signal))
    .map(([signal, body]) => `trap -- '${body.replace(/'/g, `'\\''`)}' ${signal === 'EXIT' || ['ERR', 'DEBUG', 'RETURN'].includes(signal) ? signal : `SIG${signal}`}\n`)
    .join('');
  if (args.length === 0) return { output: listing(), exitCode: 0 };
  if (args[0] === '-l' || args[0] === '-L') return { output: signalListing(), exitCode: 0 };
  if (args[0] === '-p') {
    const names = args.slice(1).map((spec) => signalName(spec) ?? spec);
    return { output: listing(names.length > 0 ? names : undefined), exitCode: 0 };
  }
  const operands = args[0] === '--' ? args.slice(1) : args;
  if (operands.length === 0) return { output: listing(), exitCode: 0 };
  const clearing = operands[0] === '-' || (/^\d+$/.test(operands[0]) && operands.length === 1);
  const action = clearing ? '' : operands[0];
  const specs = clearing ? (operands[0] === '-' ? operands.slice(1) : operands) : operands.slice(1);
  if (specs.length === 0) return fail('trap: usage: trap [-lp] [[arg] signal_spec ...]', 2);
  let errors = '';
  for (const spec of specs) {
    const name = signalName(spec);
    if (name === null) {
      errors += `bash: trap: ${spec}: invalid signal specification\n`;
      continue;
    }
    if (clearing) env.clearTrap(name);
    else env.setTrap(name, action);
  }
  return { output: '', exitCode: errors === '' ? 0 : 1, ...(errors === '' ? {} : { stderr: errors }) };
}


// ─── mapfile / readarray ────────────────────────────────────────

/**
 * `mapfile [-t] [-n COUNT] [-O ORIGIN] [-s SKIP] NAME` — bind each
 * input line to an element of indexed array NAME. The input arrives
 * via the standard `< file` redirection (pipeInput) or a `<<<`
 * herestring.
 *
 *   -t          strip the trailing newline from each line
 *   -n COUNT    stop after COUNT lines
 *   -O ORIGIN   start storing at index ORIGIN (default 0)
 *   -s SKIP     skip the first SKIP lines
 *   -d DELIM    line delimiter (default `\n`)
 *
 * Default array name when no NAME is supplied is `MAPFILE`.
 */
function builtinMapfile(
  args: string[],
  env: Environment,
  input?: StdinReader,
  readFd?: (fd: number) => StdinReader | undefined,
): BuiltinResult {
  let trim = false;
  let count = Number.POSITIVE_INFINITY;
  let origin = 0;
  let skip = 0;
  let delimiter = '\n';
  let name = 'MAPFILE';
  let fd = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') { name = a; continue; }
    for (let j = 1; j < a.length; j++) {
      const flag = a[j];
      if (flag === 't') { trim = true; continue; }
      if (!'nOsduc C'.includes(flag)) continue;
      const attached = a.slice(j + 1);
      const value = attached !== '' ? attached : (args[++i] ?? '');
      if (flag === 'n') { const n = Number.parseInt(value, 10) || 0; count = n === 0 ? Number.POSITIVE_INFINITY : n; }
      else if (flag === 'O') origin = Number.parseInt(value, 10) || 0;
      else if (flag === 's') skip = Number.parseInt(value, 10) || 0;
      else if (flag === 'd') delimiter = value === '' ? '\0' : value[0];
      else if (flag === 'u') fd = Number.parseInt(value, 10) || 0;
      break;
    }
  }
  const source = fd === 0 ? input : readFd?.(fd);
  const values: string[] = [];
  let skipped = 0;
  if (source !== undefined) {
    for (;;) {
      if (values.length >= count) break;
      const record = source.readRecord(delimiter);
      if (record === null) break;
      if (skipped < skip) { skipped++; continue; }
      values.push(trim || !record.terminated ? record.text : record.text + delimiter);
    }
  }
  const existing = origin > 0 ? [...(env.getArray(name) ?? [])] : [];
  while (existing.length < origin) existing.push('');
  env.setArray(name, [...existing.slice(0, origin), ...values]);
  return { output: '', exitCode: 0 };
}
