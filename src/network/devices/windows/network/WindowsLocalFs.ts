import type { ISshLocalFs, SshLocalDirEntry, SshLocalInode } from '@/network/protocols/ssh/ISshLocalFs';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';

function toWin(p: string): string {
  if (/^\/[A-Za-z]:/.test(p)) return p.slice(1).replace(/\//g, '\\');
  return p.replace(/\//g, '\\');
}

export class WindowsLocalFs implements ISshLocalFs {
  constructor(private readonly fs: WindowsFileSystem) {}

  normalizePath(path: string, cwd?: string): string {
    return this.fs.normalizePath(toWin(path), cwd ?? 'C:\\');
  }

  readFile(path: string): string | null {
    const r = this.fs.readFile(toWin(path));
    return r.ok ? (r.content ?? '') : null;
  }

  writeFile(path: string, content: string, _uid: number, _gid: number, _umask: number): boolean {
    const abs = toWin(path);
    const lastSep = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'));
    if (lastSep > 0) {
      const dir = abs.slice(0, lastSep);
      if (!this.fs.exists(dir)) this.fs.mkdirp(dir);
    }
    return this.fs.createFile(abs, content).ok;
  }

  chmod(_path: string, _mode: number): boolean {
    return true;
  }

  resolveInode(path: string): SshLocalInode | null {
    const abs = toWin(path);
    if (!this.fs.exists(abs)) return null;
    return { type: this.fs.isDirectory(abs) ? 'directory' : 'file' };
  }

  listDirectory(path: string): readonly SshLocalDirEntry[] | null {
    const abs = toWin(path);
    if (!this.fs.exists(abs)) return null;
    return this.fs.listDirectory(abs).map((e) => ({
      name: e.name,
      inode: { type: e.type === 'directory' ? 'directory' : 'file' },
    }));
  }

  mkdir(path: string, _permissions: number, _uid: number, _gid: number): boolean {
    return this.fs.mkdir(toWin(path)).ok;
  }

  mkdirp(path: string, _permissions: number, _uid: number, _gid: number): boolean {
    this.fs.mkdirp(toWin(path));
    return true;
  }
}
