/**
 * File operation commands: touch, ls, cat, cp, mv, rm, mkdir, rmdir, ln, echo, pwd, cd, tee
 */

import { VirtualFileSystem, INode } from './VirtualFileSystem';
import { LinuxUserManager } from './LinuxUserManager';
import { interpretEscapes } from './LinuxShellParser';

export interface ShellContext {
  vfs: VirtualFileSystem;
  userMgr: LinuxUserManager;
  cwd: string;
  umask: number;
  uid: number;
  gid: number;
}

export function cmdTouch(ctx: ShellContext, args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const path = ctx.vfs.normalizePath(arg, ctx.cwd);
    ctx.vfs.touch(path, ctx.uid, ctx.gid, ctx.umask);
  }
  return '';
}

export function cmdLs(ctx: ShellContext, args: string[]): string {
  let longFormat = false;
  let showAll = false;
  let showInode = false;
  let sortBySize = false;
  let sortByTime = false;
  let recursive = false;
  let dirOnly = false;
  const paths: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('-') && !arg.startsWith('--')) {
      const flags = arg.slice(1);
      for (const f of flags) {
        switch (f) {
          case 'l': longFormat = true; break;
          case 'a': showAll = true; break;
          case 'i': showInode = true; break;
          case 'S': sortBySize = true; break;
          case 't': sortByTime = true; break;
          case 'R': recursive = true; break;
          case 'd': dirOnly = true; break;
        }
      }
    } else if (arg.startsWith('--')) {
      // ignore --color=auto etc
    } else {
      paths.push(arg);
    }
  }

  if (paths.length === 0) paths.push('.');

  const allOutput: string[] = [];

  for (const rawPath of paths) {
    // Glob expansion
    const expandedPaths = expandGlob(ctx, rawPath);

    for (const p of expandedPaths) {
      const absPath = ctx.vfs.normalizePath(p, ctx.cwd);
      const inode = ctx.vfs.resolveInode(absPath, false);

      if (!inode) {
        allOutput.push(`ls: cannot access '${p}': No such file or directory`);
        continue;
      }

      if (inode.type !== 'directory' || dirOnly) {
        // Show single file/dir entry
        allOutput.push(formatEntry(ctx, p, inode, absPath, longFormat, showInode));
      } else {
        const result = listDir(ctx, absPath, p, longFormat, showAll, showInode, sortBySize, sortByTime, recursive);
        allOutput.push(result);
      }
    }
  }

  return allOutput.join('\n').trimEnd();
}

function listDir(ctx: ShellContext, absPath: string, displayPath: string,
  longFormat: boolean, showAll: boolean, showInode: boolean,
  sortBySize: boolean, sortByTime: boolean, recursive: boolean): string {
  const entries = ctx.vfs.listDirectory(absPath);
  if (!entries) return `ls: cannot access '${displayPath}': No such file or directory`;

  let filtered = entries.filter(e => showAll || !e.name.startsWith('.'));

  // Sort
  if (sortBySize) {
    filtered.sort((a, b) => b.inode.size - a.inode.size);
  } else if (sortByTime) {
    filtered.sort((a, b) => b.inode.mtime - a.inode.mtime);
  } else {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  const lines: string[] = [];

  if (recursive) {
    lines.push(`${displayPath}:`);
  }

  for (const entry of filtered) {
    if (!showAll && (entry.name === '.' || entry.name === '..')) continue;
    const childPath = absPath === '/' ? '/' + entry.name : absPath + '/' + entry.name;
    lines.push(formatEntry(ctx, entry.name, entry.inode, childPath, longFormat, showInode));
  }

  if (recursive) {
    for (const entry of filtered) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (entry.inode.type === 'directory') {
        const childPath = absPath === '/' ? '/' + entry.name : absPath + '/' + entry.name;
        const childDisplay = displayPath === '.' ? entry.name : displayPath + '/' + entry.name;
        lines.push('');
        lines.push(listDir(ctx, childPath, childDisplay, longFormat, showAll, showInode, sortBySize, sortByTime, recursive));
      }
    }
  }

  return lines.join('\n');
}

function formatEntry(ctx: ShellContext, name: string, inode: INode, absPath: string,
  longFormat: boolean, showInode: boolean): string {
  let line = '';

  if (showInode) {
    line += `${inode.id} `;
  }

  if (longFormat) {
    const perms = ctx.vfs.formatPermissions(inode);
    const owner = ctx.userMgr.uidToName(inode.uid);
    const group = ctx.userMgr.gidToName(inode.gid);
    const size = inode.size;
    const date = new Date(inode.mtime);
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dateStr = `${monthNames[date.getMonth()]} ${date.getDate().toString().padStart(2)} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

    line += `${perms} ${inode.linkCount} ${owner} ${group} ${size.toString().padStart(5)} ${dateStr} ${name}`;

    // Symlink target
    if (inode.type === 'symlink') {
      line += ` -> ${inode.target}`;
    }
  } else {
    line += name;
  }

  return line;
}

export function cmdCat(ctx: ShellContext, args: string[]): string {
  const outputs: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const path = ctx.vfs.normalizePath(arg, ctx.cwd);
    const content = ctx.vfs.readFile(path);
    if (content === null) {
      return `cat: ${arg}: No such file or directory`;
    }
    outputs.push(content);
  }
  // Remove trailing newline (cat output doesn't add extra newline)
  let result = outputs.join('');
  if (result.endsWith('\n')) result = result.slice(0, -1);
  return result;
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

export function cmdCp(ctx: ShellContext, args: string[]): string {
  const nonFlags = args.filter(a => !a.startsWith('-'));
  if (nonFlags.length < 2) return 'cp: missing operand';
  const src = ctx.vfs.normalizePath(nonFlags[0], ctx.cwd);
  const dst = ctx.vfs.normalizePath(nonFlags[1], ctx.cwd);
  if (!ctx.vfs.copy(src, dst, ctx.uid, ctx.gid, ctx.umask)) {
    return `cp: cannot copy '${nonFlags[0]}' to '${nonFlags[1]}'`;
  }
  return '';
}

export function cmdMv(ctx: ShellContext, args: string[]): string {
  const nonFlags = args.filter(a => !a.startsWith('-'));
  if (nonFlags.length < 2) return 'mv: missing operand';
  const src = ctx.vfs.normalizePath(nonFlags[0], ctx.cwd);
  const dst = ctx.vfs.normalizePath(nonFlags[1], ctx.cwd);
  if (!ctx.vfs.rename(src, dst)) {
    return `mv: cannot move '${nonFlags[0]}' to '${nonFlags[1]}'`;
  }
  return '';
}

export function cmdRm(ctx: ShellContext, args: string[]): string {
  let recursive = false;
  let force = false;
  const paths: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (arg.includes('r') || arg.includes('R')) recursive = true;
      if (arg.includes('f')) force = true;
    } else {
      paths.push(arg);
    }
  }

  for (const p of paths) {
    // Expand globs
    const expanded = expandGlob(ctx, p);
    for (const ep of expanded) {
      const absPath = ctx.vfs.normalizePath(ep, ctx.cwd);
      const inode = ctx.vfs.resolveInode(absPath, false);
      if (!inode) {
        if (!force) return `rm: cannot remove '${ep}': No such file or directory`;
        continue;
      }
      if (inode.type === 'directory') {
        if (recursive) {
          ctx.vfs.rmrf(absPath);
        } else {
          return `rm: cannot remove '${ep}': Is a directory`;
        }
      } else {
        ctx.vfs.deleteFile(absPath);
      }
    }
  }
  return '';
}

export function cmdMkdir(ctx: ShellContext, args: string[]): string {
  let parents = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === '-p') { parents = true; continue; }
    if (arg.startsWith('-')) continue;
    paths.push(arg);
  }

  for (const p of paths) {
    const absPath = ctx.vfs.normalizePath(p, ctx.cwd);
    const perms = 0o777 & ~ctx.umask;
    if (parents) {
      ctx.vfs.mkdirp(absPath, perms, ctx.uid, ctx.gid);
    } else {
      if (!ctx.vfs.mkdir(absPath, perms, ctx.uid, ctx.gid)) {
        return `mkdir: cannot create directory '${p}'`;
      }
    }
  }
  return '';
}

export function cmdRmdir(ctx: ShellContext, args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const absPath = ctx.vfs.normalizePath(arg, ctx.cwd);
    if (!ctx.vfs.rmdir(absPath)) {
      return `rmdir: failed to remove '${arg}'`;
    }
  }
  return '';
}

export function cmdLn(ctx: ShellContext, args: string[]): string {
  let symbolic = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === '-s') { symbolic = true; continue; }
    if (arg.startsWith('-')) continue;
    paths.push(arg);
  }
  if (paths.length < 2) return 'ln: missing operand';

  const target = paths[0];
  const linkPath = ctx.vfs.normalizePath(paths[1], ctx.cwd);

  if (symbolic) {
    if (!ctx.vfs.createSymlink(linkPath, target, ctx.uid, ctx.gid)) {
      return `ln: failed to create symbolic link '${paths[1]}'`;
    }
  } else {
    const absTarget = ctx.vfs.normalizePath(target, ctx.cwd);
    if (!ctx.vfs.createHardLink(linkPath, absTarget)) {
      return `ln: failed to create hard link '${paths[1]}'`;
    }
  }
  return '';
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
  if (!pattern.includes('*') && !pattern.includes('?')) return [pattern];

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
