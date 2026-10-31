/**
 * File operation commands: touch, ls, cat, cp, mv, rm, mkdir, rmdir, ln, echo, pwd, cd, tee
 */

import { formatLsTime, parseLsTimeStyle, parseTouchDate, parseTouchStamp, type LsTimeStyle } from './time/FileTimes';
import { simulationNowMs } from '@/network/core/SystemClock';

import { VirtualFileSystem, INode } from './VirtualFileSystem';
import { LinuxUserManager } from './LinuxUserManager';
import { gnuOptionSet } from './GnuOptionGuard';
import { fnmatch } from './fs/Glob';
import { versionCompare } from './LinuxTextCommands';
import { lsColumns, lsCommas, lsEscapeNonPrinting, lsExtension, lsHideControl, lsHumanSize, lsQuoteC, type LsFormat } from './LsLayout';
import { shortOptions } from './commands/Getopt';
import { parseChmodMode } from './ChmodMode';
import { interpretEscapes } from './LinuxShellParser';
import type { PathActor } from './VfsPath';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export function actorOf(ctx: ShellContext): PathActor {
  const groups = ctx.userMgr.getUserGroups(ctx.userMgr.currentUser) ?? [];
  return {
    uid: ctx.uid,
    gid: ctx.gid,
    gids: groups.map((g) => g.gid),
    user: ctx.userMgr.currentUser,
    groupNames: groups.map((g) => g.name),
  };
}

// ANSI color codes matching GNU ls defaults (LS_COLORS)
const C = {
  RESET: '\x1b[0m',
  BOLD_BLUE: '\x1b[1;34m',    // directories
  BOLD_CYAN: '\x1b[1;36m',    // symlinks
  BOLD_GREEN: '\x1b[1;32m',   // executables
  BOLD_YELLOW: '\x1b[1;33m',  // FIFOs (named pipes)
  BOLD_MAGENTA: '\x1b[1;35m', // sockets
  BOLD_YELBG: '\x1b[30;43m',  // sticky + other-writable dirs
  BOLD_BLUEBG: '\x1b[34;42m', // other-writable dirs (no sticky)
  BOLD_GREENBG: '\x1b[37;42m',// sticky dirs (not other-writable)
  CHARDEV: '\x1b[1;33m',      // character devices (bold yellow)
};

export interface ShellContext {
  vfs: VirtualFileSystem;
  userMgr: LinuxUserManager;
  cwd: string;
  umask: number;
  uid: number;
  gid: number;
  color?: boolean;
  /** True when this command's stdout is not a terminal — piped into a
   *  later command or redirected to a file (`>`/`>>`). Mirrors real
   *  coreutils' `isatty(STDOUT_FILENO)` check. */
  isPiped?: boolean;
  /** When set, a script run through this context (e.g. a cron job) uses
   *  this exact environment instead of the interactive session's. */
  envOverride?: Record<string, string>;
  openRefusal?: (absPath: string) => string | null;
  zone?: string;
  nowMs?: () => number;
  deviceOf?: (absPath: string) => number;
}

export function cmdTouch(ctx: ShellContext, args: string[]): string {
  const errors: string[] = [];
  const nowMs = ctx.nowMs?.() ?? simulationNowMs();
  let setAccess = false;
  let setModify = false;
  let noCreate = false;
  let stampMs: number | null = null;
  const targets: string[] = [];
  const bad = (message: string): string => `touch: ${message}`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { targets.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (name === 'no-create') noCreate = true;
      else if (name === 'date') {
        const spec = inline ?? args[++i] ?? '';
        const parsed = parseTouchDate(spec, ctx.zone, nowMs);
        if (parsed === null) return bad(`invalid date format '${spec}'`);
        stampMs = parsed;
      } else if (name === 'reference') {
        const ref = inline ?? args[++i] ?? '';
        const inode = ctx.vfs.resolveInode(ctx.vfs.normalizePath(ref, ctx.cwd));
        if (!inode) return bad(`failed to get attributes of '${ref}': No such file or directory`);
        stampMs = inode.mtime;
      } else if (name === 'time') {
        const which = inline ?? args[++i] ?? '';
        if (/^(atime|access|use)$/.test(which)) setAccess = true;
        else if (/^(mtime|modify)$/.test(which)) setModify = true;
      }
      continue;
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      for (let k = 1; k < arg.length; k++) {
        const flag = arg[k];
        if (flag === 'a') setAccess = true;
        else if (flag === 'm') setModify = true;
        else if (flag === 'c') noCreate = true;
        else if (flag === 'd' || flag === 't' || flag === 'r') {
          const operand = arg.slice(k + 1) || args[++i] || '';
          if (flag === 'd') {
            const parsed = parseTouchDate(operand, ctx.zone, nowMs);
            if (parsed === null) return bad(`invalid date format '${operand}'`);
            stampMs = parsed;
          } else if (flag === 't') {
            const parsed = parseTouchStamp(operand, ctx.zone, nowMs);
            if (parsed === null) return bad(`invalid date format '${operand}'`);
            stampMs = parsed;
          } else {
            const inode = ctx.vfs.resolveInode(ctx.vfs.normalizePath(operand, ctx.cwd));
            if (!inode) return bad(`failed to get attributes of '${operand}': No such file or directory`);
            stampMs = inode.mtime;
          }
          break;
        }
      }
      continue;
    }
    targets.push(arg);
  }

  if (targets.length === 0) return 'touch: missing file operand\nTry \'touch --help\' for more information.';
  const both = !setAccess && !setModify;
  for (const arg of targets) {
    const path = ctx.vfs.normalizePath(arg, ctx.cwd);
    const existed = ctx.vfs.exists(path);
    if (!existed && noCreate) continue;
    const target = ctx.vfs.path(path, '/', actorOf(ctx));
    if (ctx.uid !== 0 && (existed ? !target.canWrite() && !target.ownedByActor() : target.parent().exists() && !target.parent().isWritableDir())) {
      errors.push(`touch: cannot touch '${arg}': Permission denied`);
      continue;
    }
    if (!existed) {
      ctx.vfs.touch(path, ctx.uid, ctx.gid, ctx.umask);
      if (!ctx.vfs.exists(path)) {
        errors.push(ctx.vfs.freeInodes() === 0
          ? `touch: cannot touch '${arg}': No space left on device`
          : `touch: cannot touch '${arg}': No such file or directory`);
        continue;
      }
    }
    const at = stampMs ?? nowMs;
    ctx.vfs.setTimes(path, {
      atime: both || setAccess ? at : undefined,
      mtime: both || setModify ? at : undefined,
    });
  }
  return errors.join('\n');
}

const DIRECTORY_BYTES = 4096;
const DEFAULT_LINE_WIDTH = 80;

type LsSort = 'name' | 'size' | 'time' | 'extension' | 'version' | 'width' | 'none';
type LsIndicator = 'none' | 'slash' | 'file-type' | 'classify';
type LsQuoting = 'literal' | 'c' | 'escape';
type LsAll = 'none' | 'almost' | 'all';

interface LsTiming {
  field: 'mtime' | 'atime' | 'ctime';
  style: LsTimeStyle | null;
  reverse: boolean;
}

interface LsOpts {
  timing: LsTiming;
  format: LsFormat;
  all: LsAll;
  showInode: boolean;
  showSize: boolean;
  human: 1024 | 1000 | null;
  indicator: LsIndicator;
  quoting: LsQuoting;
  hideControl: boolean;
  useColor: boolean;
  sort: LsSort;
  groupDirectoriesFirst: boolean;
  recursive: boolean;
  ignore: string[];
  hide: string[];
  ignoreBackups: boolean;
  width: number;
  tabSize: number;
  zero: boolean;
  context: boolean;
  hideOwner: boolean;
  hideGroup: boolean;
  numeric: boolean;
  author: boolean;
  dereference: 'none' | 'arguments' | 'all';
}

interface LsEntry {
  name: string;
  inode: INode;
  absPath: string;
}

export const lsSize = (inode: INode): number => (inode.type === 'directory' ? DIRECTORY_BYTES : inode.size);

export const lsBlocksKiB = (inode: INode): number => {
  if (inode.type === 'directory') return 4;
  if (inode.type === 'symlink' || inode.type === 'chardev') return 0;
  return Math.ceil(inode.size / 4096) * 4;
};

const LS_ARGUMENT_CHOICES: Readonly<Record<string, readonly string[]>> = {
  color: ["'always', 'yes', 'force'", "'never', 'no', 'none'", "'auto', 'tty', 'if-tty'"],
  classify: ["'always', 'yes', 'force'", "'never', 'no', 'none'", "'auto', 'tty', 'if-tty'"],
  sort: ["'none'", "'time'", "'size'", "'extension'", "'version'", "'width'"],
  format: ["'verbose', 'long'", "'commas'", "'horizontal', 'across'", "'vertical'", "'single-column'"],
  time: ["'atime', 'access', 'use'", "'ctime', 'status'", "'mtime', 'modification'", "'birth', 'creation'"],
  'indicator-style': ["'none'", "'slash'", "'file-type'", "'classify'"],
  'quoting-style': ["'literal'", "'shell'", "'shell-always'", "'shell-escape'", "'shell-escape-always'", "'c'", "'c-maybe'", "'escape'", "'locale'", "'clocale'"],
};

function lsInvalidArgument(option: string, value: string): string {
  const choices = LS_ARGUMENT_CHOICES[option];
  const lines = [`ls: invalid argument '${value}' for '--${option}'`];
  if (choices !== undefined) lines.push('Valid arguments are:', ...choices.map((choice) => `  - ${choice}`), "Try 'ls --help' for more information.");
  return lines.join('\n');
}

function parseLsArguments(ctx: ShellContext, args: readonly string[]): { opts: LsOpts; paths: string[]; dirOnly: boolean } | string {
  const set = gnuOptionSet('ls');
  const opts: LsOpts = {
    timing: { field: 'mtime', style: null, reverse: false },
    format: ctx.isPiped === true ? 'single' : 'columns',
    all: 'none', showInode: false, showSize: false, human: null, indicator: 'none', quoting: 'literal',
    hideControl: false, useColor: ctx.color === true, sort: 'name', groupDirectoriesFirst: false,
    recursive: false, ignore: [], hide: [], ignoreBackups: false, width: DEFAULT_LINE_WIDTH, zero: false, tabSize: 8,
    context: false, hideOwner: false, hideGroup: false, numeric: false, author: false, dereference: 'none',
  };
  const paths: string[] = [];
  let dirOnly = false;
  let sortChosen = false;
  const setFormat = (word: string): boolean => {
    const formats: Record<string, LsFormat> = {
      long: 'long', verbose: 'long', 'single-column': 'single', across: 'across', horizontal: 'across',
      vertical: 'columns', commas: 'commas',
    };
    const format = formats[word];
    if (format === undefined) return false;
    opts.format = format;
    return true;
  };
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand') { paths.push(item.value); continue; }
    if (item.kind !== 'option') continue;
    const long = item.long;
    const argument = item.argument;
    switch (long ?? item.letter) {
      case 'l': opts.format = 'long'; break;
      case 'g': opts.format = 'long'; opts.hideOwner = true; break;
      case 'o': opts.format = 'long'; opts.hideGroup = true; break;
      case 'n': opts.format = 'long'; opts.numeric = true; break;
      case 'G': opts.hideGroup = true; break;
      case 'a': opts.all = 'all'; break;
      case 'A': if (opts.all !== 'all') opts.all = 'almost'; break;
      case 'f': opts.all = 'all'; opts.sort = 'none'; sortChosen = true; opts.showSize = false; opts.useColor = false; break;
      case 'i': opts.showInode = true; break;
      case 's': opts.showSize = true; break;
      case 'S': opts.sort = 'size'; sortChosen = true; break;
      case 't': opts.sort = 'time'; sortChosen = true; break;
      case 'X': opts.sort = 'extension'; sortChosen = true; break;
      case 'v': opts.sort = 'version'; sortChosen = true; break;
      case 'U': opts.sort = 'none'; sortChosen = true; break;
      case 'R': opts.recursive = true; break;
      case 'd': dirOnly = true; break;
      case 'r': opts.timing.reverse = true; break;
      case 'c': opts.timing.field = 'ctime'; break;
      case 'u': opts.timing.field = 'atime'; break;
      case '1': opts.format = 'single'; break;
      case 'C': opts.format = 'columns'; break;
      case 'x': opts.format = 'across'; break;
      case 'm': opts.format = 'commas'; break;
      case 'p': opts.indicator = 'slash'; break;
      case 'F': opts.indicator = 'classify'; break;
      case 'h': opts.human = 1024; break;
      case 'k': opts.human = null; break;
      case 'H': opts.dereference = 'arguments'; break;
      case 'L': opts.dereference = 'all'; break;
      case 'Q': opts.quoting = 'c'; break;
      case 'N': opts.quoting = 'literal'; opts.hideControl = false; break;
      case 'b': opts.quoting = 'escape'; break;
      case 'q': opts.hideControl = true; break;
      case 'B': opts.ignoreBackups = true; break;
      case 'Z': opts.context = true; break;
      case 'I': opts.ignore.push(argument ?? ''); break;
      case 'w': {
        if (argument === undefined || !/^\d+$/.test(argument)) return `ls: invalid line width: '${argument ?? ''}'`;
        opts.width = Number(argument);
        break;
      }
      case 'T': {
        if (argument === undefined || !/^\d+$/.test(argument)) return `ls: invalid tab size: '${argument ?? ''}'`;
        opts.tabSize = Number(argument);
        break;
      }
      case 'color': {
        const when = argument ?? 'always';
        if (/^(always|yes|force)$/.test(when)) opts.useColor = true;
        else if (/^(never|no|none)$/.test(when)) opts.useColor = false;
        else if (/^(auto|tty|if-tty)$/.test(when)) opts.useColor = ctx.color === true;
        else return lsInvalidArgument('color', when);
        break;
      }
      case 'reverse': opts.timing.reverse = true; break;
      case 'full-time': opts.format = 'long'; opts.timing.style = 'full-iso'; break;
      case 'time-style': {
        const style = parseLsTimeStyle(argument ?? '');
        if (style === null) return `ls: invalid argument '${argument ?? ''}' for '--time-style'`;
        opts.timing.style = style;
        break;
      }
      case 'time': {
        const which = argument ?? '';
        if (/^(atime|access|use)$/.test(which)) opts.timing.field = 'atime';
        else if (/^(ctime|status)$/.test(which)) opts.timing.field = 'ctime';
        else if (/^(mtime|modify|modification|birth|creation)$/.test(which)) opts.timing.field = 'mtime';
        else return lsInvalidArgument('time', which);
        break;
      }
      case 'format': if (!setFormat(argument ?? '')) return lsInvalidArgument('format', argument ?? ''); break;
      case 'sort': {
        const sorts: Record<string, LsSort> = { none: 'none', size: 'size', time: 'time', version: 'version', extension: 'extension', width: 'width' };
        const sort = sorts[argument ?? ''];
        if (sort === undefined) return lsInvalidArgument('sort', argument ?? '');
        opts.sort = sort;
        sortChosen = true;
        break;
      }
      case 'indicator-style': {
        const styles: Record<string, LsIndicator> = { none: 'none', slash: 'slash', 'file-type': 'file-type', classify: 'classify' };
        const style = styles[argument ?? ''];
        if (style === undefined) return lsInvalidArgument('indicator-style', argument ?? '');
        opts.indicator = style;
        break;
      }
      case 'classify': {
        const when = argument ?? 'always';
        if (/^(always|yes|force)$/.test(when)) opts.indicator = 'classify';
        else if (/^(auto|tty|if-tty)$/.test(when)) { if (ctx.color === true) opts.indicator = 'classify'; }
        else if (!/^(never|no|none)$/.test(when)) return lsInvalidArgument('classify', when);
        break;
      }
      case 'file-type': opts.indicator = 'file-type'; break;
      case 'quote-name': opts.quoting = 'c'; break;
      case 'quoting-style': {
        const styles: Record<string, LsQuoting> = { literal: 'literal', c: 'c', 'c-maybe': 'c', escape: 'escape', locale: 'c', clocale: 'c', shell: 'literal', 'shell-always': 'literal', 'shell-escape': 'literal', 'shell-escape-always': 'literal' };
        const style = styles[argument ?? ''];
        if (style === undefined) return lsInvalidArgument('quoting-style', argument ?? '');
        opts.quoting = style;
        break;
      }
      case 'literal': opts.quoting = 'literal'; break;
      case 'escape': opts.quoting = 'escape'; break;
      case 'hide-control-chars': opts.hideControl = true; break;
      case 'show-control-chars': opts.hideControl = false; break;
      case 'ignore-backups': opts.ignoreBackups = true; break;
      case 'ignore': opts.ignore.push(argument ?? ''); break;
      case 'hide': opts.hide.push(argument ?? ''); break;
      case 'all': opts.all = 'all'; break;
      case 'almost-all': if (opts.all !== 'all') opts.all = 'almost'; break;
      case 'group-directories-first': opts.groupDirectoriesFirst = true; break;
      case 'human-readable': opts.human = 1024; break;
      case 'si': opts.human = 1000; break;
      case 'kibibytes': opts.human = null; break;
      case 'inode': opts.showInode = true; break;
      case 'size': opts.showSize = true; break;
      case 'recursive': opts.recursive = true; break;
      case 'directory': dirOnly = true; break;
      case 'numeric-uid-gid': opts.format = 'long'; opts.numeric = true; break;
      case 'no-group': opts.hideGroup = true; break;
      case 'author': opts.author = true; break;
      case 'context': opts.context = true; break;
      case 'zero': opts.zero = true; break;
      case 'dereference': opts.dereference = 'all'; break;
      case 'dereference-command-line': opts.dereference = 'arguments'; break;
      case 'tabsize': {
        if (argument === undefined || !/^\d+$/.test(argument)) return `ls: invalid tab size: '${argument ?? ''}'`;
        opts.tabSize = Number(argument);
        break;
      }
      case 'width': {
        if (argument === undefined || !/^\d+$/.test(argument)) return `ls: invalid line width: '${argument ?? ''}'`;
        opts.width = Number(argument);
        break;
      }
      default: break;
    }
  }
  if (opts.zero && opts.format !== 'long') opts.format = 'single';
  if (!sortChosen && opts.format !== 'long' && opts.timing.field !== 'mtime') opts.sort = 'time';
  return { opts, paths, dirOnly };
}

export interface LsStreams {
  readonly stdout: string;
  readonly stderr: string;
}

export function cmdLs(ctx: ShellContext, args: string[]): LsStreams {
  const parsed = parseLsArguments(ctx, args);
  if (typeof parsed === 'string') return { stdout: '', stderr: parsed };
  const { opts, dirOnly } = parsed;
  const paths = parsed.paths.length === 0 ? ['.'] : parsed.paths;

  const failures: string[] = [];
  const diagnostics: string[] = [];
  const listedFiles: LsEntry[] = [];
  const listedDirectories: Array<{ name: string; absPath: string }> = [];

  for (const rawPath of paths) {
    for (const p of expandGlob(ctx, rawPath)) {
      const absPath = ctx.vfs.normalizePath(p, ctx.cwd);
      const followsLink = opts.dereference !== 'none' || (opts.format !== 'long' && !dirOnly);
      const inode = ctx.vfs.resolveInode(absPath, followsLink)
        ?? ctx.vfs.resolveInode(absPath, false);
      if (!inode) {
        failures.push(`ls: cannot access '${p}': No such file or directory`);
      } else if (inode.type !== 'directory' || dirOnly) {
        listedFiles.push({ name: p, inode, absPath });
      } else {
        listedDirectories.push({ name: p, absPath });
      }
    }
  }

  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
  if (opts.sort !== 'none') {
    listedFiles.sort(byName);
    listedDirectories.sort(byName);
  }
  const eol = opts.zero ? '\0' : '\n';
  const out: string[] = [];
  if (listedFiles.length > 0) out.push(...renderEntries(ctx, listedFiles, opts, false).lines);
  const headed = paths.length > 1 && !opts.recursive;
  listedDirectories.forEach((directory, index) => {
    if (headed) out.push(`${index > 0 || listedFiles.length > 0 ? '\n' : ''}${directory.name}:`);
    const listing = listDir(ctx, directory.absPath, directory.name, opts, diagnostics);
    if (listing !== null) out.push(listing);
  });
  const text = out.join(eol);
  return { stdout: opts.zero ? `${text}\0` : text.trimEnd(), stderr: [...failures, ...diagnostics].join('\n') };
}

function lsIgnored(name: string, opts: LsOpts): boolean {
  if (opts.all === 'none' && name.startsWith('.')) return true;
  if (opts.all === 'almost' && (name === '.' || name === '..')) return true;
  if (opts.ignoreBackups && opts.all !== 'all' && name.endsWith('~')) return true;
  if (opts.ignore.some((pattern) => fnmatch(pattern, name, { period: false }))) return true;
  if (opts.all === 'none' && opts.hide.some((pattern) => fnmatch(pattern, name, { period: false }))) return true;
  return false;
}

function lsCompare(opts: LsOpts, a: LsEntry, b: LsEntry): number {
  const byName = a.name.localeCompare(b.name);
  switch (opts.sort) {
    case 'size': return (lsSize(b.inode) - lsSize(a.inode)) || byName;
    case 'time': return (b.inode[opts.timing.field] - a.inode[opts.timing.field]) || byName;
    case 'extension': return lsExtension(a.name).localeCompare(lsExtension(b.name)) || byName;
    case 'version': return versionCompare(a.name, b.name) || byName;
    case 'width': return (a.name.length - b.name.length) || byName;
    default: return byName;
  }
}

function sortEntries(entries: LsEntry[], opts: LsOpts): LsEntry[] {
  if (opts.sort === 'none') return entries;
  const direction = opts.timing.reverse ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (opts.groupDirectoriesFirst) {
      const dirA = a.inode.type === 'directory' ? 0 : 1;
      const dirB = b.inode.type === 'directory' ? 0 : 1;
      if (dirA !== dirB) return dirA - dirB;
    }
    return direction * lsCompare(opts, a, b);
  });
}

function listDir(ctx: ShellContext, absPath: string, displayPath: string, opts: LsOpts, diagnostics: string[]): string | null {
  const entries = ctx.vfs.listDirectory(absPath);
  if (!entries) {
    diagnostics.push(`ls: cannot access '${displayPath}': No such file or directory`);
    return null;
  }
  if (ctx.uid !== 0 && !ctx.vfs.path(absPath, '/', actorOf(ctx)).canRead()) {
    diagnostics.push(`ls: cannot open directory '${displayPath}': Permission denied`);
    return null;
  }

  const listed: LsEntry[] = [];
  const visible = entries.filter((e) => e.name !== '.' && e.name !== '..' && !lsIgnored(e.name, opts));
  if (opts.all === 'all' && !opts.ignore.some((p) => fnmatch(p, '.', {}))) {
    const self = ctx.vfs.resolveInode(absPath, true);
    const parentPath = absPath === '/' ? '/' : absPath.replace(/\/[^/]*$/, '') || '/';
    const parent = ctx.vfs.resolveInode(parentPath, true);
    if (self) listed.push({ name: '.', inode: self, absPath });
    if (parent) listed.push({ name: '..', inode: parent, absPath: parentPath });
  }
  for (const entry of visible) {
    const childPath = absPath === '/' ? `/${entry.name}` : `${absPath}/${entry.name}`;
    const inode = opts.dereference === 'all' ? (ctx.vfs.resolveInode(childPath, true) ?? entry.inode) : entry.inode;
    listed.push({ name: entry.name, inode, absPath: childPath });
  }
  const filtered = sortEntries(listed, opts);

  const lines: string[] = [];
  if (opts.recursive) lines.push(`${displayPath}:`);
  const rendered = renderEntries(ctx, filtered, opts, true);
  lines.push(...rendered.lines);

  if (opts.recursive) {
    for (const entry of filtered) {
      if (entry.name === '.' || entry.name === '..') continue;
      const real = ctx.vfs.resolveInode(entry.absPath, false);
      if (real?.type !== 'directory') continue;
      const childDisplay = displayPath.endsWith('/') ? `${displayPath}${entry.name}` : `${displayPath}/${entry.name}`;
      lines.push('');
      const nested = listDir(ctx, entry.absPath, childDisplay, opts, diagnostics);
      if (nested !== null) lines.push(nested);
    }
  }
  return lines.join(opts.zero ? '\0' : '\n');
}

function indicatorOf(inode: INode, style: LsIndicator, long = false): string {
  if (style === 'none') return '';
  if (long && inode.type === 'symlink') return '';
  if (inode.type === 'directory') return '/';
  if (style === 'slash') return '';
  switch (inode.type) {
    case 'symlink': return '@';
    case 'fifo': return '|';
    case 'socket': return '=';
    case 'file': return style === 'classify' && (inode.permissions & 0o111) ? '*' : '';
    default: return '';
  }
}

function quotedName(name: string, opts: LsOpts): string {
  if (opts.quoting === 'c') return lsQuoteC(name);
  if (opts.quoting === 'escape') return lsEscapeNonPrinting(name);
  return opts.hideControl ? lsHideControl(name) : name;
}

function renderEntries(ctx: ShellContext, entries: LsEntry[], opts: LsOpts, withTotal: boolean): { lines: string[] } {
  const long = opts.format === 'long';
  const sizeText = (blocksKiB: number): string => (opts.human === null ? String(blocksKiB) : lsHumanSize(blocksKiB * 1024, opts.human));
  const inodeWidth = opts.showInode ? Math.max(...entries.map((e) => String(e.inode.id).length), 1) : 0;
  const blocksWidth = opts.showSize ? Math.max(...entries.map((e) => sizeText(lsBlocksKiB(e.inode)).length), 1) : 0;
  const prefixOf = (e: LsEntry): string => {
    let prefix = '';
    if (opts.showInode) prefix += `${padToWidth(String(e.inode.id), inodeWidth, 'right')} `;
    if (opts.showSize) prefix += `${padToWidth(sizeText(lsBlocksKiB(e.inode)), blocksWidth, 'right')} `;
    if (opts.context && !long) prefix += '? ';
    return prefix;
  };
  const lines: string[] = [];

  if (long) {
    const sizeOf = (e: LsEntry): string => (opts.human === null ? String(lsSize(e.inode)) : lsHumanSize(lsSize(e.inode), opts.human));
    const ownerOf = (e: LsEntry): string => (opts.numeric ? String(e.inode.uid) : ctx.userMgr.uidToName(e.inode.uid));
    const groupOf = (e: LsEntry): string => (opts.numeric ? String(e.inode.gid) : ctx.userMgr.gidToName(e.inode.gid));
    const widths = {
      links: Math.max(1, ...entries.map((e) => String(e.inode.linkCount).length)),
      owner: Math.max(1, ...entries.map((e) => ownerOf(e).length)),
      group: Math.max(1, ...entries.map((e) => groupOf(e).length)),
      size: Math.max(1, ...entries.map((e) => sizeOf(e).length)),
    };
    if (withTotal) {
      const total = entries.reduce((sum, e) => sum + lsBlocksKiB(e.inode), 0);
      lines.push(`total ${sizeText(total)}`);
    }
    for (const e of entries) {
      const cells = [ctx.vfs.formatPermissions(e.inode), padToWidth(String(e.inode.linkCount), widths.links, 'right')];
      if (!opts.hideOwner) cells.push(padToWidth(ownerOf(e), widths.owner));
      if (!opts.hideGroup) cells.push(padToWidth(groupOf(e), widths.group));
      if (opts.author) cells.push(padToWidth(ownerOf(e), widths.owner));
      if (opts.context) cells.push('?');
      cells.push(padToWidth(sizeOf(e), widths.size, 'right'));
      cells.push(formatLsTime(opts.timing.style, e.inode[opts.timing.field], ctx.zone, ctx.nowMs?.() ?? simulationNowMs()));
      const name = colorName(quotedName(e.name, opts), e.inode, opts.useColor) + indicatorOf(e.inode, opts.indicator, true);
      let line = `${prefixOf(e)}${cells.join(' ')} ${name}`;
      if (e.inode.type === 'symlink' && opts.dereference !== 'all') line += ` -> ${ctx.vfs.linkTarget(e.inode)}`;
      lines.push(line);
    }
    return { lines };
  }

  if (withTotal && opts.showSize) {
    lines.push(`total ${sizeText(entries.reduce((sum, e) => sum + lsBlocksKiB(e.inode), 0))}`);
  }
  const shown: string[] = [];
  const lengths: number[] = [];
  for (const e of entries) {
    const base = quotedName(e.name, opts) + indicatorOf(e.inode, opts.indicator);
    const prefix = prefixOf(e);
    shown.push(prefix + colorName(quotedName(e.name, opts), e.inode, opts.useColor) + indicatorOf(e.inode, opts.indicator));
    lengths.push(prefix.length + base.length);
  }
  if (opts.format === 'single' || shown.length === 0) lines.push(...shown);
  else if (opts.format === 'commas') lines.push(...lsCommas(shown, lengths, opts.width));
  else lines.push(...lsColumns(shown, lengths, opts.width, opts.format === 'across', opts.tabSize));
  return { lines };
}

function colorName(name: string, inode: INode, useColor = true): string {
  if (!useColor) return name;
  switch (inode.type) {
    case 'directory': {
      const sticky = (inode.permissions >> 9) & 1;
      const ow = (inode.permissions & 0o002);
      if (sticky && ow) return `${C.BOLD_YELBG}${name}${C.RESET}`;
      if (ow) return `${C.BOLD_BLUEBG}${name}${C.RESET}`;
      if (sticky) return `${C.BOLD_GREENBG}${name}${C.RESET}`;
      return `${C.BOLD_BLUE}${name}${C.RESET}`;
    }
    case 'symlink': return `${C.BOLD_CYAN}${name}${C.RESET}`;
    case 'fifo': return `${C.BOLD_YELLOW}${name}${C.RESET}`;
    case 'socket': return `${C.BOLD_MAGENTA}${name}${C.RESET}`;
    case 'chardev': return `${C.CHARDEV}${name}${C.RESET}`;
    case 'file':
      if (inode.permissions & 0o111) return `${C.BOLD_GREEN}${name}${C.RESET}`;
      return name;
    default: return name;
  }
}

export interface CatFlags {
  readonly numberAll: boolean;
  readonly numberNonBlank: boolean;
  readonly showEnds: boolean;
  readonly showTabs: boolean;
  readonly showNonPrinting: boolean;
  readonly squeezeBlank: boolean;
}

export function parseCatFlags(args: readonly string[]): CatFlags {
  const letters = args.filter((a) => a.startsWith('-') && !a.startsWith('--') && a.length > 1).join('').replace(/-/g, '');
  const longs = new Set(args.filter((a) => a.startsWith('--')));
  const has = (letter: string, long: string): boolean => letters.includes(letter) || longs.has(long);
  const showAll = has('A', '--show-all');
  return {
    numberAll: has('n', '--number'),
    numberNonBlank: has('b', '--number-nonblank'),
    showEnds: showAll || has('E', '--show-ends') || letters.includes('e'),
    showTabs: showAll || has('T', '--show-tabs') || letters.includes('t'),
    showNonPrinting: showAll || has('v', '--show-nonprinting') || letters.includes('e') || letters.includes('t'),
    squeezeBlank: has('s', '--squeeze-blank'),
  };
}

function visible(line: string, flags: CatFlags): string {
  let out = '';
  for (const ch of line) {
    const code = ch.charCodeAt(0);
    if (ch === '\t') out += flags.showTabs ? '^I' : ch;
    else if (flags.showNonPrinting && code < 32) out += `^${String.fromCharCode(code + 64)}`;
    else if (flags.showNonPrinting && code === 127) out += '^?';
    else out += ch;
  }
  return out;
}

export function renderCat(contents: readonly string[], flags: CatFlags): string {
  if (!flags.numberAll && !flags.numberNonBlank && !flags.showEnds && !flags.showTabs && !flags.showNonPrinting && !flags.squeezeBlank) {
    return contents.join('');
  }
  let number = 0;
  let previousBlank = false;
  let out = '';
  for (const content of contents) {
    const records = content.split(/(?<=\n)/).filter((r) => r !== '');
    for (const record of records) {
      const terminated = record.endsWith('\n');
      const body = terminated ? record.slice(0, -1) : record;
      const blank = body === '';
      if (flags.squeezeBlank && blank && previousBlank) continue;
      previousBlank = blank;
      const numbered = flags.numberNonBlank ? !blank : flags.numberAll;
      if (numbered) out += `${String(++number).padStart(6, ' ')}\t`;
      out += visible(body, flags) + (flags.showEnds && terminated ? '$' : '') + (terminated ? '\n' : '');
    }
  }
  return out;
}

export function cmdEcho(ctx: ShellContext, args: string[]): string {
  let interpretEsc = false;
  let noNewline = false;
  const textParts: string[] = [];

  for (const arg of args) {
    if (arg === '-e' && textParts.length === 0) { interpretEsc = true; continue; }
    if (arg === '-n' && textParts.length === 0) { noNewline = true; continue; }
    textParts.push(arg);
  }

  let text = textParts.join(' ');
  if (interpretEsc) {
    text = interpretEscapes(text);
  }
  return text;
}

const INSTALL_DEFAULT_MODE = 0o755;

interface InstallRequest {
  readonly directories: boolean;
  readonly createLeading: boolean;
  readonly verbose: boolean;
  readonly modeText: string | null;
  readonly owner: string | null;
  readonly group: string | null;
  readonly targetDirectory: string | null;
  readonly operands: string[];
}

function parseInstallArguments(args: readonly string[]): InstallRequest {
  let directories = false;
  let createLeading = false;
  let verbose = false;
  let modeText: string | null = null;
  let owner: string | null = null;
  let group: string | null = null;
  let targetDirectory: string | null = null;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (argument === '--directory') directories = true;
    else if (argument === '--verbose') verbose = true;
    else if (argument.startsWith('--mode=')) modeText = argument.slice('--mode='.length);
    else if (argument.startsWith('--owner=')) owner = argument.slice('--owner='.length);
    else if (argument.startsWith('--group=')) group = argument.slice('--group='.length);
    else if (argument.startsWith('--target-directory=')) targetDirectory = argument.slice('--target-directory='.length);
    else if (argument.startsWith('--')) continue;
    else if (argument.startsWith('-') && argument.length > 1) {
      for (let letter = 1; letter < argument.length; letter++) {
        const flag = argument[letter];
        if (flag === 'd') directories = true;
        else if (flag === 'D') createLeading = true;
        else if (flag === 'v') verbose = true;
        else if (flag === 'm' || flag === 'o' || flag === 'g' || flag === 't') {
          const attached = argument.slice(letter + 1);
          const value = attached !== '' ? attached : args[++index] ?? '';
          if (flag === 'm') modeText = value;
          else if (flag === 'o') owner = value;
          else if (flag === 'g') group = value;
          else targetDirectory = value;
          break;
        }
      }
    } else operands.push(argument);
  }
  return { directories, createLeading, verbose, modeText, owner, group, targetDirectory, operands };
}

export function installOperands(args: readonly string[]): string[] {
  return parseInstallArguments(args).operands;
}

export function cmdInstall(ctx: ShellContext, args: string[]): string {
  const request = parseInstallArguments(args);
  let mode = INSTALL_DEFAULT_MODE;
  if (request.modeText !== null) {
    const parsed = parseChmodMode(request.modeText, 0);
    if (parsed === null) return `install: invalid mode '${request.modeText}'`;
    mode = parsed;
  }
  const uid = request.owner === null ? ctx.uid : ctx.userMgr.resolveUid(request.owner);
  const gid = request.group === null ? ctx.gid : ctx.userMgr.resolveGid(request.group);
  if (uid < 0) return `install: invalid user '${request.owner}'`;
  if (gid < 0) return `install: invalid group '${request.group}'`;
  const messages: string[] = [];
  const makeDirectories = (absolute: string, display: string): void => {
    const missing: string[] = [];
    for (let probe = absolute; probe !== '/' && !ctx.vfs.exists(probe); probe = probe.slice(0, probe.lastIndexOf('/')) || '/') missing.unshift(probe);
    for (const component of missing) {
      ctx.vfs.mkdir(component, component === absolute ? mode : INSTALL_DEFAULT_MODE, ctx.uid, ctx.gid);
      if (uid !== ctx.uid || gid !== ctx.gid) ctx.vfs.chown(component, uid, gid);
      if (request.verbose) messages.push(`install: creating directory '${displayedComponent(display, absolute, missing, component)}'`);
    }
  };
  if (request.directories) {
    if (request.operands.length === 0) return "install: missing file operand\nTry 'install --help' for more information.";
    for (const operand of request.operands) makeDirectories(ctx.vfs.normalizePath(operand, ctx.cwd), operand);
    return messages.join('\n');
  }
  const operands = [...request.operands];
  const destinationName = request.targetDirectory ?? operands.pop();
  if (destinationName === undefined || operands.length === 0) {
    return destinationName === undefined
      ? "install: missing file operand\nTry 'install --help' for more information."
      : `install: missing destination file operand after '${destinationName}'\nTry 'install --help' for more information.`;
  }
  const destination = ctx.vfs.normalizePath(destinationName, ctx.cwd);
  const intoDirectory = ctx.vfs.getType(destination) === 'directory';
  if (operands.length > 1 && !intoDirectory) return `install: target '${destinationName}': ${ctx.vfs.exists(destination) ? 'Not a directory' : 'No such file or directory'}`;
  for (const sourceName of operands) {
    const source = ctx.vfs.resolveInode(ctx.vfs.normalizePath(sourceName, ctx.cwd));
    if (source === null) {
      messages.push(`install: cannot stat '${sourceName}': No such file or directory`);
      continue;
    }
    if (source.type === 'directory') {
      messages.push(`install: omitting directory '${sourceName}'`);
      continue;
    }
    const base = sourceName.split('/').filter(Boolean).pop() ?? '';
    const target = intoDirectory ? `${destination.replace(/\/$/, '')}/${base}` : destination;
    const targetName = intoDirectory ? `${destinationName.replace(/\/$/, '')}/${base}` : destinationName;
    if (request.createLeading) makeDirectories(target.slice(0, target.lastIndexOf('/')) || '/', targetName);
    if (ctx.vfs.lstat(target) !== null) ctx.vfs.deleteFile(target);
    if (ctx.vfs.createFileAt(target, source.content, mode, ctx.uid, ctx.gid) === null) {
      messages.push(`install: cannot create regular file '${targetName}': No such file or directory`);
      continue;
    }
    ctx.vfs.chmod(target, mode);
    if (uid !== ctx.uid || gid !== ctx.gid) ctx.vfs.chown(target, uid, gid);
    if (request.verbose) messages.push(`'${sourceName}' -> '${targetName}'`);
  }
  return messages.join('\n');
}

export function displayedComponent(typed: string, absolute: string, components: readonly string[], component: string): string {
  const trimmed = typed.replace(/\/+$/, '');
  const segments = trimmed.split('/');
  const dropped = components.length - 1 - components.indexOf(component);
  return segments.slice(0, Math.max(1, segments.length - dropped)).join('/') || absolute;
}

export function cmdPwd(ctx: ShellContext): string {
  return ctx.cwd;
}

export function cmdTee(ctx: ShellContext, args: string[], stdin: string): { output: string; failed: boolean } {
  let append = false;
  const files: string[] = [];
  for (const arg of args) {
    if (arg === '-a') { append = true; continue; }
    if (arg.startsWith('-')) continue;
    files.push(arg);
  }

  const refusedAtOpen: string[] = [];
  const refusedAtWrite: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const refusal = ctx.openRefusal?.(absPath) ?? null;
    if (refusal !== null) {
      refusedAtOpen.push(`tee: ${f}: ${refusal}`);
      continue;
    }
    const written = ctx.vfs.writeFile(absPath, stdin, ctx.uid, ctx.gid, ctx.umask, append);
    if (!written && ctx.vfs.hasWriter(absPath)) refusedAtWrite.push(`tee: ${f}: Invalid argument`);
  }

  const copied = refusedAtWrite.length === 0 || stdin.endsWith('\n') ? stdin : `${stdin}\n`;
  const output = [...refusedAtOpen.map((line) => `${line}\n`), copied, ...refusedAtWrite].join('');
  return { output, failed: refusedAtOpen.length + refusedAtWrite.length > 0 };
}

// ─── Glob expansion helper ─────────────────────────────────────────

export function expandGlob(ctx: ShellContext, pattern: string): string[] {
  if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[')) return [pattern];

  const absPattern = ctx.vfs.normalizePath(pattern, ctx.cwd);
  const expanded = ctx.vfs.globExpand(pattern, ctx.cwd);
  if (expanded.length === 0) return [pattern]; // No match, return literal

  // Return relative paths if input was relative
  if (!pattern.startsWith('/')) {
    const cwdPrefix = ctx.cwd === '/' ? '/' : ctx.cwd + '/';
    return expanded.map(p => p.startsWith(cwdPrefix) ? p.slice(cwdPrefix.length) : p);
  }

  return expanded;
}
