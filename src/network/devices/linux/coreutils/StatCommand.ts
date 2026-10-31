import { shortOptions, getoptDiagnostic } from '../commands/Getopt';
import { gnuOptionSet } from '../GnuOptionGuard';
import { formatStatTime } from '../time/FileTimes';
import type { INode } from '../VirtualFileSystem';
import type { DfContext } from '../LinuxSystemCommands';
import { filesystemRowFor } from '../LinuxSystemCommands';
import { Streams, docsResult, quoteLocale, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const PRINTF_FLAGS = "'-+ #0I";
const BLOCK_BYTES = 4096;
const NBLOCKSIZE = 512;
const DEFAULT_MOUNT_MARK = '?';

const FORMAT_TERSE = '%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o\n';
const FORMAT_TERSE_FS = '%n %i %l %t %s %S %b %f %a %c %d\n';
const FORMAT_FS = '  File: "%n"\n    ID: %-8i Namelen: %-7l Type: %T\nBlock size: %-10s Fundamental block size: %S\n'
  + 'Blocks: Total: %-10b Free: %-10f Available: %a\nInodes: Total: %-10c Free: %d\n';
const FORMAT_FILE_HEAD = '  File: %N\n  Size: %-10s\tBlocks: %-10b IO Block: %-6o %F\n';
const FORMAT_DEVICE_TAIL = 'Device: %Dh/%dd\tInode: %-10i  Links: %-5h Device type: %t,%T\n';
const FORMAT_REGULAR_TAIL = 'Device: %Dh/%dd\tInode: %-10i  Links: %h\n';
const FORMAT_OWNERS = 'Access: (%04a/%10.10A)  Uid: (%5u/%8U)   Gid: (%5g/%8G)\n';
const FORMAT_TIMES = 'Access: %x\nModify: %y\nChange: %z\n Birth: %w\n';

const TYPE_BITS: Readonly<Record<INode['type'], number>> = {
  file: 0o100000, directory: 0o040000, symlink: 0o120000, fifo: 0o010000, chardev: 0o020000, blockdev: 0o060000, socket: 0o140000,
};

const FILESYSTEM_TYPES: Readonly<Record<string, readonly [number, string]>> = {
  ext4: [0xef53, 'ext2/ext3'], ext3: [0xef53, 'ext2/ext3'], ext2: [0xef53, 'ext2/ext3'],
  tmpfs: [0x01021994, 'tmpfs'], devtmpfs: [0x01021994, 'tmpfs'], proc: [0x9fa0, 'proc'], sysfs: [0x62656572, 'sysfs'],
  devpts: [0x1cd1, 'devpts'], cgroup2: [0x63677270, 'cgroup2fs'], cgroup: [0x27e0eb, 'cgroupfs'],
  securityfs: [0x73636673, 'securityfs'], xfs: [0x58465342, 'xfs'], vfat: [0x4d44, 'msdos'], nfs: [0x6969, 'nfs'],
  nfs4: [0x6969, 'nfs'], overlay: [0x794c7630, 'overlayfs'],
};

export interface StatContext extends DfContext {
  readonly stdin?: string;
}

interface Spec {
  readonly flags: string;
  readonly width: string;
  readonly precision: string | null;
}

function parseSpec(prefix: string): Spec {
  let at = 1;
  while (at < prefix.length && PRINTF_FLAGS.includes(prefix[at])) at++;
  const flags = prefix.slice(1, at);
  const widthStart = at;
  while (at < prefix.length && /[0-9]/.test(prefix[at])) at++;
  const width = prefix.slice(widthStart, at);
  const precision = prefix[at] === '.' ? prefix.slice(at + 1) : null;
  return { flags, width, precision };
}

function pad(text: string, spec: Spec, allowed: string, zeroPad: boolean): string {
  const width = spec.width === '' ? 0 : parseInt(spec.width, 10);
  const left = spec.flags.includes('-') && allowed.includes('-');
  if (text.length >= width) return text;
  if (left) return text.padEnd(width);
  if (zeroPad) {
    const sign = /^[+-]/.test(text) ? text[0] : '';
    const prefix = /^(0x)/.test(text.slice(sign.length)) ? '0x' : '';
    const digits = text.slice(sign.length + prefix.length);
    return sign + prefix + digits.padStart(width - sign.length - prefix.length, '0');
  }
  return text.padStart(width);
}

function outString(spec: Spec, value: string): string {
  const cut = spec.precision === null ? value : value.slice(0, spec.precision === '' ? 0 : parseInt(spec.precision, 10));
  return pad(cut, spec, '-', false);
}

function minimumDigits(digits: string, spec: Spec): string {
  if (spec.precision === null) return digits;
  const precision = spec.precision === '' ? 0 : parseInt(spec.precision, 10);
  return precision === 0 && digits === '0' ? '' : digits.padStart(precision, '0');
}

function outInteger(spec: Spec, value: number): string {
  const sign = value < 0 ? '-' : spec.flags.includes('+') ? '+' : spec.flags.includes(' ') ? ' ' : '';
  const body = sign + minimumDigits(String(Math.abs(value)), spec);
  return pad(body, spec, "'-+ 0", spec.flags.includes('0') && !spec.flags.includes('-') && spec.precision === null);
}

function outUnsigned(spec: Spec, value: number): string {
  return pad(minimumDigits(String(value), spec), spec, "'-0", spec.flags.includes('0') && !spec.flags.includes('-') && spec.precision === null);
}

function outRadix(spec: Spec, value: number, radix: 8 | 16): string {
  let digits = minimumDigits(value.toString(radix), spec);
  if (spec.flags.includes('#') && value !== 0) digits = (radix === 8 ? '0' : '0x') + digits;
  return pad(digits, spec, '-#0', spec.flags.includes('0') && !spec.flags.includes('-') && spec.precision === null);
}

function outEpoch(spec: Spec, seconds: number, nanoseconds: number): string {
  if (spec.precision === null) return outInteger(spec, seconds);
  const precision = spec.precision === '' ? 9 : Math.min(parseInt(spec.precision, 10), 9);
  const divisor = 10 ** (9 - precision);
  const fraction = Math.floor(nanoseconds / divisor);
  const integer = outInteger({ ...spec, precision: null }, seconds);
  return precision === 0 ? integer : `${integer}.${String(fraction).padStart(precision, '0')}`;
}

function escapeChar(char: string, warnings: string[]): string {
  switch (char) {
    case 'a': return '\x07';
    case 'b': return '\b';
    case 'e': return '\x1b';
    case 'f': return '\f';
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'v': return '\v';
    case '"': case '\\': return char;
    default:
      warnings.push(`stat: warning: unrecognized escape '\\${char}'`);
      return char;
  }
}

interface Subject {
  readonly name: string;
  readonly inode: INode;
  readonly path: string;
  readonly device: number;
}

function modeBits(inode: INode): number {
  return TYPE_BITS[inode.type] | (inode.permissions & 0o7777);
}

function blocksOf(inode: INode): number {
  if (inode.type === 'directory') return BLOCK_BYTES / NBLOCKSIZE;
  if (inode.type !== 'file') return 0;
  return Math.ceil(inode.size / BLOCK_BYTES) * (BLOCK_BYTES / NBLOCKSIZE);
}

function fileType(inode: INode): string {
  switch (inode.type) {
    case 'file': return inode.size === 0 ? 'regular empty file' : 'regular file';
    case 'directory': return 'directory';
    case 'symlink': return 'symbolic link';
    case 'fifo': return 'fifo';
    case 'socket': return 'socket';
    case 'blockdev': return 'block special file';
    default: return 'character special file';
  }
}

function deviceNumbers(inode: INode): readonly [number, number] {
  return inode.rdev === undefined ? [0, 0] : [inode.rdev.major, inode.rdev.minor];
}

function quoteName(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function splitTime(ms: number): { seconds: number; nanoseconds: number } {
  const seconds = Math.floor(ms / 1000);
  return { seconds, nanoseconds: Math.round((ms - seconds * 1000) * 1e6) };
}

export function runStat(ctx: StatContext, args: string[]): CoreutilsRun {
  const streams = new Streams();
  const set = gnuOptionSet('stat');
  const files: string[] = [];
  let format: string | null = null;
  let interpretEscapes = false;
  let trailing = '';
  let dereference = false;
  let fileSystem = false;
  let terse = false;
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand') { files.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('stat', getoptDiagnostic('stat', item));
    if (item.long === 'help' || item.long === 'version') return docsResult('stat', item.long);
    if (item.long === 'printf') { format = item.argument ?? ''; interpretEscapes = true; trailing = ''; }
    else if (item.long === 'cached') {
      if (!['default', 'never', 'always'].includes(item.argument ?? '')) {
        streams.diagnostic(`stat: invalid argument ${quoteLocale(item.argument ?? '')} for ${quoteLocale('--cached')}`);
        streams.diagnostic('Valid arguments are:');
        for (const choice of ['default', 'never', 'always']) streams.diagnostic(`  - ${quoteLocale(choice)}`);
        streams.diagnostic("Try 'stat --help' for more information.");
        streams.exitCode = 1;
        return streams.result();
      }
    } else if (item.letter === 'c') { format = item.argument ?? ''; interpretEscapes = false; trailing = '\n'; }
    else if (item.letter === 'L') dereference = true;
    else if (item.letter === 'f') fileSystem = true;
    else if (item.letter === 't') terse = true;
  }
  if (files.length === 0) {
    streams.diagnostic('stat: missing operand');
    streams.diagnostic("Try 'stat --help' for more information.");
    streams.exitCode = 1;
    return streams.result();
  }

  const quoteNames = format !== null && format.includes('%N');
  const quoteN = (text: string): string => (quoteNames ? quoteName(text) : text);

  const defaultFormat = (device: boolean): string => {
    if (fileSystem) return terse ? FORMAT_TERSE_FS : FORMAT_FS;
    if (terse) return FORMAT_TERSE;
    return FORMAT_FILE_HEAD + (device ? FORMAT_DEVICE_TAIL : FORMAT_REGULAR_TAIL) + FORMAT_OWNERS + FORMAT_TIMES;
  };

  const mountPointOf = (path: string): string => {
    let best = '';
    for (const mount of ctx.mounts) {
      const target = mount.target;
      const covers = target === '/' || path === target || path.startsWith(`${target}/`);
      if (covers && target.length > best.length) best = target;
    }
    return best === '' ? DEFAULT_MOUNT_MARK : best;
  };

  const render = (template: string, describe: (spec: Spec, directive: string) => string | null, failureOf: (directive: string) => void): string => {
    let out = '';
    for (let at = 0; at < template.length; at++) {
      const char = template[at];
      if (char === '%') {
        let end = at + 1;
        while (end < template.length && PRINTF_FLAGS.includes(template[end])) end++;
        while (end < template.length && /[0-9]/.test(template[end])) end++;
        if (template[end] === '.') { end++; while (end < template.length && /[0-9]/.test(template[end])) end++; }
        const prefix = template.slice(at, end);
        const directive = template[end] ?? '';
        if (directive === '' || directive === '%') {
          if (prefix.length > 1) {
            streams.diagnostic(`stat: ${quoteLocale(prefix + directive)}: invalid directive`);
            streams.exitCode = 1;
            throw new StatAbort();
          }
          out += '%';
          at = directive === '' ? template.length : end;
          continue;
        }
        const rendered = describe(parseSpec(prefix), directive);
        if (rendered === null) failureOf(directive);
        out += rendered ?? '?';
        at = end;
      } else if (char === '\\' && interpretEscapes) {
        at++;
        const next = template[at];
        if (next !== undefined && /[0-7]/.test(next)) {
          let value = parseInt(next, 8);
          let count = 1;
          while (count < 3 && /[0-7]/.test(template[at + 1] ?? '')) { value = value * 8 + parseInt(template[++at], 8); count++; }
          out += String.fromCharCode(value);
        } else if (next === 'x' && /[0-9a-fA-F]/.test(template[at + 1] ?? '')) {
          let value = parseInt(template[++at], 16);
          if (/[0-9a-fA-F]/.test(template[at + 1] ?? '')) value = value * 16 + parseInt(template[++at], 16);
          out += String.fromCharCode(value);
        } else if (next === undefined) {
          streams.diagnostic('stat: warning: backslash at end of format');
          out += '\\';
        } else {
          const warnings: string[] = [];
          out += escapeChar(next, warnings);
          for (const warning of warnings) streams.diagnostic(warning);
        }
      } else {
        out += char;
      }
    }
    return out + trailing;
  };

  let ok = true;
  const vfs = ctx.vfs;
  try {
    for (const name of files) {
      const absolute = vfs.normalizePath(name, ctx.cwd);

      if (fileSystem) {
        if (name === '-') {
          streams.diagnostic(`stat: using ${quoteLocale('-')} to denote standard input does not work in file system mode`);
          ok = false;
          continue;
        }
        if (vfs.resolveInode(absolute, true) === null) {
          streams.diagnostic(`stat: cannot read file system information for ${quoteShell(name)}: No such file or directory`);
          ok = false;
          continue;
        }
        const row = filesystemRowFor(ctx, absolute);
        const [typeCode, typeName] = FILESYSTEM_TYPES[row.type] ?? [0, `UNKNOWN (0x${(0).toString(16)})`];
        const blocks = Math.floor(row.sizeKb / (BLOCK_BYTES / 1024));
        const free = Math.floor((row.sizeKb - row.usedKb) / (BLOCK_BYTES / 1024));
        const available = Math.floor(row.availKb / (BLOCK_BYTES / 1024));
        const template = format ?? defaultFormat(false);
        streams.stdout(render(template, (spec, directive) => {
          switch (directive) {
            case 'n': return outString(spec, name);
            case 'i': return outRadix(spec, (ctx.deviceOf?.(absolute) ?? 1) * 0x10001, 16);
            case 'l': return outInteger(spec, 255);
            case 't': return outRadix(spec, typeCode, 16);
            case 'T': return outString(spec, typeName);
            case 'b': return outInteger(spec, blocks);
            case 'f': return outInteger(spec, free);
            case 'a': return outInteger(spec, available);
            case 's': return outUnsigned(spec, BLOCK_BYTES);
            case 'S': return outUnsigned(spec, BLOCK_BYTES);
            case 'c': return outUnsigned(spec, row.inodesTotal);
            case 'd': return outInteger(spec, row.inodesTotal - row.inodesUsed);
            default: return '?';
          }
        }, () => undefined));
        continue;
      }

      let subject: Subject | null;
      if (name === '-') {
        const now = ctx.nowMs?.() ?? Date.now();
        const standardInput: INode = {
          id: 0, type: 'fifo', permissions: 0o600, uid: ctx.uid, gid: ctx.gid, content: '', target: '', children: new Map(),
          linkCount: 1, size: 0, mtime: now, atime: now, ctime: now,
        };
        subject = { name, inode: standardInput, path: '/dev/stdin', device: 0 };
      } else {
        const inode = vfs.resolveInode(absolute, dereference);
        subject = inode === null ? null : { name, inode, path: absolute, device: ctx.deviceOf?.(absolute) ?? 0 };
      }
      if (subject === null) {
        streams.diagnostic(`stat: cannot statx ${quoteShell(name)}: No such file or directory`);
        ok = false;
        continue;
      }
      const { inode } = subject;
      const template = format ?? defaultFormat(inode.type === 'chardev' || inode.type === 'blockdev');
      let failed = false;
      const text = render(template, (spec, directive) => {
        const [major, minor] = deviceNumbers(inode);
        const owner = (): string => ctx.userMgr.uidToName(inode.uid) || 'UNKNOWN';
        const group = (): string => ctx.userMgr.gidToName(inode.gid) || 'UNKNOWN';
        switch (directive) {
          case 'n': return outString(spec, subject.name);
          case 'N': {
            const quoted = outString(spec, quoteN(subject.name));
            return inode.type === 'symlink' ? `${quoted} -> ${outString(spec, quoteN(inode.target))}` : quoted;
          }
          case 'd': return outUnsigned(spec, subject.device);
          case 'D': return outRadix(spec, subject.device, 16);
          case 'i': return outUnsigned(spec, inode.id);
          case 'a': return outRadix(spec, inode.permissions & 0o7777, 8);
          case 'A': return outString(spec, vfs.formatPermissions(inode).slice(0, 10));
          case 'f': return outRadix(spec, modeBits(inode), 16);
          case 'F': return outString(spec, fileType(inode));
          case 'h': return outUnsigned(spec, inode.linkCount);
          case 'u': return outUnsigned(spec, inode.uid);
          case 'U': return outString(spec, owner());
          case 'g': return outUnsigned(spec, inode.gid);
          case 'G': return outString(spec, group());
          case 'm': return outString(spec, mountPointOf(subject.path));
          case 's': return outInteger(spec, inode.size);
          case 't': return outRadix(spec, major, 16);
          case 'T': return outRadix(spec, minor, 16);
          case 'B': return outUnsigned(spec, NBLOCKSIZE);
          case 'b': return outUnsigned(spec, blocksOf(inode));
          case 'o': return outUnsigned(spec, BLOCK_BYTES);
          case 'w': return outString(spec, '-');
          case 'W': return outEpoch(spec, 0, 0);
          case 'x': return outString(spec, formatStatTime(inode.atime, ctx.zone));
          case 'X': { const t = splitTime(inode.atime); return outEpoch(spec, t.seconds, t.nanoseconds); }
          case 'y': return outString(spec, formatStatTime(inode.mtime, ctx.zone));
          case 'Y': { const t = splitTime(inode.mtime); return outEpoch(spec, t.seconds, t.nanoseconds); }
          case 'z': return outString(spec, formatStatTime(inode.ctime, ctx.zone));
          case 'Z': { const t = splitTime(inode.ctime); return outEpoch(spec, t.seconds, t.nanoseconds); }
          case 'C': {
            streams.diagnostic(`stat: failed to get security context of ${quoteShell(subject.name)}: No data available`);
            failed = true;
            return outString(spec, '?');
          }
          default: return '?';
        }
      }, () => undefined);
      streams.stdout(text);
      if (failed) ok = false;
    }
  } catch (error) {
    if (!(error instanceof StatAbort)) throw error;
    return streams.result();
  }
  streams.exitCode = ok ? 0 : 1;
  return streams.result();
}

class StatAbort extends Error {}
