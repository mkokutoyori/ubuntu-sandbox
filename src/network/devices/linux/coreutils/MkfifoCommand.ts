import { applyMode, compileMode } from '../ChmodMode';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'mode', letter: 'm', takesArgument: true },
  { name: 'context', letter: 'Z', takesArgument: false, optionalArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export function runMkfifo(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  let modeText: string | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'm:Z', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('mkfifo', getoptDiagnostic('mkfifo', item));
    switch (item.letter) {
      case 'H': return docsResult('mkfifo', 'help');
      case 'V': return docsResult('mkfifo', 'version');
      case 'm': modeText = item.argument ?? ''; break;
      default: break;
    }
  }
  const streams = new Streams();
  if (operands.length === 0) return usageFailure('mkfifo', 'mkfifo: missing operand');
  let mode = 0o666 & ~ctx.umask;
  if (modeText !== null) {
    const spec = compileMode(modeText);
    if (spec === null) {
      streams.diagnostic('mkfifo: invalid mode');
      streams.exitCode = 1;
      return streams.result();
    }
    mode = applyMode(spec, 0o666, false, ctx.umask);
  }
  const actor = actorOf(ctx);
  for (const operand of operands) {
    const path = ctx.vfs.path(operand, ctx.cwd, actor);
    const fail = (reason: string): void => {
      streams.diagnostic(`mkfifo: cannot create fifo ${quoteShell(operand)}: ${reason}`);
      streams.exitCode = 1;
    };
    if (path.lexists()) { fail('File exists'); continue; }
    const parent = path.parent().inode();
    if (parent === null) { fail('No such file or directory'); continue; }
    if (parent.type !== 'directory') { fail('Not a directory'); continue; }
    if (ctx.uid !== 0 && !path.parent().isWritableDir()) { fail('Permission denied'); continue; }
    if (!ctx.vfs.createFifo(path.value, mode, ctx.uid, ctx.gid)) fail('No such file or directory');
  }
  return streams.result();
}
