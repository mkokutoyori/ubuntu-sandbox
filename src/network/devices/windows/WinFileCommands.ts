/**
 * Windows file command context and file operation commands.
 *
 * Context interface for file commands (extends WinCommandContext concept
 * but specifically for filesystem operations).
 *
 * Commands: type, copy, move, ren/rename, del/erase, echo (with redirect),
 *           mkdir/md, rmdir/rd, cd/chdir, cls, tree, set,
 *           attrib, find, findstr, where, more, fc, xcopy, sort
 */

import { WindowsFileSystem } from './WindowsFileSystem';
import {
  filterFind, filterFindstr, parseFindArguments, parseFindstrArguments, textLines,
} from './FindText';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import { driveLetterOf } from './windowsPath';
import { hasWildcard } from './WinPathSpec';
import { TREE_HELP, treeBody, treeHeading } from './WinTree';
import {
  ERROR_DIRECTORY, ERROR_INVALID_DRIVE, ERROR_INVALID_NAME, ERROR_PATH_NOT_FOUND,
} from './win32ErrorText';

/** Context provided to all Windows file command modules */
export interface WinFileCommandContext {
  fs: WindowsFileSystem;
  cwd: string;
  hostname: string;
  env: Map<string, string>;
  setEnv(name: string, value: string): void;
  setCwd(path: string): void;
  driveDirectory(letter: string): string;
  setDriveDirectory(letter: string, path: string): void;
  setExitCode(code: number): void;
  readonly inScript: boolean;
  readonly timezone: string;
  ask(prompt: string, preceding?: string): Promise<{ answer: string | null; flushed: boolean }>;
}

// ─── cd / chdir ────────────────────────────────────────────────────

export type DirectoryTarget = { readonly path: string } | { readonly error: string };

export function locateDirectory(ctx: WinFileCommandContext, text: string): DirectoryTarget {
  if (hasWildcard(text)) return { error: ERROR_INVALID_NAME };
  const absolute = ctx.fs.normalizePath(text, ctx.cwd);
  if (!ctx.fs.hasDrive(absolute[0])) return { error: ERROR_INVALID_DRIVE };
  const entry = ctx.fs.resolve(absolute);
  if (entry === null) return { error: ERROR_PATH_NOT_FOUND };
  if (entry.type !== 'directory') return { error: ERROR_DIRECTORY };
  return { path: ctx.fs.canonicalPath(absolute) };
}

export function refuse(ctx: WinFileCommandContext, message: string): string {
  ctx.setExitCode(1);
  return message;
}

export function enterDirectory(ctx: WinFileCommandContext, text: string): string | null {
  const located = locateDirectory(ctx, text);
  if ('error' in located) return refuse(ctx, located.error);
  ctx.setCwd(located.path);
  return null;
}

export function cmdCd(ctx: WinFileCommandContext, args: string[]): string {
  if (args.includes('/?')) return CD_HELP;
  const switchesDrive = args[0]?.toLowerCase() === '/d';
  const text = (switchesDrive ? args.slice(1) : args).join(' ');
  if (text === '') return ctx.cwd;

  const bareDrive = /^([A-Za-z]):$/.exec(text);
  if (bareDrive && !switchesDrive) {
    const letter = bareDrive[1].toUpperCase();
    return ctx.fs.hasDrive(letter) ? ctx.driveDirectory(letter) : refuse(ctx, ERROR_INVALID_DRIVE);
  }

  const located = locateDirectory(ctx, text);
  if ('error' in located) return refuse(ctx, located.error);
  if (switchesDrive || driveLetterOf(located.path) === driveLetterOf(ctx.cwd)) ctx.setCwd(located.path);
  else ctx.setDriveDirectory(located.path[0], located.path);
  return '';
}

const CD_HELP = [
  'Displays the name of or changes the current directory.',
  '',
  'CHDIR [/D] [drive:][path]',
  'CHDIR [..]',
  'CD [/D] [drive:][path]',
  'CD [..]',
  '',
  '  ..   Specifies that you want to change to the parent directory.',
  '',
  'Type CD drive: to display the current directory in the specified drive.',
  'Type CD without parameters to display the current drive and directory.',
  '',
  'Use the /D switch to change current drive in addition to changing current',
  'directory for a drive.',
  '',
  'If Command Extensions are enabled CHDIR changes as follows:',
  '',
  'The current directory string is converted to use the same case as',
  'the on disk names.  So CD C:\\TEMP would actually set the current',
  'directory to C:\\Temp if that is the case on disk.',
  '',
  'CHDIR command does not treat spaces as delimiters, so it is possible to',
  'CD into a subdirectory name that contains a space without surrounding',
  'the name with quotes.  For example:',
  '',
  '    cd \\winnt\\profiles\\username\\programs\\start menu',
  '',
  'is the same as:',
  '',
  '    cd "\\winnt\\profiles\\username\\programs\\start menu"',
  '',
  'which is what you would have to type if extensions were disabled.',
].join('\n');

// ─── mkdir / md ────────────────────────────────────────────────────

export function cmdMkdir(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'The syntax of the command is incorrect.';
  const path = args.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);

  // mkdir in Windows creates intermediate directories automatically
  if (ctx.fs.exists(absPath)) {
    return `A subdirectory or file ${path} already exists.`;
  }
  const made = ctx.fs.makeDirectories(absPath);
  return made.ok ? '' : refuse(ctx, made.error!);
}

// ─── rmdir / rd ────────────────────────────────────────────────────

export function cmdRmdir(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'The syntax of the command is incorrect.';

  let recursive = false;
  let quiet = false;
  const pathParts: string[] = [];

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/s') recursive = true;
    else if (lower === '/q') quiet = true;
    else pathParts.push(arg);
  }

  if (pathParts.length === 0) return 'The syntax of the command is incorrect.';
  const path = pathParts.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);

  if (recursive) {
    const result = ctx.fs.rmdirRecursive(absPath);
    return result.ok ? '' : refuse(ctx, result.error!);
  }

  const result = ctx.fs.rmdir(absPath);
  return result.ok ? '' : refuse(ctx, result.error!);
}

// ─── type ──────────────────────────────────────────────────────────

export function cmdType(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'The syntax of the command is incorrect.';
  const path = args.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);
  const result = ctx.fs.readFile(absPath);
  if (!result.ok) return result.error!;
  return result.content!;
}

// ─── ren / rename ──────────────────────────────────────────────────

export function cmdRen(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length < 2) return 'The syntax of the command is incorrect.';
  const absPath = ctx.fs.normalizePath(args[0], ctx.cwd);
  const newName = args[1];
  const result = ctx.fs.renameEntry(absPath, newName);
  return result.ok ? '' : refuse(ctx, result.error!);
}

// ─── del / erase ───────────────────────────────────────────────────

export function cmdDel(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'The syntax of the command is incorrect.';

  const pathParts: string[] = [];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/s' || lower === '/q' || lower === '/f') continue;
    pathParts.push(arg);
  }
  if (pathParts.length === 0) return 'The syntax of the command is incorrect.';

  const pattern = pathParts.join(' ');

  // Check for wildcard
  if (pattern.includes('*') || pattern.includes('?')) {
    const count = ctx.fs.deleteGlob(ctx.cwd, pattern);
    return count > 0 ? '' : 'Could Not Find ' + pattern;
  }

  const absPath = ctx.fs.normalizePath(pattern, ctx.cwd);
  const result = ctx.fs.deleteFile(absPath);
  if (!result.ok) return result.error!;
  return '';
}

// ─── tree ──────────────────────────────────────────────────────────

export function cmdTree(ctx: WinFileCommandContext, args: string[]): string {
  let files = false;
  let ascii = false;
  const pathArgs: string[] = [];

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/?') return TREE_HELP;
    if (lower === '/f') files = true;
    else if (lower === '/a') ascii = true;
    else pathArgs.push(arg);
  }

  const target = pathArgs.length > 0 ? pathArgs[0] : '.';
  const absPath = ctx.fs.normalizePath(target, ctx.cwd);
  const root = ctx.fs.resolve(absPath);
  if (!root || root.type !== 'directory') return 'Invalid path - ' + absPath;

  const drive = absPath[0];
  const label = ctx.fs.getVolumeLabel(drive);
  const shownPath = pathArgs.length > 0 ? ctx.fs.canonicalPath(absPath).toUpperCase() : `${drive}:.`;
  return [
    treeHeading(label),
    `Volume serial number is ${ctx.fs.getNtfsVolumeSerialNumber(drive)}`,
    shownPath,
    ...treeBody(root, { files, ascii }),
  ].join('\n');
}

// ─── set ───────────────────────────────────────────────────────────

// ─── tasklist ──────────────────────────────────────────────────────

export function cmdTasklist(ctx: WinFileCommandContext): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Image Name                     PID Session Name        Mem Usage');
  lines.push('========================= ======== ================ ===========');

  const processes = [
    ['System Idle Process',     0,  'Services',   8],
    ['System',                  4,  'Services',   144],
    ['smss.exe',               340, 'Services',   1024],
    ['csrss.exe',              472, 'Services',   4608],
    ['wininit.exe',            548, 'Services',   3584],
    ['services.exe',           620, 'Services',   7168],
    ['lsass.exe',              636, 'Services',   10240],
    ['svchost.exe',            784, 'Services',   12288],
    ['svchost.exe',            836, 'Services',   8192],
    ['dwm.exe',               1024, 'Console',    45056],
    ['explorer.exe',          2848, 'Console',    65536],
    ['cmd.exe',               5120, 'Console',    3072],
    ['conhost.exe',           5132, 'Console',    10240],
    ['tasklist.exe',          6200, 'Console',    5120],
  ];

  for (const [name, pid, session, mem] of processes) {
    const nameStr = padToWidth(String(name), 25);
    const pidStr = padToWidth(String(pid), 8, 'right');
    const sessStr = padToWidth(String(session), 16);
    const memStr = (Number(mem) / 1024).toFixed(0) + ' K';
    lines.push(`${nameStr} ${pidStr} ${sessStr} ${padToWidth(memStr, 11, 'right')}`);
  }

  return lines.join('\n');
}

// ─── attrib ───────────────────────────────────────────────────────

export function cmdAttrib(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) {
    return attribList(ctx, ctx.cwd);
  }

  const setAttrs: string[] = [];
  const removeAttrs: string[] = [];
  const pathParts: string[] = [];

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/s' || lower === '/d') continue;
    if (arg.match(/^\+[rahsRAHS]$/)) { setAttrs.push(arg[1].toLowerCase()); continue; }
    if (arg.match(/^-[rahsRAHS]$/)) { removeAttrs.push(arg[1].toLowerCase()); continue; }
    pathParts.push(arg);
  }

  const target = pathParts.join(' ');

  if (setAttrs.length === 0 && removeAttrs.length === 0) {
    const absPath = target ? ctx.fs.normalizePath(target, ctx.cwd) : ctx.cwd;
    if (ctx.fs.isDirectory(absPath)) return attribList(ctx, absPath);
    const entry = ctx.fs.resolve(absPath);
    if (!entry) return 'File not found - ' + target;
    return formatAttrib(entry, absPath);
  }

  if (!target) return 'The syntax of the command is incorrect.';
  const absPath = ctx.fs.normalizePath(target, ctx.cwd);
  const entry = ctx.fs.resolve(absPath);
  if (!entry) return 'File not found - ' + target;

  const attrMap: Record<string, string> = { r: 'readonly', a: 'archive', h: 'hidden', s: 'system' };
  for (const a of setAttrs) { if (attrMap[a]) entry.attributes.add(attrMap[a]); }
  for (const a of removeAttrs) { if (attrMap[a]) entry.attributes.delete(attrMap[a]); }
  return '';
}

function attribList(ctx: WinFileCommandContext, dirPath: string): string {
  const entries = ctx.fs.listDirectory(dirPath);
  const lines: string[] = [];
  for (const { name, entry } of entries) {
    const childPath = dirPath.endsWith('\\') ? dirPath + name : dirPath + '\\' + name;
    lines.push(formatAttrib(entry, childPath));
  }
  return lines.join('\n');
}

function formatAttrib(entry: { attributes: Set<string> }, path: string): string {
  const a = entry.attributes.has('archive') ? 'A' : ' ';
  const s = entry.attributes.has('system') ? 'S' : ' ';
  const h = entry.attributes.has('hidden') ? 'H' : ' ';
  const r = entry.attributes.has('readonly') ? 'R' : ' ';
  return `${a}  ${s}${h}${r}        ${path}`;
}

// ─── find ─────────────────────────────────────────────────────────

export function cmdFind(ctx: WinFileCommandContext, args: string[], stdin?: string): string {
  const parsed = parseFindArguments(args);
  if ('error' in parsed) {
    ctx.setExitCode(2);
    return parsed.error;
  }
  const { options, files } = parsed;

  if (files.length === 0) {
    if (stdin === undefined) {
      ctx.setExitCode(2);
      return 'FIND: Parameter format not correct';
    }
    const { shown, count } = filterFind(textLines(stdin), options);
    ctx.setExitCode(count > 0 ? 0 : 1);
    return options.count ? String(count) : shown.join('\n');
  }

  const lines: string[] = [];
  let matched = 0;
  let unreadable = false;
  for (const file of files) {
    const result = ctx.fs.readFile(ctx.fs.normalizePath(file, ctx.cwd));
    if (!result.ok) { lines.push(`File not found - ${file}`); unreadable = true; continue; }
    lines.push(`---------- ${file.toUpperCase()}`);
    const { shown, count } = filterFind(textLines(result.content!), options);
    matched += count;
    if (options.count) lines.push(`---------- ${file.toUpperCase()}: ${count}`);
    else lines.push(...shown);
  }
  ctx.setExitCode(unreadable ? 2 : matched > 0 ? 0 : 1);
  return lines.join('\n');
}

// ─── findstr ──────────────────────────────────────────────────────

export function cmdFindstr(ctx: WinFileCommandContext, args: string[], stdin?: string): string {
  const parsed = parseFindstrArguments(args);
  if ('error' in parsed) {
    ctx.setExitCode(2);
    return parsed.error;
  }
  const { options, files } = parsed;

  if (files.length === 0) {
    if (stdin === undefined) {
      ctx.setExitCode(2);
      return 'FINDSTR: Wrong number of arguments';
    }
    const selected = filterFindstr(textLines(stdin), options);
    if (selected === null) {
      ctx.setExitCode(2);
      return `FINDSTR: Cannot open ${options.patterns[0]}`;
    }
    ctx.setExitCode(selected.length > 0 ? 0 : 1);
    return selected.join('\n');
  }

  const lines: string[] = [];
  let unreadable = false;
  for (const file of files) {
    const result = ctx.fs.readFile(ctx.fs.normalizePath(file, ctx.cwd));
    if (!result.ok) { lines.push(`FINDSTR: Cannot open ${file}`); unreadable = true; continue; }
    const selected = filterFindstr(textLines(result.content!), options, files.length > 1 ? `${file}:` : '');
    if (selected === null) {
      ctx.setExitCode(2);
      return `FINDSTR: Cannot open ${options.patterns[0]}`;
    }
    lines.push(...selected);
  }
  const shown = lines.filter(line => !line.startsWith('FINDSTR: Cannot open ')).length;
  ctx.setExitCode(unreadable ? 2 : shown > 0 ? 0 : 1);
  return lines.join('\n');
}

// ─── more ─────────────────────────────────────────────────────────

export function cmdMore(ctx: WinFileCommandContext, args: string[], stdin?: string): string {
  if (args.length === 0) return stdin === undefined ? '' : textLines(stdin).join('\n');
  const path = args.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);
  const result = ctx.fs.readFile(absPath);
  if (!result.ok) return `Cannot access file ${path}`;
  return result.content!;
}

// ─── fc (file compare) ───────────────────────────────────────────

export function cmdFc(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length < 2) {
    ctx.setExitCode(-1);
    return 'FC: Insufficient number of file specifications';
  }

  let ignoreCase = false;
  const filePaths: string[] = [];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/n' || lower === '/l' || lower === '/a') continue;
    if (lower === '/c') { ignoreCase = true; continue; }
    filePaths.push(arg);
  }

  if (filePaths.length < 2) {
    ctx.setExitCode(-1);
    return 'FC: Insufficient number of file specifications';
  }

  const absPath1 = ctx.fs.normalizePath(filePaths[0], ctx.cwd);
  const absPath2 = ctx.fs.normalizePath(filePaths[1], ctx.cwd);

  const r1 = ctx.fs.readFile(absPath1);
  if (!r1.ok) {
    ctx.setExitCode(2);
    return `FC: cannot open ${filePaths[0]} - No such file or directory`;
  }
  const r2 = ctx.fs.readFile(absPath2);
  if (!r2.ok) {
    ctx.setExitCode(2);
    return `FC: cannot open ${filePaths[1]} - No such file or directory`;
  }

  const lines1 = r1.content!.split('\n');
  const lines2 = r2.content!.split('\n');

  const lines: string[] = [];
  lines.push(`Comparing files ${filePaths[0].toUpperCase()} and ${filePaths[1].toUpperCase()}`);

  let hasDiff = false;
  const maxLen = Math.max(lines1.length, lines2.length);
  for (let i = 0; i < maxLen; i++) {
    const l1 = i < lines1.length ? lines1[i] : '';
    const l2 = i < lines2.length ? lines2[i] : '';
    const a = ignoreCase ? l1.toLowerCase() : l1;
    const b = ignoreCase ? l2.toLowerCase() : l2;
    if (a !== b) {
      hasDiff = true;
      lines.push(`***** ${filePaths[0].toUpperCase()}`);
      lines.push(l1);
      lines.push(`***** ${filePaths[1].toUpperCase()}`);
      lines.push(l2);
      lines.push('*****');
    }
  }

  if (!hasDiff) lines.push('FC: no differences encountered');
  ctx.setExitCode(hasDiff ? 1 : 0);
  return lines.join('\n');
}

// ─── xcopy ────────────────────────────────────────────────────────

// ─── sort ─────────────────────────────────────────────────────────

export function cmdSort(ctx: WinFileCommandContext, args: string[], stdin?: string): string {
  let reverse = false;
  const filePaths: string[] = [];
  for (const arg of args) {
    if (arg.toLowerCase() === '/r') { reverse = true; continue; }
    filePaths.push(arg);
  }

  let lines: string[];
  if (filePaths.length === 0) {
    if (stdin === undefined) return '';
    lines = textLines(stdin);
  } else {
    const result = ctx.fs.readFile(ctx.fs.normalizePath(filePaths[0], ctx.cwd));
    if (!result.ok) return 'The system cannot find the file specified.';
    lines = textLines(result.content!);
  }
  lines.sort((a, b) => a.localeCompare(b));
  if (reverse) lines.reverse();
  return lines.join('\n');
}
