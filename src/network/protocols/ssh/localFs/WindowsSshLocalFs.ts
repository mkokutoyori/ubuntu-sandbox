/**
 * WindowsSshLocalFs — the SSH client's view of a Windows machine's own
 * disk, so `known_hosts` and identity files live where a Windows admin
 * would look for them (`C:\Users\<user>\.ssh\`) instead of in a
 * side-store invented for the client.
 *
 * The SSH client speaks POSIX paths; Windows stores backslashed ones on
 * drive C:. Translation happens here and nowhere else — the client never
 * learns there is more than one path flavour.
 */

import type { ISshLocalFs, SshLocalDirEntry, SshLocalInode } from '../ISshLocalFs';

interface WindowsFsLike {
  normalizePath(path: string, cwd: string): string;
  readFile(absPath: string): { ok: boolean; content?: string };
  createFile(absPath: string, content: string): { ok: boolean; error?: string };
  appendFile(absPath: string, content: string): { ok: boolean; error?: string };
  exists(absPath: string): boolean;
  isDirectory(absPath: string): boolean;
  listDirectory(absPath: string): readonly { name: string; entry: { type: string } }[];
  mkdirp(absPath: string): void;
}

/** POSIX path the client uses → absolute Windows path on C:. */
function toWindows(path: string): string {
  const trimmed = path.replace(/^\/+/, '');
  return `C:\\${trimmed.split('/').filter(Boolean).join('\\')}`;
}

function inodeType(type: string): SshLocalInode['type'] {
  return type === 'directory' ? 'directory' : 'file';
}

export class WindowsSshLocalFs implements ISshLocalFs {
  constructor(private readonly fs: WindowsFsLike) {}

  normalizePath(path: string, cwd: string = '/'): string {
    const raw = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`;
    const parts: string[] = [];
    for (const segment of raw.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') { parts.pop(); continue; }
      parts.push(segment);
    }
    return `/${parts.join('/')}`;
  }

  readFile(path: string): string | null {
    const result = this.fs.readFile(toWindows(this.normalizePath(path)));
    return result.ok ? (result.content ?? '') : null;
  }

  writeFile(
    path: string, content: string,
    _uid: number, _gid: number, _umask: number, append = false,
  ): boolean {
    const key = this.normalizePath(path);
    const parent = key.slice(0, key.lastIndexOf('/')) || '/';
    this.fs.mkdirp(toWindows(parent));
    const target = toWindows(key);
    const result = append && this.fs.exists(target)
      ? this.fs.appendFile(target, content)
      : this.fs.createFile(target, content);
    return result.ok;
  }

  chmod(_path: string, _mode: number): boolean {
    return true;
  }

  resolveInode(path: string): SshLocalInode | null {
    const target = toWindows(this.normalizePath(path));
    if (!this.fs.exists(target)) return null;
    return { type: this.fs.isDirectory(target) ? 'directory' : 'file' };
  }

  listDirectory(path: string): readonly SshLocalDirEntry[] | null {
    const target = toWindows(this.normalizePath(path));
    if (!this.fs.exists(target) || !this.fs.isDirectory(target)) return null;
    return this.fs.listDirectory(target).map((e) => ({
      name: e.name,
      inode: { type: inodeType(e.entry.type) },
    }));
  }

  mkdir(path: string, _permissions: number, _uid: number, _gid: number): boolean {
    this.fs.mkdirp(toWindows(this.normalizePath(path)));
    return true;
  }

  mkdirp(path: string, _permissions: number, _uid: number, _gid: number): boolean {
    this.fs.mkdirp(toWindows(this.normalizePath(path)));
    return true;
  }
}
