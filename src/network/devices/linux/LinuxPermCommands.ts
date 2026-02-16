/**
 * Permission commands: chmod, chown, chgrp, stat, umask, test, mkfifo
 */

import { ShellContext, expandGlob } from './LinuxFileCommands';
import { INode } from './VirtualFileSystem';

export function cmdChmod(ctx: ShellContext, args: string[]): string {
  let recursive = false;
  const nonFlags: string[] = [];

  for (const a of args) {
    if (a === '-R') { recursive = true; continue; }
    nonFlags.push(a);
  }

  if (nonFlags.length < 2) return 'chmod: missing operand';

  const modeStr = nonFlags[0];
  const targets = nonFlags.slice(1);

  for (const target of targets) {
    const expanded = expandGlob(ctx, target);
    for (const t of expanded) {
      const absPath = ctx.vfs.normalizePath(t, ctx.cwd);
      const inode = ctx.vfs.resolveInode(absPath);
      if (!inode) return `chmod: cannot access '${t}': No such file or directory`;

      const newMode = parseChmodMode(modeStr, inode.permissions);
      if (newMode === null) return `chmod: invalid mode: '${modeStr}'`;

      ctx.vfs.chmod(absPath, newMode);

      if (recursive && inode.type === 'directory') {
        chmodRecursive(ctx, absPath, modeStr);
      }
    }
  }

  return '';
}

function chmodRecursive(ctx: ShellContext, path: string, modeStr: string): void {
  const entries = ctx.vfs.listDirectory(path);
  if (!entries) return;
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const childPath = path + '/' + e.name;
    const newMode = parseChmodMode(modeStr, e.inode.permissions);
    if (newMode !== null) ctx.vfs.chmod(childPath, newMode);
    if (e.inode.type === 'directory') chmodRecursive(ctx, childPath, modeStr);
  }
}

function parseChmodMode(modeStr: string, current: number): number | null {
  // Octal mode: 755, 4755, 2755, etc.
  if (/^\d{3,4}$/.test(modeStr)) {
    return parseInt(modeStr, 8);
  }

  // Symbolic mode: u+x, g-w, o=r, a+x, u+s, g+s, +t, u+w,g-w,o=r
  let mode = current;
  const parts = modeStr.split(',');

  for (const part of parts) {
    const match = part.match(/^([ugoa]*)([+\-=])([rwxstXugo]*)$/);
    if (!match) return null;

    let who = match[1] || 'a';
    const op = match[2];
    const perms = match[3];

    // Expand 'a' to 'ugo'
    if (who === 'a' || who === '') who = 'ugo';

    let bits = 0;
    let specialBits = 0;

    for (const p of perms) {
      switch (p) {
        case 'r': bits |= 4; break;
        case 'w': bits |= 2; break;
        case 'x': bits |= 1; break;
        case 's':
          if (who.includes('u')) specialBits |= 0o4000;
          if (who.includes('g')) specialBits |= 0o2000;
          break;
        case 't':
          specialBits |= 0o1000;
          break;
      }
    }

    for (const w of who) {
      let shift: number;
      switch (w) {
        case 'u': shift = 6; break;
        case 'g': shift = 3; break;
        case 'o': shift = 0; break;
        default: continue;
      }

      const shiftedBits = bits << shift;

      switch (op) {
        case '+':
          mode |= shiftedBits;
          break;
        case '-':
          mode &= ~shiftedBits;
          break;
        case '=':
          // Clear the 3 bits for this category, then set
          mode &= ~(7 << shift);
          mode |= shiftedBits;
          break;
      }
    }

    // Apply special bits
    if (specialBits) {
      if (op === '+') mode |= specialBits;
      else if (op === '-') mode &= ~specialBits;
    }
  }

  return mode;
}

export function cmdChown(ctx: ShellContext, args: string[]): string {
  let recursive = false;
  const nonFlags: string[] = [];

  for (const a of args) {
    if (a === '-R') { recursive = true; continue; }
    if (a.startsWith('-')) continue;
    nonFlags.push(a);
  }

  if (nonFlags.length < 2) return 'chown: missing operand';

  const ownerSpec = nonFlags[0];
  const targets = nonFlags.slice(1);

  let newUid: number | undefined;
  let newGid: number | undefined;

  if (ownerSpec.includes(':')) {
    const [userPart, groupPart] = ownerSpec.split(':');
    if (userPart) newUid = ctx.userMgr.resolveUid(userPart);
    if (groupPart) newGid = ctx.userMgr.resolveGid(groupPart);
  } else {
    newUid = ctx.userMgr.resolveUid(ownerSpec);
  }

  for (const target of targets) {
    const expanded = expandGlob(ctx, target);
    for (const t of expanded) {
      const absPath = ctx.vfs.normalizePath(t, ctx.cwd);
      if (!ctx.vfs.exists(absPath)) {
        return `chown: cannot access '${t}': No such file or directory`;
      }

      if (recursive) {
        ctx.vfs.chownRecursive(absPath, newUid ?? ctx.uid, newGid);
      } else {
        ctx.vfs.chown(absPath, newUid ?? ctx.uid, newGid);
      }
    }
  }

  return '';
}

export function cmdChgrp(ctx: ShellContext, args: string[]): string {
  let recursive = false;
  const nonFlags: string[] = [];

  for (const a of args) {
    if (a === '-R') { recursive = true; continue; }
    if (a.startsWith('-')) continue;
    nonFlags.push(a);
  }

  if (nonFlags.length < 2) return 'chgrp: missing operand';

  const groupName = nonFlags[0];
  const gid = ctx.userMgr.resolveGid(groupName);
  if (gid < 0) return `chgrp: invalid group: '${groupName}'`;

  for (const target of nonFlags.slice(1)) {
    const absPath = ctx.vfs.normalizePath(target, ctx.cwd);
    if (!ctx.vfs.exists(absPath)) {
      return `chgrp: cannot access '${target}': No such file or directory`;
    }
    if (recursive) {
      ctx.vfs.chownRecursive(absPath, -1, gid);
    } else {
      ctx.vfs.chgrp(absPath, gid);
    }
  }

  return '';
}

export function cmdStat(ctx: ShellContext, args: string[]): string {
  let formatStr: string | undefined;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '--format') {
      formatStr = args[++i];
      continue;
    }
    if (!a.startsWith('-')) files.push(a);
  }

  if (files.length === 0) return 'stat: missing operand';

  const results: string[] = [];

  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const inode = ctx.vfs.resolveInode(absPath);
    if (!inode) return `stat: cannot stat '${f}': No such file or directory`;

    if (formatStr) {
      results.push(formatStat(formatStr, f, inode, ctx));
    } else {
      results.push(fullStat(f, inode, ctx));
    }
  }

  return results.join('\n');
}

function formatStat(fmt: string, name: string, inode: INode, ctx: ShellContext): string {
  const owner = ctx.userMgr.uidToName(inode.uid);
  const group = ctx.userMgr.gidToName(inode.gid);
  const octal = ctx.vfs.formatOctalPermissions(inode);

  return fmt
    .replace(/%n/g, name)
    .replace(/%U/g, owner)
    .replace(/%G/g, group)
    .replace(/%a/g, octal)
    .replace(/%i/g, inode.id.toString())
    .replace(/%s/g, inode.size.toString())
    .replace(/%h/g, inode.linkCount.toString())
    .replace(/%F/g, inode.type === 'file' ? 'regular file' : inode.type)
    .replace(/%A/g, ctx.vfs.formatPermissions(inode));
}

function fullStat(name: string, inode: INode, ctx: ShellContext): string {
  const owner = ctx.userMgr.uidToName(inode.uid);
  const group = ctx.userMgr.gidToName(inode.gid);
  const octal = ctx.vfs.formatOctalPermissions(inode);
  const perms = ctx.vfs.formatPermissions(inode);
  const typeStr = inode.type === 'file' ? 'regular file' : inode.type;
  const access = new Date(inode.atime).toISOString();
  const modify = new Date(inode.mtime).toISOString();
  const change = new Date(inode.ctime).toISOString();

  return [
    `  File: ${name}`,
    `  Size: ${inode.size}\tBlocks: ${Math.ceil(inode.size / 512) * 8}\tIO Block: 4096\t${typeStr}`,
    `Device: 0h/0d\tInode: ${inode.id}\tLinks: ${inode.linkCount}`,
    `Access: (${octal}/${perms})  Uid: ( ${inode.uid}/ ${owner})   Gid: ( ${inode.gid}/ ${group})`,
    `Access: ${access}`,
    `Modify: ${modify}`,
    `Change: ${change}`,
  ].join('\n');
}

export function cmdUmask(ctx: ShellContext, args: string[]): { output: string; newUmask?: number } {
  if (args.length === 0) {
    return { output: ctx.umask.toString(8).padStart(4, '0') };
  }
  const newUmask = parseInt(args[0], 8);
  if (isNaN(newUmask)) return { output: `umask: ${args[0]}: invalid octal number` };
  return { output: '', newUmask };
}

export function cmdTest(ctx: ShellContext, args: string[]): { success: boolean } {
  if (args.length === 0) return { success: false };

  const flag = args[0];
  const target = args[1];

  if (!target) return { success: false };

  const absPath = ctx.vfs.normalizePath(target, ctx.cwd);

  switch (flag) {
    case '-f': return { success: ctx.vfs.getType(absPath) === 'file' };
    case '-d': return { success: ctx.vfs.getType(absPath) === 'directory' };
    case '-e': return { success: ctx.vfs.exists(absPath) };
    case '-L': return { success: ctx.vfs.getType(absPath, false) === 'symlink' };
    case '-r': {
      const inode = ctx.vfs.resolveInode(absPath);
      if (!inode) return { success: false };
      return { success: hasPermission(inode, ctx.uid, ctx.gid, 'r') };
    }
    case '-w': {
      const inode = ctx.vfs.resolveInode(absPath);
      if (!inode) return { success: false };
      return { success: hasPermission(inode, ctx.uid, ctx.gid, 'w') };
    }
    case '-x': {
      const inode = ctx.vfs.resolveInode(absPath);
      if (!inode) return { success: false };
      return { success: hasPermission(inode, ctx.uid, ctx.gid, 'x') };
    }
    case '-s': {
      const inode = ctx.vfs.resolveInode(absPath);
      return { success: !!inode && inode.size > 0 };
    }
    default: return { success: false };
  }
}

function hasPermission(inode: INode, uid: number, gid: number, perm: 'r' | 'w' | 'x'): boolean {
  if (uid === 0) return perm !== 'x' || (inode.permissions & 0o111) !== 0; // root can read/write anything

  const permBit = perm === 'r' ? 4 : perm === 'w' ? 2 : 1;

  if (inode.uid === uid) {
    return ((inode.permissions >> 6) & permBit) !== 0;
  }
  if (inode.gid === gid) {
    return ((inode.permissions >> 3) & permBit) !== 0;
  }
  return (inode.permissions & permBit) !== 0;
}

export function cmdMkfifo(ctx: ShellContext, args: string[]): string {
  for (const a of args) {
    if (a.startsWith('-')) continue;
    const absPath = ctx.vfs.normalizePath(a, ctx.cwd);
    const perms = 0o666 & ~ctx.umask;
    if (!ctx.vfs.createFifo(absPath, perms, ctx.uid, ctx.gid)) {
      return `mkfifo: cannot create fifo '${a}'`;
    }
  }
  return '';
}
