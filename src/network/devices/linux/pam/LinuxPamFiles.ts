import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { PamFileStat, PamWritableFiles } from './PamLinuxHost';

const ROOT = 0;
const UMASK = 0o022;
const DIRECTORY_MODE = 0o755;

export class LinuxPamFiles implements PamWritableFiles {
  constructor(private readonly vfs: VirtualFileSystem) {}

  writeFile(path: string, content: string): boolean {
    return this.vfs.writeFile(path, content, ROOT, ROOT, UMASK);
  }

  exists(path: string): boolean {
    return this.vfs.exists(path);
  }

  stat(path: string): PamFileStat | null {
    const inode = this.vfs.resolveInode(path);
    if (inode === null) return null;
    return {
      mode: inode.permissions,
      regular: inode.type === 'file',
      directory: inode.type === 'directory',
      size: inode.size,
      accessTime: inode.atime,
      modifyTime: inode.mtime,
    };
  }

  mkdirp(path: string): void {
    this.vfs.mkdirp(path, DIRECTORY_MODE, ROOT, ROOT);
  }

  listDirectory(path: string): readonly string[] | null {
    const entries = this.vfs.listDirectory(path);
    return entries === null ? null : entries.map((entry) => entry.name);
  }

  remove(path: string): void {
    this.vfs.deleteFile(path);
  }
}
