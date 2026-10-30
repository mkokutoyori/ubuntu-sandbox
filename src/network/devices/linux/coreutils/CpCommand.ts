import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import type { INode } from '../VirtualFileSystem';
import { argumentFailure, makeBackup, matchArgument, parseBackupControl, type BackupControl } from './BackupControl';
import { Streams, docsResult, quoteLocale, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'archive', letter: 'a', takesArgument: false },
  { name: 'attributes-only', letter: '1', takesArgument: false },
  { name: 'backup', letter: 'B', takesArgument: false, optionalArgument: true },
  { name: 'copy-contents', letter: '2', takesArgument: false },
  { name: 'dereference', letter: 'L', takesArgument: false },
  { name: 'force', letter: 'f', takesArgument: false },
  { name: 'interactive', letter: 'i', takesArgument: false },
  { name: 'link', letter: 'l', takesArgument: false },
  { name: 'no-clobber', letter: 'n', takesArgument: false },
  { name: 'no-dereference', letter: 'P', takesArgument: false },
  { name: 'no-preserve', letter: '3', takesArgument: true },
  { name: 'no-target-directory', letter: 'T', takesArgument: false },
  { name: 'one-file-system', letter: 'x', takesArgument: false },
  { name: 'parents', letter: '4', takesArgument: false },
  { name: 'preserve', letter: '5', takesArgument: false, optionalArgument: true },
  { name: 'recursive', letter: 'R', takesArgument: false },
  { name: 'reflink', letter: '6', takesArgument: false, optionalArgument: true },
  { name: 'remove-destination', letter: '7', takesArgument: false },
  { name: 'sparse', letter: '8', takesArgument: true },
  { name: 'strip-trailing-slashes', letter: '9', takesArgument: false },
  { name: 'suffix', letter: 'S', takesArgument: true },
  { name: 'symbolic-link', letter: 's', takesArgument: false },
  { name: 'target-directory', letter: 't', takesArgument: true },
  { name: 'update', letter: 'u', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'context', letter: 'Z', takesArgument: false, optionalArgument: true },
  { name: 'help', letter: '0', takesArgument: false },
  { name: 'version', letter: 'W', takesArgument: false },
];

const NO_CLOBBER_WARNING = 'cp: warning: behavior of -n is non-portable and may change in future; use --update=none instead';
const OPTSTRING = 'abdfHilLnpPRrsS:t:TuvxZ';
const PRESERVE_ATTRIBUTES = ['mode', 'timestamps', 'ownership', 'links', 'context', 'xattr'] as const;
type PreserveAttribute = typeof PRESERVE_ATTRIBUTES[number];
const PRESERVE_WORDS: readonly (readonly [string, readonly PreserveAttribute[]])[] = [
  ...PRESERVE_ATTRIBUTES.map((name) => [name, [name]] as const),
  ['all', PRESERVE_ATTRIBUTES],
];
const REFLINK_WORDS: readonly (readonly [string, 'auto' | 'always' | 'never'])[] = [['auto', 'auto'], ['always', 'always'], ['never', 'never']];
const SPARSE_WORDS: readonly (readonly [string, 'never' | 'auto' | 'always'])[] = [['never', 'never'], ['auto', 'auto'], ['always', 'always']];

export interface CpRequest {
  recursive: boolean;
  preserve: Set<PreserveAttribute>;
  noClobber: boolean;
  interactive: boolean;
  verbose: boolean;
  updateOnly: boolean;
  hardLink: boolean;
  symbolicLink: boolean;
  backup: BackupControl;
  suffix: string;
  noTargetDirectory: boolean;
  targetDirectory: string | null;
  dereference: 'always' | 'command-line' | 'never' | null;
  parents: boolean;
  removeDestination: boolean;
  attributesOnly: boolean;
  reflink: 'auto' | 'always' | 'never';
  operands: string[];
}

type Parsed = { request: CpRequest } | { early: CoreutilsRun };

function parseArguments(args: readonly string[]): Parsed {
  const request: CpRequest = {
    recursive: false, preserve: new Set(), noClobber: false, interactive: false, verbose: false, updateOnly: false,
    hardLink: false, symbolicLink: false, backup: 'none', suffix: '~', noTargetDirectory: false, targetDirectory: null,
    dereference: null, parents: false, removeDestination: false, attributesOnly: false,
    reflink: 'never', operands: [],
  };
  const addPreserve = (word: string | undefined, remove: boolean): string | null => {
    const names = (word ?? 'mode,ownership,timestamps').split(',');
    for (const name of names) {
      const matched = matchArgument(name, PRESERVE_WORDS);
      if (matched === 'invalid' || matched === 'ambiguous') {
        return argumentFailure('cp', matched, name, remove ? '--no-preserve' : '--preserve', [...PRESERVE_ATTRIBUTES, 'all']);
      }
      for (const attribute of matched) {
        if (remove) request.preserve.delete(attribute);
        else request.preserve.add(attribute);
      }
    }
    return null;
  };
  for (const item of shortOptions(args, OPTSTRING, LONG_OPTIONS)) {
    if (item.kind === 'operand') { request.operands.push(item.value); continue; }
    if (item.kind !== 'option') return { early: usageFailure('cp', getoptDiagnostic('cp', item)) };
    let problem: string | null = null;
    switch (item.letter) {
      case '0': return { early: docsResult('cp', 'help') };
      case 'H': request.dereference = 'command-line'; break;
      case 'W': return { early: docsResult('cp', 'version') };
      case 'r': case 'R': request.recursive = true; break;
      case 'a':
        request.recursive = true;
        request.dereference ??= 'never';
        problem = addPreserve('all', false);
        break;
      case 'p': problem = addPreserve(item.argument ?? 'mode,ownership,timestamps', false); break;
      case '5': problem = addPreserve(item.argument, false); break;
      case '3': problem = addPreserve(item.argument, true); break;
      case 'n': request.noClobber = true; request.interactive = false; break;
      case 'i': request.interactive = true; request.noClobber = false; break;
      case 'f': break;
      case 'v': request.verbose = true; break;
      case 'u': request.updateOnly = true; break;
      case 'l': request.hardLink = true; break;
      case 's': request.symbolicLink = true; break;
      case 'b': request.backup = 'existing'; break;
      case 'B': {
        const control = parseBackupControl('cp', item.argument);
        if (control.includes('\n')) return { early: usageFailure('cp', control) };
        request.backup = control as BackupControl;
        break;
      }
      case 'S': request.suffix = item.argument ?? '~'; if (request.backup === 'none') request.backup = 'existing'; break;
      case 'T': request.noTargetDirectory = true; break;
      case 'L': request.dereference = 'always'; break;
      case 'P': request.dereference = 'never'; break;
      case 'd': request.dereference = 'never'; problem = addPreserve('links', false); break;
      case 'x': case 'Z': case '2': break;
      case 't': request.targetDirectory = item.argument ?? null; break;
      case '1': request.attributesOnly = true; break;
      case '4': request.parents = true; break;
      case '7': request.removeDestination = true; break;
      case '9': break;
      case '6': {
        const matched = matchArgument(item.argument ?? 'always', REFLINK_WORDS);
        if (matched === 'invalid' || matched === 'ambiguous') {
          return { early: usageFailure('cp', argumentFailure('cp', matched, item.argument ?? '', '--reflink', ['auto', 'always', 'never'])) };
        }
        request.reflink = matched;
        break;
      }
      case '8': {
        const matched = matchArgument(item.argument ?? '', SPARSE_WORDS);
        if (matched === 'invalid' || matched === 'ambiguous') {
          return { early: usageFailure('cp', argumentFailure('cp', matched, item.argument ?? '', '--sparse', ['never', 'auto', 'always'])) };
        }
        break;
      }
      default: break;
    }
    if (problem !== null) return { early: usageFailure('cp', problem) };
  }
  if (request.targetDirectory !== null && request.noTargetDirectory) {
    return { early: usageFailure('cp', 'cp: cannot combine --target-directory (-t) and --no-target-directory (-T)') };
  }
  if (request.hardLink && request.symbolicLink) request.hardLink = false;
  return { request };
}

export function cpOperands(args: readonly string[]): string[] {
  const parsed = parseArguments(args);
  return 'request' in parsed ? parsed.request.operands : [];
}

class Copier {
  readonly streams = new Streams();
  private readonly answers: string[];

  constructor(private readonly ctx: ShellContext, private readonly request: CpRequest, stdin: string | undefined) {
    this.answers = (stdin ?? '').split('\n');
  }

  fail(message: string): void {
    this.streams.diagnostic(`cp: ${message}`);
    this.streams.exitCode = 1;
  }

  private confirm(targetName: string): boolean {
    this.streams.stderr(`cp: overwrite ${quoteShell(targetName)}? `);
    const answer = this.answers.shift();
    return answer !== undefined && /^[yY]/.test(answer);
  }

  private preserveMetadata(target: string, inode: INode): void {
    const { vfs, uid } = this.ctx;
    const preserve = this.request.preserve;
    if (preserve.has('mode')) vfs.chmod(target, inode.permissions & 0o7777);
    if (preserve.has('ownership') && uid === 0) vfs.chown(target, inode.uid, inode.gid);
    if (preserve.has('timestamps')) vfs.setTimes(target, { atime: inode.atime, mtime: inode.mtime });
  }

  private announce(sourceName: string, targetName: string, backup: string | null, target = ''): void {
    if (!this.request.verbose) return;
    const suffix = backup === null ? '' : ` (backup: ${quoteShell(targetName + backup.slice(target.length))})`;
    this.streams.stdout(`${quoteShell(sourceName)} -> ${quoteShell(targetName)}${suffix}\n`);
  }

  copy(source: string, target: string, sourceName: string, targetName: string, depth = 0): void {
    const { ctx, request } = this;
    const link = ctx.vfs.lstat(source);
    if (link === null) { this.fail(`cannot stat ${quoteShell(sourceName)}: No such file or directory`); return; }
    const follow = request.dereference === 'always'
      || (depth === 0 && (request.dereference === 'command-line' || (request.dereference === null && !request.recursive)));
    const inode = link.type === 'symlink' && follow ? ctx.vfs.resolveInode(source) : link;
    if (inode === null) { this.fail(`cannot stat ${quoteShell(sourceName)}: No such file or directory`); return; }
    const existing = ctx.vfs.lstat(target);
    if (inode.type === 'directory') {
      if (!request.recursive) { this.fail(`-r not specified; omitting directory ${quoteShell(sourceName)}`); return; }
      const resolved = existing !== null && existing.type === 'symlink' ? ctx.vfs.resolveInode(target) : existing;
      if (resolved !== null && resolved.id === inode.id) {
        this.fail(`${quoteShell(sourceName)} and ${quoteShell(targetName)} are the same file`);
        return;
      }
      const parentOfTarget = target.slice(0, target.lastIndexOf('/')) || '/';
      if (target === source || (target.startsWith(`${source}/`) && parentOfTarget !== source)) {
        this.fail(`cannot copy a directory, ${quoteShell(sourceName)}, into itself, ${quoteShell(targetName)}`);
        return;
      }
      if (resolved !== null && resolved.type !== 'directory') {
        this.fail(`cannot overwrite non-directory ${quoteShell(targetName)} with directory ${quoteShell(sourceName)}`);
        return;
      }
      if (resolved === null) {
        const mode = request.preserve.has('mode') ? inode.permissions & 0o7777 : inode.permissions & 0o777 & ~ctx.umask;
        if (!ctx.vfs.mkdir(target, mode, ctx.uid, ctx.gid)) { this.fail(`cannot create directory ${quoteShell(targetName)}: No such file or directory`); return; }
        this.announce(sourceName, targetName, null);
      } else if (request.verbose) this.announce(sourceName, targetName, null);
      for (const entry of ctx.vfs.listDirectory(source) ?? []) {
        if (entry.name === '.' || entry.name === '..' || `${source}/${entry.name}` === target) continue;
        this.copy(`${source}/${entry.name}`, `${target}/${entry.name}`, `${sourceName}/${entry.name}`, `${targetName}/${entry.name}`, depth + 1);
      }
      this.preserveMetadata(target, inode);
      return;
    }
    if (existing !== null) {
      const resolved = existing.type === 'symlink' && !(inode.type === 'symlink' && !follow) ? ctx.vfs.resolveInode(target) ?? existing : existing;
      if (resolved.type === 'directory') {
        this.fail(`cannot overwrite directory ${quoteShell(targetName)} with non-directory`);
        return;
      }
      if (resolved.id === inode.id && request.backup === 'none' && !request.removeDestination) {
        this.fail(`${quoteShell(sourceName)} and ${quoteShell(targetName)} are the same file`);
        return;
      }
      if (request.interactive) {
        if (!this.confirm(targetName)) { this.streams.exitCode = 1; return; }
      } else if (request.noClobber) return;
      if (request.updateOnly && resolved.mtime >= inode.mtime) return;
    }
    let backup: string | null = null;
    if (existing !== null && request.backup !== 'none') {
      backup = makeBackup(ctx.vfs, target, request.backup, request.suffix);
    } else if (existing !== null && (request.removeDestination || request.hardLink || request.symbolicLink || inode.type === 'symlink')) {
      ctx.vfs.deleteFile(target);
    }
    if (request.hardLink || request.symbolicLink) {
      const made = request.symbolicLink ? ctx.vfs.createSymlink(target, sourceName, ctx.uid, ctx.gid) : ctx.vfs.createHardLink(target, source);
      if (!made) this.fail(`cannot create ${request.symbolicLink ? 'symbolic' : 'hard'} link ${quoteShell(targetName)} to ${quoteShell(sourceName)}`);
      else this.announce(sourceName, targetName, backup, target);
      return;
    }
    if (inode.type === 'symlink') {
      if (!ctx.vfs.createSymlink(target, inode.target, ctx.uid, ctx.gid)) this.fail(`cannot create symbolic link ${quoteShell(targetName)}`);
      else this.announce(sourceName, targetName, backup, target);
      return;
    }
    if (inode.type !== 'file') { this.fail(`cannot copy ${quoteShell(sourceName)} to ${quoteShell(targetName)}`); return; }
    if (request.reflink === 'always') {
      this.fail(`failed to clone ${quoteShell(targetName)} from ${quoteShell(sourceName)}: Operation not supported`);
      return;
    }
    const keepContent = request.attributesOnly && ctx.vfs.lstat(target) !== null;
    if (!keepContent) {
      const content = request.attributesOnly ? '' : inode.content;
      const created = ctx.vfs.createFileAt(target, content, inode.permissions & 0o777 & ~ctx.umask, ctx.uid, ctx.gid);
      if (created === null) { this.fail(`cannot create regular file ${quoteShell(targetName)}: No such file or directory`); return; }
    }
    this.preserveMetadata(target, inode);
    this.announce(sourceName, targetName, backup, target);
  }
}

function baseOf(name: string): string {
  const trimmed = name.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export function runCp(ctx: ShellContext, args: readonly string[], stdin: string | undefined): CoreutilsRun {
  const parsed = parseArguments(args);
  if ('early' in parsed) return parsed.early;
  const request = parsed.request;
  const operands = [...request.operands];
  if (request.targetDirectory === null && operands.length === 0) return usageFailure('cp', 'cp: missing file operand');
  if (request.noTargetDirectory && operands.length > 2) return usageFailure('cp', `cp: extra operand ${quoteLocale(operands[2])}`);
  const destinationName = request.targetDirectory ?? operands.pop() as string;
  if (operands.length === 0) {
    return usageFailure('cp', request.targetDirectory === null
      ? `cp: missing destination file operand after ${quoteLocale(destinationName)}`
      : 'cp: missing file operand');
  }
  const copier = new Copier(ctx, request, stdin);
  if (request.noClobber) copier.streams.diagnostic(NO_CLOBBER_WARNING);
  const actor = actorOf(ctx);
  const destination = ctx.vfs.path(destinationName, ctx.cwd, actor);
  const destinationIsDirectory = destination.isDirectory();
  const mustBeDirectory = request.targetDirectory !== null || request.parents || operands.length > 1;
  if (mustBeDirectory && !destinationIsDirectory) {
    copier.fail(`target${request.targetDirectory !== null ? ' directory' : ''} ${quoteShell(destinationName)}: ${destination.lexists() ? 'Not a directory' : 'No such file or directory'}`);
    return copier.streams.result();
  }
  const intoDirectory = !request.noTargetDirectory && destinationIsDirectory;
  for (const typed of operands) {
    const sourceName = typed;
    const source = ctx.vfs.path(sourceName, ctx.cwd, actor);
    const sourceNode = source.lstatNode();
    if (sourceNode === null) { copier.fail(`cannot stat ${quoteShell(typed)}: No such file or directory`); continue; }
    if (/\/$/.test(sourceName) && sourceNode.type !== 'directory' && !(sourceNode.type === 'symlink' && source.isDirectory())) {
      copier.fail(`cannot stat ${quoteShell(typed)}: Not a directory`);
      continue;
    }
    if (ctx.uid !== 0) {
      if (sourceNode.type === 'file' && !source.canRead()) { copier.fail(`cannot open ${quoteShell(typed)} for reading: Permission denied`); continue; }
      const destinationDirectory = intoDirectory ? destination : destination.parent();
      if (destinationDirectory.inode() && !destinationDirectory.isWritableDir()) {
        copier.fail(`cannot create regular file ${quoteShell(destinationName)}: Permission denied`);
        continue;
      }
    }
    let relative = baseOf(sourceName);
    if (request.parents) relative = sourceName.replace(/^\/+/, '');
    const target = intoDirectory ? `${destination.value.replace(/\/$/, '')}/${relative}` : destination.value;
    const targetName = intoDirectory ? `${destinationName.replace(/\/+$/, '')}/${request.parents ? sourceName.replace(/^\/+/, '') : relative}` : destinationName;
    if (request.symbolicLink && !sourceName.startsWith('/') && targetName.includes('/')) {
      copier.fail(`${quoteShell(targetName)}: can make relative symbolic links only in current directory`);
      continue;
    }
    if (request.parents) {
      const parts = target.split('/').slice(0, -1);
      let built = '';
      for (const part of parts) {
        built = `${built}/${part}`.replace(/^\/\//, '/');
        if (built !== '/' && ctx.vfs.lstat(built) === null) ctx.vfs.mkdir(built, 0o755 & ~ctx.umask, ctx.uid, ctx.gid);
      }
    }
    copier.copy(source.value, target, sourceName, targetName);
  }
  return copier.streams.result();
}
