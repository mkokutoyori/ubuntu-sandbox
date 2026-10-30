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

export function cmdStat(ctx: ShellContext, args: string[]): string {
  let formatStr: string | undefined;
  const files: string[] = [];

  const set = gnuOptionSet('stat');
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand') files.push(item.value);
    else if (item.kind === 'option' && item.letter === 'c') formatStr = item.argument;
  }

  if (files.length === 0) return "stat: missing operand\nTry 'stat --help' for more information.";

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

  const human = (ms: number) => formatStatTime(ms, ctx.zone);
  const epoch = (ms: number) => String(Math.floor(ms / 1000));

  return fmt
    .replace(/%x/g, human(inode.atime))
    .replace(/%y/g, human(inode.mtime))
    .replace(/%z/g, human(inode.ctime))
    .replace(/%X/g, epoch(inode.atime))
    .replace(/%Y/g, epoch(inode.mtime))
    .replace(/%Z/g, epoch(inode.ctime))
    .replace(/%w/g, '-')
    .replace(/%W/g, '0')
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
  const octal = ctx.vfs.formatOctalPermissions(inode, 4);
  const perms = ctx.vfs.formatPermissions(inode);
  const typeStr = inode.type === 'file' ? 'regular file' : inode.type;
  const stamp = (ms: number) => formatStatTime(ms, ctx.zone);
  const access = stamp(inode.atime);
  const modify = stamp(inode.mtime);
  const change = stamp(inode.ctime);

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
