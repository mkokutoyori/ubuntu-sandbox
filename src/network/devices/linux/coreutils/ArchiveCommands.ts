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
import type { DirEntry, INode } from '../VirtualFileSystem';

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
}

export interface ArchiveCtx {
  fs: ArchiveFs;
  cwd: string;
  uid: number;
  gid: number;
  umask: number;
}

export interface CmdResult { output: string; exitCode: number; }

// ── Envelope format ─────────────────────────────────────────────────

const TAR_MAGIC = '!<simtar>';
const GZ_MAGIC = '!<simgz>';
const ZIP_MAGIC = '!<simzip>';

interface ArchiveMember {
  /** Stored path (always relative — leading `/` stripped like GNU tar). */
  path: string;
  type: 'file' | 'dir';
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
}

function packMembers(magic: string, members: ArchiveMember[]): string {
  return `${magic}\n${JSON.stringify({ v: 1, members })}`;
}

function unpackMembers(magic: string, raw: string): ArchiveMember[] | null {
  if (!raw.startsWith(`${magic}\n`)) return null;
  try {
    const body = JSON.parse(raw.slice(magic.length + 1)) as
      { v?: number; members?: ArchiveMember[] };
    return Array.isArray(body.members) ? body.members : null;
  } catch { return null; }
}

function packGzip(body: GzipBody): string {
  return `${GZ_MAGIC}\n${JSON.stringify(body)}`;
}

function unpackGzip(raw: string): GzipBody | null {
  if (!raw.startsWith(`${GZ_MAGIC}\n`)) return null;
  try {
    const body = JSON.parse(raw.slice(GZ_MAGIC.length + 1)) as GzipBody;
    return typeof body.payload === 'string' ? body : null;
  } catch { return null; }
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

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

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

// ── tar ─────────────────────────────────────────────────────────────

interface TarOptions {
  modes: string[];               // among 'c' | 'x' | 't'
  verbose: boolean;
  compress: boolean;             // -z / -j
  archive?: string;              // -f value
  directory?: string;            // -C value
  operands: string[];
  error?: CmdResult;
}

const TAR_FAIL =
  'tar: Exiting with failure status due to previous errors';

function parseTarArgs(args: string[]): TarOptions {
  const o: TarOptions = {
    modes: [], verbose: false, compress: false, operands: [],
  };
  const takeBundle = (letters: string, rest: string[], at: number): number => {
    let consumed = 0;
    for (const ch of letters) {
      if (ch === 'c' || ch === 'x' || ch === 't') o.modes.push(ch);
      else if (ch === 'v') o.verbose = true;
      else if (ch === 'z' || ch === 'j' || ch === 'J' || ch === 'a') o.compress = true;
      else if (ch === 'f') { o.archive = rest[at + ++consumed]; }
      else if (ch === 'C') { o.directory = rest[at + ++consumed]; }
      else if (ch === 'p' || ch === 'k') { /* accepted, default behaviour */ }
      else {
        o.error = {
          output: `tar: invalid option -- '${ch}'\n` +
            `Try 'tar --help' or 'tar --usage' for more information.`,
          exitCode: 64,
        };
        return consumed;
      }
    }
    return consumed;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (o.error) break;
    if (a === '--create') o.modes.push('c');
    else if (a === '--extract' || a === '--get') o.modes.push('x');
    else if (a === '--list') o.modes.push('t');
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--gzip' || a === '--bzip2' || a === '--xz' ||
             a === '--auto-compress') o.compress = true;
    else if (a === '--file') o.archive = args[++i];
    else if (a.startsWith('--file=')) o.archive = a.slice(7);
    else if (a === '--directory') o.directory = args[++i];
    else if (a.startsWith('--directory=')) o.directory = a.slice(12);
    else if (a.startsWith('--')) {
      o.error = {
        output: `tar: unrecognized option '${a}'\n` +
          `Try 'tar --help' or 'tar --usage' for more information.`,
        exitCode: 64,
      };
    } else if (a.startsWith('-') && a.length > 1) {
      i += takeBundle(a.slice(1), args, i);
    } else if (i === 0 && /^[A-Za-z]+$/.test(a) && /[cxt]/.test(a)) {
      // Old option style: `tar czf archive.tgz files…`
      i += takeBundle(a, args, i);
    } else {
      o.operands.push(a);
    }
  }
  return o;
}

export function cmdTar(ctx: ArchiveCtx, args: string[]): CmdResult {
  const o = parseTarArgs(args);
  if (o.error) return o.error;
  const uniqueModes = [...new Set(o.modes)];
  if (uniqueModes.length === 0) {
    return {
      output: "tar: You must specify one of the '-Acdtrux', " +
        "'--delete' or '--test-label' options\n" +
        "Try 'tar --help' or 'tar --usage' for more information.",
      exitCode: 2,
    };
  }
  if (uniqueModes.length > 1) {
    return {
      output: "tar: You may not specify more than one '-Acdtrux', " +
        "'--delete' or '--test-label' option\n" +
        "Try 'tar --help' or 'tar --usage' for more information.",
      exitCode: 2,
    };
  }
  const mode = uniqueModes[0];
  if (!o.archive) {
    return {
      output: mode === 'c'
        ? 'tar: Refusing to write archive contents to terminal (missing -f option?)\ntar: Error is not recoverable: exiting now'
        : 'tar: Refusing to read archive contents from terminal (missing -f option?)\ntar: Error is not recoverable: exiting now',
      exitCode: 2,
    };
  }
  const baseDir = o.directory
    ? ctx.fs.normalizePath(o.directory, ctx.cwd) : ctx.cwd;
  if (o.directory && ctx.fs.resolveInode(baseDir)?.type !== 'directory') {
    return {
      output: `tar: ${o.directory}: Cannot chdir: No such file or directory\n` +
        'tar: Error is not recoverable: exiting now',
      exitCode: 2,
    };
  }
  return mode === 'c'
    ? tarCreate(ctx, o, baseDir)
    : tarReadArchive(ctx, o, baseDir, mode as 'x' | 't');
}

function tarCreate(ctx: ArchiveCtx, o: TarOptions, baseDir: string): CmdResult {
  if (o.operands.length === 0) {
    return {
      output: 'tar: Cowardly refusing to create an empty archive\n' +
        "Try 'tar --help' or 'tar --usage' for more information.",
      exitCode: 2,
    };
  }
  const lines: string[] = [];
  if (o.operands.some((s) => s.startsWith('/'))) {
    lines.push("tar: Removing leading `/' from member names");
  }
  const members: ArchiveMember[] = [];
  let failed = false;
  for (const src of o.operands) {
    const before = members.length;
    if (!collect(ctx, baseDir, src, members, true)) {
      lines.push(`tar: ${src}: Cannot stat: No such file or directory`);
      failed = true;
      continue;
    }
    if (o.verbose) {
      for (const m of members.slice(before)) lines.push(m.path);
    }
  }
  let payload = packMembers(TAR_MAGIC, members);
  if (o.compress) {
    payload = packGzip({
      name: basename(o.archive!).replace(/\.(gz|tgz)$/, (s) =>
        s === '.tgz' ? '.tar' : ''),
      mtime: Date.now(), payload,
    });
  }
  const archiveAbs = ctx.fs.normalizePath(o.archive!, ctx.cwd);
  ctx.fs.writeFile(archiveAbs, payload, ctx.uid, ctx.gid, ctx.umask);
  if (failed) lines.push(TAR_FAIL);
  return { output: lines.join('\n'), exitCode: failed ? 2 : 0 };
}

/** Open + auto-decompress an archive (GNU tar detects compression). */
function openTar(ctx: ArchiveCtx, archive: string):
  { members: ArchiveMember[] } | CmdResult {
  const abs = ctx.fs.normalizePath(archive, ctx.cwd);
  const raw = ctx.fs.readFile(abs);
  if (raw === null) {
    return {
      output: `tar: ${archive}: Cannot open: No such file or directory\n` +
        'tar: Error is not recoverable: exiting now',
      exitCode: 2,
    };
  }
  const inner = unpackGzip(raw)?.payload ?? raw;
  const members = unpackMembers(TAR_MAGIC, inner);
  if (!members) {
    return {
      output: 'tar: This does not look like a tar archive\n' +
        `tar: Skipping to next header\n${TAR_FAIL}`,
      exitCode: 2,
    };
  }
  return { members };
}

function tarReadArchive(ctx: ArchiveCtx, o: TarOptions, baseDir: string,
  mode: 'x' | 't'): CmdResult {
  const opened = openTar(ctx, o.archive!);
  if ('exitCode' in opened) return opened;
  if (mode === 't') {
    const lines = opened.members.map((m) => o.verbose
      ? `${m.type === 'dir' ? 'd' : '-'}${formatMode(m.mode)} ` +
        `${m.uid}/${m.gid} ${String((m.content ?? '').length).padStart(7)} ` +
        `${formatDate(m.mtime)} ${m.path}`
      : m.path);
    return { output: lines.join('\n'), exitCode: 0 };
  }
  const names = restore(ctx, baseDir, opened.members);
  return { output: o.verbose ? names.join('\n') : '', exitCode: 0 };
}

function formatMode(mode: number): string {
  const bit = (m: number, r: number, w: number, x: number): string =>
    `${m & r ? 'r' : '-'}${m & w ? 'w' : '-'}${m & x ? 'x' : '-'}`;
  return bit(mode, 0o400, 0o200, 0o100) + bit(mode, 0o040, 0o020, 0o010) +
    bit(mode, 0o004, 0o002, 0o001);
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── gzip / gunzip / zcat ────────────────────────────────────────────

export function cmdGzip(ctx: ArchiveCtx, args: string[],
  invokedAs: 'gzip' | 'gunzip' | 'zcat'): CmdResult {
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const operands = args.filter((a) => !a.startsWith('-'));
  const keep = flags.has('-k') || flags.has('--keep');
  const decompress = invokedAs !== 'gzip' ||
    flags.has('-d') || flags.has('--decompress');

  if (operands.length === 0) {
    return {
      output: invokedAs === 'zcat'
        ? 'zcat: compressed data not read from a terminal.'
        : `gzip: compressed data not ${decompress ? 'read from' : 'written to'} ` +
          'a terminal. Use -f to force.',
      exitCode: 1,
    };
  }

  const lines: string[] = [];
  const stdout: string[] = [];
  let exitCode = 0;
  for (const op of operands) {
    const abs = ctx.fs.normalizePath(op, ctx.cwd);
    const node = ctx.fs.resolveInode(abs);
    if (!node) {
      lines.push(`gzip: ${op}: No such file or directory`);
      exitCode = 1;
      continue;
    }
    if (node.type === 'directory') {
      lines.push(`gzip: ${op} is a directory -- ignored`);
      exitCode = Math.max(exitCode, 2);
      continue;
    }
    const raw = ctx.fs.readFile(abs) ?? node.content;
    if (decompress || invokedAs === 'zcat') {
      const body = unpackGzip(raw);
      if (!body) {
        lines.push(`gzip: ${op}: not in gzip format`);
        exitCode = 1;
        continue;
      }
      if (invokedAs === 'zcat') {
        stdout.push(body.payload);
        continue;
      }
      if (!/\.(gz|tgz)$/.test(op)) {
        lines.push(`gzip: ${op}: unknown suffix -- ignored`);
        exitCode = Math.max(exitCode, 2);
        continue;
      }
      const outPath = op.endsWith('.tgz')
        ? abs.replace(/\.tgz$/, '.tar') : abs.replace(/\.gz$/, '');
      ctx.fs.writeFile(outPath, body.payload, ctx.uid, ctx.gid, ctx.umask);
      ctx.fs.chmod(outPath, node.permissions & 0o7777);
      if (ctx.uid === 0) ctx.fs.chown(outPath, node.uid, node.gid);
      if (!keep) ctx.fs.deleteFile(abs);
    } else {
      if (/\.gz$/.test(op)) {
        lines.push(`gzip: ${op} already has .gz suffix -- unchanged`);
        exitCode = Math.max(exitCode, 2);
        continue;
      }
      ctx.fs.writeFile(`${abs}.gz`,
        packGzip({ name: basename(abs), mtime: node.mtime, payload: raw }),
        ctx.uid, ctx.gid, ctx.umask);
      ctx.fs.chmod(`${abs}.gz`, node.permissions & 0o7777);
      if (ctx.uid === 0) ctx.fs.chown(`${abs}.gz`, node.uid, node.gid);
      if (!keep) ctx.fs.deleteFile(abs);
    }
  }
  return {
    output: [...lines, ...stdout].join('\n'),
    exitCode,
  };
}

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
      return `${String(len).padStart(9)}  ${formatDate(m.mtime)}   ${m.path}`;
    });
    const total = members.reduce((s, m) => s + (m.content ?? '').length, 0);
    return {
      output: [
        `Archive:  ${name}`,
        '  Length      Date    Time    Name',
        '---------  ---------- -----   ----',
        ...rows,
        '---------                     -------',
        `${String(total).padStart(9)}                     ${members.length} files`,
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
