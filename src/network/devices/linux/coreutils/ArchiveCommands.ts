/**
 * ArchiveCommands — real `tar` / `gzip` / `gunzip` / `zcat` / `zip` /
 * `unzip` semantics over the VFS (GAP §8.4: the previous handlers were
 * pure no-ops — `tar -x` restored nothing and `gunzip` REPLACED the
 * data with a placeholder).
 *
 * Archives are stored as structured envelopes (a magic first line +
 * JSON body) so extraction restores the exact member contents, modes
 * and — when extracting as root — owners. The envelope is the
 * simulator's "binary" format: `file` recognises it, `cat` shows
 * gibberish-ish JSON, and round-trips are lossless, which is what lab
 * scripts (backup/restore, deploy) actually depend on.
 *
 * Realism contract per command: GNU/Info-ZIP error texts, exit codes,
 * option grammar (including tar's old bundled style `tar czf a.tgz x`),
 * leading-`/` stripping, split listings, `-k/-d/-r/-l/-d dir/-C dir`.
 * SRP: pure functions over a narrow filesystem seam — no executor
 * dependency, testable in isolation.
 */
import { simulationNowMs } from '@/network/core/SystemClock';
import { binaryStringToBytes, bytesToBinaryString, bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { gzipCompress, gzipDecompressTolerant, isGzip } from '@/network/rsyslog/Zlib';

import type { DirEntry, INode } from '../VirtualFileSystem';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

/** Narrow filesystem seam (DIP — the executor injects its VFS). */
export interface ArchiveFs {
  normalizePath(path: string, cwd?: string): string;
  readFile(path: string): string | null;
  writeFile(path: string, content: string, uid: number, gid: number,
    umask: number, append?: boolean): boolean;
  deleteFile(path: string): boolean;
  exists(path: string): boolean;
  listDirectory(path: string): DirEntry[] | null;
  resolveInode(path: string, followSymlinks?: boolean): INode | null;
  mkdirp(path: string, permissions: number, uid: number, gid: number): boolean;
  chmod(path: string, mode: number): boolean;
  chown(path: string, uid: number, gid?: number): boolean;
  createSymlink(path: string, target: string, uid: number, gid: number, permissions?: number): boolean;
  linkTarget(inode: INode): string;
  setTimes(path: string, times: { atime?: number; mtime?: number }): boolean;
  rmdir(path: string): boolean;
}

export interface ArchiveCtx {
  fs: ArchiveFs;
  cwd: string;
  uid: number;
  gid: number;
  umask: number;
  stdin?: string;
  userName?: (uid: number) => string;
  groupName?: (gid: number) => string;
}

export interface CmdResult { output: string; exitCode: number; }

// ── Envelope format ─────────────────────────────────────────────────

export const TAR_MAGIC = '!<simtar>';
const ZIP_MAGIC = '!<simzip>';

export interface ArchiveMember {
  /** Stored path (always relative — leading `/` stripped like GNU tar). */
  path: string;
  type: 'file' | 'dir' | 'symlink';
  link?: string;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  content?: string;
}

interface GzipBody {
  /** Original file name (for `gzip -l` / `file` / `gunzip -N`). */
  name: string;
  mtime: number;
  payload: string;
  truncated?: boolean;
}

export function packMembers(magic: string, members: ArchiveMember[]): string {
  return `${magic}\n${JSON.stringify({ v: 1, members })}`;
}

export function unpackMembers(magic: string, raw: string): ArchiveMember[] | null {
  if (!raw.startsWith(`${magic}\n`)) return null;
  try {
    const body = JSON.parse(raw.slice(magic.length + 1)) as
      { v?: number; members?: ArchiveMember[] };
    return Array.isArray(body.members) ? body.members : null;
  } catch { return null; }
}

export function gzipText(payload: string, name: string, mtimeMs: number): string {
  return packGzip({ name, mtime: mtimeMs, payload });
}

export function gunzipText(raw: string): string | null {
  return unpackGzip(raw)?.payload ?? null;
}

const GZIP_DEFAULT_LEVEL = 6;

export function packGzip(body: GzipBody): string {
  return bytesToBinaryString(gzipCompress(fileTextToBytes(body.payload), GZIP_DEFAULT_LEVEL, { name: body.name, mtimeMs: body.mtime }));
}

function gzipHeaderName(bytes: Uint8Array): string {
  const flags = bytes[3];
  let at = 10;
  if (flags & 0x04) at += 2 + (bytes[at] | (bytes[at + 1] << 8));
  if (!(flags & 0x08)) return '';
  let end = at;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(at, end));
}

const GZIP_MAGIC_AS_BINARY_STRING = bytesToBinaryString(Uint8Array.of(0x1f, 0x8b));
const GZIP_MAGIC_AS_FILE_TEXT = bytesToFileText(Uint8Array.of(0x1f, 0x8b));

export function gzipBytesOf(raw: string): Uint8Array | null {
  if (raw.startsWith(GZIP_MAGIC_AS_BINARY_STRING)) return binaryStringToBytes(raw);
  if (raw.startsWith(GZIP_MAGIC_AS_FILE_TEXT)) return fileTextToBytes(raw);
  return null;
}

function unpackRealGzip(raw: string): GzipBody | null {
  const bytes = gzipBytesOf(raw);
  if (bytes === null || !isGzip(bytes)) return null;
  try {
    const mtime = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
    const decoded = gzipDecompressTolerant(bytes);
    return { name: gzipHeaderName(bytes), mtime: mtime * 1000, payload: bytesToFileText(decoded.output), truncated: !decoded.complete };
  } catch { return null; }
}

export function unpackGzip(raw: string): GzipBody | null {
  return unpackRealGzip(raw);
}

/** What `file` should say about a content blob (archive awareness). */
export function describeArchiveContent(raw: string): string | null {
  const gz = unpackGzip(raw);
  if (gz) {
    return `gzip compressed data, was "${gz.name}", last modified: ` +
      `${new Date(gz.mtime).toUTCString()}, from Unix`;
  }
  if (raw.startsWith(`${TAR_MAGIC}\n`)) return 'POSIX tar archive (GNU)';
  if (raw.startsWith(`${ZIP_MAGIC}\n`)) {
    return 'Zip archive data, at least v2.0 to extract';
  }
  return null;
}

// ── Shared walking helpers ──────────────────────────────────────────

export const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

/**
 * Collect one operand (file or directory, recursively) into members.
 * Returns false when the operand cannot be stat'ed.
 */
function collect(ctx: ArchiveCtx, baseDir: string, operand: string,
  members: ArchiveMember[], recurseDirs: boolean): boolean {
  const abs = ctx.fs.normalizePath(operand, baseDir);
  const node = ctx.fs.resolveInode(abs);
  if (!node) return false;
  // GNU tar stores relative names: strip any leading slashes.
  const storedRoot = operand.replace(/^\/+/, '') || basename(abs);
  const walk = (nodePath: string, stored: string, n: INode): void => {
    if (n.type === 'directory') {
      members.push({
        path: `${stored}/`, type: 'dir',
        mode: n.permissions & 0o7777, uid: n.uid, gid: n.gid, mtime: n.mtime,
      });
      if (!recurseDirs) return;
      for (const child of ctx.fs.listDirectory(nodePath) ?? []) {
        if (child.name === '.' || child.name === '..') continue;
        walk(`${nodePath}/${child.name}`, `${stored}/${child.name}`, child.inode);
      }
    } else {
      members.push({
        path: stored, type: 'file',
        mode: n.permissions & 0o7777, uid: n.uid, gid: n.gid, mtime: n.mtime,
        content: ctx.fs.readFile(nodePath) ?? n.content,
      });
    }
  };
  walk(abs, storedRoot.replace(/\/+$/, ''), node);
  return true;
}

/** Materialise members under `destDir`; returns the names restored. */
function restore(ctx: ArchiveCtx, destDir: string,
  members: ArchiveMember[]): string[] {
  const names: string[] = [];
  for (const m of members) {
    const target = ctx.fs.normalizePath(m.path.replace(/\/+$/, ''), destDir);
    if (m.type === 'dir') {
      ctx.fs.mkdirp(target, m.mode, ctx.uid, ctx.gid);
    } else {
      ctx.fs.writeFile(target, m.content ?? '', ctx.uid, ctx.gid, ctx.umask);
      ctx.fs.chmod(target, m.mode);
    }
    // Only root preserves archived ownership (real tar/unzip semantics);
    // other users own what they extract.
    if (ctx.uid === 0) ctx.fs.chown(target, m.uid, m.gid);
    names.push(m.path);
  }
  return names;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── gzip / gunzip / zcat ────────────────────────────────────────────

// ── zip / unzip ─────────────────────────────────────────────────────

/** Deterministic display ratio (Info-ZIP shows one per member). */
function deflateRatio(content: string): string {
  if (content.length === 0) return 'stored 0%';
  const ratio = 10 + ((content.length * 7) % 76);
  return `deflated ${ratio}%`;
}

export function cmdZip(ctx: ArchiveCtx, args: string[]): CmdResult {
  const recurse = args.includes('-r') || args.includes('--recurse-paths');
  const operands = args.filter((a) => !a.startsWith('-'));
  if (operands.length === 0) {
    return {
      output: 'zip error: Nothing to do! (try: zip -r archive.zip . -i pattern)',
      exitCode: 12,
    };
  }
  const archiveName = basename(operands[0]).includes('.')
    ? operands[0] : `${operands[0]}.zip`;
  const archiveAbs = ctx.fs.normalizePath(archiveName, ctx.cwd);
  const sources = operands.slice(1);
  if (sources.length === 0) {
    return {
      output: `\nzip error: Nothing to do! (${archiveName})`,
      exitCode: 12,
    };
  }

  // Info-ZIP updates an existing archive in place.
  const existingRaw = ctx.fs.readFile(archiveAbs);
  const members: ArchiveMember[] = existingRaw
    ? (unpackMembers(ZIP_MAGIC, existingRaw) ?? []) : [];
  const known = new Set(members.map((m) => m.path));

  const lines: string[] = [];
  let matchedAny = false;
  for (const src of sources) {
    const fresh: ArchiveMember[] = [];
    if (!collect(ctx, ctx.cwd, src, fresh, recurse)) {
      lines.push(`\tzip warning: name not matched: ${src}`);
      continue;
    }
    matchedAny = true;
    for (const m of fresh) {
      const verb = known.has(m.path) ? 'updating' : 'adding';
      const idx = members.findIndex((e) => e.path === m.path);
      if (idx >= 0) members[idx] = m; else members.push(m);
      known.add(m.path);
      lines.push(m.type === 'dir'
        ? `  ${verb}: ${m.path} (stored 0%)`
        : `  ${verb}: ${m.path} (${deflateRatio(m.content ?? '')})`);
    }
  }
  if (!matchedAny) {
    lines.push(`\nzip error: Nothing to do! (${archiveName})`);
    return { output: lines.join('\n'), exitCode: 12 };
  }
  ctx.fs.writeFile(archiveAbs, packMembers(ZIP_MAGIC, members),
    ctx.uid, ctx.gid, ctx.umask);
  return { output: lines.join('\n'), exitCode: 0 };
}

export function cmdUnzip(ctx: ArchiveCtx, args: string[]): CmdResult {
  const list = args.includes('-l');
  const dIdx = args.findIndex((a) => a === '-d');
  const destDir = dIdx >= 0 ? args[dIdx + 1] : undefined;
  const operands = args.filter((a, i) =>
    !a.startsWith('-') && (dIdx < 0 || i !== dIdx + 1));
  if (operands.length === 0) {
    return {
      output: 'UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.\n\n' +
        'Usage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]',
      exitCode: 0,
    };
  }
  const name = operands[0];
  let abs = ctx.fs.normalizePath(name, ctx.cwd);
  if (!ctx.fs.exists(abs) && !name.endsWith('.zip')) {
    abs = ctx.fs.normalizePath(`${name}.zip`, ctx.cwd);
  }
  const raw = ctx.fs.readFile(abs);
  if (raw === null) {
    return {
      output: `unzip:  cannot find or open ${name}, ${name}.zip or ${name}.ZIP.`,
      exitCode: 9,
    };
  }
  const members = unpackMembers(ZIP_MAGIC, raw);
  if (!members) {
    return {
      output: `Archive:  ${name}\n` +
        '  End-of-central-directory signature not found.  Either this file is not\n' +
        '  a zipfile, or it constitutes one disk of a multi-part archive.',
      exitCode: 9,
    };
  }
  if (list) {
    const rows = members.map((m) => {
      const len = (m.content ?? '').length;
      return `${padToWidth(String(len), 9, 'right')}  ${formatDate(m.mtime)}   ${m.path}`;
    });
    const total = members.reduce((s, m) => s + (m.content ?? '').length, 0);
    return {
      output: [
        `Archive:  ${name}`,
        '  Length      Date    Time    Name',
        '---------  ---------- -----   ----',
        ...rows,
        '---------                     -------',
        `${padToWidth(String(total), 9, 'right')}                     ${members.length} files`,
      ].join('\n'),
      exitCode: 0,
    };
  }
  const base = destDir ? ctx.fs.normalizePath(destDir, ctx.cwd) : ctx.cwd;
  if (destDir) ctx.fs.mkdirp(base, 0o755, ctx.uid, ctx.gid);
  const lines = [`Archive:  ${name}`];
  for (const m of members) {
    lines.push(m.type === 'dir'
      ? `   creating: ${m.path}`
      : `  inflating: ${m.path}`);
  }
  restore(ctx, base, members);
  return { output: lines.join('\n'), exitCode: 0 };
}
