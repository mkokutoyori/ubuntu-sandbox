import { simulationNowMs } from '@/network/core/SystemClock';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import { compilePosix } from '../regex/PosixRegex';
import { fnmatch } from '../fs/Glob';
import {
  TAR_MAGIC, basename, packGzip, packMembers, unpackGzip, unpackMembers,
  type ArchiveCtx, type ArchiveMember, type CmdResult,
} from './ArchiveCommands';
import { COREUTILS_DOCS } from './CoreutilsDocs';

const TRY = "Try 'tar --help' or 'tar --usage' for more information.";
const FAILED = 'tar: Exiting with failure status due to previous errors';
const FATAL = 'tar: Error is not recoverable: exiting now';

type Operation = 'c' | 'x' | 't' | 'r' | 'u' | 'd' | 'A' | 'delete';

interface Operand {
  readonly name: string;
  readonly excludes: readonly string[];
  readonly directory: string | null;
  readonly recursion: boolean;
}

interface TarOptions {
  operations: Operation[];
  archive: string | null;
  directory: string | null;
  verbose: number;
  compress: boolean;
  toStdout: boolean;
  dereference: boolean;
  absolute: boolean;
  keep: 'replace' | 'keep' | 'skip' | 'overwrite';
  touch: boolean;
  samePermissions: boolean | null;
  numericOwner: boolean;
  ownerName: string | null;
  groupName: string | null;
  strip: number;
  transforms: Array<{ expression: RegExp; replacement: string; global: boolean }>;
  wildcards: boolean;
  anchored: boolean;
  matchSlash: boolean;
  oneTopLevel: string | boolean | null;
  readRecursion: boolean;
  explicitNoWildcards: boolean;
  filesFrom: string[];
  excludeFrom: string[];
  operands: Operand[];
}

class TarUsage extends Error {
  constructor(readonly output: string, readonly exitCode: number) { super(output); }
}

const usage = (message: string, code = 64): never => {
  throw new TarUsage(`${message}\n${TRY}`, code);
};

const OPERATION_LETTERS: Readonly<Record<string, Operation>> = { c: 'c', x: 'x', t: 't', r: 'r', u: 'u', d: 'd', A: 'A' };
const SHORT_WITH_ARGUMENT = new Set(['f', 'C', 'T', 'X']);
const SHORT_FLAGS = new Set(['v', 'z', 'j', 'J', 'a', 'O', 'h', 'P', 'k', 'm', 'p', 's', 'U', 'w', 'W', 'l', 'n', 'S', 'g']);

const LONG_OPTIONS: ReadonlyArray<readonly [string, boolean]> = [
  ['create', false], ['extract', false], ['get', false], ['list', false], ['append', false], ['update', false], ['diff', false], ['compare', false], ['catenate', false], ['concatenate', false], ['delete', false],
  ['file', true], ['directory', true], ['verbose', false], ['gzip', false], ['gunzip', false], ['ungzip', false], ['bzip2', false], ['xz', false], ['auto-compress', false],
  ['to-stdout', false], ['dereference', false], ['absolute-names', false], ['keep-old-files', false], ['skip-old-files', false], ['overwrite', false], ['touch', false],
  ['preserve-permissions', false], ['same-permissions', false], ['no-same-permissions', false], ['numeric-owner', false], ['owner', true], ['group', true],
  ['strip-components', true], ['transform', true], ['xform', true], ['no-recursion', false], ['recursion', false], ['wildcards', false], ['no-wildcards', false],
  ['wildcards-match-slash', false], ['no-wildcards-match-slash', false], ['anchored', false], ['no-anchored', false], ['exclude', true], ['exclude-from', true], ['files-from', true],
  ['one-top-level', true], ['totals', false], ['version', false], ['help', false], ['usage', false], ['same-owner', false], ['no-same-owner', false], ['unlink-first', false],
];

function resolveLong(name: string): { name: string; takes: boolean } {
  const exact = LONG_OPTIONS.find(([candidate]) => candidate === name);
  if (exact !== undefined) return { name: exact[0], takes: exact[1] };
  const matches = LONG_OPTIONS.filter(([candidate]) => candidate.startsWith(name));
  const distinct = new Set(matches.map(([candidate]) => candidate.replace(/^(get)$/, 'extract')));
  if (matches.length === 0) return usage(`tar: unrecognized option '--${name}'`);
  if (distinct.size > 1 && matches.length > 1) {
    return usage(`tar: option '--${name}' is ambiguous; possibilities:${matches.map(([candidate]) => ` '--${candidate}'`).join('')}`);
  }
  return { name: matches[0][0], takes: matches[0][1] };
}

function parseTransform(expression: string): TarOptions['transforms'][number] {
  const delimiter = expression[1];
  if (expression[0] !== 's' || delimiter === undefined) return usage(`tar: Invalid transform expression`, 2);
  const parts: string[] = [];
  let current = '';
  let at = 2;
  for (; at < expression.length; at++) {
    if (expression[at] === '\\' && at + 1 < expression.length) { current += expression[at] + expression[at + 1]; at++; continue; }
    if (expression[at] === delimiter) { parts.push(current); current = ''; if (parts.length === 2) { at++; break; } continue; }
    current += expression[at];
  }
  if (parts.length < 2) return usage('tar: Invalid transform expression', 2);
  const flags = expression.slice(at);
  const body = parts[0];
  return { expression: compilePosix(body, { extended: false, ignoreCase: flags.includes('i') }), replacement: parts[1], global: flags.includes('g') };
}

function parseArguments(args: readonly string[]): TarOptions {
  const o: TarOptions = {
    operations: [], archive: null, directory: null, verbose: 0, compress: false, toStdout: false, dereference: false, absolute: false, keep: 'replace', touch: false,
    samePermissions: null, numericOwner: false, ownerName: null, groupName: null, strip: 0, transforms: [], wildcards: false, anchored: true, matchSlash: true,
    oneTopLevel: null, readRecursion: true, explicitNoWildcards: false, filesFrom: [], excludeFrom: [], operands: [],
  };
  let excludes: string[] = [];
  let directory: string | null = null;
  let recursion = true;
  const apply = (name: string, value: string | null): void => {
    switch (name) {
      case 'create': o.operations.push('c'); break;
      case 'extract': case 'get': o.operations.push('x'); break;
      case 'list': o.operations.push('t'); break;
      case 'append': o.operations.push('r'); break;
      case 'update': o.operations.push('u'); break;
      case 'diff': case 'compare': o.operations.push('d'); break;
      case 'catenate': case 'concatenate': o.operations.push('A'); break;
      case 'delete': o.operations.push('delete'); break;
      case 'file': o.archive = value; break;
      case 'directory': o.directory = value; directory = value; break;
      case 'verbose': o.verbose++; break;
      case 'gzip': case 'gunzip': case 'ungzip': case 'bzip2': case 'xz': case 'auto-compress': o.compress = true; break;
      case 'to-stdout': o.toStdout = true; break;
      case 'dereference': o.dereference = true; break;
      case 'absolute-names': o.absolute = true; break;
      case 'keep-old-files': o.keep = 'keep'; break;
      case 'skip-old-files': o.keep = 'skip'; break;
      case 'overwrite': o.keep = 'overwrite'; break;
      case 'touch': o.touch = true; break;
      case 'preserve-permissions': case 'same-permissions': o.samePermissions = true; break;
      case 'no-same-permissions': o.samePermissions = false; break;
      case 'numeric-owner': o.numericOwner = true; break;
      case 'owner': o.ownerName = value; break;
      case 'group': o.groupName = value; break;
      case 'strip-components': {
        if (value === null || !/^\d+$/.test(value)) usage(`tar: ${value ?? ''}: Invalid number of elements`, 2);
        o.strip = Number(value);
        break;
      }
      case 'transform': case 'xform': o.transforms.push(parseTransform(value ?? '')); break;
      case 'no-recursion': recursion = false; o.readRecursion = false; break;
      case 'recursion': recursion = true; o.readRecursion = true; break;
      case 'wildcards': o.wildcards = true; break;
      case 'no-wildcards': o.wildcards = false; o.explicitNoWildcards = true; break;
      case 'wildcards-match-slash': o.matchSlash = true; break;
      case 'no-wildcards-match-slash': o.matchSlash = false; break;
      case 'anchored': o.anchored = true; break;
      case 'no-anchored': o.anchored = false; break;
      case 'exclude': excludes = [...excludes, value ?? '']; break;
      case 'exclude-from': o.excludeFrom.push(value ?? ''); break;
      case 'files-from': o.filesFrom.push(value ?? ''); break;
      case 'one-top-level': o.oneTopLevel = value === null ? true : value; break;
      case 'version': throw new TarUsage(COREUTILS_DOCS.tar.version, 0);
      case 'help': throw new TarUsage(COREUTILS_DOCS.tar.help, 0);
      default: break;
    }
  };
  const pushOperand = (name: string): void => {
    o.operands.push({ name, excludes, directory, recursion });
  };
  const bundle = (letters: string, rest: readonly string[], at: number, oldStyle: boolean): number => {
    let consumed = 0;
    for (let position = 0; position < letters.length; position++) {
      const letter = letters[position];
      if (OPERATION_LETTERS[letter] !== undefined) { o.operations.push(OPERATION_LETTERS[letter]); continue; }
      if (SHORT_WITH_ARGUMENT.has(letter)) {
        const attached = oldStyle ? '' : letters.slice(position + 1);
        const value = attached !== '' ? attached : rest[at + 1 + consumed];
        if (attached !== '') position = letters.length;
        if (value === undefined) {
          if (oldStyle) usage(`tar: Old option '${letter}' requires an argument.`, 2);
          usage(`tar: option requires an argument -- '${letter}'`, 64);
        }
        if (attached === '') consumed++;
        apply(letter === 'f' ? 'file' : letter === 'C' ? 'directory' : letter === 'T' ? 'files-from' : 'exclude-from', value);
        continue;
      }
      if (SHORT_FLAGS.has(letter)) {
        const long: Record<string, string> = { v: 'verbose', z: 'gzip', j: 'bzip2', J: 'xz', a: 'auto-compress', O: 'to-stdout', h: 'dereference', P: 'absolute-names', k: 'keep-old-files', m: 'touch', p: 'preserve-permissions' };
        if (long[letter] !== undefined) apply(long[letter], null);
        continue;
      }
      usage(`tar: invalid option -- '${letter}'`, 64);
    }
    return consumed;
  };
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (optionsEnded) { pushOperand(arg); continue; }
    if (arg === '--') { optionsEnded = true; continue; }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const given = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      const { name, takes } = resolveLong(given);
      if (name === 'one-top-level') { apply(name, equals === -1 ? null : arg.slice(equals + 1)); continue; }
      if (takes) {
        let value: string | null = equals === -1 ? null : arg.slice(equals + 1);
        if (value === null) {
          value = args[i + 1] ?? null;
          if (value === null) usage(`tar: option '--${name}' requires an argument`, 64);
          i++;
        }
        apply(name, value);
      } else {
        if (equals !== -1) usage(`tar: option '--${name}' doesn't allow an argument`, 64);
        apply(name, null);
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      i += bundle(arg.slice(1), args, i, false);
      continue;
    }
    if (i === 0 && /^[A-Za-z]+$/.test(arg) && /[cxtruAd]/.test(arg)) {
      i += bundle(arg, args, i, true);
      continue;
    }
    pushOperand(arg);
  }
  return o;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function listingDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function modeString(mode: number, type: ArchiveMember['type']): string {
  const bit = (m: number, r: number, w: number, x: number): string => `${m & r ? 'r' : '-'}${m & w ? 'w' : '-'}${m & x ? 'x' : '-'}`;
  const kind = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : '-';
  return kind + bit(mode, 0o400, 0o200, 0o100) + bit(mode, 0o040, 0o020, 0o010) + bit(mode, 0o004, 0o002, 0o001);
}

function memberLine(ctx: ArchiveCtx, member: ArchiveMember, o: TarOptions): string {
  const owner = o.ownerName ?? (o.numericOwner ? String(member.uid) : ctx.userName?.(member.uid) ?? String(member.uid));
  const group = o.groupName ?? (o.numericOwner ? String(member.gid) : ctx.groupName?.(member.gid) ?? String(member.gid));
  const identity = `${owner}/${group}`;
  const size = member.type === 'file' ? String((member.content ?? '').length) : '0';
  const width = Math.max(19, identity.length + 1 + size.length);
  const arrow = member.type === 'symlink' ? ` -> ${member.link ?? ''}` : '';
  return `${modeString(member.mode, member.type)} ${identity}${padToWidth(size, width - identity.length, 'right')} ${listingDate(member.mtime)} ${member.path}${arrow}`;
}

function excluded(path: string, patterns: readonly string[], o: TarOptions): boolean {
  const plain = path.replace(/\/+$/, '');
  const parts = plain.split('/');
  return patterns.some((pattern) => {
    const trimmed = pattern.replace(/\/+$/, '');
    for (let start = 0; start < parts.length; start++) {
      if (fnmatch(trimmed, parts.slice(start).join('/'))) return true;
    }
    return o.anchored && fnmatch(trimmed, plain);
  });
}

function selects(name: string, patterns: readonly string[], o: TarOptions): number[] {
  const plain = name.replace(/\/+$/, '');
  const hits: number[] = [];
  patterns.forEach((pattern, index) => {
    const wanted = pattern.replace(/\/+$/, '');
    let matched: boolean;
    if (o.wildcards) {
      const candidates = o.anchored ? [plain] : plain.split('/').map((_, start, parts) => parts.slice(start).join('/'));
      matched = candidates.some((candidate) => (o.matchSlash ? fnmatch(wanted, candidate) : fnmatch(wanted, candidate) && !/\//.test(candidate.slice(0, 0))) || (o.readRecursion && candidate.startsWith(`${wanted}/`)));
      if (!o.matchSlash) matched = candidates.some((candidate) => new RegExp(`^${wanted.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`).test(candidate));
    } else matched = plain === wanted || (o.readRecursion && plain.startsWith(`${wanted}/`));
    if (matched) hits.push(index);
  });
  return hits;
}

function transformName(name: string, o: TarOptions): string {
  let result = name;
  for (const transform of o.transforms) {
    const expression = new RegExp(transform.expression.source, transform.expression.flags.replace('g', '') + (transform.global ? 'g' : ''));
    result = result.replace(expression, (...groups) => transform.replacement.replace(/\\([0-9])|&/g, (_m, digit: string | undefined) => (digit === undefined ? groups[0] : String(groups[Number(digit)] ?? ''))));
  }
  return result;
}

function walk(ctx: ArchiveCtx, o: TarOptions, baseDir: string, operand: Operand, members: ArchiveMember[], lines: string[], failures: { count: number }): void {
  const dir = operand.directory === null ? baseDir : ctx.fs.normalizePath(operand.directory, ctx.cwd);
  const abs = ctx.fs.normalizePath(operand.name, dir);
  let stored = operand.name;
  if (!o.absolute && stored.startsWith('/')) {
    stored = stored.replace(/^\/+/, '');
    if (!lines.includes("tar: Removing leading `/' from member names")) lines.push("tar: Removing leading `/' from member names");
  }
  stored = stored.replace(/\/+$/, '') || basename(abs);
  if (excluded(stored, operand.excludes, o)) return;
  const node = ctx.fs.resolveInode(abs, o.dereference);
  if (node === null) {
    lines.push(`tar: ${operand.name}: Cannot stat: No such file or directory`);
    failures.count++;
    return;
  }
  const visit = (nodePath: string, name: string, inode: NonNullable<typeof node>, top: boolean): void => {
    if (!top && excluded(name, operand.excludes, o)) return;
    const base = { mode: inode.permissions & 0o7777, uid: inode.uid, gid: inode.gid, mtime: inode.mtime };
    const shown = transformName(name, o);
    if (inode.type === 'symlink' && !o.dereference) {
      members.push({ ...base, path: shown, type: 'symlink', link: ctx.fs.linkTarget(inode) });
      if (o.verbose > 0) lines.push(shown);
      return;
    }
    if (inode.type === 'directory') {
      members.push({ ...base, path: `${shown}/`, type: 'dir' });
      if (o.verbose > 0) lines.push(`${shown}/`);
      if (!operand.recursion) return;
      for (const child of ctx.fs.listDirectory(nodePath) ?? []) {
        if (child.name === '.' || child.name === '..') continue;
        const childPath = `${nodePath}/${child.name}`;
        const childInode = ctx.fs.resolveInode(childPath, o.dereference) ?? child.inode;
        visit(childPath, `${name}/${child.name}`, childInode, false);
      }
      return;
    }
    members.push({ ...base, path: shown, type: 'file', content: ctx.fs.readFile(nodePath) ?? inode.content });
    if (o.verbose > 0) lines.push(shown);
  };
  visit(abs, stored, node, true);
}

function packArchive(members: ArchiveMember[], o: TarOptions, name: string): string {
  const payload = packMembers(TAR_MAGIC, members);
  if (!o.compress) return payload;
  return packGzip({ name: basename(name).replace(/\.(gz|tgz)$/, (suffix) => (suffix === '.tgz' ? '.tar' : '')), mtime: simulationNowMs(), payload });
}

function openArchive(ctx: ArchiveCtx, o: TarOptions): { members: ArchiveMember[] } | CmdResult {
  let raw: string | null;
  if (o.archive === null || o.archive === '-') raw = ctx.stdin ?? '';
  else raw = ctx.fs.readFile(ctx.fs.normalizePath(o.archive, ctx.cwd));
  if (raw === null) return { output: `tar: ${o.archive}: Cannot open: No such file or directory\n${FATAL}`, exitCode: 2 };
  const inner = unpackGzip(raw)?.payload ?? raw;
  const members = unpackMembers(TAR_MAGIC, inner);
  if (members === null) return { output: `tar: This does not look like a tar archive\n${FAILED}`, exitCode: 2 };
  return { members };
}

function operandsPatterns(o: TarOptions, ctx: ArchiveCtx): string[] {
  const names = o.operands.map((operand) => operand.name);
  for (const file of o.filesFrom) {
    const text = file === '-' ? ctx.stdin ?? '' : ctx.fs.readFile(ctx.fs.normalizePath(file, ctx.cwd)) ?? '';
    names.push(...text.split('\n').filter((line) => line !== ''));
  }
  return names;
}

function notFound(patterns: string[], hit: boolean[], lines: string[], o: TarOptions): number {
  let missing = 0;
  if (!o.wildcards && !o.explicitNoWildcards && patterns.some((pattern, index) => !hit[index] && /[*?[]/.test(pattern))) {
    lines.push('tar: Pattern matching characters used in file names');
    lines.push('tar: Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning');
  }
  patterns.forEach((pattern, index) => {
    if (!hit[index]) { lines.push(`tar: ${pattern}: Not found in archive`); missing++; }
  });
  return missing;
}

function extract(ctx: ArchiveCtx, o: TarOptions, members: ArchiveMember[], baseDir: string, lines: string[], out: string[]): number {
  let errors = 0;
  const patterns = operandsPatterns(o, ctx);
  const hit = patterns.map(() => false);
  const root = ctx.uid === 0;
  const permissions = o.samePermissions ?? root;
  let top: string | null = null;
  if (typeof o.oneTopLevel === 'string') top = o.oneTopLevel;
  else if (o.oneTopLevel === true) top = basename(o.archive ?? 'archive').replace(/\.(tar|tgz|tar\.gz|tar\.xz|tar\.bz2|txz|tbz2?)$/, '');
  if (top !== null) ctx.fs.mkdirp(ctx.fs.normalizePath(top, baseDir), 0o777 & ~ctx.umask, ctx.uid, ctx.gid);
  for (const member of members) {
    if (patterns.length > 0) {
      const hits = selects(member.path, patterns, o);
      if (hits.length === 0) continue;
      hits.forEach((index) => { hit[index] = true; });
    }
    let name = member.path.replace(/\/+$/, '');
    if (!o.absolute && name.startsWith('/')) {
      name = name.replace(/^\/+/, '');
      if (!lines.includes("tar: Removing leading `/' from member names")) lines.push("tar: Removing leading `/' from member names");
    }
    if (o.strip > 0) {
      const parts = name.split('/');
      if (parts.length <= o.strip) continue;
      name = parts.slice(o.strip).join('/');
    }
    name = transformName(name, o);
    if (name === '') continue;
    if (top !== null) name = `${top}/${name}`;
    if (o.verbose > 0 && !o.toStdout) out.push(member.type === 'dir' ? `${name}/` : name);
    if (o.toStdout) {
      if (member.type === 'file') out.push(member.content ?? '');
      continue;
    }
    const target = ctx.fs.normalizePath(name, baseDir);
    const existing = ctx.fs.resolveInode(target, false);
    if (member.type === 'dir') {
      if (existing === null) ctx.fs.mkdirp(target, permissions ? member.mode : member.mode & ~ctx.umask, ctx.uid, ctx.gid);
      else if (permissions) ctx.fs.chmod(target, member.mode);
    } else {
      if (existing !== null && existing.type !== 'directory') {
        if (o.keep === 'keep') { lines.push(`tar: ${name}: Cannot open: File exists`); errors++; continue; }
        if (o.keep === 'skip') continue;
        if (o.keep !== 'overwrite') ctx.fs.deleteFile(target);
      }
      const parent = target.slice(0, target.lastIndexOf('/')) || '/';
      if (ctx.fs.resolveInode(parent, false) === null) ctx.fs.mkdirp(parent, 0o777 & ~ctx.umask, ctx.uid, ctx.gid);
      if (member.type === 'symlink') ctx.fs.createSymlink(target, member.link ?? '', ctx.uid, ctx.gid);
      else {
        ctx.fs.writeFile(target, member.content ?? '', ctx.uid, ctx.gid, ctx.umask);
        ctx.fs.chmod(target, permissions ? member.mode : member.mode & ~ctx.umask);
      }
    }
    if (root && member.type !== 'symlink') ctx.fs.chown(target, member.uid, member.gid);
    if (!o.touch && member.type !== 'symlink') ctx.fs.setTimes(target, { mtime: member.mtime });
  }
  errors += notFound(patterns, hit, lines, o);
  return errors;
}

function compare(ctx: ArchiveCtx, o: TarOptions, members: ArchiveMember[], baseDir: string, out: string[]): number {
  const patterns = operandsPatterns(o, ctx);
  let differences = 0;
  for (const member of members) {
    if (patterns.length > 0 && selects(member.path, patterns, o).length === 0) continue;
    const name = member.path.replace(/\/+$/, '');
    const target = ctx.fs.normalizePath(name, baseDir);
    const node = ctx.fs.resolveInode(target, false);
    if (o.verbose > 0) out.push(member.path);
    if (node === null) { out.push(`tar: ${name}: Warning: Cannot stat: No such file or directory`); differences++; continue; }
    const problems: string[] = [];
    if (member.type === 'file') {
      if (node.type !== 'file') problems.push('File type differs');
      else {
        const content = ctx.fs.readFile(target) ?? node.content ?? '';
        if (content.length !== (member.content ?? '').length) problems.push('Size differs');
      }
    }
    if ((node.permissions & 0o7777) !== member.mode) problems.push('Mode differs');
    if (node.uid !== member.uid) problems.push('Uid differs');
    if (node.gid !== member.gid) problems.push('Gid differs');
    if (member.type === 'file' && node.type === 'file') {
      if (Math.floor(node.mtime / 1000) !== Math.floor(member.mtime / 1000)) problems.push('Mod time differs');
      const content = ctx.fs.readFile(target) ?? node.content ?? '';
      if (!problems.includes('Size differs') && content !== (member.content ?? '')) problems.push('Contents differ');
    }
    for (const problem of problems) out.push(`${name}: ${problem}`);
    if (problems.length > 0) differences++;
  }
  return differences;
}

export function cmdTar(ctx: ArchiveCtx, args: string[]): CmdResult {
  let o: TarOptions;
  try {
    o = parseArguments(args);
  } catch (error) {
    if (error instanceof TarUsage) return { output: error.output, exitCode: error.exitCode };
    throw error;
  }
  for (const file of o.excludeFrom) {
    const text = ctx.fs.readFile(ctx.fs.normalizePath(file, ctx.cwd));
    if (text === null) return { output: `tar: ${file}: No such file or directory\n${FATAL}`, exitCode: 2 };
    const patterns = text.split('\n').filter((line) => line !== '');
    o.operands = o.operands.map((operand) => ({ ...operand, excludes: [...operand.excludes, ...patterns] }));
  }
  for (const file of o.filesFrom) {
    if (file !== '-' && ctx.fs.readFile(ctx.fs.normalizePath(file, ctx.cwd)) === null) {
      return { output: `tar: ${file}: Cannot stat: No such file or directory\n${FATAL}`, exitCode: 2 };
    }
  }
  const unique = [...new Set(o.operations)];
  if (unique.length === 0) {
    return { output: `tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\n${TRY}`, exitCode: 2 };
  }
  if (unique.length > 1) {
    return { output: `tar: You may not specify more than one '-Acdtrux', '--delete' or '--test-label' option\n${TRY}`, exitCode: 2 };
  }
  const operation = unique[0];
  const baseDir = o.directory === null ? ctx.cwd : ctx.fs.normalizePath(o.directory, ctx.cwd);
  if (o.directory !== null && ctx.fs.resolveInode(baseDir)?.type !== 'directory') {
    return { output: `tar: ${o.directory}: Cannot open: No such file or directory\n${FATAL}`, exitCode: 2 };
  }
  const lines: string[] = [];
  const out: string[] = [];
  const archiveName = o.archive ?? '-';
  if (operation === 'c') {
    const names = operandsPatterns(o, ctx);
    if (names.length === 0) return { output: `tar: Cowardly refusing to create an empty archive\n${TRY}`, exitCode: 2 };
    const members: ArchiveMember[] = [];
    const failures = { count: 0 };
    const listed: Operand[] = names.slice(o.operands.length).map((name) => ({ name, excludes: [], directory: null, recursion: true }));
    const operands = [...o.operands, ...listed];
    for (const operand of operands) walk(ctx, o, ctx.cwd, operand, members, lines, failures);
    const payload = packArchive(members, o, archiveName);
    if (archiveName === '-') return { output: [...lines, payload].join('\n'), exitCode: failures.count > 0 ? 2 : 0 };
    ctx.fs.writeFile(ctx.fs.normalizePath(archiveName, ctx.cwd), payload, ctx.uid, ctx.gid, ctx.umask);
    if (failures.count > 0) lines.push(FAILED);
    return { output: lines.join('\n'), exitCode: failures.count > 0 ? 2 : 0 };
  }
  const opened = openArchive(ctx, o);
  if ('exitCode' in opened) return opened;
  const { members } = opened;
  if (operation === 't') {
    const patterns = operandsPatterns(o, ctx);
    const hit = patterns.map(() => false);
    for (const member of members) {
      if (patterns.length > 0) {
        const hits = selects(member.path, patterns, o);
        if (hits.length === 0) continue;
        hits.forEach((index) => { hit[index] = true; });
      }
      out.push(o.verbose > 0 ? memberLine(ctx, member, o) : member.path);
    }
    const missing = notFound(patterns, hit, lines, o);
    if (missing > 0) lines.push(FAILED);
    return { output: [...out, ...lines].join('\n'), exitCode: missing > 0 ? 2 : 0 };
  }
  if (operation === 'x') {
    const errors = extract(ctx, o, members, baseDir, lines, out);
    if (errors > 0) lines.push(FAILED);
    return { output: o.toStdout ? [...out, ...lines].join('') : [...lines, ...out].join('\n'), exitCode: errors > 0 ? 2 : 0 };
  }
  if (operation === 'd') {
    const differences = compare(ctx, o, members, baseDir, out);
    return { output: out.join('\n'), exitCode: differences > 0 ? 1 : 0 };
  }
  if (archiveName === '-' || o.compress) {
    return { output: `tar: Cannot update compressed archives\n${FATAL}`, exitCode: 2 };
  }
  if (operation === 'delete') {
    const patterns = operandsPatterns(o, ctx);
    if (patterns.length === 0) return { output: `tar: You must specify at least one member to delete\n${TRY}`, exitCode: 2 };
    const hit = patterns.map(() => false);
    const kept = members.filter((member) => {
      const hits = selects(member.path, patterns, o);
      hits.forEach((index) => { hit[index] = true; });
      return hits.length === 0;
    });
    const missing = notFound(patterns, hit, lines, o);
    ctx.fs.writeFile(ctx.fs.normalizePath(archiveName, ctx.cwd), packArchive(kept, o, archiveName), ctx.uid, ctx.gid, ctx.umask);
    if (missing > 0) lines.push(FAILED);
    return { output: lines.join('\n'), exitCode: missing > 0 ? 2 : 0 };
  }
  const added: ArchiveMember[] = [];
  const failures = { count: 0 };
  for (const operand of o.operands) walk(ctx, o, ctx.cwd, operand, added, lines, failures);
  const fresh = operation === 'u'
    ? added.filter((candidate) => {
      const previous = [...members].reverse().find((member) => member.path === candidate.path);
      return previous === undefined || candidate.mtime > previous.mtime;
    })
    : added;
  ctx.fs.writeFile(ctx.fs.normalizePath(archiveName, ctx.cwd), packArchive([...members, ...fresh], o, archiveName), ctx.uid, ctx.gid, ctx.umask);
  if (failures.count > 0) lines.push(FAILED);
  return { output: lines.join('\n'), exitCode: failures.count > 0 ? 2 : 0 };
}
