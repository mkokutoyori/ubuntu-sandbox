import type { VirtualFileSystem } from '../../VirtualFileSystem';
import type { LinuxUserManager } from '../../LinuxUserManager';
import type { AuditdConfigFs, FileInfo, FsErrno, StatResult } from './AuditdConfig';

const MODE_MASK = 0o7777;

function readable(info: FileInfo, uid: number, gids: readonly number[]): boolean {
  if (uid === 0) return true;
  if (info.uid === uid) return (info.mode & 0o400) !== 0;
  if (gids.includes(info.gid)) return (info.mode & 0o040) !== 0;
  return (info.mode & 0o004) !== 0;
}

export function vfsAuditdConfigFs(
  vfs: VirtualFileSystem, users: LinuxUserManager, actor: { uid: number; gids: readonly number[] } = { uid: 0, gids: [0] },
): AuditdConfigFs {
  const statOf = (path: string, follow: boolean): StatResult => {
    const inode = vfs.resolveInode(path, follow);
    if (inode === null) return { ok: false, errno: 'ENOENT' };
    const kind = inode.type === 'file' ? 'file' : inode.type === 'directory' ? 'directory' : inode.type === 'symlink' ? 'symlink' : 'other';
    return { ok: true, info: { kind, ino: inode.id, uid: inode.uid, gid: inode.gid, mode: inode.permissions & MODE_MASK } };
  };
  return {
    stat(path, followLinks) {
      const found = statOf(path, followLinks);
      if (found.ok === false || found.info.kind === 'symlink') return found;
      return readable(found.info, actor.uid, actor.gids) ? found : { ok: false, errno: 'EACCES' };
    },
    readText: (path) => vfs.readFile(path),
    openDirectory(path): FsErrno | null {
      const found = statOf(path, true);
      if (found.ok === false) return found.errno;
      return found.info.kind === 'directory' ? null : 'ENOTDIR';
    },
    groupGid: (name) => users.getGroup(name)?.gid ?? null,
    isExecutable(path) {
      const found = statOf(path, true);
      return found.ok && found.info.kind === 'file' && (found.info.mode & 0o111) !== 0;
    },
    hostResolves: () => true,
  };
}
