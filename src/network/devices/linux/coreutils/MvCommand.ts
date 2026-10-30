import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { makeBackup, parseBackupControl, type BackupControl } from './BackupControl';
import { Streams, docsResult, quoteLocale, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'backup', letter: 'B', takesArgument: false, optionalArgument: true },
  { name: 'context', letter: 'Z', takesArgument: false },
  { name: 'force', letter: 'f', takesArgument: false },
  { name: 'interactive', letter: 'i', takesArgument: false },
  { name: 'no-clobber', letter: 'n', takesArgument: false },
  { name: 'no-target-directory', letter: 'T', takesArgument: false },
  { name: 'strip-trailing-slashes', letter: '9', takesArgument: false },
  { name: 'suffix', letter: 'S', takesArgument: true },
  { name: 'target-directory', letter: 't', takesArgument: true },
  { name: 'update', letter: 'u', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

export function mvOperands(args: readonly string[]): string[] {
  const operands: string[] = [];
  for (const item of shortOptions(args, 'bfinS:t:TuvZ', LONG_OPTIONS)) {
    if (item.kind === 'operand') operands.push(item.value);
  }
  return operands;
}

function baseOf(name: string): string {
  const trimmed = name.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export function runMv(ctx: ShellContext, args: readonly string[], stdin: string | undefined): CoreutilsRun {
  let noClobber = false;
  let interactive = false;
  let update = false;
  let verbose = false;
  let noTargetDirectory = false;
  let stripTrailingSlashes = false;
  let backup: BackupControl = 'none';
  let suffix = '~';
  let targetDirectory: string | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'bfinS:t:TuvZ', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('mv', getoptDiagnostic('mv', item));
    switch (item.letter) {
      case 'H': return docsResult('mv', 'help');
      case 'V': return docsResult('mv', 'version');
      case 'f': interactive = false; noClobber = false; break;
      case 'i': interactive = true; noClobber = false; break;
      case 'n': noClobber = true; interactive = false; break;
      case 'u': update = true; break;
      case 'v': verbose = true; break;
      case 'T': noTargetDirectory = true; break;
      case '9': stripTrailingSlashes = true; break;
      case 'b': backup = 'existing'; break;
      case 'B': {
        const control = parseBackupControl('mv', item.argument);
        if (control.includes('\n')) return usageFailure('mv', control);
        backup = control as BackupControl;
        break;
      }
      case 'S': suffix = item.argument ?? '~'; if (backup === 'none') backup = 'existing'; break;
      case 't': targetDirectory = item.argument ?? null; break;
      default: break;
    }
  }
  if (targetDirectory !== null && noTargetDirectory) {
    return usageFailure('mv', 'mv: cannot combine --target-directory (-t) and --no-target-directory (-T)');
  }
  if (operands.length === 0) return usageFailure('mv', 'mv: missing file operand');
  if (targetDirectory === null && operands.length === 1) {
    return usageFailure('mv', `mv: missing destination file operand after ${quoteLocale(operands[0])}`);
  }
  if (noTargetDirectory && operands.length > 2) return usageFailure('mv', `mv: extra operand ${quoteLocale(operands[2])}`);

  const streams = new Streams();
  const actor = actorOf(ctx);
  const answers = (stdin ?? '').split('\n');
  const sources = targetDirectory === null ? operands.slice(0, -1) : operands;
  const destination = targetDirectory ?? operands[operands.length - 1];
  const destinationPath = ctx.vfs.path(destination, ctx.cwd, actor);
  const destinationIsDirectory = destinationPath.isDirectory();
  if (targetDirectory !== null && !destinationIsDirectory) {
    streams.diagnostic(`mv: target directory ${quoteShell(destination)}: ${destinationPath.lexists() ? 'Not a directory' : 'No such file or directory'}`);
    streams.exitCode = 1;
    return streams.result();
  }
  if (sources.length > 1 && !destinationIsDirectory) {
    streams.diagnostic(`mv: target ${quoteShell(destination)}: ${destinationPath.lexists() ? 'Not a directory' : 'No such file or directory'}`);
    streams.exitCode = 1;
    return streams.result();
  }
  const intoDirectory = !noTargetDirectory && destinationIsDirectory;
  const fail = (message: string): void => {
    streams.diagnostic(`mv: ${message}`);
    streams.exitCode = 1;
  };

  for (const typed of sources) {
    const source = stripTrailingSlashes ? typed.replace(/\/+$/, '') || typed : typed;
    const sourcePath = ctx.vfs.path(source, ctx.cwd, actor);
    const sourceNode = sourcePath.lstatNode();
    if (sourceNode === null) { fail(`cannot stat ${quoteShell(typed)}: No such file or directory`); continue; }
    if (/\/$/.test(typed) && sourceNode.type !== 'directory' && !(sourceNode.type === 'symlink' && sourcePath.isDirectory())) {
      const shownSource = stripTrailingSlashes ? typed.replace(/\/+$/, '') : typed;
      fail(stripTrailingSlashes
        ? `cannot move ${quoteShell(shownSource)} to ${quoteShell(intoDirectory ? `${destination.replace(/\/+$/, '')}/${baseOf(source)}` : destination)}: Not a directory`
        : `cannot stat ${quoteShell(typed)}: Not a directory`);
      continue;
    }
    const shown = intoDirectory ? `${destination.replace(/\/+$/, '')}/${baseOf(source)}` : destination;
    const targetPath = ctx.vfs.path(shown, ctx.cwd, actor);
    const existing = targetPath.lstatNode();
    if (existing !== null && existing.id === sourceNode.id && sourcePath.value === targetPath.value) {
      fail(`${quoteShell(typed)} and ${quoteShell(shown)} are the same file`);
      continue;
    }
    const resolvedTarget = intoDirectory ? `${(ctx.vfs.realpath(destination, ctx.cwd) ?? destinationPath.value).replace(/\/$/, '')}/${baseOf(source)}` : targetPath.value;
    const resolvedSource = ctx.vfs.realpath(sourcePath.value, '/', false) ?? sourcePath.value;
    if (sourceNode.type === 'directory' && (resolvedTarget === resolvedSource || resolvedTarget.startsWith(`${resolvedSource}/`))) {
      fail(`cannot move ${quoteShell(typed)} to a subdirectory of itself, ${quoteShell(shown)}`);
      continue;
    }
    if (existing !== null) {
      const targetIsDirectory = targetPath.isDirectory();
      if (sourceNode.type === 'directory' && !targetIsDirectory) {
        fail(`cannot overwrite non-directory ${quoteShell(shown)} with directory ${quoteShell(typed)}`);
        continue;
      }
      if (sourceNode.type !== 'directory' && targetIsDirectory) {
        fail(`cannot overwrite directory ${quoteShell(shown)} with non-directory`);
        continue;
      }
      if (interactive) {
        streams.stderr(`mv: overwrite ${quoteShell(shown)}? `);
        const answer = answers.shift();
        if (answer === undefined || !/^[yY]/.test(answer)) { streams.exitCode = 1; continue; }
      } else if (noClobber) {
        continue;
      }
      if (update && existing.mtime >= sourceNode.mtime) continue;
      if (targetIsDirectory && (ctx.vfs.listDirectory(targetPath.value) ?? []).some((entry) => entry.name !== '.' && entry.name !== '..')) {
        fail(`cannot move ${quoteShell(typed)} to ${quoteShell(shown)}: Directory not empty`);
        continue;
      }
    }
    const parent = targetPath.parent().inode();
    if (parent === null) { fail(`cannot move ${quoteShell(typed)} to ${quoteShell(shown)}: No such file or directory`); continue; }
    if (parent.type !== 'directory') { fail(`cannot move ${quoteShell(typed)} to ${quoteShell(shown)}: Not a directory`); continue; }
    if (ctx.uid !== 0) {
      const sourceParent = sourcePath.parent();
      const sourceParentNode = sourceParent.inode();
      if (sourceParentNode && (!sourceParent.canWrite() || !sourceParent.canExecute())) {
        fail(`cannot move ${quoteShell(typed)} to ${quoteShell(shown)}: Permission denied`);
        continue;
      }
      if (sourceParentNode && (sourceParentNode.permissions & 0o1000) !== 0 && sourceNode.uid !== ctx.uid && sourceParentNode.uid !== ctx.uid) {
        fail(`cannot move ${quoteShell(typed)} to ${quoteShell(shown)}: Operation not permitted`);
        continue;
      }
      if (!targetPath.parent().isWritableDir()) {
        fail(`cannot move ${quoteShell(typed)} to ${quoteShell(shown)}: Permission denied`);
        continue;
      }
    }
    let backupName: string | null = null;
    if (existing !== null && backup !== 'none') backupName = makeBackup(ctx.vfs, targetPath.value, backup, suffix);
    if (!ctx.vfs.rename(sourcePath.value, targetPath.value)) { fail(`cannot move ${quoteShell(typed)} to ${quoteShell(shown)}`); continue; }
    if (verbose) {
      const note = backupName === null ? '' : ` (backup: ${quoteShell(shown + backupName.slice(targetPath.value.length))})`;
      streams.stdout(`renamed ${quoteShell(typed)} -> ${quoteShell(shown)}${note}\n`);
    }
  }
  return streams.result();
}
