import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntimeError';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';

export function nativeArgv(positional: readonly PSValue[], named: Record<string, PSValue>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(named)) {
    if (value === true) { out.push(`-${key}`); continue; }
    if (value === false || value === null || value === undefined) continue;
    out.push(`-${key}`);
    out.push(psValueToString(value));
  }
  for (const p of positional) out.push(psValueToString(p));
  return out;
}

export class NativeCommandNeedsAsync extends PSRuntimeError {
  readonly command: string;
  readonly commandLine: string;

  constructor(command: string, args: readonly string[]) {
    super(commandNotFoundMessage(command));
    this.name = 'NativeCommandNeedsAsync';
    this.command = command;
    this.commandLine = [command, ...args].join(' ').trim();
  }
}

const CMD_NOT_RECOGNIZED = /is not recognized as an internal or external command/;

export function translateNativeAnswer(command: string, answer: string): string {
  return CMD_NOT_RECOGNIZED.test(answer) ? commandNotFoundMessage(command) : answer;
}

export function isNativeProgramName(name: string): boolean {
  return !/[\\/]/.test(name) && !/^[A-Za-z]:/.test(name);
}

export function nativeLineFor(failure: NativeCommandNeedsAsync, typed: string): string {
  const head = typed.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, '') ?? '';
  return head.toLowerCase() === failure.command.toLowerCase() ? typed.trim() : failure.commandLine;
}
