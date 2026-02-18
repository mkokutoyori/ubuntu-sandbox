/**
 * Windows file command context and file operation commands.
 *
 * Context interface for file commands (extends WinCommandContext concept
 * but specifically for filesystem operations).
 *
 * Commands: type, copy, move, ren/rename, del/erase, echo (with redirect),
 *           mkdir/md, rmdir/rd, cd/chdir, cls, tree, set
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
  const target = args.length > 0 ? args[0] : '.';
  const absPath = ctx.fs.normalizePath(target, ctx.cwd);
  return ctx.fs.tree(absPath);
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
