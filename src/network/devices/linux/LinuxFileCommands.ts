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

export function cmdLs(ctx: ShellContext, args: string[]): string {
  const parsed = parseLsArguments(ctx, args);
  if (typeof parsed === 'string') return parsed;
  const { opts, dirOnly } = parsed;
  const paths = parsed.paths.length === 0 ? ['.'] : parsed.paths;

  const failures: string[] = [];
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
  const out: string[] = [...failures];
  if (listedFiles.length > 0) out.push(...renderEntries(ctx, listedFiles, opts, false).lines);
  const headed = paths.length > 1 && !opts.recursive;
  listedDirectories.forEach((directory, index) => {
    if (headed) out.push(`${index > 0 || listedFiles.length > 0 ? '\n' : ''}${directory.name}:`);
    out.push(listDir(ctx, directory.absPath, directory.name, opts));
  });
  const text = out.join(eol);
  return opts.zero ? `${text}\0` : text.trimEnd();
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

function listDir(ctx: ShellContext, absPath: string, displayPath: string, opts: LsOpts): string {
  const entries = ctx.vfs.listDirectory(absPath);
  if (!entries) return `ls: cannot access '${displayPath}': No such file or directory`;
  if (ctx.uid !== 0 && !ctx.vfs.path(absPath, '/', actorOf(ctx)).canRead()) {
    return `ls: cannot open directory '${displayPath}': Permission denied`;
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
      lines.push(listDir(ctx, entry.absPath, childDisplay, opts));
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

export function cmdCat(ctx: ShellContext, args: string[]): string {
  const contents: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const path = ctx.vfs.normalizePath(arg, ctx.cwd);
    const inode = ctx.vfs.resolveInode(path, true);
    if (inode && ctx.uid !== 0 && !ctx.vfs.path(path, '/', actorOf(ctx)).canRead()) {
      return `cat: ${arg}: Permission denied`;
    }
    const content = ctx.vfs.readFile(path);
    if (content === null) {
      return `cat: ${arg}: No such file or directory`;
    }
    contents.push(content);
  }
  return renderCat(contents, parseCatFlags(args));
}

function canReadInode(
  inode: { permissions: number; uid: number; gid: number },
  ctx: ShellContext,
): boolean {
  const mode = inode.permissions;
  if (ctx.uid === inode.uid) return (mode & 0o400) !== 0;
  const groups = (ctx.userMgr as unknown as {
    getUserGroups?: (n: string) => Array<{ gid: number }>;
  }).getUserGroups?.(ctx.userMgr.currentUser) ?? [];
  if (inode.gid === ctx.gid || groups.some((g) => g.gid === inode.gid)) {
    return (mode & 0o040) !== 0;
  }
  return (mode & 0o004) !== 0;
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

interface CpRequest {
  readonly recursive: boolean;
  readonly preserve: boolean;
  readonly noClobber: boolean;
  readonly verbose: boolean;
  readonly updateOnly: boolean;
  readonly hardLink: boolean;
  readonly symbolicLink: boolean;
  readonly backup: boolean;
  readonly noTargetDirectory: boolean;
  readonly targetDirectory: string | null;
  readonly dereference: 'always' | 'command-line' | 'never' | null;
  readonly operands: string[];
}

function parseCpArguments(args: readonly string[]): CpRequest | string {
  const flags = {
    recursive: false, preserve: false, noClobber: false, verbose: false, updateOnly: false, hardLink: false, symbolicLink: false,
    backup: false, noTargetDirectory: false,
  };
  let targetDirectory: string | null = null;
  let dereference: CpRequest['dereference'] = null;
  const operands: string[] = [];
  const invalid = (text: string): string => `cp: invalid option -- '${text}'\nTry 'cp --help' for more information.`;
  let optionsEnded = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (optionsEnded || !argument.startsWith('-') || argument === '-') {
      operands.push(argument);
    } else if (argument === '--') {
      optionsEnded = true;
    } else if (argument.startsWith('--')) {
      if (argument === '--recursive') flags.recursive = true;
      else if (argument === '--archive') { flags.recursive = true; flags.preserve = true; dereference ??= 'never'; }
      else if (argument === '--preserve' || argument.startsWith('--preserve=')) flags.preserve = true;
      else if (argument === '--no-clobber') flags.noClobber = true;
      else if (argument === '--verbose') flags.verbose = true;
      else if (argument === '--update' || argument.startsWith('--update=')) flags.updateOnly = true;
      else if (argument === '--link') flags.hardLink = true;
      else if (argument === '--symbolic-link') flags.symbolicLink = true;
      else if (argument === '--backup' || argument.startsWith('--backup=')) flags.backup = true;
      else if (argument === '--no-target-directory') flags.noTargetDirectory = true;
      else if (argument === '--dereference') dereference = 'always';
      else if (argument === '--no-dereference') dereference = 'never';
      else if (argument.startsWith('--target-directory=')) targetDirectory = argument.slice('--target-directory='.length);
      else if (argument === '--target-directory') targetDirectory = args[++index] ?? null;
      else if (argument !== '--force' && argument !== '--one-file-system') return `cp: unrecognized option '${argument}'\nTry 'cp --help' for more information.`;
    } else {
      for (let letter = 1; letter < argument.length; letter++) {
        const flag = argument[letter];
        if (flag === 'r' || flag === 'R') flags.recursive = true;
        else if (flag === 'a') { flags.recursive = true; flags.preserve = true; dereference ??= 'never'; }
        else if (flag === 'p') flags.preserve = true;
        else if (flag === 'n') flags.noClobber = true;
        else if (flag === 'v') flags.verbose = true;
        else if (flag === 'u') flags.updateOnly = true;
        else if (flag === 'l') flags.hardLink = true;
        else if (flag === 's') flags.symbolicLink = true;
        else if (flag === 'b') flags.backup = true;
        else if (flag === 'T') flags.noTargetDirectory = true;
        else if (flag === 'L') dereference = 'always';
        else if (flag === 'H') dereference = 'command-line';
        else if (flag === 'P' || flag === 'd') dereference = 'never';
        else if (flag === 't') {
          const attached = argument.slice(letter + 1);
          if (attached !== '') targetDirectory = attached;
          else if (index + 1 < args.length) targetDirectory = args[++index];
          else return "cp: option requires an argument -- 't'\nTry 'cp --help' for more information.";
          break;
        } else if (flag !== 'f' && flag !== 'x' && flag !== 'Z' && flag !== 'i') return invalid(flag);
      }
    }
  }
  return { ...flags, targetDirectory, dereference, operands };
}

export function cpOperands(args: readonly string[]): string[] {
  const request = parseCpArguments(args);
  return typeof request === 'string' ? [] : request.operands;
}

const PERMISSION_BITS = 0o777;
const ALL_MODE_BITS = 0o7777;
const CP_NO_CLOBBER_WARNING = 'cp: warning: behavior of -n is non-portable and may change in future; use --update=none instead';

function copyTree(
  ctx: ShellContext, request: CpRequest, source: string, target: string, sourceName: string, targetName: string, messages: string[],
  depth = 0,
): void {
  const link = ctx.vfs.lstat(source);
  if (link === null) {
    messages.push(`cp: cannot stat '${sourceName}': No such file or directory`);
    return;
  }
  const follow = request.dereference === 'always'
    || (depth === 0 && (request.dereference === 'command-line' || (request.dereference === null && !request.recursive)));
  const inode = link.type === 'symlink' && follow ? ctx.vfs.resolveInode(source) ?? link : link;
  const exists = ctx.vfs.lstat(target) !== null;
  if (inode.type === 'directory') {
    if (!request.recursive) {
      messages.push(`cp: -r not specified; omitting directory '${sourceName}'`);
      return;
    }
    if (target === source || target.startsWith(`${source}/`)) {
      messages.push(`cp: cannot copy a directory, '${sourceName}', into itself, '${targetName}'`);
      return;
    }
    if (!exists && !ctx.vfs.mkdir(target, request.preserve ? inode.permissions & ALL_MODE_BITS : inode.permissions & PERMISSION_BITS & ~ctx.umask, ctx.uid, ctx.gid)) {
      messages.push(`cp: cannot create directory '${targetName}'`);
      return;
    }
    if (request.verbose) messages.push(`'${sourceName}' -> '${targetName}'`);
    for (const entry of ctx.vfs.listDirectory(source) ?? []) {
      if (entry.name === '.' || entry.name === '..') continue;
      copyTree(ctx, request, `${source}/${entry.name}`, `${target}/${entry.name}`, `${sourceName}/${entry.name}`, `${targetName}/${entry.name}`, messages, depth + 1);
    }
    if (request.preserve) {
      ctx.vfs.chmod(target, inode.permissions & ALL_MODE_BITS);
      if (ctx.uid === 0) ctx.vfs.chown(target, inode.uid, inode.gid);
    }
    return;
  }
  if (exists && request.noClobber) return;
  if (exists && request.updateOnly && (ctx.vfs.lstat(target)?.mtime ?? 0) >= inode.mtime) return;
  if (exists && request.backup) ctx.vfs.rename(target, `${target}~`);
  if (request.hardLink || request.symbolicLink) {
    if (ctx.vfs.lstat(target) !== null) ctx.vfs.deleteFile(target);
    const made = request.symbolicLink ? ctx.vfs.createSymlink(target, sourceName, ctx.uid, ctx.gid) : ctx.vfs.createHardLink(target, source);
    if (!made) messages.push(`cp: cannot create ${request.symbolicLink ? 'symbolic' : 'hard'} link '${targetName}' to '${sourceName}'`);
    else if (request.verbose) messages.push(`'${sourceName}' -> '${targetName}'`);
    return;
  }
  if (inode.type === 'symlink') {
    if (exists) ctx.vfs.deleteFile(target);
    if (!ctx.vfs.createSymlink(target, inode.target, ctx.uid, ctx.gid)) messages.push(`cp: cannot create symbolic link '${targetName}'`);
    else if (request.verbose) messages.push(`'${sourceName}' -> '${targetName}'`);
    return;
  }
  if (inode.type !== 'file') {
    messages.push(`cp: cannot copy '${sourceName}' to '${targetName}'`);
    return;
  }
  const created = ctx.vfs.createFileAt(target, inode.content, inode.permissions & PERMISSION_BITS & ~ctx.umask, ctx.uid, ctx.gid);
  if (created === null) {
    messages.push(`cp: cannot create regular file '${targetName}'`);
    return;
  }
  if (request.preserve) {
    ctx.vfs.chmod(target, inode.permissions & ALL_MODE_BITS);
    if (ctx.uid === 0) ctx.vfs.chown(target, inode.uid, inode.gid);
  }
  if (request.verbose) messages.push(`'${sourceName}' -> '${targetName}'`);
}

export function cmdCp(ctx: ShellContext, args: string[]): string {
  const parsed = parseCpArguments(args);
  if (typeof parsed === 'string') return parsed;
  const request = parsed;
  const operands = [...request.operands];
  const destinationName = request.targetDirectory ?? operands.pop();
  if (destinationName === undefined) return "cp: missing file operand\nTry 'cp --help' for more information.";
  if (operands.length === 0) {
    return request.targetDirectory === null
      ? `cp: missing destination file operand after '${destinationName}'\nTry 'cp --help' for more information.`
      : "cp: missing file operand\nTry 'cp --help' for more information.";
  }
  const actor = actorOf(ctx);
  const destination = ctx.vfs.path(destinationName, ctx.cwd, actor);
  const intoDirectory = request.targetDirectory !== null || (!request.noTargetDirectory && destination.isDirectory());
  if (request.targetDirectory !== null && !destination.isDirectory()) return `cp: target '${destinationName}': ${destination.exists() ? 'Not a directory' : 'No such file or directory'}`;
  if (operands.length > 1 && !intoDirectory) return `cp: target '${destinationName}': ${destination.exists() ? 'Not a directory' : 'No such file or directory'}`;
  const messages: string[] = request.noClobber ? [CP_NO_CLOBBER_WARNING] : [];
  for (const sourceName of operands) {
    const source = ctx.vfs.path(sourceName, ctx.cwd, actor);
    if (ctx.uid !== 0) {
      if (source.exists() && !source.canRead()) {
        messages.push(`cp: cannot open '${sourceName}' for reading: Permission denied`);
        continue;
      }
      const destinationDirectory = intoDirectory ? destination : destination.parent();
      if (destinationDirectory.inode() && !destinationDirectory.isWritableDir()) {
        messages.push(`cp: cannot create regular file '${destinationName}': Permission denied`);
        continue;
      }
    }
    const base = source.value.split('/').filter(Boolean).pop() ?? '';
    const target = intoDirectory ? `${destination.value.replace(/\/$/, '')}/${base}` : destination.value;
    const targetName = intoDirectory ? `${destinationName.replace(/\/$/, '')}/${base}` : destinationName;
    copyTree(ctx, request, source.value, target, sourceName, targetName, messages);
  }
  return messages.join('\n');
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

export function cmdMv(ctx: ShellContext, args: string[]): string {
  const set = gnuOptionSet('mv');
  const operands: string[] = [];
  let noClobber = false;
  let update = false;
  let verbose = false;
  let noTargetDirectory = false;
  let targetDirectory: string | undefined;
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand') operands.push(item.value);
    else if (item.kind === 'option') {
      if (item.letter === 'n') noClobber = true;
      else if (item.letter === 'u') update = true;
      else if (item.letter === 'v') verbose = true;
      else if (item.letter === 'T') noTargetDirectory = true;
      else if (item.letter === 't') targetDirectory = item.argument;
    }
  }
  const actor = actorOf(ctx);
  const tryHelp = "Try 'mv --help' for more information.";
  let sources: string[];
  let destination: string;
  if (targetDirectory !== undefined) {
    sources = operands;
    destination = targetDirectory;
    if (sources.length === 0) return `mv: missing file operand\n${tryHelp}`;
    if (!ctx.vfs.path(destination, ctx.cwd, actor).isDirectory()) return `mv: target directory '${destination}': No such file or directory`;
  } else {
    if (operands.length === 0) return `mv: missing file operand\n${tryHelp}`;
    if (operands.length === 1) return `mv: missing destination file operand after '${operands[0]}'\n${tryHelp}`;
    sources = operands.slice(0, -1);
    destination = operands[operands.length - 1];
    if (noTargetDirectory && operands.length > 2) return `mv: extra operand '${operands[2]}'\n${tryHelp}`;
    if (sources.length > 1 && !ctx.vfs.path(destination, ctx.cwd, actor).isDirectory()) return `mv: target '${destination}' is not a directory\n${tryHelp}`;
  }
  const destinationIsDirectory = !noTargetDirectory && ctx.vfs.path(destination, ctx.cwd, actor).isDirectory();
  const lines: string[] = [];
  for (const source of sources) {
    const srcPath = ctx.vfs.path(source, ctx.cwd, actor);
    const baseName = source.replace(/\/+$/, '').split('/').pop() ?? source;
    const shownDestination = destinationIsDirectory ? `${destination.replace(/\/+$/, '')}/${baseName}` : destination;
    const dstPath = ctx.vfs.path(shownDestination, ctx.cwd, actor);
    if (!srcPath.exists()) { lines.push(`mv: cannot stat '${source}': No such file or directory`); continue; }
    if (srcPath.value === dstPath.value) { lines.push(`mv: '${source}' and '${shownDestination}' are the same file`); continue; }
    if (dstPath.exists()) {
      if (noClobber) continue;
      const srcNode = srcPath.lstatNode();
      const dstNode = dstPath.lstatNode();
      if (update && srcNode && dstNode && dstNode.mtime >= srcNode.mtime) continue;
    }
    if (ctx.uid !== 0) {
      const srcParent = srcPath.parent();
      const sp = srcParent.inode();
      if (sp && (!srcParent.canWrite() || !srcParent.canExecute())) {
        lines.push(`mv: cannot move '${source}' to '${shownDestination}': Permission denied`); continue;
      }
      const srcInode = srcPath.lstatNode();
      if (srcInode && sp && (sp.permissions & 0o1000) !== 0 && srcInode.uid !== ctx.uid && sp.uid !== ctx.uid) {
        lines.push(`mv: cannot move '${source}' to '${shownDestination}': Operation not permitted`); continue;
      }
      const destDir = dstPath.parent();
      if (destDir.inode() && !destDir.isWritableDir()) {
        lines.push(`mv: cannot move '${source}' to '${shownDestination}': Permission denied`); continue;
      }
    }
    if (!ctx.vfs.rename(srcPath.value, dstPath.value)) { lines.push(`mv: cannot move '${source}' to '${shownDestination}'`); continue; }
    if (verbose) lines.push(`renamed '${source}' -> '${shownDestination}'`);
  }
  return lines.join('\n');
}

export function cmdRm(ctx: ShellContext, args: string[]): string {
  let recursive = false;
  let force = false;
  let preserveRoot = true;
  const paths: string[] = [];

  for (const arg of args) {
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      if (arg === '--recursive') recursive = true;
      else if (arg === '--force') force = true;
      else if (arg === '--no-preserve-root') preserveRoot = false;
      else if (arg === '--preserve-root') preserveRoot = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) {
        if (ch === 'r' || ch === 'R') recursive = true;
        else if (ch === 'f') force = true;
      }
      continue;
    }
    paths.push(arg);
  }

  const actor = actorOf(ctx);

  for (const p of paths) {
    // Expand globs
    const expanded = expandGlob(ctx, p);
    for (const ep of expanded) {
      const path = ctx.vfs.path(ep, ctx.cwd, actor);
      const absPath = path.value;
      if (absPath === '/' && recursive && preserveRoot) {
        return `rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe`;
      }
      const inode = path.lstatNode();
      if (!inode) {
        if (!force) return `rm: cannot remove '${ep}': No such file or directory`;
        continue;
      }
      if (inode.type === 'directory' && !recursive) {
        return `rm: cannot remove '${ep}': Is a directory`;
      }
      if (ctx.uid !== 0) {
        const parent = path.parent();
        const pnode = parent.inode();
        if (pnode && (!parent.canWrite() || !parent.canExecute())) {
          return `rm: cannot remove '${ep}': Permission denied`;
        }
        if (pnode && (pnode.permissions & 0o1000) !== 0
            && inode.uid !== ctx.uid && pnode.uid !== ctx.uid) {
          return `rm: cannot remove '${ep}': Operation not permitted`;
        }
      }
      if (inode.type === 'directory') {
        ctx.vfs.rmrf(absPath);
      } else {
        ctx.vfs.deleteFile(absPath);
      }
    }
  }
  return '';
}

function displayedComponent(typed: string, absolute: string, components: readonly string[], component: string): string {
  const trimmed = typed.replace(/\/+$/, '');
  const segments = trimmed.split('/');
  const dropped = components.length - 1 - components.indexOf(component);
  return segments.slice(0, Math.max(1, segments.length - dropped)).join('/') || absolute;
}

const MKDIR_INTERMEDIATE_BITS = 0o300;
const MKDIR_DEFAULT_MODE = 0o777;

interface MkdirRequest {
  readonly parents: boolean;
  readonly verbose: boolean;
  readonly modeText: string | null;
  readonly paths: string[];
}

function parseMkdirArguments(args: readonly string[]): MkdirRequest | string {
  let parents = false;
  let verbose = false;
  let modeText: string | null = null;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      paths.push(...args.slice(index + 1));
      break;
    }
    if (argument === '--parents') parents = true;
    else if (argument === '--verbose') verbose = true;
    else if (argument.startsWith('--mode=')) modeText = argument.slice('--mode='.length);
    else if (argument === '--mode') modeText = args[++index] ?? null;
    else if (argument.startsWith('-') && argument.length > 1 && !argument.startsWith('--')) {
      for (let letter = 1; letter < argument.length; letter++) {
        const flag = argument[letter];
        if (flag === 'p') parents = true;
        else if (flag === 'v') verbose = true;
        else if (flag === 'm') {
          const attached = argument.slice(letter + 1);
          if (attached !== '') modeText = attached;
          else if (index + 1 < args.length) modeText = args[++index];
          else return "mkdir: option requires an argument -- 'm'\nTry 'mkdir --help' for more information.";
          break;
        }
      }
    } else {
      paths.push(argument);
    }
  }
  return { parents, verbose, modeText, paths };
}

export function mkdirOperands(args: readonly string[]): string[] {
  const request = parseMkdirArguments(args);
  return typeof request === 'string' ? [] : request.paths;
}

export function cmdMkdir(ctx: ShellContext, args: string[]): string {
  const request = parseMkdirArguments(args);
  if (typeof request === 'string') return request;
  if (request.paths.length === 0) return "mkdir: missing operand\nTry 'mkdir --help' for more information.";
  const defaultMode = MKDIR_DEFAULT_MODE & ~ctx.umask;
  let finalMode = defaultMode;
  if (request.modeText !== null) {
    const parsed = parseChmodMode(request.modeText, MKDIR_DEFAULT_MODE);
    if (parsed === null) return `mkdir: invalid mode '${request.modeText}'`;
    finalMode = parsed;
  }

  const actor = actorOf(ctx);
  const messages: string[] = [];
  const created = (name: string): void => {
    if (request.verbose) messages.push(`mkdir: created directory '${name}'`);
  };
  for (const p of request.paths) {
    const path = ctx.vfs.path(p, ctx.cwd, actor);
    const absPath = path.value;
    if (absPath.startsWith('/proc/') && !path.exists()) return `mkdir: cannot create directory '${p}': No such file or directory`;
    if (request.parents) {
      if (ctx.uid !== 0 && !path.exists()) {
        let anc = path.parent();
        while (!anc.exists() && anc.value !== '/') anc = anc.parent();
        if (!anc.isWritableDir()) {
          return [...messages, `mkdir: cannot create directory '${p}': Permission denied`].join('\n');
        }
      }
      const missing: string[] = [];
      for (let probe = absPath; probe !== '/' && !ctx.vfs.exists(probe); probe = probe.slice(0, probe.lastIndexOf('/')) || '/') missing.unshift(probe);
      for (const component of missing) {
        const isLast = component === absPath;
        ctx.vfs.mkdir(component, isLast ? finalMode : defaultMode | MKDIR_INTERMEDIATE_BITS, ctx.uid, ctx.gid);
        created(displayedComponent(p, absPath, missing, component));
      }
    } else {
      if (ctx.uid !== 0 && path.parent().inode() && !path.parent().isWritableDir()) {
        return [...messages, `mkdir: cannot create directory '${p}': Permission denied`].join('\n');
      }
      if (ctx.vfs.exists(absPath)) {
        messages.push(`mkdir: cannot create directory '${p}': File exists`);
        continue;
      }
      if (!ctx.vfs.mkdir(absPath, finalMode, ctx.uid, ctx.gid)) {
        // A directory costs an inode; on an exhausted volume that is the
        // real reason, and the one an operator has to be told about.
        if (ctx.vfs.freeInodes() === 0) {
          return [...messages, `mkdir: cannot create directory '${p}': No space left on device`].join('\n');
        }
        const parentType = ctx.vfs.getType(absPath.slice(0, absPath.lastIndexOf('/')) || '/');
        const reason = parentType === null ? ': No such file or directory' : parentType === 'directory' ? '' : ': Not a directory';
        messages.push(`mkdir: cannot create directory '${p}'${reason}`);
        continue;
      }
      created(p);
    }
  }
  return messages.join('\n');
}

export function cmdRmdir(ctx: ShellContext, args: string[]): string {
  const actor = actorOf(ctx);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const path = ctx.vfs.path(arg, ctx.cwd, actor);
    if (ctx.uid !== 0) {
      const parent = path.parent();
      const pnode = parent.inode();
      if (pnode && (!parent.canWrite() || !parent.canExecute())) {
        return `rmdir: failed to remove '${arg}': Permission denied`;
      }
      const inode = path.lstatNode();
      if (inode && pnode && (pnode.permissions & 0o1000) !== 0
          && inode.uid !== ctx.uid && pnode.uid !== ctx.uid) {
        return `rmdir: failed to remove '${arg}': Operation not permitted`;
      }
    }
    if (!ctx.vfs.rmdir(path.value)) {
      return `rmdir: failed to remove '${arg}'`;
    }
  }
  return '';
}

export function cmdLn(ctx: ShellContext, args: string[]): string {
  const flags = { symbolic: false, force: false, noDereference: false, verbose: false, relative: false, noTargetDirectory: false };
  const paths: string[] = [];
  let targetDirectory: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { paths.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const long = arg.slice(2);
      if (long === 'symbolic') flags.symbolic = true;
      else if (long === 'force') flags.force = true;
      else if (long === 'no-dereference') flags.noDereference = true;
      else if (long === 'verbose') flags.verbose = true;
      else if (long === 'relative') flags.relative = true;
      else if (long === 'no-target-directory') flags.noTargetDirectory = true;
      else return `ln: unrecognized option '${arg}'\nTry 'ln --help' for more information.`;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const letter of arg.slice(1)) {
        if (letter === 's') flags.symbolic = true;
        else if (letter === 'f') flags.force = true;
        else if (letter === 'n') flags.noDereference = true;
        else if (letter === 'v') flags.verbose = true;
        else if (letter === 'r') flags.relative = true;
        else if (letter === 'T') flags.noTargetDirectory = true;
        else if (letter === 't') { targetDirectory = args[++i] ?? null; break; }
        else return `ln: invalid option -- '${letter}'\nTry 'ln --help' for more information.`;
      }
      continue;
    }
    paths.push(arg);
  }
  const sources = targetDirectory !== null ? paths : paths.slice(0, -1);
  const destination = targetDirectory ?? paths[paths.length - 1];
  if (paths.length === 0 || (targetDirectory === null && paths.length < 2)) {
    return paths.length === 0 ? "ln: missing file operand\nTry 'ln --help' for more information." : `ln: missing destination file operand after '${paths[0]}'\nTry 'ln --help' for more information.`;
  }

  const actor = actorOf(ctx);
  const output: string[] = [];
  for (const source of sources) {
    const destP = ctx.vfs.path(destination, ctx.cwd, actor);
    const intoDirectory = !flags.noTargetDirectory && destP.isDirectory();
    const name = source.replace(/\/+$/, '').split('/').pop() ?? source;
    const linkText = intoDirectory ? `${destination.replace(/\/+$/, '')}/${name}` : destination;
    const linkP = ctx.vfs.path(linkText, ctx.cwd, actor);
    const linkPath = linkP.value;

    if (ctx.uid !== 0 && linkP.parent().inode() && !linkP.parent().isWritableDir()) {
      const kind = flags.symbolic ? 'symbolic link' : 'hard link';
      return `ln: failed to create ${kind} '${linkText}': Permission denied`;
    }
    if (ctx.vfs.lstat(linkPath)) {
      if (!flags.force) {
        return `ln: failed to create ${flags.symbolic ? 'symbolic' : 'hard'} link '${linkText}': File exists`;
      }
      ctx.vfs.deleteFile(linkPath);
    }

    let target = source;
    if (flags.symbolic && flags.relative) {
      const absTarget = ctx.vfs.normalizePath(source, ctx.cwd);
      const base = linkPath.split('/').slice(0, -1);
      const goal = absTarget.split('/');
      let common = 0;
      while (common < base.length && common < goal.length && base[common] === goal[common]) common++;
      target = [...base.slice(common).map(() => '..'), ...goal.slice(common)].join('/') || '.';
    }
    if (flags.symbolic) {
      if (!ctx.vfs.createSymlink(linkPath, target, ctx.uid, ctx.gid)) {
        return `ln: failed to create symbolic link '${linkText}'`;
      }
    } else {
      const absTarget = ctx.vfs.normalizePath(source, ctx.cwd);
      if (!ctx.vfs.createHardLink(linkPath, absTarget)) {
        return `ln: failed to create hard link '${linkText}'`;
      }
    }
    if (flags.verbose) output.push(`'${linkText}' ${flags.symbolic ? '->' : '=>'} '${target}'`);
  }
  return output.join('\n');
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
