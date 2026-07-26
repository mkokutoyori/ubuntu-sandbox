/**
 * MemorySshLocalFs — the client-side storage an SSH client needs when the
 * device it runs on has no general-purpose filesystem to borrow.
 *
 * A router keeps host keys in NVRAM, not in a directory tree, so there is
 * no real path to point `known_hosts` at. Rather than special-case the
 * client for such devices, they get this: a flat, per-device store that
 * satisfies {@link ISshLocalFs} and persists for as long as the device
 * does. Only the handful of paths the SSH client actually touches
 * (known_hosts, identity files) ever land in it.
 */

import type { ISshLocalFs, SshLocalDirEntry, SshLocalInode } from '../ISshLocalFs';

const FILE: SshLocalInode = { type: 'file' };
const DIRECTORY: SshLocalInode = { type: 'directory' };

export class MemorySshLocalFs implements ISshLocalFs {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>(['/']);

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
    return this.files.get(this.normalizePath(path)) ?? null;
  }

  writeFile(
    path: string, content: string,
    _uid: number, _gid: number, _umask: number, append = false,
  ): boolean {
    const key = this.normalizePath(path);
    const parent = key.slice(0, key.lastIndexOf('/')) || '/';
    this.ensureDirs(parent);
    this.files.set(key, append ? `${this.files.get(key) ?? ''}${content}` : content);
    return true;
  }

  chmod(_path: string, _mode: number): boolean {
    return true;
  }

  resolveInode(path: string): SshLocalInode | null {
    const key = this.normalizePath(path);
    if (this.files.has(key)) return FILE;
    if (this.dirs.has(key)) return DIRECTORY;
    return null;
  }

  listDirectory(path: string): readonly SshLocalDirEntry[] | null {
    const key = this.normalizePath(path);
    if (!this.dirs.has(key)) return null;
    const prefix = key === '/' ? '/' : `${key}/`;
    const seen = new Map<string, SshLocalDirEntry>();
    const collect = (full: string, inode: SshLocalInode) => {
      if (!full.startsWith(prefix) || full === key) return;
      const name = full.slice(prefix.length).split('/')[0];
      if (!name || seen.has(name)) return;
      seen.set(name, { name, inode: full.slice(prefix.length).includes('/') ? DIRECTORY : inode });
    };
    for (const full of this.files.keys()) collect(full, FILE);
    for (const full of this.dirs) collect(full, DIRECTORY);
    return [...seen.values()];
  }

  mkdir(path: string, _permissions: number, _uid: number, _gid: number): boolean {
    this.dirs.add(this.normalizePath(path));
    return true;
  }

  mkdirp(path: string, _permissions: number, _uid: number, _gid: number): boolean {
    this.ensureDirs(this.normalizePath(path));
    return true;
  }

  private ensureDirs(path: string): void {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    this.dirs.add('/');
    for (const part of parts) {
      current += `/${part}`;
      this.dirs.add(current);
    }
  }
}
