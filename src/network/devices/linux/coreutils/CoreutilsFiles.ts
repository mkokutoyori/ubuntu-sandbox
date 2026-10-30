import { actorOf, type ShellContext } from '../LinuxFileCommands';
import type { CoreutilsIO, FileRead } from './CoreutilsKit';

export function coreutilsIO(ctx: ShellContext, stdin: string | undefined): CoreutilsIO {
  return {
    stdin,
    read: (name): FileRead => {
      const path = ctx.vfs.normalizePath(name, ctx.cwd);
      const inode = ctx.vfs.resolveInode(path, true);
      if (inode === null) return { kind: 'missing' };
      if (ctx.uid !== 0 && !ctx.vfs.path(path, '/', actorOf(ctx)).canRead()) return { kind: 'denied' };
      if (inode.type === 'directory') return { kind: 'directory' };
      const text = ctx.vfs.readFile(path);
      return text === null ? { kind: 'missing' } : { kind: 'ok', text };
    },
    readBytes: (name, count) => {
      const path = ctx.vfs.normalizePath(name, ctx.cwd);
      return ctx.vfs.exists(path) ? ctx.vfs.readFileBytes(path, count) : null;
    },
    write: (name, text) => ctx.vfs.writeFile(ctx.vfs.normalizePath(name, ctx.cwd), text, ctx.uid, ctx.gid, ctx.umask, false, undefined, false),
  };
}
