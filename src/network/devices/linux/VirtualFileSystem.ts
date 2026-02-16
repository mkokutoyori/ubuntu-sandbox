/**
 * Inode-based Virtual File System for Linux device simulation.
 * Supports files, directories, symlinks, hard links, FIFOs, and special devices.
 */

export type FileType = 'file' | 'directory' | 'symlink' | 'fifo' | 'chardev';

export interface INode {
  id: number;
  type: FileType;
  permissions: number;    // 12-bit: setuid(1) setgid(1) sticky(1) owner(3) group(3) other(3)
  uid: number;
  gid: number;
  content: string;        // file content
  target: string;         // symlink target path
  children: Map<string, number>;  // directory entries -> inode ids
  linkCount: number;
  size: number;
  mtime: number;
  atime: number;
  ctime: number;
  deviceType?: string;    // 'null' | 'zero' | 'urandom' for chardev
}

export interface DirEntry {
  name: string;
  inode: INode;
}

export class VirtualFileSystem {
  private inodes: Map<number, INode> = new Map();
  private nextInodeId = 1;

  constructor() {
    this.initializeRootFS();
  }

  private initializeRootFS(): void {
    // Create root directory (inode 1)
    const rootInode = this.allocInode('directory', 0o755, 0, 0);
    rootInode.children.set('.', rootInode.id);
    rootInode.children.set('..', rootInode.id);

    // Create essential directories
    const dirs = [
      '/bin', '/sbin', '/usr', '/usr/bin', '/usr/sbin', '/usr/local', '/usr/local/bin',
      '/etc', '/etc/cron.hourly', '/etc/cron.daily', '/etc/cron.weekly', '/etc/cron.monthly',
      '/etc/sudoers.d',
      '/home', '/root', '/tmp', '/var', '/var/lib', '/var/lib/dhcp', '/var/log',
      '/dev', '/proc', '/sys', '/opt', '/run', '/mnt', '/media',
    ];
    for (const dir of dirs) {
      this.mkdirp(dir, 0o755, 0, 0);
    }

    // /tmp is world-writable with sticky bit
    const tmpInode = this.resolveInode('/tmp');
    if (tmpInode) tmpInode.permissions = 0o1777;

    // Create special device files
    this.createCharDev('/dev/null', 'null');
    this.createCharDev('/dev/zero', 'zero');
    this.createCharDev('/dev/urandom', 'urandom');

    // Create essential system files
    this.createFileAt('/etc/hostname', 'localhost\n', 0o644, 0, 0);
    this.createFileAt('/etc/shells', '/bin/bash\n/bin/sh\n', 0o644, 0, 0);
    this.createFileAt('/etc/sudoers', 'root ALL=(ALL:ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\n', 0o440, 0, 0);

    // Create binaries (stubs)
    const binaries = ['ls', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'chmod',
      'chown', 'chgrp', 'ln', 'find', 'grep', 'head', 'tail', 'wc', 'sort', 'cut',
      'uniq', 'tr', 'awk', 'stat', 'test', 'mkfifo', 'echo', 'pwd', 'cd', 'bash', 'sh',
      'id', 'whoami', 'groups', 'who', 'w', 'last', 'hostname', 'uname', 'tee', 'sleep',
      'kill', 'locate', 'updatedb'];
    for (const bin of binaries) {
      this.createFileAt(`/bin/${bin}`, `#!/bin/bash\n# ${bin} binary stub\n`, 0o755, 0, 0);
    }
    const usrBins = ['which', 'whereis', 'sudo'];
    for (const bin of usrBins) {
      this.createFileAt(`/usr/bin/${bin}`, `#!/bin/bash\n# ${bin} binary stub\n`, 0o755, 0, 0);
    }
    const sbinBins = ['useradd', 'usermod', 'userdel', 'groupadd', 'groupmod', 'groupdel',
      'chpasswd', 'chage'];
    for (const bin of sbinBins) {
      this.createFileAt(`/usr/sbin/${bin}`, `#!/bin/bash\n# ${bin} binary stub\n`, 0o755, 0, 0);
    }
  }

  private allocInode(type: FileType, permissions: number, uid: number, gid: number): INode {
    const id = this.nextInodeId++;
    const now = Date.now();
    const inode: INode = {
      id,
      type,
      permissions,
      uid,
      gid,
      content: '',
      target: '',
      children: new Map(),
      linkCount: type === 'directory' ? 2 : 1,
      size: 0,
      mtime: now,
      atime: now,
      ctime: now,
    };
    this.inodes.set(id, inode);
    return inode;
  }

  private createCharDev(path: string, deviceType: string): void {
    const inode = this.createFileAt(path, '', 0o666, 0, 0);
    if (inode) {
      inode.type = 'chardev';
      inode.deviceType = deviceType;
    }
  }

  // ─── Path Resolution ──────────────────────────────────────────────

  normalizePath(path: string, cwd: string = '/'): string {
    if (!path.startsWith('/')) {
      path = cwd.replace(/\/$/, '') + '/' + path;
    }
    const parts = path.split('/').filter(Boolean);
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === '.') continue;
      if (p === '..') {
        resolved.pop();
      } else {
        resolved.push(p);
      }
    }
    return '/' + resolved.join('/');
  }

  /**
   * Resolve a path to its inode, following symlinks.
   * Returns null if path doesn't exist.
   */
  resolveInode(path: string, followSymlinks = true, maxDepth = 20): INode | null {
    if (maxDepth <= 0) return null; // symlink loop protection

    const parts = path.split('/').filter(Boolean);
    let currentId = 1; // root inode
    let current = this.inodes.get(currentId)!;

    for (let i = 0; i < parts.length; i++) {
      // If current is a symlink, resolve it
      if (current.type === 'symlink' && followSymlinks) {
        const target = this.normalizePath(current.target, this.parentPath(path, parts, i));
        const resolved = this.resolveInode(target, true, maxDepth - 1);
        if (!resolved) return null;
        current = resolved;
        currentId = current.id;
      }

      if (current.type !== 'directory') return null;

      const childId = current.children.get(parts[i]);
      if (childId === undefined) return null;

      const child = this.inodes.get(childId);
      if (!child) return null;

      current = child;
      currentId = child.id;
    }

    // Final symlink resolution
    if (current.type === 'symlink' && followSymlinks) {
      const parentDir = '/' + parts.slice(0, -1).join('/');
      const target = this.normalizePath(current.target, parentDir || '/');
      return this.resolveInode(target, true, maxDepth - 1);
    }

    return current;
  }

  /**
   * Resolve path WITHOUT following the final symlink component.
   */
  lstat(path: string): INode | null {
    return this.resolveInode(path, false);
  }

  private parentPath(fullPath: string, parts: string[], currentIndex: number): string {
    return '/' + parts.slice(0, currentIndex).join('/');
  }

  /**
   * Resolve the parent directory and return [parentInode, basename].
   */
  resolveParent(path: string): [INode, string] | null {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return null; // root has no parent

    const basename = parts[parts.length - 1];
    const parentPath = '/' + parts.slice(0, -1).join('/');
    const parentInode = this.resolveInode(parentPath || '/');
    if (!parentInode || parentInode.type !== 'directory') return null;

    return [parentInode, basename];
  }

  // ─── File Operations ──────────────────────────────────────────────

  exists(path: string): boolean {
    return this.resolveInode(path) !== null;
  }

  existsNoFollow(path: string): boolean {
    return this.resolveInode(path, false) !== null;
  }

  getType(path: string, followSymlinks = true): FileType | null {
    const inode = followSymlinks ? this.resolveInode(path) : this.resolveInode(path, false);
    return inode?.type ?? null;
  }

  createFileAt(path: string, content: string, permissions: number, uid: number, gid: number): INode | null {
    const parent = this.resolveParent(path);
    if (!parent) return null;
    const [parentInode, basename] = parent;

    // If file already exists, just update content
    const existingId = parentInode.children.get(basename);
    if (existingId !== undefined) {
      const existing = this.inodes.get(existingId);
      if (existing && existing.type === 'file') {
        existing.content = content;
        existing.size = content.length;
        existing.mtime = Date.now();
        return existing;
      }
      return null; // Can't overwrite non-file
    }

    const inode = this.allocInode('file', permissions, uid, gid);
    inode.content = content;
    inode.size = content.length;
    parentInode.children.set(basename, inode.id);
    parentInode.mtime = Date.now();
    return inode;
  }

  touch(path: string, uid: number, gid: number, umask: number): boolean {
    const existing = this.resolveInode(path);
    if (existing) {
      existing.mtime = Date.now();
      existing.atime = Date.now();
      return true;
    }
    const perms = 0o666 & ~umask;
    return this.createFileAt(path, '', perms, uid, gid) !== null;
  }

  readFile(path: string): string | null {
    const inode = this.resolveInode(path);
    if (!inode) return null;

    if (inode.type === 'chardev') {
      switch (inode.deviceType) {
        case 'null': return '';
        case 'zero': return '\0'.repeat(1024);
        case 'urandom': {
          // Return pseudo-random bytes
          let s = '';
          for (let i = 0; i < 1024; i++) {
            s += String.fromCharCode(Math.floor(Math.random() * 256));
          }
          return s;
        }
      }
    }

    if (inode.type !== 'file') return null;
    inode.atime = Date.now();
    return inode.content;
  }

  readFileBytes(path: string, count: number): string {
    const inode = this.resolveInode(path);
    if (!inode) return '';

    if (inode.type === 'chardev') {
      switch (inode.deviceType) {
        case 'null': return '';
        case 'zero': return '\0'.repeat(count);
        case 'urandom': {
          let s = '';
          for (let i = 0; i < count; i++) {
            s += String.fromCharCode(Math.floor(Math.random() * 256));
          }
          return s;
        }
      }
    }

    if (inode.type === 'file') {
      return inode.content.slice(0, count);
    }
    return '';
  }

  writeFile(path: string, content: string, uid: number, gid: number, umask: number, append = false): boolean {
    // Handle special devices
    const inode = this.resolveInode(path);
    if (inode?.type === 'chardev') {
      if (inode.deviceType === 'null') return true; // silently discard
      return false;
    }

    if (inode?.type === 'file') {
      if (append) {
        inode.content += content;
      } else {
        inode.content = content;
      }
      inode.size = inode.content.length;
      inode.mtime = Date.now();
      return true;
    }

    if (!inode) {
      // Create new file
      const perms = 0o666 & ~umask;
      const newInode = this.createFileAt(path, content, perms, uid, gid);
      return newInode !== null;
    }

    return false;
  }

  deleteFile(path: string): boolean {
    const parent = this.resolveParent(path);
    if (!parent) return false;
    const [parentInode, basename] = parent;

    const childId = parentInode.children.get(basename);
    if (childId === undefined) return false;

    const child = this.inodes.get(childId);
    if (!child) return false;
    if (child.type === 'directory') return false;

    parentInode.children.delete(basename);
    parentInode.mtime = Date.now();

    child.linkCount--;
    if (child.linkCount <= 0) {
      this.inodes.delete(childId);
    }
    return true;
  }

  // ─── Directory Operations ──────────────────────────────────────────

  mkdir(path: string, permissions: number, uid: number, gid: number): boolean {
    const parent = this.resolveParent(path);
    if (!parent) return false;
    const [parentInode, basename] = parent;

    if (parentInode.children.has(basename)) return false;

    const dirInode = this.allocInode('directory', permissions, uid, gid);
    const parentPath = path.split('/').filter(Boolean);
    parentPath.pop();
    dirInode.children.set('.', dirInode.id);
    dirInode.children.set('..', parentInode.id);
    parentInode.children.set(basename, dirInode.id);
    parentInode.linkCount++;
    parentInode.mtime = Date.now();
    return true;
  }

  mkdirp(path: string, permissions: number, uid: number, gid: number): boolean {
    const parts = path.split('/').filter(Boolean);
    let currentPath = '';
    for (const part of parts) {
      currentPath += '/' + part;
      if (!this.exists(currentPath)) {
        if (!this.mkdir(currentPath, permissions, uid, gid)) return false;
      }
    }
    return true;
  }

  rmdir(path: string): boolean {
    const inode = this.resolveInode(path);
    if (!inode || inode.type !== 'directory') return false;

    // Check if empty (only . and ..)
    if (inode.children.size > 2) return false;

    const parent = this.resolveParent(path);
    if (!parent) return false;
    const [parentInode, basename] = parent;

    parentInode.children.delete(basename);
    parentInode.linkCount--;
    parentInode.mtime = Date.now();
    this.inodes.delete(inode.id);
    return true;
  }

  rmrf(path: string): boolean {
    const inode = this.resolveInode(path);
    if (!inode) return false;

    if (inode.type !== 'directory') {
      return this.deleteFile(path);
    }

    // Recursively delete directory contents
    for (const [name, childId] of inode.children) {
      if (name === '.' || name === '..') continue;
      const childPath = path.replace(/\/$/, '') + '/' + name;
      const child = this.inodes.get(childId);
      if (child?.type === 'directory') {
        this.rmrf(childPath);
      } else {
        this.deleteFile(childPath);
      }
    }

    // Now remove the empty directory
    return this.rmdir(path);
  }

  listDirectory(path: string): DirEntry[] | null {
    const inode = this.resolveInode(path);
    if (!inode || inode.type !== 'directory') return null;

    const entries: DirEntry[] = [];
    for (const [name, childId] of inode.children) {
      const child = this.inodes.get(childId);
      if (child) {
        entries.push({ name, inode: child });
      }
    }
    return entries;
  }

  // ─── Link Operations ──────────────────────────────────────────────

  createSymlink(path: string, target: string, uid: number, gid: number): boolean {
    const parent = this.resolveParent(path);
    if (!parent) return false;
    const [parentInode, basename] = parent;

    if (parentInode.children.has(basename)) return false;

    const inode = this.allocInode('symlink', 0o777, uid, gid);
    inode.target = target;
    inode.size = target.length;
    parentInode.children.set(basename, inode.id);
    parentInode.mtime = Date.now();
    return true;
  }

  createHardLink(path: string, targetPath: string): boolean {
    const targetInode = this.resolveInode(targetPath);
    if (!targetInode || targetInode.type === 'directory') return false;

    const parent = this.resolveParent(path);
    if (!parent) return false;
    const [parentInode, basename] = parent;

    if (parentInode.children.has(basename)) return false;

    parentInode.children.set(basename, targetInode.id);
    targetInode.linkCount++;
    parentInode.mtime = Date.now();
    return true;
  }

  // ─── Permission Operations ────────────────────────────────────────

  chmod(path: string, mode: number): boolean {
    const inode = this.resolveInode(path);
    if (!inode) return false;
    inode.permissions = mode;
    inode.ctime = Date.now();
    return true;
  }

  chown(path: string, uid: number, gid?: number): boolean {
    const inode = this.resolveInode(path);
    if (!inode) return false;
    inode.uid = uid;
    if (gid !== undefined) inode.gid = gid;
    inode.ctime = Date.now();
    return true;
  }

  chgrp(path: string, gid: number): boolean {
    const inode = this.resolveInode(path);
    if (!inode) return false;
    inode.gid = gid;
    inode.ctime = Date.now();
    return true;
  }

  chownRecursive(path: string, uid: number, gid?: number): boolean {
    const inode = this.resolveInode(path);
    if (!inode) return false;
    this.chown(path, uid, gid);
    if (inode.type === 'directory') {
      for (const [name, childId] of inode.children) {
        if (name === '.' || name === '..') continue;
        const childPath = path.replace(/\/$/, '') + '/' + name;
        this.chownRecursive(childPath, uid, gid);
      }
    }
    return true;
  }

  // ─── Copy / Move Operations ───────────────────────────────────────

  copy(srcPath: string, dstPath: string, uid: number, gid: number, umask: number): boolean {
    const srcInode = this.resolveInode(srcPath);
    if (!srcInode || srcInode.type !== 'file') return false;

    // If dst is a directory, copy into it
    const dstInode = this.resolveInode(dstPath);
    let finalDst = dstPath;
    if (dstInode?.type === 'directory') {
      const srcBasename = srcPath.split('/').filter(Boolean).pop()!;
      finalDst = dstPath.replace(/\/$/, '') + '/' + srcBasename;
    }

    const perms = 0o666 & ~umask;
    return this.createFileAt(finalDst, srcInode.content, perms, uid, gid) !== null;
  }

  rename(srcPath: string, dstPath: string): boolean {
    const srcParent = this.resolveParent(srcPath);
    if (!srcParent) return false;
    const [srcParentInode, srcBasename] = srcParent;

    const srcId = srcParentInode.children.get(srcBasename);
    if (srcId === undefined) return false;

    // If dst is a directory, move into it
    const dstInode = this.resolveInode(dstPath);
    let finalDst = dstPath;
    if (dstInode?.type === 'directory') {
      finalDst = dstPath.replace(/\/$/, '') + '/' + srcBasename;
    }

    const dstParent = this.resolveParent(finalDst);
    if (!dstParent) return false;
    const [dstParentInode, dstBasename] = dstParent;

    // Remove from old parent
    srcParentInode.children.delete(srcBasename);
    srcParentInode.mtime = Date.now();

    // If something exists at dst, remove it
    const existingId = dstParentInode.children.get(dstBasename);
    if (existingId !== undefined) {
      const existing = this.inodes.get(existingId);
      if (existing) {
        existing.linkCount--;
        if (existing.linkCount <= 0) this.inodes.delete(existingId);
      }
    }

    // Add to new parent
    dstParentInode.children.set(dstBasename, srcId);
    dstParentInode.mtime = Date.now();

    // Update .. reference if directory
    const srcNode = this.inodes.get(srcId);
    if (srcNode?.type === 'directory') {
      srcNode.children.set('..', dstParentInode.id);
    }

    return true;
  }

  // ─── FIFO (Named Pipe) ────────────────────────────────────────────

  createFifo(path: string, permissions: number, uid: number, gid: number): boolean {
    const parent = this.resolveParent(path);
    if (!parent) return false;
    const [parentInode, basename] = parent;

    if (parentInode.children.has(basename)) return false;

    const inode = this.allocInode('fifo', permissions, uid, gid);
    parentInode.children.set(basename, inode.id);
    parentInode.mtime = Date.now();
    return true;
  }

  // ─── Search Operations ────────────────────────────────────────────

  /**
   * Recursively find files/directories matching criteria.
   */
  find(startPath: string, options: {
    name?: string;
    type?: 'f' | 'd' | 'l';
    empty?: boolean;
    user?: number;
    group?: number;
    mtime?: number; // -N means modified within N days
  }): string[] {
    const results: string[] = [];
    this._findRecursive(startPath, options, results);
    return results;
  }

  private _findRecursive(path: string, options: any, results: string[]): void {
    const inode = this.resolveInode(path);
    if (!inode) return;

    const matches = this._matchesFindCriteria(path, inode, options);
    if (matches) results.push(path);

    if (inode.type === 'directory') {
      for (const [name, childId] of inode.children) {
        if (name === '.' || name === '..') continue;
        const childPath = path.replace(/\/$/, '') + '/' + name;
        this._findRecursive(childPath, options, results);
      }
    }
  }

  private _matchesFindCriteria(path: string, inode: INode, options: any): boolean {
    if (options.type !== undefined) {
      const typeMap: Record<string, FileType> = { f: 'file', d: 'directory', l: 'symlink' };
      if (inode.type !== typeMap[options.type]) return false;
    }

    if (options.name !== undefined) {
      const basename = path.split('/').pop() || '';
      if (!this.globMatch(basename, options.name)) return false;
    }

    if (options.empty && inode.type === 'file' && inode.size > 0) return false;
    if (options.empty && inode.type === 'directory' && inode.children.size > 2) return false;

    if (options.user !== undefined && inode.uid !== options.user) return false;
    if (options.group !== undefined && inode.gid !== options.group) return false;

    if (options.mtime !== undefined) {
      const days = Math.abs(options.mtime);
      const threshold = Date.now() - days * 86400000;
      if (options.mtime < 0) {
        // -mtime -N: modified within N days
        if (inode.mtime < threshold) return false;
      } else {
        // -mtime +N: modified more than N days ago
        if (inode.mtime > threshold) return false;
      }
    }

    return true;
  }

  globMatch(text: string, pattern: string): boolean {
    // Convert glob to regex
    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '*') regex += '.*';
      else if (c === '?') regex += '.';
      else if (c === '.') regex += '\\.';
      else regex += c;
    }
    regex += '$';
    return new RegExp(regex).test(text);
  }

  /**
   * Expand a glob pattern to matching paths in a directory.
   */
  globExpand(pattern: string, cwd: string): string[] {
    const absPattern = this.normalizePath(pattern, cwd);
    const parts = absPattern.split('/').filter(Boolean);
    return this._globExpandRecursive('/', parts, 0);
  }

  private _globExpandRecursive(currentPath: string, parts: string[], index: number): string[] {
    if (index >= parts.length) return [currentPath];

    const part = parts[index];
    const inode = this.resolveInode(currentPath);
    if (!inode || inode.type !== 'directory') return [];

    const results: string[] = [];
    if (part.includes('*') || part.includes('?')) {
      for (const [name] of inode.children) {
        if (name === '.' || name === '..') continue;
        if (this.globMatch(name, part)) {
          const childPath = currentPath === '/' ? '/' + name : currentPath + '/' + name;
          results.push(...this._globExpandRecursive(childPath, parts, index + 1));
        }
      }
    } else {
      const childPath = currentPath === '/' ? '/' + part : currentPath + '/' + part;
      if (this.existsNoFollow(childPath) || this.exists(childPath)) {
        results.push(...this._globExpandRecursive(childPath, parts, index + 1));
      }
    }

    return results;
  }

  // ─── Utility ──────────────────────────────────────────────────────

  /**
   * Format permissions as rwx string (e.g., "-rwxr-xr-x").
   */
  formatPermissions(inode: INode): string {
    const typeChars: Record<FileType, string> = {
      file: '-', directory: 'd', symlink: 'l', fifo: 'p', chardev: 'c'
    };
    let s = typeChars[inode.type] || '-';

    const perms = inode.permissions & 0o7777;
    const owner = (perms >> 6) & 7;
    const group = (perms >> 3) & 7;
    const other = perms & 7;
    const setuid = (perms >> 11) & 1;
    const setgid = (perms >> 10) & 1;
    const sticky = (perms >> 9) & 1;

    // Owner
    s += (owner & 4) ? 'r' : '-';
    s += (owner & 2) ? 'w' : '-';
    if (setuid) {
      s += (owner & 1) ? 's' : 'S';
    } else {
      s += (owner & 1) ? 'x' : '-';
    }

    // Group
    s += (group & 4) ? 'r' : '-';
    s += (group & 2) ? 'w' : '-';
    if (setgid) {
      s += (group & 1) ? 's' : 'S';
    } else {
      s += (group & 1) ? 'x' : '-';
    }

    // Other
    s += (other & 4) ? 'r' : '-';
    s += (other & 2) ? 'w' : '-';
    if (sticky) {
      s += (other & 1) ? 't' : 'T';
    } else {
      s += (other & 1) ? 'x' : '-';
    }

    return s;
  }

  /**
   * Get octal representation of permissions (3 or 4 digit).
   */
  formatOctalPermissions(inode: INode): string {
    const perms = inode.permissions & 0o7777;
    const special = (perms >> 9) & 7;
    const basic = perms & 0o777;
    if (special) {
      return special.toString() + basic.toString(8).padStart(3, '0');
    }
    return basic.toString(8).padStart(3, '0');
  }

  getInode(id: number): INode | undefined {
    return this.inodes.get(id);
  }

  getInodeCount(): number {
    return this.inodes.size;
  }

  /**
   * Check if a symlink target is broken (target doesn't exist).
   */
  isSymlinkBroken(path: string): boolean {
    const lstatNode = this.resolveInode(path, false);
    if (!lstatNode || lstatNode.type !== 'symlink') return false;
    return this.resolveInode(path, true) === null;
  }
}
