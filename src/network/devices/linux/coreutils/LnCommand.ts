import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import type { INode } from '../VirtualFileSystem';
import type { PathActor } from '../VfsPath';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { makeBackup, parseBackupControl, type BackupControl } from './BackupControl';
import { Streams, docsResult, quoteLocale, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'backup', letter: 'B', takesArgument: false, optionalArgument: true },
  { name: 'directory', letter: 'd', takesArgument: false },
  { name: 'force', letter: 'f', takesArgument: false },
  { name: 'interactive', letter: 'i', takesArgument: false },
  { name: 'logical', letter: 'L', takesArgument: false },
  { name: 'no-dereference', letter: 'n', takesArgument: false },
  { name: 'physical', letter: 'P', takesArgument: false },
  { name: 'relative', letter: 'r', takesArgument: false },
  { name: 'symbolic', letter: 's', takesArgument: false },
  { name: 'suffix', letter: 'S', takesArgument: true },
  { name: 'target-directory', letter: 't', takesArgument: true },
  { name: 'no-target-directory', letter: 'T', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

function mayLinkSource(ctx: ShellContext, node: INode | null, actor: PathActor): boolean {
  if (node === null || actor.uid === 0 || node.uid === actor.uid) return true;
  if (ctx.vfs.readFile('/proc/sys/fs/protected_hardlinks')?.trim() !== '1') return true;
  if (node.type !== 'file') return false;
  if ((node.permissions & 0o4000) !== 0) return false;
  if ((node.permissions & 0o2010) === 0o2010) return false;
  return ctx.vfs.checkAccess(node, 'r', actor.uid, actor.gid, [...actor.gids])
    && ctx.vfs.checkAccess(node, 'w', actor.uid, actor.gid, [...actor.gids]);
}

function relativeTarget(linkPath: string, targetPath: string): string {
  const base = linkPath.split('/').slice(1, -1);
  const goal = targetPath.split('/').slice(1);
  let common = 0;
  while (common < base.length && common < goal.length && base[common] === goal[common]) common++;
  return [...base.slice(common).map(() => '..'), ...goal.slice(common)].join('/') || '.';
}

export function runLn(ctx: ShellContext, args: readonly string[], stdin: string | undefined): CoreutilsRun {
  let symbolic = false;
  let force = false;
  let interactive = false;
  let noDereference = false;
  let verbose = false;
  let relative = false;
  let noTargetDirectory = false;
  let backup: BackupControl = 'none';
  let suffix = '~';
  let targetDirectory: string | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'bdfinrsS:t:vFLPT', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('ln', getoptDiagnostic('ln', item));
    switch (item.letter) {
      case 'H': return docsResult('ln', 'help');
      case 'V': return docsResult('ln', 'version');
      case 's': symbolic = true; break;
      case 'f': force = true; interactive = false; break;
      case 'i': interactive = true; force = false; break;
      case 'n': noDereference = true; break;
      case 'v': verbose = true; break;
      case 'r': relative = true; break;
      case 'T': noTargetDirectory = true; break;
      case 'b': backup = 'existing'; break;
      case 'B': {
        const control = parseBackupControl('ln', item.argument);
        if (control.includes('\n')) return usageFailure('ln', control);
        backup = control as BackupControl;
        break;
      }
      case 'S': suffix = item.argument ?? '~'; if (backup === 'none') backup = 'existing'; break;
      case 't': targetDirectory = item.argument ?? null; break;
      default: break;
    }
  }
  if (targetDirectory !== null && noTargetDirectory) {
    return usageFailure('ln', 'ln: cannot combine --target-directory and --no-target-directory');
  }
  if (operands.length === 0 && targetDirectory === null) return usageFailure('ln', 'ln: missing file operand');
  if (operands.length === 0) return usageFailure('ln', 'ln: missing file operand');
  if (noTargetDirectory && operands.length > 2) return usageFailure('ln', `ln: extra operand ${quoteLocale(operands[2])}`);
  if (operands.length === 1 && targetDirectory === null && noTargetDirectory) {
    return usageFailure('ln', `ln: missing destination file operand after ${quoteLocale(operands[0])}`);
  }

  const streams = new Streams();
  const actor = actorOf(ctx);
  const answers = (stdin ?? '').split('\n');
  const isDirectory = (name: string): boolean => {
    if (name === '') return false;
    const path = ctx.vfs.path(name, ctx.cwd, actor);
    const node = noDereference ? path.lstatNode() : path.inode();
    return node !== null && node.type === 'directory';
  };

  let sources: string[];
  let destination: string | null;
  let intoDirectory: boolean;
  if (targetDirectory !== null) {
    sources = operands;
    destination = targetDirectory;
    if (!isDirectory(targetDirectory)) {
      const exists = ctx.vfs.path(targetDirectory, ctx.cwd, actor).lexists();
      streams.diagnostic(exists ? `ln: target ${quoteShell(targetDirectory)} is not a directory` : `ln: failed to access ${quoteShell(targetDirectory)}: No such file or directory`);
      streams.exitCode = 1;
      return streams.result();
    }
    intoDirectory = true;
  } else if (operands.length === 1) {
    sources = operands;
    destination = '.';
    intoDirectory = true;
  } else {
    destination = operands[operands.length - 1];
    sources = operands.slice(0, -1);
    intoDirectory = !noTargetDirectory && isDirectory(destination);
    if (sources.length > 1 && !intoDirectory) {
      const exists = ctx.vfs.path(destination, ctx.cwd, actor).lexists();
      streams.diagnostic(`ln: target ${quoteShell(destination)}: ${exists ? 'Not a directory' : 'No such file or directory'}`);
      streams.exitCode = 1;
      return streams.result();
    }
  }

  const kind = symbolic ? 'symbolic' : 'hard';
  for (const source of sources) {
    const trimmed = source.replace(/\/+$/, '') || source;
    const name = trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
    const linkText = destination === '' && !intoDirectory ? '' : intoDirectory ? `${(destination as string) === '.' ? '.' : (destination as string).replace(/\/+$/, '')}/${name}` : (destination as string);
    const linkPath = ctx.vfs.path(linkText, ctx.cwd, actor);
    const fail = (reason: string): void => {
      const shows = symbolic ? source === '' : reason !== 'File exists';
      streams.diagnostic(`ln: failed to create ${kind} link ${quoteShell(linkText)}${shows ? ` ${symbolic ? '->' : '=>'} ${quoteShell(source)}` : ''}: ${reason}`);
      streams.exitCode = 1;
    };
    if (linkText === '' || (symbolic && source === '')) { fail('No such file or directory'); continue; }
    const sourcePath = ctx.vfs.path(source, ctx.cwd, actor);
    if (!symbolic) {
      const node = sourcePath.lstatNode();
      if (node === null) {
        streams.diagnostic(`ln: failed to access ${quoteShell(source)}: No such file or directory`);
        streams.exitCode = 1;
        continue;
      }
      if (node.type === 'directory') {
        streams.diagnostic(`ln: ${source}: hard link not allowed for directory`);
        streams.exitCode = 1;
        continue;
      }
    }
    if (ctx.uid !== 0 && linkPath.parent().inode() && !linkPath.parent().isWritableDir()) { fail('Permission denied'); continue; }
    if (!symbolic && !mayLinkSource(ctx, sourcePath.lstatNode(), actor)) { fail('Operation not permitted'); continue; }
    const parentNode = linkPath.parent().inode();
    if (parentNode === null) { fail('No such file or directory'); continue; }
    if (parentNode.type !== 'directory') { fail('Not a directory'); continue; }
    const existing = linkPath.lstatNode();
    if (existing !== null) {
      if (!symbolic && sourcePath.lstatNode()?.id === existing.id) {
        if (force) continue;
        fail('File exists');
        continue;
      }
      if (interactive) {
        streams.stderr(`ln: replace ${quoteShell(linkText)}? `);
        const answer = answers.shift();
        if (answer === undefined || !/^[yY]/.test(answer)) { streams.exitCode = 1; continue; }
      } else if (!force && backup === 'none') { fail('File exists'); continue; }
      if (backup !== 'none') makeBackup(ctx.vfs, linkPath.value, backup, suffix);
      else if (existing.type === 'directory') { fail('File exists'); continue; }
      else ctx.vfs.deleteFile(linkPath.value);
    }
    let target = source;
    if (symbolic && relative) target = relativeTarget(linkPath.value, ctx.vfs.normalizePath(source, ctx.cwd));
    if (symbolic) {
      if (!ctx.vfs.createSymlink(linkPath.value, target, ctx.uid, ctx.gid)) { fail('No such file or directory'); continue; }
    } else if (!ctx.vfs.createHardLink(linkPath.value, sourcePath.value)) { fail('Invalid cross-device link'); continue; }
    if (verbose) streams.stdout(`${quoteShell(linkText)} ${symbolic ? '->' : '=>'} ${quoteShell(target)}\n`);
  }
  return streams.result();
}
