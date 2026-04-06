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
  'shift', 'type', 'source', '.', 'declare', 'readonly', 'let',
  'eval',
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
    case 'read': return builtinRead(args, env);
    case 'type': return builtinType(args, functions);
    case 'set': return builtinSet(args, env);
    case 'source': case '.': return { output: '', exitCode: 0 }; // handled at higher level
    case 'declare': return builtinDeclare(args, env, false);
    case 'readonly': return builtinDeclare(args, env, true);
    case 'let': return builtinLet(args, env);
    case 'eval': return { output: '', exitCode: 0 }; // handled at higher level
    default: return { output: '', exitCode: 127 };
  }
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
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const eqIdx = arg.indexOf('=');
    if (eqIdx >= 0) {
      env.export(arg.substring(0, eqIdx), arg.substring(eqIdx + 1));
    } else {
      env.export(arg);
    }
  }
  return { output: '', exitCode: 0 };
}

// ─── unset ──────────────────────────────────────────────────────

function builtinUnset(args: string[], env: Environment): BuiltinResult {
  for (const arg of args) {
    if (!arg.startsWith('-')) env.unset(arg);
  }
  return { output: '', exitCode: 0 };
}

// ─── Flow Control ───────────────────────────────────────────────

function builtinExit(args: string[]): BuiltinResult {
  const code = args.length > 0 ? parseInt(args[0]) || 0 : 0;
  throw new ExitSignal(code);
}

function builtinReturn(args: string[]): BuiltinResult {
  const code = args.length > 0 ? parseInt(args[0]) || 0 : 0;
  throw new ReturnSignal(code);
}

function builtinBreak(args: string[]): BuiltinResult {
  const levels = args.length > 0 ? parseInt(args[0]) || 1 : 1;
  throw new BreakSignal(levels);
}

function builtinContinue(args: string[]): BuiltinResult {
  const levels = args.length > 0 ? parseInt(args[0]) || 1 : 1;
  throw new ContinueSignal(levels);
}

// ─── shift ──────────────────────────────────────────────────────

function builtinShift(args: string[], env: Environment): BuiltinResult {
  const n = args.length > 0 ? parseInt(args[0]) || 1 : 1;
  const current = env.getPositionalArgs();
  env.setPositionalArgs(current.slice(n));
  return { output: '', exitCode: 0 };
}

// ─── local ──────────────────────────────────────────────────────

function builtinLocal(args: string[], env: Environment): BuiltinResult {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const eqIdx = arg.indexOf('=');
    if (eqIdx >= 0) {
      const name = arg.substring(0, eqIdx);
      let value = arg.substring(eqIdx + 1);
      // If value is empty and next arg exists (split assignment: VAR= value), use next arg
      if (!value && i + 1 < args.length && !args[i + 1].includes('=')) {
        value = args[i + 1];
        i++;
      }
      try {
        env.set(name, value);
      } catch {
        // readonly variable
      }
    } else {
      if (!env.isSet(arg)) env.set(arg, '');
    }
    i++;
  }
  return { output: '', exitCode: 0 };
}

// ─── read ───────────────────────────────────────────────────────

function builtinRead(args: string[], env: Environment): BuiltinResult {
  // Simplified: in simulator context, read just sets empty values
  for (const arg of args) {
    if (!arg.startsWith('-')) env.set(arg, '');
  }
  return { output: '', exitCode: 0 };
}

// ─── type ───────────────────────────────────────────────────────

function builtinType(args: string[], functions: Map<string, Command>): BuiltinResult {
  const outputs: string[] = [];
  let exitCode = 0;
  for (const name of args) {
    if (BUILTIN_NAMES.has(name)) {
      outputs.push(`${name} is a shell builtin\n`);
    } else if (functions.has(name)) {
      outputs.push(`${name} is a function\n`);
    } else {
      outputs.push(`bash: type: ${name}: not found\n`);
      exitCode = 1;
    }
  }
  return { output: outputs.join(''), exitCode };
}

// ─── set ────────────────────────────────────────────────────────

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
  return { output: '', exitCode: 0 };
}

// ─── declare / readonly ─────────────────────────────────────────

function builtinDeclare(args: string[], env: Environment, forceReadonly = false): BuiltinResult {
  const isReadonly = forceReadonly || args.includes('-r');
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const eqIdx = arg.indexOf('=');
    if (eqIdx >= 0) {
      const name = arg.substring(0, eqIdx);
      const value = arg.substring(eqIdx + 1);
      try {
        env.set(name, value);
      } catch {
        return { output: `bash: declare: ${name}: readonly variable\n`, exitCode: 1 };
      }
      if (isReadonly) env.setReadonly(name);
    } else {
      if (isReadonly) env.setReadonly(arg);
    }
  }
  return { output: '', exitCode: 0 };
}

// ─── let ────────────────────────────────────────────────────────

function builtinLet(args: string[], env: Environment): BuiltinResult {
  let result = 0;
  for (const expr of args) {
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
  }
  // let returns 1 if last expression is 0, else 0
  return { output: '', exitCode: result === 0 ? 1 : 0 };
}
