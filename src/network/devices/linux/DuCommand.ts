import type { ShellContext } from './LinuxFileCommands';
import { gnuOptionSet } from './GnuOptionGuard';
import { shortOptions } from './commands/Getopt';
import { fnmatch } from './fs/Glob';
import { lsHumanSize } from './LsLayout';
import { formatLocalTime } from './system/SystemInfo';
import type { INode } from './VirtualFileSystem';

const BLOCK_BYTES = 4096;

interface DuScale {
  readonly unit: number;
  readonly suffix: string;
}

const UNIT_POWERS: Readonly<Record<string, number>> = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8, R: 9, Q: 10 };

function parseBlockSize(text: string): DuScale | null {
  const match = /^(\d*)([KMGTPEZYRQ]?)(i?B)?$/i.exec(text);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  const power = match[2] === '' ? 0 : UNIT_POWERS[match[2].toUpperCase()];
  const decimal = match[3] !== undefined && match[3].toUpperCase() === 'B' && match[2] !== '';
  const base = decimal ? 1000 : 1024;
  const count = match[1] === '' ? 1 : Number(match[1]);
  if (count === 0) return null;
  const unit = count * base ** power;
  const suffix = match[1] === '' && power > 0 ? `${match[2].toUpperCase()}${decimal ? 'B' : ''}`.replace(/^K(B)$/, 'k$1') : '';
  return { unit, suffix };
}

function parseThreshold(text: string): number | null {
  const negative = text.startsWith('-');
  const scale = parseBlockSize(negative ? text.slice(1) : text);
  if (scale === null) return null;
  const digits = /^\d+/.exec(negative ? text.slice(1) : text);
  const count = digits === null ? 1 : Number(digits[0]);
  const bytes = digits === null ? scale.unit : scale.unit;
  return (negative ? -1 : 1) * (count === 0 ? 0 : bytes);
}

interface DuOptions {
  all: boolean;
  total: boolean;
  summarize: boolean;
  maxDepth: number | null;
  apparent: boolean;
  scale: DuScale | null;
  human: 1024 | 1000 | null;
  separate: boolean;
  countLinks: boolean;
  dereference: 'none' | 'arguments' | 'all';
  oneFileSystem: boolean;
  nul: boolean;
  inodes: boolean;
  threshold: number | null;
  time: 'mtime' | 'atime' | 'ctime' | null;
  timeStyle: string;
  patterns: string[];
  files0From: string | null;
}

const TRY_HELP = "Try 'du --help' for more information.";

function timeArgumentError(option: string, value: string, choices: readonly string[]): string {
  return [`du: invalid argument '${value}' for '${option}'`, 'Valid arguments are:', ...choices.map((c) => `  - ${c}`), TRY_HELP].join('\n');
}

function parseDuArguments(ctx: ShellContext, args: readonly string[]): { opts: DuOptions; targets: string[] } | string {
  const set = gnuOptionSet('du');
  const opts: DuOptions = {
    all: false, total: false, summarize: false, maxDepth: null, apparent: false, scale: null, human: null,
    separate: false, countLinks: false, dereference: 'none', oneFileSystem: false, nul: false, inodes: false,
    threshold: null, time: null, timeStyle: 'long-iso', patterns: [], files0From: null,
  };
  const targets: string[] = [];
  let sizeChoice: 'default' | 'human' | 'scale' = 'default';
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand') { targets.push(item.value); continue; }
    if (item.kind !== 'option') continue;
    const argument = item.argument;
    switch (item.long ?? item.letter) {
      case '0': case 'null': opts.nul = true; break;
      case 'a': case 'all': opts.all = true; break;
      case 'apparent-size': opts.apparent = true; break;
      case 'b': case 'bytes': opts.apparent = true; opts.scale = { unit: 1, suffix: '' }; sizeChoice = 'scale'; break;
      case 'B': case 'block-size': {
        const scale = parseBlockSize(argument ?? '');
        if (scale === null) return `du: invalid ${item.long === undefined ? '-B' : '--block-size'} argument '${argument ?? ''}'`;
        opts.scale = scale;
        sizeChoice = 'scale';
        break;
      }
      case 'c': case 'total': opts.total = true; break;
      case 'D': case 'H': case 'dereference-args': if (opts.dereference === 'none') opts.dereference = 'arguments'; break;
      case 'd': case 'max-depth': {
        if (!/^-?\d+$/.test(argument ?? '')) return `du: invalid maximum depth '${argument ?? ''}'\n${TRY_HELP}`;
        opts.maxDepth = Number(argument) < 0 ? null : Number(argument);
        break;
      }
      case 'files0-from': opts.files0From = argument ?? null; break;
      case 'h': case 'human-readable': opts.human = 1024; sizeChoice = 'human'; break;
      case 'si': opts.human = 1000; sizeChoice = 'human'; break;
      case 'inodes': opts.inodes = true; break;
      case 'k': opts.scale = { unit: 1024, suffix: '' }; sizeChoice = 'scale'; break;
      case 'm': opts.scale = { unit: 1048576, suffix: '' }; sizeChoice = 'scale'; break;
      case 'L': case 'dereference': opts.dereference = 'all'; break;
      case 'l': case 'count-links': opts.countLinks = true; break;
      case 'P': case 'no-dereference': opts.dereference = 'none'; break;
      case 'S': case 'separate-dirs': opts.separate = true; break;
      case 's': case 'summarize': opts.summarize = true; break;
      case 't': case 'threshold': {
        const threshold = parseThreshold(argument ?? '');
        if (threshold === null) return `du: invalid -t argument '${argument ?? ''}'`;
        opts.threshold = threshold;
        break;
      }
      case 'time': {
        const which = argument ?? 'mtime';
        if (/^(atime|access|use)$/.test(which)) opts.time = 'atime';
        else if (/^(ctime|status)$/.test(which)) opts.time = 'ctime';
        else if (which === 'mtime') opts.time = 'mtime';
        else return timeArgumentError('--time', which, ["'atime', 'access', 'use'", "'ctime', 'status'"]);
        break;
      }
      case 'time-style': {
        const style = argument ?? '';
        if (!style.startsWith('+') && !/^(full-iso|long-iso|iso)$/.test(style)) {
          return timeArgumentError('time style', style, ["'full-iso'", "'long-iso'", "'iso'"]);
        }
        opts.timeStyle = style;
        break;
      }
      case 'X': case 'exclude-from': {
        const text = ctx.vfs.readFile(ctx.vfs.normalizePath(argument ?? '', ctx.cwd));
        if (text === null) return `du: ${argument ?? ''}: No such file or directory\n${TRY_HELP}`;
        opts.patterns.push(...text.split('\n').filter((line) => line !== ''));
        break;
      }
      case 'exclude': opts.patterns.push(argument ?? ''); break;
      case 'x': case 'one-file-system': opts.oneFileSystem = true; break;
      default: break;
    }
  }
  if (sizeChoice === 'human') opts.scale = null;
  if (sizeChoice !== 'human') opts.human = null;
  if (opts.summarize && opts.maxDepth !== null && opts.maxDepth !== 0) return `du: warning: summarizing conflicts with --max-depth=${opts.maxDepth}\n${TRY_HELP}`;
  if (opts.summarize && opts.all) return `du: cannot both summarize and show all entries\n${TRY_HELP}`;
  if (opts.summarize) opts.maxDepth = 0;
  return { opts, targets };
}

interface DuNode {
  readonly inode: INode;
  readonly size: number;
}

export function cmdDu(ctx: ShellContext, args: string[]): string {
  const parsed = parseDuArguments(ctx, args);
  if (typeof parsed === 'string') return parsed;
  const { opts } = parsed;
  let targets = parsed.targets;
  const errors: string[] = [];
  if (opts.files0From !== null) {
    const text = ctx.vfs.readFile(ctx.vfs.normalizePath(opts.files0From, ctx.cwd));
    if (text === null) return `du: cannot open '${opts.files0From}' for reading: No such file or directory`;
    targets = text.split('\0').filter((name) => name !== '');
  }
  if (targets.length === 0 && opts.files0From === null) targets = ['.'];

  const eol = opts.nul ? '\0' : '\n';
  const seen = new Set<number>();
  const lines: string[] = [];
  let grand = 0;

  const usage = (inode: INode): number => {
    if (opts.inodes) return 1;
    if (opts.apparent) return inode.type === 'directory' ? 0 : inode.size;
    if (inode.type === 'directory') return BLOCK_BYTES;
    if (inode.type === 'symlink' || inode.type === 'chardev') return 0;
    return Math.ceil(inode.size / BLOCK_BYTES) * BLOCK_BYTES;
  };

  const render = (amount: number): string => {
    if (opts.inodes) return String(amount);
    if (opts.human !== null) return lsHumanSize(amount, opts.human);
    const scale = opts.scale ?? { unit: 1024, suffix: '' };
    return `${Math.ceil(amount / scale.unit)}${scale.suffix}`;
  };

  const excluded = (name: string, display: string): boolean => opts.patterns.some((pattern) =>
    fnmatch(pattern, name) || fnmatch(pattern, display) || display.split('/').some((_, at, parts) => fnmatch(pattern, parts.slice(at).join('/'))));

  const emit = (amount: number, display: string, newest: number): void => {
    if (opts.threshold !== null) {
      const bytes = opts.inodes ? amount : amount;
      if (opts.threshold >= 0 ? bytes < opts.threshold : bytes > -opts.threshold) return;
    }
    const time = opts.time === null ? '' : `\t${formatLocalTime(opts.timeStyle === 'iso' ? '%Y-%m-%d' : opts.timeStyle === 'full-iso' ? '%Y-%m-%d %H:%M:%S.%N %z' : opts.timeStyle === 'long-iso' ? '%Y-%m-%d %H:%M' : opts.timeStyle.slice(1), newest, ctx.zone)}`;
    lines.push(`${render(amount)}${time}\t${display}`);
  };

  const stampOf = (inode: INode): number => inode[opts.time ?? 'mtime'];

  const visit = (path: string, display: string, depth: number, rootDevice: number | undefined, isArgument: boolean): { amount: number; newest: number } => {
    const followLink = opts.dereference === 'all' || (opts.dereference === 'arguments' && isArgument);
    const node = ctx.vfs.resolveInode(path, followLink) ?? ctx.vfs.resolveInode(path, false);
    if (!node) return { amount: 0, newest: 0 };
    const dedupAll = opts.dereference === 'all';
    const counted = opts.countLinks || node.type === 'directory' || (!dedupAll && node.linkCount <= 1) || !seen.has(node.id);
    if (node.type !== 'directory') {
      seen.add(node.id);
      const amount = counted ? usage(node) : 0;
      const show = depth === 0 || (opts.all && (opts.maxDepth === null || depth <= opts.maxDepth));
      if (show && (counted || depth === 0)) emit(amount, display, stampOf(node));
      return { amount, newest: stampOf(node) };
    }
    let subtotal = usage(node);
    let newest = stampOf(node);
    let subdirectories = 0;
    for (const { name } of ctx.vfs.listDirectory(path) ?? []) {
      if (name === '.' || name === '..') continue;
      const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
      const childDisplay = display.endsWith('/') ? `${display}${name}` : `${display}/${name}`;
      if (excluded(name, childDisplay)) continue;
      const child = ctx.vfs.resolveInode(childPath, opts.dereference === 'all') ?? ctx.vfs.resolveInode(childPath, false);
      if (opts.oneFileSystem && child?.type === 'directory' && ctx.deviceOf !== undefined && ctx.deviceOf(childPath) !== rootDevice) continue;
      const result = visit(childPath, childDisplay, depth + 1, rootDevice, false);
      if (child?.type === 'directory') subdirectories += result.amount;
      subtotal += result.amount;
      newest = Math.max(newest, result.newest);
    }
    const reported = opts.separate ? subtotal - subdirectories : subtotal;
    if (opts.maxDepth === null || depth <= opts.maxDepth) emit(reported, display, newest);
    return { amount: subtotal, newest };
  };

  for (const target of targets) {
    const absPath = ctx.vfs.normalizePath(target, ctx.cwd);
    if (!ctx.vfs.lstat(absPath)) {
      errors.push(`du: cannot access '${target}': No such file or directory`);
      continue;
    }
    const result = visit(absPath, target, 0, ctx.deviceOf?.(absPath), true);
    grand += result.amount;
  }
  if (opts.total) emit(grand, 'total', 0);
  const body = [...errors.map((e) => e), ...lines].join(eol);
  return opts.nul && lines.length > 0 ? `${body}\0` : body;
}
