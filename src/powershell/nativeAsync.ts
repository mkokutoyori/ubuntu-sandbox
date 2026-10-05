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
  return rejoinSwitchValues(out);
}

function rejoinSwitchValues(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.endsWith('=') && token.length > 1 && i + 1 < argv.length) {
      out.push(token + argv[++i]);
      continue;
    }
    out.push(token);
  }
  return out;
}

export interface NativeResult {
  readonly output: string;
  readonly exitCode: number;
  readonly notRecognized?: boolean;
}

const NEEDS_QUOTES = /[\s"&|<>^()%]/;

export function quoteNativeArgument(argument: string): string {
  if (argument === '') return '""';
  return NEEDS_QUOTES.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument;
}

export class NativeCommandNeedsAsync extends PSRuntimeError {
  readonly command: string;
  readonly argv: readonly string[];
  readonly stdin: string | null;
  readonly commandLine: string;

  constructor(command: string, argv: readonly string[], stdin: string | null = null) {
    super(commandNotFoundMessage(command));
    this.name = 'NativeCommandNeedsAsync';
    this.command = command;
    this.argv = argv;
    this.stdin = stdin;
    this.commandLine = [command, ...argv.map(quoteNativeArgument)].join(' ').trim();
  }
}

export function nativeOutputValue(output: string): PSValue {
  if (output === '') return null;
  const lines = output.split(/\r?\n/);
  return lines.length === 1 ? lines[0] : lines;
}

export const CMD_NOT_RECOGNIZED = /is not recognized as an internal or external command/;

export function translateNativeAnswer(command: string, answer: string): string {
  return CMD_NOT_RECOGNIZED.test(answer) ? commandNotFoundMessage(command) : answer;
}

export function isNativeProgramName(name: string): boolean {
  return !/[\\/]/.test(name) && !/^[A-Za-z]:/.test(name);
}
