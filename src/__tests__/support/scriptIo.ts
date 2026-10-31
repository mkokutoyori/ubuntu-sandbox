import type { IOContext } from '@/bash/interpreter/BashInterpreter';
import type { ShellContext } from '@/network/devices/linux/LinuxFileCommands';

export function ioContextFor(ctx: ShellContext): IOContext {
  return {
    writeFile(path: string, content: string, append: boolean) {
      const written = ctx.vfs.writeFile(
        path, content, ctx.uid, ctx.gid, ctx.umask, append, undefined, false);
      if (written) return;
      const slash = path.lastIndexOf('/');
      const parent = slash > 0 ? path.slice(0, slash) : '/';
      if (!ctx.vfs.exists(parent)) {
        throw new Error(`bash: ${path}: No such file or directory`);
      }
    },
    readFile(path: string) {
      return ctx.vfs.readFile(path);
    },
    resolvePath(path: string, cwd?: string) {
      return ctx.vfs.normalizePath(path, cwd ?? ctx.cwd);
    },
    stat(path: string) {
      const absPath = ctx.vfs.normalizePath(path, ctx.cwd);
      const inode = ctx.vfs.resolveInode(absPath);
      if (!inode) return null;
      return { type: inode.type === 'directory' ? 'directory' as const : 'file' as const };
    },
    globExpand(pattern: string, cwd: string, options) {
      return ctx.vfs.globExpand(pattern, cwd, options);
    },
    homeFor(user: string) {
      const u = ctx.userMgr.getUser(user);
      return u ? u.home : null;
    },
  };
}

