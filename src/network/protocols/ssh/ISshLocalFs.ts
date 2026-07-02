export interface SshLocalDirEntry {
  readonly name: string;
  readonly inode: { readonly type: 'file' | 'directory' | 'symlink' | 'fifo' | 'chardev' };
}

export interface SshLocalInode {
  readonly type: 'file' | 'directory' | 'symlink' | 'fifo' | 'chardev';
}

export interface ISshLocalFs {
  normalizePath(path: string, cwd?: string): string;
  readFile(path: string): string | null;
  writeFile(path: string, content: string, uid: number, gid: number, umask: number, append?: boolean): boolean;
  chmod(path: string, mode: number): boolean;
  resolveInode(path: string, followSymlinks?: boolean, maxDepth?: number): SshLocalInode | null;
  listDirectory(path: string): readonly SshLocalDirEntry[] | null;
  mkdir(path: string, permissions: number, uid: number, gid: number): boolean;
  mkdirp?(path: string, permissions: number, uid: number, gid: number): boolean;
}
