/**
 * LinuxSftpAdapter — adapts VirtualFileSystem + LinuxUserManager to the
 * ISftpFileSystem / ISftpUserAuth interfaces used by SftpSession.
 */

import type { ISftpFileSystem, ISftpUserAuth } from './ISftpFileSystem';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';

export class LinuxSftpFSAdapter implements ISftpFileSystem {
  constructor(private readonly vfs: VirtualFileSystem) {}

  normalizePath(path: string, cwd: string): string {
    return this.vfs.normalizePath(path, cwd);
  }

  getEntryType(path: string): 'file' | 'directory' | null {
    const inode = this.vfs.resolveInode(path);
    if (!inode) return null;
    if (inode.type === 'file') return 'file';
    if (inode.type === 'directory') return 'directory';
    return null;
  }

  listDirectory(path: string): Array<{ name: string }> | null {
    const entries = this.vfs.listDirectory(path);
    if (!entries) return null;
    return entries
      .filter(e => e.name !== '.' && e.name !== '..')
      .map(e => ({ name: e.name }));
  }

  readFile(path: string): string | null {
    return this.vfs.readFile(path);
  }

  writeFile(path: string, content: string): void {
    this.vfs.writeFile(path, content, 0, 0, 0o022);
  }

  exists(path: string): boolean {
    return this.vfs.exists(path);
  }

  mkdirp(path: string): void {
    this.vfs.mkdirp(path, 0o755, 0, 0);
  }

  deleteFile(path: string): boolean {
    return this.vfs.deleteFile(path);
  }

  rmdir(path: string): boolean {
    return this.vfs.rmdir(path);
  }

  rename(src: string, dst: string): boolean {
    return this.vfs.rename(src, dst);
  }
}

export class LinuxSftpUserAuthAdapter implements ISftpUserAuth {
  constructor(private readonly userMgr: LinuxUserManager) {}

  checkPassword(username: string, password: string): boolean {
    return this.userMgr.checkPassword(username, password);
  }

  getHomeDirectory(username: string): string {
    return this.userMgr.getUser(username)?.home ?? '/';
  }
}
