import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import type { INode } from '../VirtualFileSystem';
import { argumentFailure } from './BackupControl';
import { Streams, docsResult, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'force', letter: 'f', takesArgument: false },
  { name: 'interactive', letter: 'i', takesArgument: false, optionalArgument: true },
  { name: 'one-file-system', letter: 'O', takesArgument: false },
  { name: 'no-preserve-root', letter: 'N', takesArgument: false },
  { name: 'preserve-root', letter: 'P', takesArgument: false, optionalArgument: true },
  { name: 'recursive', letter: 'r', takesArgument: false },
  { name: 'dir', letter: 'd', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

type Interaction = 'never' | 'once' | 'always';

const WHEN_CHOICES: ReadonlyArray<readonly [string, Interaction]> = [
  ['never', 'never'], ['no', 'never'], ['none', 'never'], ['once', 'once'], ['always', 'always'], ['yes', 'always'],
];

function describeKind(inode: INode): string {
  if (inode.type === 'directory') return 'directory';
  if (inode.type === 'symlink') return 'symbolic link';
  if (inode.type === 'file') return inode.size === 0 ? 'regular empty file' : 'regular file';
  return 'special file';
}

export function runRm(ctx: ShellContext, args: readonly string[], stdin: string | undefined): CoreutilsRun {
  let force = false;
  let interaction: Interaction = 'never';
  let recursive = false;
  let directories = false;
  let verbose = false;
  let preserveRoot = true;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'dfiIrRv', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('rm', getoptDiagnostic('rm', item));
    switch (item.letter) {
      case 'H': return docsResult('rm', 'help');
      case 'V': return docsResult('rm', 'version');
      case 'f': force = true; interaction = 'never'; break;
      case 'i':
        if (item.argument === undefined) { interaction = 'always'; force = false; break; }
        {
          const match = WHEN_CHOICES.find(([name]) => name === item.argument);
          if (match === undefined) {
            return usageFailure('rm', argumentFailure('rm', 'invalid', item.argument, '--interactive', ['never, no, none', 'once', 'always, yes']));
          }
          interaction = match[1];
          force = false;
        }
        break;
      case 'I': interaction = 'once'; force = false; break;
      case 'r': case 'R': recursive = true; break;
      case 'd': directories = true; break;
      case 'v': verbose = true; break;
      case 'N': preserveRoot = false; break;
      default: break;
    }
  }
  const streams = new Streams();
  if (operands.length === 0) {
    if (force) return streams.result();
    return usageFailure('rm', 'rm: missing operand');
  }
  const answers = (stdin ?? '').split('\n');
  const ask = (question: string): boolean => {
    streams.stderr(question);
    const answer = answers.shift();
    return answer !== undefined && /^[yY]/.test(answer);
  };
  const actor = actorOf(ctx);
  if (interaction === 'once' && (operands.length > 3 || recursive)) {
    const noun = operands.length === 1 ? 'argument' : 'arguments';
    if (!ask(`rm: remove ${operands.length} ${noun}${recursive ? ' recursively' : ''}? `)) return streams.result();
  }

  const fail = (shown: string, reason: string): void => {
    streams.diagnostic(`rm: cannot remove ${quoteShell(shown)}: ${reason}`);
    streams.exitCode = 1;
  };
  const denied = (absPath: string): string | null => {
    if (ctx.uid === 0) return null;
    const path = ctx.vfs.path(absPath, '/', actor);
    const inode = path.lstatNode();
    const parent = path.parent();
    const parentInode = parent.inode();
    if (parentInode === null || inode === null) return null;
    if (!parent.canWrite() || !parent.canExecute()) return 'Permission denied';
    if ((parentInode.permissions & 0o1000) !== 0 && inode.uid !== ctx.uid && parentInode.uid !== ctx.uid) return 'Operation not permitted';
    return null;
  };

  const removeEntry = (shown: string, absPath: string, inode: INode, topLevel: boolean): boolean => {
    if (inode.type === 'directory') {
      if (!recursive) {
        if (!directories) { fail(shown, 'Is a directory'); return false; }
        if (inode.children.size > 2) { fail(shown, 'Directory not empty'); return false; }
        if (interaction === 'always' && !ask(`rm: remove directory ${quoteShell(shown)}? `)) return false;
        const reason = denied(absPath);
        if (reason !== null) { fail(shown, reason); return false; }
        ctx.vfs.rmdir(absPath);
        if (verbose) streams.stdout(`removed directory ${quoteShell(shown)}\n`);
        return true;
      }
      if (interaction === 'always' && !ask(`rm: descend into directory ${quoteShell(shown)}? `)) return false;
      let emptied = true;
      const entries = ctx.vfs.listDirectory(absPath) ?? [];
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        const childShown = `${shown.replace(/\/+$/, '')}/${entry.name}`;
        const childPath = `${absPath.replace(/\/$/, '')}/${entry.name}`;
        const child = ctx.vfs.resolveInode(childPath, false);
        if (child === null) continue;
        if (!removeEntry(childShown, childPath, child, false)) emptied = false;
      }
      if (!emptied) return false;
      if (interaction === 'always' && !ask(`rm: remove directory ${quoteShell(shown)}? `)) return false;
      const reason = denied(absPath);
      if (reason !== null) { fail(shown, reason); return false; }
      ctx.vfs.rmdir(absPath);
      if (verbose) streams.stdout(`removed directory ${quoteShell(shown)}\n`);
      return true;
    }
    if (interaction === 'always' && !ask(`rm: remove ${describeKind(inode)} ${quoteShell(shown)}? `)) return false;
    const reason = denied(absPath);
    if (reason !== null) { fail(shown, reason); return false; }
    ctx.vfs.deleteFile(absPath);
    if (verbose) streams.stdout(`removed ${quoteShell(shown)}\n`);
    void topLevel;
    return true;
  };

  for (const operand of operands) {
    const trimmed = operand.replace(/\/+$/, '') || operand;
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    if ((base === '.' || base === '..') && (recursive || directories)) {
      streams.diagnostic(`rm: refusing to remove '.' or '..' directory: skipping ${quoteShell(operand)}`);
      streams.exitCode = 1;
      continue;
    }
    const absPath = ctx.vfs.normalizePath(operand, ctx.cwd);
    if (absPath === '/' && recursive && preserveRoot) {
      streams.diagnostic("rm: it is dangerous to operate recursively on '/'");
      streams.diagnostic('rm: use --no-preserve-root to override this failsafe');
      streams.exitCode = 1;
      continue;
    }
    const inode = ctx.vfs.resolveInode(absPath, false);
    if (inode === null) {
      if (!force) fail(operand, 'No such file or directory');
      continue;
    }
    removeEntry(operand, absPath, inode, true);
  }
  return streams.result();
}
