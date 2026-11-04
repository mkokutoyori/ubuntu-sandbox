import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import type { ShellContext } from '../LinuxFileCommands';
import { argumentFailure, matchArgument } from './BackupControl';
import { Streams, docsResult, quotef, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'append', letter: 'a', takesArgument: false },
  { name: 'ignore-interrupts', letter: 'i', takesArgument: false },
  { name: 'output-error', letter: 'E', takesArgument: false, optionalArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

type Mode = 'warn' | 'warn-nopipe' | 'exit' | 'exit-nopipe';

const MODES: readonly (readonly [string, Mode])[] = [
  ['warn', 'warn'], ['warn-nopipe', 'warn-nopipe'], ['exit', 'exit'], ['exit-nopipe', 'exit-nopipe'],
];

export function runTee(ctx: ShellContext, args: readonly string[], stdin: string): CoreutilsRun {
  let append = false;
  let mode: Mode | null = null;
  const files: string[] = [];
  const streams = new Streams();
  for (const item of shortOptions(args, 'aip', LONG_OPTIONS)) {
    if (item.kind === 'operand') { files.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('tee', getoptDiagnostic('tee', item));
    switch (item.letter) {
      case 'H': return docsResult('tee', 'help');
      case 'V': return docsResult('tee', 'version');
      case 'a': append = true; break;
      case 'E': {
        if (item.argument === undefined) { mode = 'warn-nopipe'; break; }
        const matched = matchArgument(item.argument, MODES);
        if (matched === 'invalid' || matched === 'ambiguous') {
          return usageFailure('tee', argumentFailure('tee', matched, item.argument, '--output-error', MODES.map(([name]) => name)));
        }
        mode = matched;
        break;
      }
      default: break;
    }
  }
  const exitOnError = mode === 'exit' || mode === 'exit-nopipe';
  const refusedAtWrite: string[] = [];
  for (const file of files) {
    const absolute = ctx.vfs.normalizePath(file, ctx.cwd);
    const refusal = ctx.openRefusal?.(absolute) ?? null;
    if (refusal !== null) {
      streams.diagnostic(`tee: ${quotef(file)}: ${refusal}`);
      streams.exitCode = 1;
      if (exitOnError) return streams.result();
      continue;
    }
    const written = ctx.vfs.writeFile(absolute, stdin, ctx.uid, ctx.gid, ctx.umask, append);
    if (!written && ctx.vfs.hasWriter(absolute)) refusedAtWrite.push(`tee: ${quotef(file)}: Invalid argument`);
  }
  const copied = refusedAtWrite.length === 0 || stdin.endsWith('\n') ? stdin : `${stdin}\n`;
  streams.stdout(copied);
  for (const line of refusedAtWrite) streams.diagnostic(line);
  if (refusedAtWrite.length > 0) streams.exitCode = 1;
  return streams.result();
}
