/**
 * File operation commands: touch, ls, cat, cp, mv, rm, mkdir, rmdir, ln, echo, pwd, cd, tee
 */

import { VirtualFileSystem, INode } from './VirtualFileSystem';
import { LinuxUserManager } from './LinuxUserManager';
import { interpretEscapes } from './LinuxShellParser';
import type { PathActor } from './VfsPath';

export function actorOf(ctx: ShellContext): PathActor {
  const groups = ctx.userMgr.getUserGroups(ctx.userMgr.currentUser) ?? [];
  return {
    uid: ctx.uid,
    gid: ctx.gid,
    gids: groups.map((g) => g.gid),
    user: ctx.userMgr.currentUser,
    groupNames: groups.map((g) => g.name),
  };
}

// ANSI color codes matching GNU ls defaults (LS_COLORS)
const C = {
  RESET: '\x1b[0m',
  BOLD_BLUE: '\x1b[1;34m',    // directories
  BOLD_CYAN: '\x1b[1;36m',    // symlinks
  BOLD_GREEN: '\x1b[1;32m',   // executables
  BOLD_YELLOW: '\x1b[1;33m',  // FIFOs (named pipes)
  BOLD_YELBG: '\x1b[30;43m',  // sticky + other-writable dirs
  BOLD_BLUEBG: '\x1b[34;42m', // other-writable dirs (no sticky)
  BOLD_GREENBG: '\x1b[37;42m',// sticky dirs (not other-writable)
  CHARDEV: '\x1b[1;33m',      // character devices (bold yellow)
};

export interface ShellContext {
  vfs: VirtualFileSystem;
  userMgr: LinuxUserManager;
  cwd: string;
  umask: number;
  uid: number;
  gid: number;
  color?: boolean;
}



export function cmdEcho(ctx: ShellContext, args: string[]): string {
  let interpretEsc = false;
  let noNewline = false;
  const textParts: string[] = [];

  for (const arg of args) {
    if (arg === '-e' && textParts.length === 0) { interpretEsc = true; continue; }
    if (arg === '-n' && textParts.length === 0) { noNewline = true; continue; }
    textParts.push(arg);
  }

  let text = textParts.join(' ');
  if (interpretEsc) {
    text = interpretEscapes(text);
  }
  return text;
}


export function cmdPwd(ctx: ShellContext): string {
  return ctx.cwd;
}

export function cmdTee(ctx: ShellContext, args: string[], stdin: string): string {
  let append = false;
  const files: string[] = [];
  for (const arg of args) {
    if (arg === '-a') { append = true; continue; }
    if (arg.startsWith('-')) continue;
    files.push(arg);
  }

  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    ctx.vfs.writeFile(absPath, stdin + '\n', ctx.uid, ctx.gid, ctx.umask, append);
  }

  return stdin;
}

// ─── Glob expansion helper ─────────────────────────────────────────

export function expandGlob(ctx: ShellContext, pattern: string): string[] {
  if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[')) return [pattern];

  const absPattern = ctx.vfs.normalizePath(pattern, ctx.cwd);
  const expanded = ctx.vfs.globExpand(pattern, ctx.cwd);
  if (expanded.length === 0) return [pattern]; // No match, return literal

  // Return relative paths if input was relative
  if (!pattern.startsWith('/')) {
    const cwdPrefix = ctx.cwd === '/' ? '/' : ctx.cwd + '/';
    return expanded.map(p => p.startsWith(cwdPrefix) ? p.slice(cwdPrefix.length) : p);
  }

  return expanded;
}
