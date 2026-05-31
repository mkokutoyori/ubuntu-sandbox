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
import {
  ExitSignal, ReturnSignal, BreakSignal, ContinueSignal,
} from '@/bash/errors/BashError';
import { evaluateArithmetic } from './Expansion';
import type { AliasTable } from './AliasTable';

/** Minimal IO interface for builtins that need filesystem access. */
export interface BuiltinIO {
  resolvePath(path: string): string;
  stat?(path: string): { type: 'file' | 'directory' } | null;
}

export interface BuiltinResult {
  output: string;
  exitCode: number;
}

const BUILTIN_NAMES = new Set([
  'echo', 'printf', 'cd', 'pwd', 'export', 'unset', 'set',
  'local', 'read', 'true', 'false',
  'exit', 'return', 'break', 'continue',
  'shift', 'source', '.', 'declare', 'readonly', 'let',
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
  pipeInput?: string,
  aliases?: AliasTable,
): BuiltinResult {
  switch (name) {
    case 'echo': return builtinEcho(args);
    case 'printf': return builtinPrintf(args, env);
    case 'pwd': return { output: (env.get('PWD') ?? '/') + '\n', exitCode: 0 };
    case 'cd': return builtinCd(args, env, io);
    case 'export': return builtinExport(args, env);
    case 'unset': return builtinUnset(args, env);
    case 'true': return { output: '', exitCode: 0 };
    case 'false': return { output: '', exitCode: 1 };
    case 'exit': return builtinExit(args);
    case 'return': return builtinReturn(args);
    case 'break': return builtinBreak(args);
    case 'continue': return builtinContinue(args);
    case 'shift': return builtinShift(args, env);
    case 'local': return builtinLocal(args, env);
    case 'read': return builtinRead(args, env, pipeInput);
    case 'type': return builtinType(args, functions, aliases);
    case 'set': return builtinSet(args, env);
    case 'source': case '.': return { output: '', exitCode: 0 }; // handled at higher level
    case 'declare': return builtinDeclare(args, env, false);
    case 'readonly': return builtinDeclare(args, env, true);
    case 'let': return builtinLet(args, env);
    case 'getopts': return builtinGetopts(args, env);
    case 'trap': return builtinTrap(args, env);
    case 'mapfile':
    case 'readarray': return builtinMapfile(args, env, io, pipeInput);
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
        output += `bash: alias: ${arg}: not found\n`;
        exitCode = 1;
      }
    }
  }
  return { output, exitCode };
}

function builtinUnalias(args: string[], aliases?: AliasTable): BuiltinResult {
  if (!aliases) return { output: '', exitCode: 0 };
  if (args.includes('-a')) {
    aliases.clear();
    return { output: '', exitCode: 0 };
  }
  let output = '';
  let exitCode = 0;
  for (const name of args) {
    if (name.startsWith('-')) continue;
    if (!aliases.remove(name)) {
      output += `bash: unalias: ${name}: not found\n`;
      exitCode = 1;
    }
  }
  return { output, exitCode };
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
    const processed = processEchoEscapes(text);
    text = processed.text;
    if (processed.stopOutput) newline = false;
  }

  return { output: text + (newline ? '\n' : ''), exitCode: 0 };
}

/** Process escape sequences for echo -e. Returns text and whether \c was encountered. */
function processEchoEscapes(text: string): { text: string; stopOutput: boolean } {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      switch (next) {
        case '\\': result += '\\'; i++; break;
        case 'n': result += '\n'; i++; break;
        case 't': result += '\t'; i++; break;
        case 'a': result += '\x07'; i++; break;
        case 'b': result += '\b'; i++; break;
        case 'r': result += '\r'; i++; break;
        case 'c': return { text: result, stopOutput: true };
        case '0': {
          // Octal: \0NNN (up to 3 octal digits)
          let octal = '';
          let j = i + 2;
          while (j < text.length && j < i + 5 && /[0-7]/.test(text[j])) {
            octal += text[j]; j++;
          }
          result += String.fromCharCode(parseInt(octal || '0', 8));
          i = j - 1;
          break;
        }
        case 'x': {
          // Hex: \xHH (up to 2 hex digits)
          let hex = '';
          let j = i + 2;
          while (j < text.length && j < i + 4 && /[0-9a-fA-F]/.test(text[j])) {
            hex += text[j]; j++;
          }
          if (hex) {
            result += String.fromCharCode(parseInt(hex, 16));
            i = j - 1;
          } else {
            result += '\\x'; i++;
          }
          break;
        }
        default: result += '\\' + next; i++; break;
      }
    } else {
      result += text[i];
    }
  }
  return { text: result, stopOutput: false };
}

// ─── printf ─────────────────────────────────────────────────────

function builtinPrintf(args: string[], env: Environment): BuiltinResult {
  if (args.length === 0) {
    return { output: 'bash: printf: usage: printf [-v var] format [arguments]\n', exitCode: 1 };
  }

  // Handle -v var flag
  let targetVar: string | null = null;
  let fmtStart = 0;
  if (args[0] === '-v' && args.length >= 3) {
    targetVar = args[1];
    fmtStart = 2;
  }

  const format = args[fmtStart];
  const fmtArgs = args.slice(fmtStart + 1);
  let output = '';
  let argIdx = 0;

  // Re-use format string when there are remaining arguments
  do {
    const startArgIdx = argIdx;
    output += printfFormat(format, fmtArgs, argIdx);
    // Count how many args were consumed by scanning format
    argIdx = startArgIdx + countFormatSpecs(format);
  } while (argIdx < fmtArgs.length && argIdx > 0);

  if (targetVar) {
    try { env.set(targetVar, output); } catch { /* readonly */ }
    return { output: '', exitCode: 0 };
  }
  return { output, exitCode: 0 };
}

/** Count the number of format specifiers (excluding %%) in a format string. */
function countFormatSpecs(format: string): number {
  let count = 0;
  for (let i = 0; i < format.length; i++) {
    if (format[i] === '%' && i + 1 < format.length) {
      i++;
      // Skip flags, width, precision
      while (i < format.length && /[-+ 0#]/.test(format[i])) i++;
      while (i < format.length && /[0-9]/.test(format[i])) i++;
      if (i < format.length && format[i] === '.') {
        i++;
        while (i < format.length && /[0-9]/.test(format[i])) i++;
      }
      if (i < format.length && format[i] !== '%') count++;
    } else if (format[i] === '\\' && i + 1 < format.length) {
      i++;
    }
  }
  return count;
}

/** Format a single pass through the format string with given args starting at argIdx. */
function printfFormat(format: string, fmtArgs: string[], argIdx: number): string {
  let output = '';
  let ai = argIdx;

  for (let i = 0; i < format.length; i++) {
    if (format[i] === '%' && i + 1 < format.length) {
      i++;
      if (format[i] === '%') { output += '%'; continue; }

      // Parse flags
      let flags = '';
      while (i < format.length && /[-+ 0#]/.test(format[i])) { flags += format[i]; i++; }

      // Parse width
      let width = '';
      while (i < format.length && /[0-9]/.test(format[i])) { width += format[i]; i++; }

      // Parse precision
      let precision = '';
      if (i < format.length && format[i] === '.') {
        i++;
        while (i < format.length && /[0-9]/.test(format[i])) { precision += format[i]; i++; }
        if (!precision) precision = '0';
      }

      const specifier = format[i] ?? 's';
      const arg = fmtArgs[ai++] ?? '';

      output += applyPrintfSpec(specifier, arg, flags, width, precision);
    } else if (format[i] === '\\' && i + 1 < format.length) {
      i++;
      switch (format[i]) {
        case 'n': output += '\n'; break;
        case 't': output += '\t'; break;
        case '\\': output += '\\'; break;
        case 'a': output += '\x07'; break;
        case 'b': output += '\b'; break;
        case 'r': output += '\r'; break;
        case '0': {
          let octal = '';
          let j = i + 1;
          while (j < format.length && j < i + 4 && /[0-7]/.test(format[j])) { octal += format[j]; j++; }
          output += String.fromCharCode(parseInt(octal || '0', 8));
          i = j - 1;
          break;
        }
        case 'x': {
          let hex = '';
          let j = i + 1;
          while (j < format.length && j < i + 3 && /[0-9a-fA-F]/.test(format[j])) { hex += format[j]; j++; }
          if (hex) { output += String.fromCharCode(parseInt(hex, 16)); i = j - 1; }
          else { output += '\\x'; }
          break;
        }
        default: output += '\\' + format[i];
      }
    } else {
      output += format[i];
    }
  }
  return output;
}

/** Apply a single printf format specifier. */
function applyPrintfSpec(spec: string, arg: string, flags: string, widthStr: string, precisionStr: string): string {
  const width = widthStr ? parseInt(widthStr) : 0;
  const leftAlign = flags.includes('-');
  const zeroPad = flags.includes('0') && !leftAlign;

  let result: string;
  switch (spec) {
    case 's': {
      result = arg;
      if (precisionStr) result = result.substring(0, parseInt(precisionStr));
      break;
    }
    case 'd': case 'i': {
      const num = parseInt(arg) || 0;
      result = String(num);
      break;
    }
    case 'f': {
      const num = parseFloat(arg) || 0;
      const prec = precisionStr ? parseInt(precisionStr) : 6;
      result = num.toFixed(prec);
      break;
    }
    case 'x': {
      const num = parseInt(arg) || 0;
      result = (num >>> 0).toString(16);
      break;
    }
    case 'X': {
      const num = parseInt(arg) || 0;
      result = (num >>> 0).toString(16).toUpperCase();
      break;
    }
    case 'o': {
      const num = parseInt(arg) || 0;
      result = (num >>> 0).toString(8);
      break;
    }
    case 'c': {
      result = arg ? arg[0] : '';
      break;
    }
    case 'b': {
      // %b: interpret backslash escapes in arg (like echo -e)
      result = processEchoEscapes(arg).text;
      break;
    }
    default:
      result = '%' + spec;
  }

  // Apply width padding
  if (width > result.length) {
    const padChar = zeroPad ? '0' : ' ';
    const padding = padChar.repeat(width - result.length);
    result = leftAlign ? result + padding : padding + result;
  }

  return result;
}

// ─── cd ─────────────────────────────────────────────────────────

function builtinCd(args: string[], env: Environment, io?: BuiltinIO): BuiltinResult {
  // cd accepts at most one argument
  if (args.length > 1) {
    return { output: 'bash: cd: too many arguments\n', exitCode: 1 };
  }

  let target: string;
  if (args.length === 0) {
    const home = env.get('HOME');
    if (!home) {
      return { output: 'bash: cd: HOME not set\n', exitCode: 1 };
    }
    target = home;
  } else if (args[0] === '-') {
    const oldpwd = env.get('OLDPWD');
    if (!oldpwd) {
      return { output: 'bash: cd: OLDPWD not set\n', exitCode: 1 };
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
      return { output: `bash: cd: ${args[0] ?? resolved}: No such file or directory\n`, exitCode: 1 };
    }
    if (info.type !== 'directory') {
      return { output: `bash: cd: ${args[0] ?? resolved}: Not a directory\n`, exitCode: 1 };
    }
  }

  // Print old directory when using cd -
  const printDir = args[0] === '-';
  env.set('OLDPWD', cwd);
  env.set('PWD', resolved);
  return { output: printDir ? resolved + '\n' : '', exitCode: 0 };
}

// ─── export ─────────────────────────────────────────────────────

function builtinExport(args: string[], env: Environment): BuiltinResult {
  // export with no args or -p → list all exports
  if (args.length === 0 || (args.length === 1 && args[0] === '-p')) {
    const exported = env.getExported();
    const lines = Object.entries(exported)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `declare -x ${k}="${v}"`);
    return { output: lines.length ? lines.join('\n') + '\n' : '', exitCode: 0 };
  }

  // Handle -n flag (remove export attribute)
  if (args[0] === '-n') {
    for (const name of args.slice(1)) {
      env.unexport(name);
    }
    return { output: '', exitCode: 0 };
  }

  let exitCode = 0;
  let output = '';
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const eqIdx = arg.indexOf('=');
    const name = eqIdx >= 0 ? arg.substring(0, eqIdx) : arg;

    // Validate identifier
    if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name)) {
      output += `bash: export: \`${arg}': not a valid identifier\n`;
      exitCode = 1;
      continue;
    }

    try {
      if (eqIdx >= 0) {
        env.export(name, arg.substring(eqIdx + 1));
      } else {
        env.export(name);
      }
    } catch (e) {
      output += e instanceof Error ? e.message + '\n' : '';
      exitCode = 1;
    }
  }
  return { output, exitCode };
}

// ─── unset ──────────────────────────────────────────────────────

function builtinUnset(args: string[], env: Environment): BuiltinResult {
  let exitCode = 0;
  let output = '';
  for (const arg of args) {
    if (arg === '-v' || arg === '-f') continue; // flags: -v (var), -f (func)
    if (arg.startsWith('-')) continue;
    // `unset name[key]` — drop a single array / assoc element.
    const sub = arg.match(/^([A-Za-z_][A-Za-z_0-9]*)\[([^\]]+)\]$/);
    if (sub) {
      const [, name, keyRaw] = sub;
      const key = keyRaw.replace(/\$\{?([A-Za-z_][A-Za-z_0-9]*)\}?/g, (_, n) => env.get(n) ?? '');
      if (env.isAssoc(name)) { env.unsetAssocElement(name, key); continue; }
      const arr = env.getArray(name);
      if (arr) {
        const idx = Number.parseInt(key, 10);
        if (Number.isFinite(idx) && idx >= 0 && idx < arr.length) {
          const next = [...arr];
          next.splice(idx, 1);
          env.setArray(name, next);
        }
      }
      continue;
    }
    if (env.isReadonly(arg)) {
      output += `bash: unset: ${arg}: cannot unset: readonly variable\n`;
      exitCode = 1;
      continue;
    }
    env.unset(arg);
  }
  return { output, exitCode };
}

// ─── Flow Control ───────────────────────────────────────────────

function builtinExit(args: string[]): BuiltinResult {
  if (args.length === 0) throw new ExitSignal(0);
  const parsed = parseInt(args[0]);
  if (isNaN(parsed)) {
    // Non-numeric: exit with code 2 (bash behavior)
    throw new ExitSignal(2);
  }
  throw new ExitSignal(parsed);
}

function builtinReturn(args: string[]): BuiltinResult {
  if (args.length === 0) throw new ReturnSignal(0);
  const parsed = parseInt(args[0]);
  if (isNaN(parsed)) {
    throw new ReturnSignal(2);
  }
  throw new ReturnSignal(parsed);
}

function builtinBreak(args: string[]): BuiltinResult {
  if (args.length === 0) throw new BreakSignal(1);
  const parsed = parseInt(args[0]);
  if (isNaN(parsed)) {
    return { output: `bash: break: ${args[0]}: numeric argument required\n`, exitCode: 1 };
  }
  if (parsed <= 0) {
    return { output: `bash: break: ${args[0]}: loop count out of range\n`, exitCode: 1 };
  }
  throw new BreakSignal(parsed);
}

function builtinContinue(args: string[]): BuiltinResult {
  if (args.length === 0) throw new ContinueSignal(1);
  const parsed = parseInt(args[0]);
  if (isNaN(parsed)) {
    return { output: `bash: continue: ${args[0]}: numeric argument required\n`, exitCode: 1 };
  }
  if (parsed <= 0) {
    return { output: `bash: continue: ${args[0]}: loop count out of range\n`, exitCode: 1 };
  }
  throw new ContinueSignal(parsed);
}

// ─── shift ──────────────────────────────────────────────────────

function builtinShift(args: string[], env: Environment): BuiltinResult {
  const n = args.length > 0 ? (parseInt(args[0]) ?? 1) : 1;
  if (isNaN(n) || n < 0) {
    return { output: `bash: shift: ${args[0]}: numeric argument required\n`, exitCode: 1 };
  }
  const current = env.getPositionalArgs();
  if (n > current.length) {
    return { output: `bash: shift: shift count out of range\n`, exitCode: 1 };
  }
  if (n === 0) return { output: '', exitCode: 0 };
  env.setPositionalArgs(current.slice(n));
  return { output: '', exitCode: 0 };
}

// ─── local ──────────────────────────────────────────────────────

function builtinLocal(args: string[], env: Environment): BuiltinResult {
  let exitCode = 0;
  let output = '';
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('-')) { i++; continue; } // skip flags like -r, -i
    const eqIdx = arg.indexOf('=');
    if (eqIdx >= 0) {
      const name = arg.substring(0, eqIdx);
      let value = arg.substring(eqIdx + 1);
      // If value is empty and next arg exists (split assignment: VAR= value), use next arg
      if (!value && i + 1 < args.length && !args[i + 1].includes('=')) {
        value = args[i + 1];
        i++;
      }
      env.declareLocal(name);
      try {
        env.set(name, value);
      } catch (e) {
        output += `bash: local: ${name}: readonly variable\n`;
        exitCode = 1;
      }
    } else {
      env.declareLocal(arg);
      if (!env.isSet(arg)) {
        try { env.set(arg, ''); } catch { /* readonly */ }
      }
    }
    i++;
  }
  return { output, exitCode };
}

// ─── read ───────────────────────────────────────────────────────

function builtinRead(args: string[], env: Environment, pipeInput?: string): BuiltinResult {
  let prompt = '';
  let raw = false;
  let arrayName: string | null = null;
  let delim = '\n';
  const varNames: string[] = [];
  let output = '';

  // Parse flags, including the new -a (read into array) and -d DELIM
  // (custom line terminator, "" means NUL / read to EOF).
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-r') { raw = true; continue; }
    if (arg === '-p' && i + 1 < args.length) { prompt = args[++i]; continue; }
    if (arg === '-a' && i + 1 < args.length) { arrayName = args[++i]; continue; }
    if (arg === '-d') { delim = args[++i] ?? '\n'; if (delim === '') delim = '\0'; continue; }
    if (arg === '-s' || arg === '-n' || arg === '-t') {
      if ((arg === '-n' || arg === '-t') && i + 1 < args.length) i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      // Clustered short flags like `-ra`, `-rd`, `-ra arr`.
      let j = 1;
      while (j < arg.length) {
        const f = arg[j];
        if (f === 'r') { raw = true; j++; continue; }
        if (f === 'a') {
          const next = arg.slice(j + 1);
          if (next) { arrayName = next; }
          else if (i + 1 < args.length) { arrayName = args[++i]; }
          break;
        }
        if (f === 'd') {
          const next = arg.slice(j + 1);
          if (next) { delim = next === '' ? '\0' : next; }
          else if (i + 1 < args.length) { delim = args[++i] || '\0'; }
          break;
        }
        if (f === 'p') {
          const next = arg.slice(j + 1);
          if (next) { prompt = next; }
          else if (i + 1 < args.length) { prompt = args[++i]; }
          break;
        }
        j++;
      }
      continue;
    }
    varNames.push(arg);
  }

  // Display prompt
  if (prompt) output = prompt;

  // In simulator context: read from pipe input or set empty
  if (!pipeInput) {
    // No stdin available: set variables to empty, return 1 (EOF)
    if (varNames.length === 0) {
      env.set('REPLY', '');
    } else {
      for (const name of varNames) {
        try { env.set(name, ''); } catch { /* readonly */ }
      }
    }
    return { output, exitCode: 1 };
  }

  // Read the first record from the pipe input. `delim` defaults to
  // newline but a `-d ""` form reads until NUL (effectively to EOF).
  const lineEnd = pipeInput.indexOf(delim);
  let line = lineEnd >= 0 ? pipeInput.substring(0, lineEnd) : pipeInput;
  // Trim a trailing newline that came from a heredoc-style source so
  // `read foo <<< value` doesn't capture an extra `\n` (matches bash).
  if (delim === '\n' && pipeInput.endsWith('\n') && lineEnd < 0) {
    line = pipeInput.slice(0, -1);
  }

  // Process backslash escapes unless -r
  if (!raw) {
    line = line.replace(/\\(.)/g, '$1');
  }

  // `-a NAME` binds every IFS-split token to elements of NAME.
  if (arrayName) {
    const ifs = env.get('IFS') ?? ' \t\n';
    const split = line.split(new RegExp(`[${ifs.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')}]+`)).filter(Boolean);
    try { env.setArray(arrayName, split); } catch { /* readonly */ }
    return { output, exitCode: 0 };
  }

  if (varNames.length === 0) {
    // No variable names → use REPLY
    env.set('REPLY', line);
  } else if (varNames.length === 1) {
    try { env.set(varNames[0], line); } catch { /* readonly */ }
  } else {
    // Split input by IFS (default: space/tab/newline)
    const ifs = env.get('IFS') ?? ' \t\n';
    const parts = line.split(new RegExp(`[${ifs.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')}]+`));
    for (let i = 0; i < varNames.length; i++) {
      let value: string;
      if (i === varNames.length - 1) {
        // Last variable gets remainder
        value = parts.slice(i).join(' ');
      } else {
        value = parts[i] ?? '';
      }
      try { env.set(varNames[i], value); } catch { /* readonly */ }
    }
  }

  return { output, exitCode: 0 };
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
      if (!terse) outputs.push(`bash: type: ${name}: not found\n`);
      exitCode = 1;
    }
  }
  return { output: outputs.join(''), exitCode };
}

// ─── set ────────────────────────────────────────────────────────

/** Map short flags to SHELLOPTS option names. */
const SET_FLAG_MAP: Record<string, string> = {
  e: 'errexit', u: 'nounset', x: 'xtrace', f: 'noglob',
  n: 'noexec', v: 'verbose', C: 'noclobber', B: 'braceexpand',
};

function builtinSet(args: string[], env: Environment): BuiltinResult {
  if (args.length === 0) {
    // Display all variables
    const all = env.getAll();
    const lines: string[] = [];
    for (const [k, v] of all) lines.push(`${k}='${v}'`);
    return { output: lines.sort().join('\n') + '\n', exitCode: 0 };
  }

  // set -- args: reset positional
  if (args[0] === '--') {
    env.setPositionalArgs(args.slice(1));
    return { output: '', exitCode: 0 };
  }

  // Parse shell options: -e, +e, -o name, +o name, etc.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' && i + 1 < args.length) {
      setShellOpt(env, args[++i], true);
    } else if (arg === '+o' && i + 1 < args.length) {
      setShellOpt(env, args[++i], false);
    } else if (arg.startsWith('-') && arg.length > 1 && arg !== '--') {
      for (let j = 1; j < arg.length; j++) {
        const optName = SET_FLAG_MAP[arg[j]];
        if (optName) setShellOpt(env, optName, true);
      }
    } else if (arg.startsWith('+') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const optName = SET_FLAG_MAP[arg[j]];
        if (optName) setShellOpt(env, optName, false);
      }
    }
  }

  return { output: '', exitCode: 0 };
}

/** Enable or disable a shell option in SHELLOPTS. */
function setShellOpt(env: Environment, optName: string, enable: boolean): void {
  const current = env.get('SHELLOPTS') ?? '';
  const opts = new Set(current.split(':').filter(Boolean));
  if (enable) {
    opts.add(optName);
  } else {
    opts.delete(optName);
  }
  const value = [...opts].sort().join(':');
  try { env.set('SHELLOPTS', value); } catch { /* readonly */ }
}

// ─── declare / readonly ─────────────────────────────────────────

function builtinDeclare(args: string[], env: Environment, forceReadonly = false): BuiltinResult {
  const cmdName = forceReadonly ? 'readonly' : 'declare';
  let isReadonly = forceReadonly;
  let isExport = false;
  let isAssoc = false;
  let isIndexed = false;
  let printMode = false;
  const varArgs: string[] = [];

  // Parse flags
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-r') { isReadonly = true; }
    else if (arg === '-x') { isExport = true; }
    else if (arg === '-A') { isAssoc = true; }
    else if (arg === '-a') { isIndexed = true; }
    else if (arg === '-i') { /* integer: accept but ignore */ }
    else if (arg === '-p') { printMode = true; }
    else if (arg.startsWith('-') && arg.length > 1) {
      // Combined flags like -rx, -rA, -Ag, etc.
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === 'r') isReadonly = true;
        else if (arg[j] === 'x') isExport = true;
        else if (arg[j] === 'A') isAssoc = true;
        else if (arg[j] === 'a') isIndexed = true;
        else if (arg[j] === 'p') printMode = true;
      }
    } else {
      varArgs.push(arg);
    }
  }

  // Print mode: declare -p [name] or readonly -p
  if (printMode || (forceReadonly && varArgs.length === 0 && args.includes('-p'))) {
    return declarePrint(varArgs, env, cmdName, forceReadonly);
  }

  // List readonly variables when readonly with no args
  if (forceReadonly && varArgs.length === 0 && args.length === 0) {
    return declarePrint([], env, cmdName, true);
  }

  let exitCode = 0;
  let output = '';
  for (const arg of varArgs) {
    const eqIdx = arg.indexOf('=');
    const name = eqIdx >= 0 ? arg.substring(0, eqIdx) : arg;

    // Validate identifier
    if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name)) {
      output += `bash: ${cmdName}: \`${arg}': not a valid identifier\n`;
      exitCode = 1;
      continue;
    }

    // `declare -A name` (or -A with no value) creates an empty assoc map.
    if (isAssoc && eqIdx < 0) env.declareAssoc(name);
    if (isIndexed && eqIdx < 0 && !env.getArray(name)) env.setArray(name, []);

    if (eqIdx >= 0) {
      const value = arg.substring(eqIdx + 1);
      try {
        env.set(name, value);
      } catch {
        output += `bash: ${cmdName}: ${name}: readonly variable\n`;
        exitCode = 1;
        continue;
      }
    }
    if (isReadonly) env.setReadonly(name);
    if (isExport) env.export(name);
  }
  return { output, exitCode };
}

/** Print variable declarations for declare -p / readonly -p. */
function declarePrint(names: string[], env: Environment, cmdName: string, readonlyOnly: boolean): BuiltinResult {
  if (names.length > 0) {
    let output = '';
    let exitCode = 0;
    for (const name of names) {
      const val = env.get(name);
      if (val === undefined) {
        output += `bash: ${cmdName}: ${name}: not found\n`;
        exitCode = 1;
      } else {
        const flags = env.isReadonly(name) ? '-r' : '--';
        output += `declare ${flags} ${name}="${val}"\n`;
      }
    }
    return { output, exitCode };
  }
  // List all (or readonly only)
  const all = env.getAll();
  const lines: string[] = [];
  for (const [k, v] of all) {
    if (readonlyOnly && !env.isReadonly(k)) continue;
    const flags = env.isReadonly(k) ? '-r' : '--';
    lines.push(`declare ${flags} ${k}="${v}"`);
  }
  return { output: lines.sort().join('\n') + (lines.length ? '\n' : ''), exitCode: 0 };
}

// ─── let ────────────────────────────────────────────────────────

function builtinLet(args: string[], env: Environment): BuiltinResult {
  if (args.length === 0) {
    return { output: 'bash: let: expression expected\n', exitCode: 1 };
  }

  let result = 0;
  for (const expr of args) {
    try {
      // Handle assignment: var=expr
      const eqIdx = expr.indexOf('=');
      if (eqIdx >= 0 && /^[a-zA-Z_]/.test(expr)) {
        const name = expr.substring(0, eqIdx);
        const value = evaluateArithmetic(expr.substring(eqIdx + 1), env);
        env.set(name, value);
        result = parseInt(value);
      } else {
        result = parseInt(evaluateArithmetic(expr, env));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `bash: let: ${msg}\n`, exitCode: 1 };
    }
  }
  // let returns 1 if last expression is 0, else 0
  return { output: '', exitCode: result === 0 ? 1 : 0 };
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
    return { output: 'getopts: usage: getopts optstring name [args]\n', exitCode: 2 };
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
    return { output: silent ? '' : `bash: illegal option -- ${flag}\n`, exitCode: 0 };
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
      return { output: silent ? '' : `bash: option requires an argument -- ${flag}\n`, exitCode: 0 };
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
  if (args.length === 0) {
    const out: string[] = [];
    for (const [sig, body] of env.listTraps()) {
      out.push(`trap -- '${body.replace(/'/g, `'\\''`)}' ${sig}`);
    }
    return { output: out.join('\n') + (out.length ? '\n' : ''), exitCode: 0 };
  }
  if (args[0] === '-l') {
    return {
      output: 'EXIT HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM\n',
      exitCode: 0,
    };
  }
  // Clear form: `trap - SIG …` removes the handlers.
  if (args[0] === '-') {
    for (const sig of args.slice(1)) env.clearTrap(normalizeSig(sig));
    return { output: '', exitCode: 0 };
  }
  const action = args[0];
  const signals = args.slice(1);
  if (signals.length === 0) {
    return { output: 'trap: usage: trap [-lp] [[arg] signal_spec …]\n', exitCode: 2 };
  }
  for (const sig of signals) {
    env.setTrap(normalizeSig(sig), action);
  }
  return { output: '', exitCode: 0 };
}

function normalizeSig(sig: string): string {
  const s = sig.toUpperCase();
  if (s === '0') return 'EXIT';
  return s.startsWith('SIG') ? s.slice(3) : s;
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
  _io: BuiltinIO | undefined,
  pipeInput?: string,
): BuiltinResult {
  let trim = false;
  let count = Number.POSITIVE_INFINITY;
  let origin = 0;
  let skip = 0;
  let delim = '\n';
  let name = 'MAPFILE';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t') { trim = true; continue; }
    if (a === '-n') { count = Number.parseInt(args[++i] ?? '0', 10) || 0; continue; }
    if (a === '-O') { origin = Number.parseInt(args[++i] ?? '0', 10) || 0; continue; }
    if (a === '-s') { skip = Number.parseInt(args[++i] ?? '0', 10) || 0; continue; }
    if (a === '-d') { delim = args[++i] ?? '\n'; if (delim === '') delim = '\0'; continue; }
    if (a === '-u' || a === '-c' || a === '-C') { i++; continue; } // accepted, ignored
    if (a.startsWith('-')) continue;
    name = a;
  }
  const source = pipeInput ?? '';
  const lines = source.length === 0 ? [] : source.split(delim);
  if (source.endsWith(delim)) lines.pop();
  const sliced = lines.slice(skip, count === Number.POSITIVE_INFINITY ? undefined : skip + count);
  const values = sliced.map(l => trim ? l : l + delim);
  // Pad with empty slots when origin > 0 so the new elements land at
  // the requested offset (matches bash semantics).
  const final = new Array<string>(Math.max(0, origin)).fill('').concat(values);
  env.setArray(name, final);
  return { output: '', exitCode: 0 };
}
