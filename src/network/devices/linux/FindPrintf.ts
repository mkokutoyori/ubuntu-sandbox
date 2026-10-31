import type { ShellContext } from './LinuxFileCommands';
import { lsBlocksKiB, lsSize } from './LinuxFileCommands';
import { formatGeneral } from '@/bash/runtime/Printf';
import { formatLocalTime } from './system/SystemInfo';
import type { INode } from './VirtualFileSystem';

export interface PrintfSubject {
  readonly path: string;
  readonly display: string;
  readonly start: string;
  readonly inode: INode;
  readonly depth: number;
}

export interface PrintfEnvironment {
  readonly ctx: ShellContext;
  fsType(path: string): string;
  targetType(path: string): string;
  reportError(message: string): void;
}

interface Spec {
  readonly flags: string;
  readonly width: number | null;
  readonly precision: number | null;
}

type Part =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'field'; readonly directive: string; readonly timeDirective?: string; readonly spec: Spec; readonly source: string }
  | { readonly kind: 'stop' };

export interface CompiledPrintf {
  readonly parts: readonly Part[];
  readonly warnings: readonly string[];
}

const ESCAPES: Readonly<Record<string, string>> = {
  a: '\u0007', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\',
};

const KNOWN_DIRECTIVES = new Set('abcdDfFgGhHiklmMnpPsStuUyYZ'.split(''));
const TIME_DIRECTIVES = new Set(['A', 'C', 'T']);
const NUMERIC_DIRECTIVES = new Set(['d', 'm']);

export class PrintfFormatError extends Error {}

export function compilePrintf(format: string): CompiledPrintf {
  const parts: Part[] = [];
  const warnings: string[] = [];
  let text = '';
  const flush = () => { if (text !== '') { parts.push({ kind: 'text', text }); text = ''; } };
  let i = 0;
  while (i < format.length) {
    const c = format[i];
    if (c === '\\') {
      const next = format[i + 1];
      if (next === undefined) { warnings.push("find: warning: unrecognized escape `\\'"); text += '\\'; i++; continue; }
      if (next === 'c') { flush(); parts.push({ kind: 'stop' }); return { parts, warnings }; }
      if (next in ESCAPES) { text += ESCAPES[next]; i += 2; continue; }
      if (next >= '0' && next <= '7') {
        let digits = '';
        let j = i + 1;
        while (digits.length < 3 && format[j] >= '0' && format[j] <= '7') { digits += format[j]; j++; }
        text += String.fromCharCode(parseInt(digits, 8) & 0xff);
        i = j;
        continue;
      }
      warnings.push(`find: warning: unrecognized escape \`\\${next}'`);
      text += `\\${next}`;
      i += 2;
      continue;
    }
    if (c !== '%') { text += c; i++; continue; }
    if (format[i + 1] === '%') { text += '%'; i += 2; continue; }
    let j = i + 1;
    let flags = '';
    while (j < format.length && '-+ #0'.includes(format[j])) { flags += format[j]; j++; }
    let width = '';
    while (j < format.length && format[j] >= '0' && format[j] <= '9') { width += format[j]; j++; }
    let precision: string | null = null;
    if (format[j] === '.') {
      j++;
      precision = '';
      while (j < format.length && format[j] >= '0' && format[j] <= '9') { precision += format[j]; j++; }
    }
    const directive = format[j];
    if (directive === undefined) throw new PrintfFormatError('find: error: % at end of format string');
    const spec: Spec = { flags, width: width === '' ? null : Number(width), precision: precision === null ? null : Number(precision || '0') };
    if (TIME_DIRECTIVES.has(directive)) {
      const time = format[j + 1];
      if (time === undefined) {
        warnings.push(`find: warning: unrecognized format directive \`%${directive}'`);
        text += format.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      flush();
      parts.push({ kind: 'field', directive, timeDirective: time, spec, source: format.slice(i, j + 2) });
      i = j + 2;
      continue;
    }
    if (!KNOWN_DIRECTIVES.has(directive)) {
      warnings.push(`find: warning: unrecognized format directive \`%${directive}'`);
      text += format.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    flush();
    parts.push({ kind: 'field', directive, spec, source: format.slice(i, j + 1) });
    i = j + 1;
  }
  flush();
  return { parts, warnings };
}

function typeLetter(inode: INode): string {
  switch (inode.type) {
    case 'directory': return 'd';
    case 'symlink': return 'l';
    case 'fifo': return 'p';
    case 'socket': return 's';
    case 'chardev': return 'c';
    case 'blockdev': return 'b';
    default: return 'f';
  }
}

function fraction(ms: number): string {
  return `${String(Math.floor(ms) % 1000).padStart(3, '0')}0000000`;
}

function ctimeText(ctx: ShellContext, ms: number): string {
  return `${formatLocalTime('%a %b %e %H:%M:%S', ms, ctx.zone)}.${fraction(ms)} ${formatLocalTime('%Y', ms, ctx.zone)}`;
}

function timeText(ctx: ShellContext, ms: number, directive: string): string {
  if (directive === '@') return `${Math.floor(ms / 1000)}.${fraction(ms)}`;
  if (directive === 'S') return `${formatLocalTime('%S', ms, ctx.zone)}.${fraction(ms)}`;
  if (directive === 'T') return `${formatLocalTime('%H:%M:%S', ms, ctx.zone)}.${fraction(ms)}`;
  if (directive === '+') return `${formatLocalTime('%Y-%m-%d+%H:%M:%S', ms, ctx.zone)}.${fraction(ms)}0`;
  return formatLocalTime(`%${directive}`, ms, ctx.zone);
}

function fieldText(part: Extract<Part, { kind: 'field' }>, subject: PrintfSubject, env: PrintfEnvironment): string {
  const { ctx } = env;
  const inode = subject.inode;
  const display = subject.display;
  const startPrefix = subject.start.replace(/\/+$/, '');
  switch (part.directive) {
    case 'p': return display;
    case 'P': return display === subject.start ? '' : display.slice(startPrefix.length).replace(/^\/+/, '');
    case 'f': {
      const trimmed = display.replace(/\/+$/, '');
      if (trimmed === '') return display === '' ? '' : '/';
      return display.slice(trimmed.lastIndexOf('/') + 1);
    }
    case 'h': {
      const trimmed = display.replace(/\/+$/, '');
      if (trimmed === '') return '';
      const cut = trimmed.lastIndexOf('/');
      return cut < 0 ? '.' : cut === 0 ? '/' : trimmed.slice(0, cut);
    }
    case 'H': return subject.start;
    case 'm': return `${part.spec.flags.includes('#') ? '0' : ''}${(inode.permissions & 0o7777).toString(8)}`;
    case 'M': return ctx.vfs.formatPermissions(inode);
    case 'u': { const name = ctx.userMgr.getUserByUid(inode.uid)?.username; return name ?? String(inode.uid); }
    case 'g': { const name = ctx.userMgr.getGroupByGid(inode.gid)?.name; return name ?? String(inode.gid); }
    case 'U': return String(inode.uid);
    case 'G': return String(inode.gid);
    case 's': return String(lsSize(inode));
    case 'S': { const size = lsSize(inode); return size === 0 ? '1' : formatGeneral((lsBlocksKiB(inode) * 1024) / size, 6, false); }
    case 'b': return String(lsBlocksKiB(inode) * 2);
    case 'k': return String(lsBlocksKiB(inode));
    case 'y': return typeLetter(inode);
    case 'Y': return inode.type === 'symlink' ? env.targetType(subject.path) : typeLetter(inode);
    case 'n': return String(inode.linkCount);
    case 'i': return String(inode.id);
    case 'd': return String(subject.depth);
    case 'D': return String(ctx.deviceOf?.(subject.path) ?? 0);
    case 'F': return env.fsType(subject.path);
    case 'l': return inode.type === 'symlink' ? inode.target : '';
    case 'a': return ctimeText(ctx, inode.atime);
    case 'c': return ctimeText(ctx, inode.ctime);
    case 't': return ctimeText(ctx, inode.mtime);
    case 'A': case 'C': case 'T': {
      const stamp = part.directive === 'A' ? inode.atime : part.directive === 'C' ? inode.ctime : inode.mtime;
      return timeText(ctx, stamp, part.timeDirective as string);
    }
    case 'Z': env.reportError(`find: getfilecon failed: '${display}': No data available`); return '';
    default: return part.source;
  }
}

function pad(text: string, spec: Spec, numeric: boolean): string {
  let value = text;
  if (spec.precision !== null && !numeric) value = value.slice(0, spec.precision);
  if (spec.precision !== null && numeric && value.length < spec.precision) value = value.padStart(spec.precision, '0');
  if (numeric && /^\d/.test(value)) {
    if (spec.flags.includes('+')) value = `+${value}`;
    else if (spec.flags.includes(' ')) value = ` ${value}`;
  }
  if (spec.width === null || value.length >= spec.width) return value;
  if (spec.flags.includes('-')) return value.padEnd(spec.width);
  if (numeric && spec.flags.includes('0') && spec.precision === null) {
    const sign = /^[+ ]/.test(value) ? value[0] : '';
    return sign + value.slice(sign.length).padStart(spec.width - sign.length, '0');
  }
  return value.padStart(spec.width);
}

export function renderPrintf(compiled: CompiledPrintf, subject: PrintfSubject, env: PrintfEnvironment): string {
  let out = '';
  for (const part of compiled.parts) {
    if (part.kind === 'stop') return out;
    if (part.kind === 'text') { out += part.text; continue; }
    out += pad(fieldText(part, subject, env), part.spec, NUMERIC_DIRECTIVES.has(part.directive));
  }
  return out;
}
