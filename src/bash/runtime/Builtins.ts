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
): BuiltinResult {
  switch (name) {
    case 'echo': return builtinEcho(args);
    case 'printf': return builtinPrintf(args, env);
    case 'pwd': return { output: (env.get('PWD') ?? '/') + '\n', exitCode: 0 };
    case 'cd': return builtinCd(args, env);
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

  while (start < args.length) {
    if (args[start] === '-n') { newline = false; start++; }
    else if (args[start] === '-e') { escapes = true; start++; }
    else if (args[start] === '-E') { escapes = false; start++; }
    else break;
  }

  let text = args.slice(start).join(' ');
  if (escapes) {
    text = text
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  }

  return { output: text + (newline ? '\n' : ''), exitCode: 0 };
}

// ─── printf ─────────────────────────────────────────────────────

function builtinPrintf(args: string[], env: Environment): BuiltinResult {
  if (args.length === 0) return { output: '', exitCode: 1 };
  const format = args[0];
  const fmtArgs = args.slice(1);
  let output = '';
  let argIdx = 0;

  for (let i = 0; i < format.length; i++) {
    if (format[i] === '%' && i + 1 < format.length) {
      i++;
      const arg = fmtArgs[argIdx++] ?? '';
      switch (format[i]) {
        case 's': output += arg; break;
        case 'd': output += String(parseInt(arg) || 0); break;
        case '%': output += '%'; argIdx--; break;
        default: output += '%' + format[i];
      }
    } else if (format[i] === '\\' && i + 1 < format.length) {
      i++;
      switch (format[i]) {
        case 'n': output += '\n'; break;
        case 't': output += '\t'; break;
        case '\\': output += '\\'; break;
        default: output += '\\' + format[i];
      }
    } else {
      output += format[i];
    }
  }
  return { output, exitCode: 0 };
}

// ─── cd ─────────────────────────────────────────────────────────

function builtinCd(args: string[], env: Environment): BuiltinResult {
  let target = args[0] ?? env.get('HOME') ?? '/';
  if (target === '~') target = env.get('HOME') ?? '/';
  else if (target.startsWith('~/')) target = (env.get('HOME') ?? '/') + target.slice(1);
  else if (target === '-') target = env.get('OLDPWD') ?? env.get('HOME') ?? '/';

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

  env.set('OLDPWD', cwd);
  env.set('PWD', resolved);
  return { output: '', exitCode: 0 };
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
