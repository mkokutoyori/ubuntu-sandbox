import { bytesToBinaryString, bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { simulationNowMs } from '@/network/core/SystemClock';
import { crc32, gzipCompress, gzipDecompressTolerant, isGzip, ZlibError } from '@/network/rsyslog/Zlib';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { formatLocalTime } from '../system/SystemInfo';
import { basename, gzipBytesOf, type ArchiveCtx, type CmdResult } from './ArchiveCommands';
import { COREUTILS_DOCS } from './CoreutilsDocs';

type Program = 'gzip' | 'gunzip' | 'zcat';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'stdout', letter: 'c', takesArgument: false },
  { name: 'to-stdout', letter: 'c', takesArgument: false },
  { name: 'decompress', letter: 'd', takesArgument: false },
  { name: 'uncompress', letter: 'd', takesArgument: false },
  { name: 'force', letter: 'f', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'keep', letter: 'k', takesArgument: false },
  { name: 'list', letter: 'l', takesArgument: false },
  { name: 'license', letter: 'L', takesArgument: false },
  { name: 'no-name', letter: 'n', takesArgument: false },
  { name: 'name', letter: 'N', takesArgument: false },
  { name: 'quiet', letter: 'q', takesArgument: false },
  { name: 'recursive', letter: 'r', takesArgument: false },
  { name: 'suffix', letter: 'S', takesArgument: true },
  { name: 'synchronous', letter: 'Y', takesArgument: false },
  { name: 'test', letter: 't', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'fast', letter: '1', takesArgument: false },
  { name: 'best', letter: '9', takesArgument: false },
  { name: 'rsyncable', letter: 'R', takesArgument: false },
  { name: 'silent', letter: 'q', takesArgument: false },
];

const TRY = "Try `gzip --help' for more information.";
const KNOWN_SUFFIXES = ['.gz', '.z', '.Z', '-gz', '-z', '_z'];

interface GzipOptions {
  decompress: boolean;
  toStdout: boolean;
  force: boolean;
  keep: boolean;
  list: boolean;
  test: boolean;
  verbose: boolean;
  quiet: boolean;
  recursive: boolean;
  restoreName: boolean;
  storeName: boolean;
  suffix: string;
  level: number;
  operands: string[];
}

class Usage extends Error {
  constructor(readonly result: CmdResult) { super(result.output); }
}

function parse(program: Program, args: readonly string[]): GzipOptions {
  const o: GzipOptions = {
    decompress: program !== 'gzip', toStdout: program === 'zcat', force: false, keep: false, list: false, test: false, verbose: false, quiet: false,
    recursive: false, restoreName: false, storeName: true, suffix: '.gz', level: 6, operands: [],
  };
  for (const item of shortOptions(args, '123456789acdfhHklLnNqrS:tvV', LONG_OPTIONS)) {
    if (item.kind === 'operand') { o.operands.push(item.value); continue; }
    if (item.kind !== 'option') {
      const text = getoptDiagnostic('gzip', item).replace(/ \(.*$/, '');
      throw new Usage({ output: `${text}\n${TRY}`, exitCode: 1 });
    }
    switch (item.letter) {
      case 'c': o.toStdout = true; break;
      case 'd': o.decompress = true; break;
      case 'f': o.force = true; break;
      case 'k': o.keep = true; break;
      case 'l': o.list = true; o.decompress = true; break;
      case 't': o.test = true; o.decompress = true; break;
      case 'v': o.verbose = true; break;
      case 'q': o.quiet = true; break;
      case 'r': o.recursive = true; break;
      case 'n': o.storeName = false; o.restoreName = false; break;
      case 'N': o.storeName = true; o.restoreName = true; break;
      case 'S': o.suffix = item.argument ?? '.gz'; break;
      case 'h': case 'H': throw new Usage({ output: COREUTILS_DOCS[item.long === 'help' && program !== 'gzip' ? program : 'gzip'].help, exitCode: 0 });
      case 'V': throw new Usage({ output: COREUTILS_DOCS[item.long === 'version' && program !== 'gzip' ? program : 'gzip'].version, exitCode: 0 });
      case 'L': throw new Usage({ output: COREUTILS_DOCS.gzip.version, exitCode: 0 });
      default:
        if (/^[1-9]$/.test(item.letter)) o.level = Number(item.letter);
    }
  }
  return o;
}

const asBytes = (raw: string): Uint8Array => gzipBytesOf(raw) ?? fileTextToBytes(raw);

const looksGzip = (raw: string): boolean => gzipBytesOf(raw) !== null;

interface Member { name: string; mtime: number; payload: Uint8Array; compressedBytes: number; crc: number; headerBytes: number; trailingGarbage: boolean }

function headerOf(bytes: Uint8Array): { name: string; mtime: number; size: number } {
  const flags = bytes[3];
  let at = 10;
  if (flags & 0x04) at += 2 + (bytes[at] | (bytes[at + 1] << 8));
  let name = '';
  if (flags & 0x08) {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    name = new TextDecoder().decode(bytes.subarray(at, end));
    at = end + 1;
  }
  if (flags & 0x10) { while (at < bytes.length && bytes[at] !== 0) at++; at++; }
  if (flags & 0x02) at += 2;
  const mtime = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  return { name, mtime: mtime * 1000, size: at };
}

type Decoded = { kind: 'ok'; member: Member } | { kind: 'error'; message: string; exitCode: number; partial?: Uint8Array };

function decode(raw: string, label: string): Decoded {
  if (raw === '') return { kind: 'error', message: `\ngzip: ${label}: unexpected end of file`, exitCode: 1 };
  if (!looksGzip(raw)) return { kind: 'error', message: `\ngzip: ${label}: not in gzip format`, exitCode: 1 };
  const bytes = asBytes(raw);
  const header = headerOf(bytes);
  try {
    const result = gzipDecompressTolerant(bytes);
    if (!result.complete) return { kind: 'error', message: `\ngzip: ${label}: unexpected end of file`, exitCode: 1, partial: result.output };
    return { kind: 'ok', member: { name: header.name, mtime: header.mtime, payload: result.output, compressedBytes: bytes.length, crc: crc32(result.output), headerBytes: header.size, trailingGarbage: false } };
  } catch (error) {
    if (error instanceof ZlibError) {
      if (/not in gzip format/.test(error.message)) return { kind: 'error', message: `\ngzip: ${label}: decompression OK, trailing garbage ignored`, exitCode: 2 };
      return { kind: 'error', message: `\ngzip: ${label}: invalid compressed data--crc error`, exitCode: 1 };
    }
    throw error;
  }
}

function compressBytes(payload: Uint8Array, name: string, mtimeMs: number, o: GzipOptions): string {
  return bytesToBinaryString(gzipCompress(payload, o.level, o.storeName ? { name, mtimeMs } : { name: '', mtimeMs }));
}

function percent(compressed: number, original: number): string {
  if (original === 0) return ' 0.0%';
  return `${((original - compressed) * 100 / original).toFixed(1).padStart(5)}%`;
}

function listRow(label: string, compressed: number, original: number, headerBytes: number, o: GzipOptions, crc?: number, mtime?: number): string {
  const data = Math.max(0, compressed - headerBytes - 8);
  const verbose = o.verbose ? `defla ${(crc ?? 0).toString(16).padStart(8, '0')} ${formatLocalTime('%b %e %H:%M', mtime ?? 0, undefined)} ` : '';
  return `${verbose}${String(compressed).padStart(19)} ${String(original).padStart(19)} ${percent(data, original)} ${label}`;
}

function suffixOf(name: string, o: GzipOptions): string | null {
  const candidates = [o.suffix, ...KNOWN_SUFFIXES];
  for (const suffix of candidates) if (name.endsWith(suffix) && name.length > suffix.length) return suffix;
  if (name.endsWith('.tgz') || name.endsWith('.taz')) return name.slice(-4);
  return null;
}

export function cmdGzip(ctx: ArchiveCtx, args: string[], program: Program): CmdResult {
  let o: GzipOptions;
  try { o = parse(program, args); } catch (error) {
    if (error instanceof Usage) return error.result;
    throw error;
  }
  const lines: string[] = [];
  const stdout: string[] = [];
  let exitCode = 0;
  const warn = (text: string, code: number): void => {
    if (!o.quiet || code === 1) { if (!o.quiet) lines.push(text); }
    exitCode = Math.max(exitCode, code === 1 && exitCode === 2 ? 2 : code);
  };
  const failure = (text: string, code = 1): void => {
    if (!o.quiet) lines.push(text);
    exitCode = Math.max(exitCode, code);
  };
  const listing: string[] = [];
  let totalCompressed = 0;
  let totalOriginal = 0;
  let listed = 0;

  const operateOnStdin = (): void => {
    if (ctx.stdin === undefined && !o.force) {
      lines.push(program === 'zcat' ? 'zcat: compressed data not read from a terminal.' : `gzip: compressed data not ${o.decompress ? 'read from' : 'written to'} a terminal. Use -f to force.`);
      exitCode = 1;
      return;
    }
    const raw = ctx.stdin ?? '';
    if (!o.decompress) {
      stdout.push(compressBytes(fileTextToBytes(raw), '', simulationNowMs(), { ...o, storeName: false }));
      return;
    }
    if (o.force && !looksGzip(raw) && raw !== '') { stdout.push(raw); return; }
    const decoded = decode(raw, 'stdin');
    if (decoded.kind === 'error') { failure(decoded.message, decoded.exitCode); return; }
    if (o.list) { listing.push(listRow('stdin', decoded.member.compressedBytes, decoded.member.payload.length, decoded.member.headerBytes, o, decoded.member.crc, decoded.member.mtime)); return; }
    if (!o.test) stdout.push(bytesToFileText(decoded.member.payload));
  };

  const operateOnFile = (operand: string, directoryAbs: string | null): void => {
    const shown = operand;
    let abs = ctx.fs.normalizePath(operand, directoryAbs ?? ctx.cwd);
    let node = ctx.fs.resolveInode(abs, true);
    if (node === null && o.decompress && suffixOf(operand, o) === null) {
      const withSuffix = ctx.fs.normalizePath(`${operand}${o.suffix}`, directoryAbs ?? ctx.cwd);
      const alternative = ctx.fs.resolveInode(withSuffix, true);
      if (alternative !== null) { abs = withSuffix; node = alternative; }
      else { failure(`gzip: ${operand}${o.suffix}: No such file or directory`); return; }
    }
    if (node === null) { failure(`gzip: ${shown}: No such file or directory`); return; }
    if (node.type === 'directory') {
      if (!o.recursive) { failure(`gzip: ${shown} is a directory -- ignored`, 2); return; }
      for (const child of ctx.fs.listDirectory(abs) ?? []) {
        if (child.name === '.' || child.name === '..') continue;
        operateOnFile(`${operand.replace(/\/+$/, '')}/${child.name}`, directoryAbs);
      }
      return;
    }
    const raw = ctx.fs.readFile(abs) ?? node.content;
    if (!o.decompress) {
      const known = suffixOf(operand, o);
      if (known !== null && (known === o.suffix || KNOWN_SUFFIXES.includes(known))) {
        failure(`gzip: ${shown} already has ${known} suffix -- unchanged`, 0);
        return;
      }
      const payload = fileTextToBytes(raw);
      const packed = compressBytes(payload, basename(abs), node.mtime, o);
      if (o.toStdout) { stdout.push(packed); return; }
      const target = `${abs}${o.suffix}`;
      if (ctx.fs.resolveInode(target, false) !== null && !o.force) {
        failure(`gzip: ${shown}${o.suffix} already exists;\tnot overwritten`, 2);
        return;
      }
      ctx.fs.writeFile(target, packed, ctx.uid, ctx.gid, ctx.umask);
      ctx.fs.chmod(target, node.permissions & 0o7777);
      ctx.fs.setTimes(target, { mtime: node.mtime });
      if (ctx.uid === 0) ctx.fs.chown(target, node.uid, node.gid);
      if (!o.keep) ctx.fs.deleteFile(abs);
      if (o.verbose) lines.push(`${shown}:\t${percent(Math.max(0, ctx.fs.readFile(target)?.length ?? 0) - 18 - basename(abs).length, payload.length)} -- ${o.keep ? 'created' : 'replaced with'} ${shown}${o.suffix}`);
      return;
    }
    if (o.force && !looksGzip(raw) && o.toStdout) { stdout.push(raw); return; }
    if (!o.toStdout && !o.test && !o.list && suffixOf(operand, o) === null) { failure(`gzip: ${shown}: unknown suffix -- ignored`, 2); return; }
    const decoded = decode(raw, shown);
    if (decoded.kind === 'error') {
      if (o.toStdout && decoded.partial !== undefined) stdout.push(bytesToFileText(decoded.partial));
      failure(decoded.message, decoded.exitCode);
      return;
    }
    const { member } = decoded;
    if (o.list) {
      listed++;
      totalCompressed += member.compressedBytes;
      totalOriginal += member.payload.length;
      listing.push(listRow(member.name !== '' ? member.name.replace(/^.*\//, '') : shown.replace(/\.gz$/, ''), member.compressedBytes, member.payload.length, member.headerBytes, o, member.crc, member.mtime));
      return;
    }
    if (o.test) { if (o.verbose) lines.push(`${shown}:\t OK`); return; }
    if (o.toStdout) { stdout.push(bytesToFileText(member.payload)); return; }
    const suffix = suffixOf(operand, o);
    if (suffix === null) { failure(`gzip: ${shown}: unknown suffix -- ignored`, 2); return; }
    let outName = operand.slice(0, operand.length - suffix.length) + (suffix === '.tgz' || suffix === '.taz' ? '.tar' : '');
    if (o.restoreName && member.name !== '') outName = `${operand.includes('/') ? operand.replace(/[^/]*$/, '') : ''}${member.name}`;
    const target = ctx.fs.normalizePath(outName, directoryAbs ?? ctx.cwd);
    if (ctx.fs.resolveInode(target, false) !== null && !o.force) {
      failure(`gzip: ${outName} already exists;\tnot overwritten`, 2);
      return;
    }
    ctx.fs.writeFile(target, bytesToFileText(member.payload), ctx.uid, ctx.gid, ctx.umask);
    ctx.fs.chmod(target, node.permissions & 0o7777);
    ctx.fs.setTimes(target, { mtime: member.mtime || node.mtime });
    if (ctx.uid === 0) ctx.fs.chown(target, node.uid, node.gid);
    if (!o.keep) ctx.fs.deleteFile(abs);
    if (o.verbose) lines.push(`${shown}:\t${percent(Math.max(0, member.compressedBytes - member.headerBytes - 8), member.payload.length)} -- ${o.keep ? 'created' : 'replaced with'} ${outName}`);
  };

  if (o.operands.length === 0) operateOnStdin();
  else for (const operand of o.operands) operateOnFile(operand, null);

  if (o.list) {
    const header = `${o.verbose ? 'method  crc     date  time  ' : ''}${'compressed'.padStart(19)} ${'uncompressed'.padStart(19)}  ratio uncompressed_name`;
    const rows = [...(o.quiet ? [] : [header]), ...listing];
    if (listed > 1) rows.push(listRow('(totals)', totalCompressed, totalOriginal, 18, o).replace(/^(.{0}).*?(\s+\d)/, '$1$2'));
    return { output: `${[...lines, ...rows].join('\n')}${rows.length + lines.length > 0 ? '\n' : ''}`, exitCode };
  }
  const messages = lines.map((line) => `${line}\n`).join('');
  return { output: messages + stdout.join(''), exitCode };
}
