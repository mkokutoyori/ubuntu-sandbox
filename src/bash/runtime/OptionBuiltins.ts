import type { Environment } from './Environment';
import {
  SET_OPTIONS, SHOPT_OPTIONS, isShellOptionEnabled, setShellOption,
} from './ShellOptions';

export interface OptionResult {
  readonly output: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly positional?: string[];
}

function column(name: string, enabled: boolean): string {
  return `${name.padEnd(15)}\t${enabled ? 'on' : 'off'}\n`;
}

function listSetOptions(env: Environment, reusable: boolean): string {
  return SET_OPTIONS.map((option) => {
    const enabled = isShellOptionEnabled(env, option.name);
    return reusable ? `set ${enabled ? '-' : '+'}o ${option.name}\n` : column(option.name, enabled);
  }).join('');
}

export function runSet(args: readonly string[], env: Environment): OptionResult {
  let output = '';
  let stderr = '';
  let exitCode = 0;
  let index = 0;
  let positional: string[] | undefined;
  const apply = (name: string, enable: boolean): void => {
    if (!SET_OPTIONS.some((option) => option.name === name)) {
      stderr += `bash: set: ${name}: invalid option name\n`;
      exitCode = 1;
      return;
    }
    setShellOption(env, 'SHELLOPTS', name, enable);
  };
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') {
      positional = args.slice(index + 1) as string[];
      break;
    }
    if (arg === '-' || arg === '+') {
      positional = args.slice(index + 1) as string[];
      break;
    }
    if (!/^[-+]./.test(arg)) {
      positional = args.slice(index) as string[];
      break;
    }
    const enable = arg[0] === '-';
    for (let position = 1; position < arg.length; position++) {
      const letter = arg[position];
      if (letter === 'o') {
        const name = args[index + 1];
        if (name === undefined || /^[-+]/.test(name)) {
          output += listSetOptions(env, !enable);
          continue;
        }
        apply(name, enable);
        index++;
        continue;
      }
      const option = SET_OPTIONS.find((candidate) => candidate.letter === letter);
      if (option === undefined) {
        stderr += `bash: set: ${arg[0]}${letter}: invalid option\nset: usage: set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]\n`;
        return { output, stderr, exitCode: 2 };
      }
      apply(option.name, enable);
    }
    index++;
  }
  return { output, stderr, exitCode, positional };
}

export function runShopt(args: readonly string[], env: Environment): OptionResult {
  let mode: 's' | 'u' | null = null;
  let quiet = false;
  let reusable = false;
  let setStyle = false;
  const names: string[] = [];
  for (const arg of args) {
    if (/^-[squpo]+$/.test(arg) && names.length === 0) {
      for (const letter of arg.slice(1)) {
        if (letter === 's' || letter === 'u') mode = letter;
        else if (letter === 'q') quiet = true;
        else if (letter === 'p') reusable = true;
        else setStyle = true;
      }
      continue;
    }
    if (arg.startsWith('-') && names.length === 0 && arg.length > 1) {
      return { output: '', stderr: `bash: shopt: ${arg}: invalid option\nshopt: usage: shopt [-pqsu] [-o] [optname ...]\n`, exitCode: 2 };
    }
    names.push(arg);
  }
  const table = setStyle ? SET_OPTIONS.map((option) => option.name) : SHOPT_OPTIONS.map((option) => option.name);
  const variable = setStyle ? 'SHELLOPTS' : 'BASHOPTS';
  const known = new Set(table);
  let output = '';
  let stderr = '';
  let exitCode = 0;
  if (names.length === 0) {
    for (const name of table) {
      const enabled = isShellOptionEnabled(env, name);
      if (mode === 's' && !enabled) continue;
      if (mode === 'u' && enabled) continue;
      if (!quiet) output += reusable ? reusableLine(name, enabled, setStyle) : column(name, enabled);
    }
    return { output, stderr, exitCode };
  }
  for (const name of names) {
    if (!known.has(name)) {
      stderr += `bash: shopt: ${name}: invalid ${setStyle ? 'option name' : 'shell option name'}\n`;
      exitCode = 1;
      continue;
    }
    if (mode !== null) {
      setShellOption(env, variable, name, mode === 's');
      continue;
    }
    const enabled = isShellOptionEnabled(env, name);
    if (!enabled) exitCode = 1;
    if (!quiet) output += reusable ? reusableLine(name, enabled, setStyle) : column(name, enabled);
  }
  return { output, stderr, exitCode };
}

function reusableLine(name: string, enabled: boolean, setStyle: boolean): string {
  return setStyle ? `set ${enabled ? '-' : '+'}o ${name}\n` : `shopt -${enabled ? 's' : 'u'} ${name}\n`;
}
