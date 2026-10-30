import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'ignore-fail-on-non-empty', letter: 'I', takesArgument: false },
  { name: 'parents', letter: 'p', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export function runRmdir(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  let ignoreNonEmpty = false;
  let parents = false;
  let verbose = false;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'pv', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('rmdir', getoptDiagnostic('rmdir', item));
    switch (item.letter) {
      case 'H': return docsResult('rmdir', 'help');
      case 'V': return docsResult('rmdir', 'version');
      case 'I': ignoreNonEmpty = true; break;
      case 'p': parents = true; break;
      case 'v': verbose = true; break;
      default: break;
    }
  }
  if (operands.length === 0) return usageFailure('rmdir', 'rmdir: missing operand');
  const streams = new Streams();
  const actor = actorOf(ctx);
  const remove = (shown: string, parent = false): boolean => {
    const path = ctx.vfs.path(shown, ctx.cwd, actor);
    if (verbose) streams.stdout(`rmdir: removing directory, ${quoteShell(shown)}\n`);
    const inode = path.lstatNode();
    let reason: string | null = null;
    const base = shown.replace(/\/+$/, '').slice(shown.replace(/\/+$/, '').lastIndexOf('/') + 1);
    if (path.value === '/') reason = 'Device or resource busy';
    else if (base === '.') reason = 'Invalid argument';
    else if (inode === null) reason = 'No such file or directory';
    else if (inode.type !== 'directory') reason = 'Not a directory';
    else if (inode.children.size > 2) reason = 'Directory not empty';
    else if (ctx.uid !== 0) {
      const parent = path.parent();
      const parentInode = parent.inode();
      if (parentInode !== null && (!parent.canWrite() || !parent.canExecute())) reason = 'Permission denied';
      else if (parentInode !== null && (parentInode.permissions & 0o1000) !== 0 && inode.uid !== ctx.uid && parentInode.uid !== ctx.uid) reason = 'Operation not permitted';
    }
    if (reason === null) {
      ctx.vfs.rmdir(path.value);
      return true;
    }
    if (reason === 'Directory not empty' && ignoreNonEmpty) return false;
    streams.diagnostic(`rmdir: failed to remove ${parent ? 'directory ' : ''}${quoteShell(shown)}: ${reason}`);
    streams.exitCode = 1;
    return false;
  };
  for (const operand of operands) {
    if (!remove(operand)) continue;
    if (!parents) continue;
    let current = operand.replace(/\/+$/, '');
    for (;;) {
      const cut = current.lastIndexOf('/');
      if (cut <= 0) break;
      current = current.slice(0, cut).replace(/\/+$/, '');
      if (current === '' || !remove(current, true)) break;
    }
  }
  return streams.result();
}
