/**
 * Permission commands: chmod, chown, chgrp, stat, umask, test, mkfifo
 */

import { formatStatTime } from './time/FileTimes';
import { ShellContext, expandGlob, actorOf } from './LinuxFileCommands';
import { INode } from './VirtualFileSystem';
import { gnuOptionSet } from './GnuOptionGuard';
import { shortOptions } from './commands/Getopt';

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

  const actor = actorOf(ctx);

  for (const target of targets) {
    const expanded = expandGlob(ctx, target);
    for (const t of expanded) {
      const absPath = ctx.vfs.normalizePath(t, ctx.cwd);
      const inode = ctx.vfs.resolveInode(absPath, false);
      if (!inode) {
        return `chown: cannot access '${t}': No such file or directory`;
      }
      if (ctx.uid !== 0) {
        if (newUid !== undefined && newUid !== inode.uid) {
          return `chown: changing ownership of '${t}': Operation not permitted`;
        }
        if (newGid !== undefined
            && (inode.uid !== ctx.uid || !(actor.gids ?? []).includes(newGid))) {
          return `chown: changing ownership of '${t}': Operation not permitted`;
        }
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

  const actor = actorOf(ctx);

  for (const target of nonFlags.slice(1)) {
    const absPath = ctx.vfs.normalizePath(target, ctx.cwd);
    const inode = ctx.vfs.resolveInode(absPath, false);
    if (!inode) {
      return `chgrp: cannot access '${target}': No such file or directory`;
    }
    if (ctx.uid !== 0
        && (inode.uid !== ctx.uid || !(actor.gids ?? []).includes(gid))) {
      return `chgrp: changing group of '${target}': Operation not permitted`;
    }
    if (recursive) {
      ctx.vfs.chownRecursive(absPath, -1, gid);
    } else {
      ctx.vfs.chgrp(absPath, gid);
    }
  }

  return '';
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
