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

/** Context provided to all Windows file command modules */
export interface WinFileCommandContext {
  fs: WindowsFileSystem;
  cwd: string;
  hostname: string;
  env: Map<string, string>;
  setCwd(path: string): void;
}

// ─── cd / chdir ────────────────────────────────────────────────────

export function cmdCd(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) {
    return ctx.cwd;
  }

  // Handle /d flag (change drive)
  let path: string;
  if (args[0].toLowerCase() === '/d' && args.length > 1) {
    path = args.slice(1).join(' ');
  } else {
    path = args.join(' ');
  }

  const absPath = ctx.fs.normalizePath(path, ctx.cwd);
  if (!ctx.fs.isDirectory(absPath)) {
    return 'The system cannot find the path specified.';
  }
  ctx.setCwd(absPath);
  return '';
}

// ─── mkdir / md ────────────────────────────────────────────────────

export function cmdMkdir(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'The syntax of the command is incorrect.';
  const path = args.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);

  // mkdir in Windows creates intermediate directories automatically
  if (ctx.fs.exists(absPath)) {
    return `A subdirectory or file ${path} already exists.`;
  }
  ctx.fs.mkdirp(absPath);
  return '';
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
    if (!result.ok) return result.error!;
    return '';
  }

  const result = ctx.fs.rmdir(absPath);
  if (!result.ok) return result.error!;
  return '';
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

// ─── copy ──────────────────────────────────────────────────────────

export function cmdCopy(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length < 2) return 'The syntax of the command is incorrect.';
  const src = ctx.fs.normalizePath(args[0], ctx.cwd);
  const dest = ctx.fs.normalizePath(args[1], ctx.cwd);
  const result = ctx.fs.copyFile(src, dest);
  if (!result.ok) return result.error!;
  return '        1 file(s) copied.';
}

// ─── move ──────────────────────────────────────────────────────────

export function cmdMove(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length < 2) return 'The syntax of the command is incorrect.';
  const src = ctx.fs.normalizePath(args[0], ctx.cwd);
  const dest = ctx.fs.normalizePath(args[1], ctx.cwd);
  const result = ctx.fs.moveFile(src, dest);
  if (!result.ok) return result.error!;
  return '        1 file(s) moved.';
}

// ─── ren / rename ──────────────────────────────────────────────────

export function cmdRen(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length < 2) return 'The syntax of the command is incorrect.';
  const absPath = ctx.fs.normalizePath(args[0], ctx.cwd);
  const newName = args[1];
  const result = ctx.fs.renameEntry(absPath, newName);
  if (!result.ok) return result.error!;
  return '';
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
  let showFiles = false;
  const pathArgs: string[] = [];

  for (const arg of args) {
    if (arg.toLowerCase() === '/f') {
      showFiles = true;
    } else if (arg.toLowerCase() === '/a') {
      // ASCII mode - already default in our implementation
    } else {
      pathArgs.push(arg);
    }
  }

  const target = pathArgs.length > 0 ? pathArgs[0] : '.';
  const absPath = ctx.fs.normalizePath(target, ctx.cwd);
  return ctx.fs.tree(absPath, showFiles);
}

// ─── set ───────────────────────────────────────────────────────────

export function cmdSet(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) {
    // Show all env vars
    const lines: string[] = [];
    const sorted = Array.from(ctx.env.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [key, value] of sorted) {
      lines.push(`${key}=${value}`);
    }
    return lines.join('\n');
  }

  const full = args.join(' ');
  const eqIndex = full.indexOf('=');
  if (eqIndex === -1) {
    // Filter by prefix
    const prefix = full.toUpperCase();
    const lines: string[] = [];
    const sorted = Array.from(ctx.env.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [key, value] of sorted) {
      if (key.toUpperCase().startsWith(prefix)) {
        lines.push(`${key}=${value}`);
      }
    }
    if (lines.length === 0) return `Environment variable ${full} not defined`;
    return lines.join('\n');
  }

  // Set new variable
  const name = full.substring(0, eqIndex).trim();
  const value = full.substring(eqIndex + 1);
  ctx.env.set(name.toUpperCase(), value);
  return '';
}

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
    const nameStr = String(name).padEnd(25);
    const pidStr = String(pid).padStart(8);
    const sessStr = String(session).padEnd(16);
    const memStr = (Number(mem) / 1024).toFixed(0) + ' K';
    lines.push(`${nameStr} ${pidStr} ${sessStr} ${memStr.padStart(11)}`);
  }

  return lines.join('\n');
}

// ─── netstat ───────────────────────────────────────────────────────

export function cmdNetstat(ctx: WinFileCommandContext): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Active Connections');
  lines.push('');
  lines.push('  Proto  Local Address          Foreign Address        State');
  // No active connections in a fresh system
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

export function cmdFind(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'FIND: Parameter format not correct';

  let ignoreCase = false;
  let countOnly = false;
  let invertMatch = false;
  let showLineNumbers = false;
  let searchString = '';
  const filePaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const lower = args[i].toLowerCase();
    if (lower === '/i') { ignoreCase = true; continue; }
    if (lower === '/c') { countOnly = true; continue; }
    if (lower === '/v') { invertMatch = true; continue; }
    if (lower === '/n') { showLineNumbers = true; continue; }
    if (!searchString && args[i].startsWith('"')) {
      let str = args[i].substring(1);
      while (i < args.length - 1 && !str.endsWith('"')) {
        i++;
        str += ' ' + args[i];
      }
      if (str.endsWith('"')) str = str.slice(0, -1);
      searchString = str;
      continue;
    }
    if (!searchString) { searchString = args[i]; continue; }
    filePaths.push(args[i]);
  }

  if (!searchString) return 'FIND: Parameter format not correct';
  if (filePaths.length === 0) return 'FIND: Parameter format not correct';

  const lines: string[] = [];
  for (const fp of filePaths) {
    const absPath = ctx.fs.normalizePath(fp, ctx.cwd);
    const result = ctx.fs.readFile(absPath);
    if (!result.ok) { lines.push(`File not found - ${fp}`); continue; }

    lines.push(`---------- ${fp.toUpperCase()}`);
    const fileLines = result.content!.split('\n');
    let count = 0;

    for (let n = 0; n < fileLines.length; n++) {
      const line = fileLines[n];
      const haystack = ignoreCase ? line.toLowerCase() : line;
      const needle = ignoreCase ? searchString.toLowerCase() : searchString;
      const found = haystack.includes(needle);
      const match = invertMatch ? !found : found;
      if (match) {
        count++;
        if (!countOnly) {
          lines.push(showLineNumbers ? `[${n + 1}]${line}` : line);
        }
      }
    }
    if (countOnly) lines.push(`---------- ${fp.toUpperCase()}: ${count}`);
  }
  return lines.join('\n');
}

// ─── findstr ──────────────────────────────────────────────────────

export function cmdFindstr(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'FINDSTR: Wrong number of arguments';

  let ignoreCase = false;
  let useRegex = false;
  let showLineNumbers = false;
  let invertMatch = false;
  let searchPattern = '';
  const filePaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const lower = args[i].toLowerCase();
    if (lower === '/i') { ignoreCase = true; continue; }
    if (lower === '/r') { useRegex = true; continue; }
    if (lower === '/n') { showLineNumbers = true; continue; }
    if (lower === '/v') { invertMatch = true; continue; }
    if (lower === '/l') { useRegex = false; continue; }
    if (!searchPattern && args[i].startsWith('"')) {
      let str = args[i].substring(1);
      while (i < args.length - 1 && !str.endsWith('"')) {
        i++;
        str += ' ' + args[i];
      }
      if (str.endsWith('"')) str = str.slice(0, -1);
      searchPattern = str;
      continue;
    }
    if (!searchPattern) { searchPattern = args[i]; continue; }
    filePaths.push(args[i]);
  }

  if (!searchPattern) return 'FINDSTR: Wrong number of arguments';
  if (filePaths.length === 0) return 'FINDSTR: Wrong number of arguments';

  const flags = ignoreCase ? 'i' : '';
  let regex: RegExp;
  try {
    regex = useRegex
      ? new RegExp(searchPattern, flags)
      : new RegExp(searchPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch {
    return `FINDSTR: Cannot open ${searchPattern}`;
  }

  const lines: string[] = [];
  for (const fp of filePaths) {
    const absPath = ctx.fs.normalizePath(fp, ctx.cwd);
    const result = ctx.fs.readFile(absPath);
    if (!result.ok) continue;

    const fileLines = result.content!.split('\n');
    for (let n = 0; n < fileLines.length; n++) {
      const line = fileLines[n];
      const found = regex.test(line);
      const match = invertMatch ? !found : found;
      if (match) {
        const prefix = filePaths.length > 1 ? `${fp}:` : '';
        const lineNum = showLineNumbers ? `${n + 1}:` : '';
        lines.push(`${prefix}${lineNum}${line}`);
      }
    }
  }
  return lines.join('\n');
}

// ─── where ────────────────────────────────────────────────────────

export function cmdWhere(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'ERROR: A pattern must be specified.';

  const patterns: string[] = [];
  for (const arg of args) {
    if (arg.toLowerCase() === '/r') continue;
    patterns.push(arg);
  }
  if (patterns.length === 0) return 'ERROR: A pattern must be specified.';

  const pattern = patterns[0];
  const searchDirs = [ctx.cwd];
  const pathVar = ctx.env.get('PATH') || '';
  if (pathVar) {
    for (const dir of pathVar.split(';')) {
      if (dir.trim()) searchDirs.push(dir.trim());
    }
  }

  const results: string[] = [];
  for (const dir of searchDirs) {
    if (!ctx.fs.isDirectory(dir)) continue;
    const entries = ctx.fs.listDirectory(dir);
    for (const { name, entry } of entries) {
      if (entry.type !== 'file') continue;
      if (matchPattern(name, pattern)) {
        results.push(dir.endsWith('\\') ? dir + name : dir + '\\' + name);
      }
    }
  }

  if (results.length === 0) return 'INFO: Could not find files for the given pattern(s).';
  return results.join('\n');
}

function matchPattern(name: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + regex + '$', 'i').test(name);
}

// ─── more ─────────────────────────────────────────────────────────

export function cmdMore(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return '';
  const path = args.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);
  const result = ctx.fs.readFile(absPath);
  if (!result.ok) return `Cannot access file ${path}`;
  return result.content!;
}

// ─── fc (file compare) ───────────────────────────────────────────

export function cmdFc(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length < 2) return 'FC: Insufficient number of file specifications';

  let ignoreCase = false;
  const filePaths: string[] = [];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/n' || lower === '/l' || lower === '/a') continue;
    if (lower === '/c') { ignoreCase = true; continue; }
    filePaths.push(arg);
  }

  if (filePaths.length < 2) return 'FC: Insufficient number of file specifications';

  const absPath1 = ctx.fs.normalizePath(filePaths[0], ctx.cwd);
  const absPath2 = ctx.fs.normalizePath(filePaths[1], ctx.cwd);

  const r1 = ctx.fs.readFile(absPath1);
  if (!r1.ok) return `FC: cannot open ${filePaths[0]} - No such file or directory`;
  const r2 = ctx.fs.readFile(absPath2);
  if (!r2.ok) return `FC: cannot open ${filePaths[1]} - No such file or directory`;

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
  return lines.join('\n');
}

// ─── xcopy ────────────────────────────────────────────────────────

export function cmdXcopy(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length < 2) return 'Invalid number of parameters';

  let recursive = false;
  const pathParts: string[] = [];

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/s') { recursive = true; continue; }
    if (lower === '/e') { recursive = true; continue; }
    if (lower === '/y' || lower === '/i' || lower === '/q' || lower === '/h') continue;
    pathParts.push(arg);
  }

  if (pathParts.length < 2) return 'Invalid number of parameters';

  const srcPath = ctx.fs.normalizePath(pathParts[0], ctx.cwd);
  const destPath = ctx.fs.normalizePath(pathParts[1], ctx.cwd);

  if (!ctx.fs.exists(srcPath)) return `File not found - ${pathParts[0]}`;

  if (ctx.fs.isFile(srcPath)) {
    const result = ctx.fs.copyFile(srcPath, destPath);
    if (!result.ok) return result.error!;
    return '1 File(s) copied';
  }

  if (!ctx.fs.isDirectory(srcPath)) return `File not found - ${pathParts[0]}`;

  ctx.fs.mkdirp(destPath);
  const count = xcopyDir(ctx, srcPath, destPath, recursive);
  return `${count} File(s) copied`;
}

function xcopyDir(ctx: WinFileCommandContext, src: string, dest: string, recursive: boolean): number {
  const entries = ctx.fs.listDirectory(src);
  let count = 0;
  for (const { name, entry } of entries) {
    const srcChild = src + '\\' + name;
    const destChild = dest + '\\' + name;
    if (entry.type === 'file') {
      ctx.fs.copyFile(srcChild, destChild);
      count++;
    } else if (entry.type === 'directory' && recursive) {
      ctx.fs.mkdirp(destChild);
      count += xcopyDir(ctx, srcChild, destChild, recursive);
    }
  }
  return count;
}

// ─── sort ─────────────────────────────────────────────────────────

export function cmdSort(ctx: WinFileCommandContext, args: string[]): string {
  let reverse = false;
  const filePaths: string[] = [];
  for (const arg of args) {
    if (arg.toLowerCase() === '/r') { reverse = true; continue; }
    filePaths.push(arg);
  }
  if (filePaths.length === 0) return '';

  const absPath = ctx.fs.normalizePath(filePaths[0], ctx.cwd);
  const result = ctx.fs.readFile(absPath);
  if (!result.ok) return 'The system cannot find the file specified.';

  const lines = result.content!.split('\n');
  lines.sort((a, b) => a.localeCompare(b));
  if (reverse) lines.reverse();
  return lines.join('\n');
}
