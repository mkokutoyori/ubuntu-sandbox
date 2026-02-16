/**
 * Windows Virtual File System for Windows device simulation.
 * Follows the same architectural pattern as linux/VirtualFileSystem.ts
 * but with Windows-specific semantics:
 *   - Drive letters (C:, D:, etc.)
 *   - Case-insensitive paths
 *   - Backslash path separators
 *   - Windows file attributes (archive, hidden, system, read-only)
 */

export type WinFileType = 'file' | 'directory';

export interface WinFSEntry {
  name: string;                         // original-case name
  type: WinFileType;
  content: string;                      // file content (empty for dirs)
  children: Map<string, WinFSEntry>;    // directory entries (key = lowercase name)
  size: number;
  mtime: Date;
  ctime: Date;
  attributes: Set<string>;             // 'archive' | 'hidden' | 'system' | 'readonly'
}

export interface WinDirEntry {
  name: string;
  entry: WinFSEntry;
}

export class WindowsFileSystem {
  /** Root of each drive: key = uppercase drive letter with colon, e.g. 'C:' */
  private drives: Map<string, WinFSEntry> = new Map();

  constructor(hostname: string = 'DESKTOP') {
    this.initializeDefaultFS(hostname);
  }

  // ─── Initialization ──────────────────────────────────────────────

  private initializeDefaultFS(hostname: string): void {
    // Create C: drive root
    const cRoot = this.createEntry('C:', 'directory');
    this.drives.set('C:', cRoot);

    // Standard Windows directories
    const dirs = [
      'C:\\PerfLogs',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\Users',
      'C:\\Users\\User',
      'C:\\Users\\User\\Desktop',
      'C:\\Users\\User\\Documents',
      'C:\\Users\\User\\Downloads',
      'C:\\Users\\User\\Pictures',
      'C:\\Users\\User\\Videos',
      'C:\\Users\\User\\Music',
      'C:\\Users\\User\\AppData',
      'C:\\Users\\User\\AppData\\Local',
      'C:\\Users\\User\\AppData\\Roaming',
      'C:\\Users\\Public',
      'C:\\Windows',
      'C:\\Windows\\System32',
      'C:\\Windows\\System32\\drivers',
      'C:\\Windows\\SysWOW64',
      'C:\\Windows\\Temp',
      'C:\\Windows\\Logs',
    ];
    for (const dir of dirs) {
      this.mkdirp(dir);
    }

    // Mark system directories as hidden/system
    const systemDirs = ['C:\\PerfLogs', 'C:\\Windows'];
    for (const sd of systemDirs) {
      const entry = this.resolve(sd);
      if (entry) {
        entry.attributes.add('system');
        entry.attributes.add('hidden');
      }
    }
  }

  // ─── Entry Creation ──────────────────────────────────────────────

  private createEntry(name: string, type: WinFileType): WinFSEntry {
    const now = new Date();
    return {
      name,
      type,
      content: '',
      children: new Map(),
      size: 0,
      mtime: now,
      ctime: now,
      attributes: new Set(),
    };
  }

  // ─── Path Utilities ──────────────────────────────────────────────

  /**
   * Normalize a Windows path:
   * - Convert forward slashes to backslashes
   * - Resolve . and .. components
   * - If relative, resolve against cwd
   */
  normalizePath(path: string, cwd: string): string {
    // Convert forward slashes
    let p = path.replace(/\//g, '\\');

    // Check if absolute (starts with drive letter)
    const driveMatch = p.match(/^([A-Za-z]):\\/);
    if (!driveMatch) {
      // Check if just a drive letter like "C:"
      const justDrive = p.match(/^([A-Za-z]):$/);
      if (justDrive) {
        return justDrive[1].toUpperCase() + ':\\';
      }
      // Relative path - prepend cwd
      if (p.startsWith('\\')) {
        // Root-relative on current drive
        const cwdDrive = cwd.match(/^([A-Za-z]):/);
        p = (cwdDrive ? cwdDrive[1].toUpperCase() : 'C') + ':' + p;
      } else {
        p = cwd + '\\' + p;
      }
    }

    // Extract drive
    const drive = p.substring(0, 2).toUpperCase();
    let rest = p.substring(2);

    // Split and resolve . and ..
    const parts = rest.split('\\').filter(s => s !== '' && s !== '.');
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        if (resolved.length > 0) resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    if (resolved.length === 0) return drive + '\\';
    return drive + '\\' + resolved.join('\\');
  }

  // ─── Resolution ──────────────────────────────────────────────────

  /**
   * Resolve a normalized absolute path to its WinFSEntry, or null if not found.
   */
  resolve(absPath: string): WinFSEntry | null {
    const drive = absPath.substring(0, 2).toUpperCase();
    const root = this.drives.get(drive);
    if (!root) return null;

    // Just the drive root?
    if (absPath.length <= 3) return root; // "C:" or "C:\"

    const rest = absPath.substring(3); // after "C:\"
    const parts = rest.split('\\').filter(Boolean);

    let current = root;
    for (const part of parts) {
      if (current.type !== 'directory') return null;
      const key = part.toLowerCase();
      const child = current.children.get(key);
      if (!child) return null;
      current = child;
    }
    return current;
  }

  /**
   * Resolve parent directory and return [parentEntry, childName] or null.
   */
  private resolveParent(absPath: string): [WinFSEntry, string] | null {
    const lastSep = absPath.lastIndexOf('\\');
    if (lastSep <= 2) {
      // Parent is drive root
      const drive = absPath.substring(0, 2).toUpperCase();
      const root = this.drives.get(drive);
      if (!root) return null;
      return [root, absPath.substring(3)];
    }
    const parentPath = absPath.substring(0, lastSep);
    const childName = absPath.substring(lastSep + 1);
    const parent = this.resolve(parentPath);
    if (!parent || parent.type !== 'directory') return null;
    return [parent, childName];
  }

  // ─── Query ───────────────────────────────────────────────────────

  exists(absPath: string): boolean {
    return this.resolve(absPath) !== null;
  }

  isDirectory(absPath: string): boolean {
    const entry = this.resolve(absPath);
    return entry !== null && entry.type === 'directory';
  }

  isFile(absPath: string): boolean {
    const entry = this.resolve(absPath);
    return entry !== null && entry.type === 'file';
  }

  // ─── Directory Operations ────────────────────────────────────────

  mkdir(absPath: string): { ok: boolean; error?: string } {
    const pair = this.resolveParent(absPath);
    if (!pair) return { ok: false, error: 'The system cannot find the path specified.' };
    const [parent, childName] = pair;
    const key = childName.toLowerCase();
    if (parent.children.has(key)) {
      return { ok: false, error: `A subdirectory or file ${childName} already exists.` };
    }
    const entry = this.createEntry(childName, 'directory');
    parent.children.set(key, entry);
    parent.mtime = new Date();
    return { ok: true };
  }

  mkdirp(absPath: string): void {
    const drive = absPath.substring(0, 2).toUpperCase();
    let root = this.drives.get(drive);
    if (!root) {
      root = this.createEntry(drive, 'directory');
      this.drives.set(drive, root);
    }

    if (absPath.length <= 3) return;

    const rest = absPath.substring(3);
    const parts = rest.split('\\').filter(Boolean);
    let current = root;
    for (const part of parts) {
      const key = part.toLowerCase();
      let child = current.children.get(key);
      if (!child) {
        child = this.createEntry(part, 'directory');
        current.children.set(key, child);
        current.mtime = new Date();
      }
      current = child;
    }
  }

  rmdir(absPath: string): { ok: boolean; error?: string } {
    const entry = this.resolve(absPath);
    if (!entry) return { ok: false, error: 'The system cannot find the path specified.' };
    if (entry.type !== 'directory') return { ok: false, error: 'The directory name is invalid.' };
    if (entry.children.size > 0) return { ok: false, error: 'The directory is not empty.' };

    const pair = this.resolveParent(absPath);
    if (!pair) return { ok: false, error: 'Cannot remove root.' };
    const [parent, childName] = pair;
    parent.children.delete(childName.toLowerCase());
    parent.mtime = new Date();
    return { ok: true };
  }

  rmdirRecursive(absPath: string): { ok: boolean; error?: string } {
    const entry = this.resolve(absPath);
    if (!entry) return { ok: false, error: 'The system cannot find the path specified.' };

    const pair = this.resolveParent(absPath);
    if (!pair) return { ok: false, error: 'Cannot remove root.' };
    const [parent, childName] = pair;
    parent.children.delete(childName.toLowerCase());
    parent.mtime = new Date();
    return { ok: true };
  }

  listDirectory(absPath: string): WinDirEntry[] {
    const entry = this.resolve(absPath);
    if (!entry || entry.type !== 'directory') return [];
    const result: WinDirEntry[] = [];
    for (const child of entry.children.values()) {
      result.push({ name: child.name, entry: child });
    }
    // Sort: directories first, then alphabetical
    result.sort((a, b) => {
      if (a.entry.type !== b.entry.type) {
        return a.entry.type === 'directory' ? -1 : 1;
      }
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return result;
  }

  // ─── File Operations ─────────────────────────────────────────────

  createFile(absPath: string, content: string): { ok: boolean; error?: string } {
    const pair = this.resolveParent(absPath);
    if (!pair) return { ok: false, error: 'The system cannot find the path specified.' };
    const [parent, childName] = pair;
    const key = childName.toLowerCase();
    const existing = parent.children.get(key);
    if (existing && existing.type === 'directory') {
      return { ok: false, error: 'Access is denied.' };
    }
    const entry = this.createEntry(childName, 'file');
    entry.content = content;
    entry.size = content.length;
    parent.children.set(key, entry);
    parent.mtime = new Date();
    return { ok: true };
  }

  appendFile(absPath: string, content: string): { ok: boolean; error?: string } {
    const entry = this.resolve(absPath);
    if (entry && entry.type === 'file') {
      entry.content += content;
      entry.size = entry.content.length;
      entry.mtime = new Date();
      return { ok: true };
    }
    // File doesn't exist yet → create it
    return this.createFile(absPath, content);
  }

  readFile(absPath: string): { ok: boolean; content?: string; error?: string } {
    const entry = this.resolve(absPath);
    if (!entry) return { ok: false, error: 'The system cannot find the file specified.' };
    if (entry.type !== 'file') return { ok: false, error: 'Access is denied.' };
    return { ok: true, content: entry.content };
  }

  deleteFile(absPath: string): { ok: boolean; error?: string } {
    const pair = this.resolveParent(absPath);
    if (!pair) return { ok: false, error: 'The system cannot find the file specified.' };
    const [parent, childName] = pair;
    const key = childName.toLowerCase();
    const existing = parent.children.get(key);
    if (!existing) return { ok: false, error: 'The system cannot find the file specified.' };
    if (existing.type === 'directory') return { ok: false, error: 'Access is denied.' };
    parent.children.delete(key);
    parent.mtime = new Date();
    return { ok: true };
  }

  copyFile(srcPath: string, destPath: string): { ok: boolean; error?: string } {
    const srcEntry = this.resolve(srcPath);
    if (!srcEntry) return { ok: false, error: 'The system cannot find the file specified.' };
    if (srcEntry.type !== 'file') return { ok: false, error: 'Access is denied.' };

    // If dest is a directory, copy into it with same name
    const destEntry = this.resolve(destPath);
    if (destEntry && destEntry.type === 'directory') {
      const srcName = srcPath.substring(srcPath.lastIndexOf('\\') + 1);
      return this.createFile(destPath + '\\' + srcName, srcEntry.content);
    }

    return this.createFile(destPath, srcEntry.content);
  }

  moveFile(srcPath: string, destPath: string): { ok: boolean; error?: string } {
    const srcEntry = this.resolve(srcPath);
    if (!srcEntry) return { ok: false, error: 'The system cannot find the file specified.' };

    // If dest is a directory, move into it
    const destEntry = this.resolve(destPath);
    if (destEntry && destEntry.type === 'directory') {
      const srcName = srcPath.substring(srcPath.lastIndexOf('\\') + 1);
      destPath = destPath + '\\' + srcName;
    }

    // Copy content then delete source
    if (srcEntry.type === 'file') {
      const result = this.createFile(destPath, srcEntry.content);
      if (!result.ok) return result;
    } else {
      // Moving a directory
      const pair = this.resolveParent(destPath);
      if (!pair) return { ok: false, error: 'The system cannot find the path specified.' };
      const [destParent, destName] = pair;
      destParent.children.set(destName.toLowerCase(), srcEntry);
      srcEntry.name = destName;
    }

    // Remove from source
    const srcPair = this.resolveParent(srcPath);
    if (srcPair) {
      const [srcParent, srcChildName] = srcPair;
      srcParent.children.delete(srcChildName.toLowerCase());
      srcParent.mtime = new Date();
    }
    return { ok: true };
  }

  renameEntry(absPath: string, newName: string): { ok: boolean; error?: string } {
    const pair = this.resolveParent(absPath);
    if (!pair) return { ok: false, error: 'The system cannot find the file specified.' };
    const [parent, oldName] = pair;
    const oldKey = oldName.toLowerCase();
    const entry = parent.children.get(oldKey);
    if (!entry) return { ok: false, error: 'The system cannot find the file specified.' };

    const newKey = newName.toLowerCase();
    if (newKey !== oldKey && parent.children.has(newKey)) {
      return { ok: false, error: 'A duplicate file name exists, or the file cannot be found.' };
    }

    parent.children.delete(oldKey);
    entry.name = newName;
    parent.children.set(newKey, entry);
    parent.mtime = new Date();
    return { ok: true };
  }

  /**
   * Delete files matching a glob pattern (simple *.ext support).
   * Returns number of files deleted.
   */
  deleteGlob(dirPath: string, pattern: string): number {
    const dir = this.resolve(dirPath);
    if (!dir || dir.type !== 'directory') return 0;

    const regex = this.globToRegex(pattern);
    const toDelete: string[] = [];
    for (const [key, child] of dir.children) {
      if (child.type === 'file' && regex.test(child.name)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      dir.children.delete(key);
    }
    dir.mtime = new Date();
    return toDelete.length;
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp('^' + escaped + '$', 'i');
  }

  // ─── Recursive Listing ───────────────────────────────────────────

  listDirectoryRecursive(absPath: string): { path: string; entries: WinDirEntry[] }[] {
    const result: { path: string; entries: WinDirEntry[] }[] = [];
    this._listRecursive(absPath, result);
    return result;
  }

  private _listRecursive(absPath: string, result: { path: string; entries: WinDirEntry[] }[]): void {
    const entries = this.listDirectory(absPath);
    result.push({ path: absPath, entries });
    for (const e of entries) {
      if (e.entry.type === 'directory') {
        const childPath = absPath.endsWith('\\') ? absPath + e.name : absPath + '\\' + e.name;
        this._listRecursive(childPath, result);
      }
    }
  }

  // ─── Tree Display ────────────────────────────────────────────────

  tree(absPath: string): string {
    const entry = this.resolve(absPath);
    if (!entry || entry.type !== 'directory') return 'Invalid path - ' + absPath;

    const lines: string[] = [absPath];
    this._tree(entry, '', lines);
    return lines.join('\n');
  }

  private _tree(entry: WinFSEntry, prefix: string, lines: string[]): void {
    const children = Array.from(entry.children.values())
      .filter(c => c.type === 'directory')
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    for (let i = 0; i < children.length; i++) {
      const isLast = i === children.length - 1;
      const connector = isLast ? '└───' : '├───';
      const extension = isLast ? '    ' : '│   ';
      lines.push(prefix + connector + children[i].name);
      this._tree(children[i], prefix + extension, lines);
    }
  }

  // ─── Tab Completion ──────────────────────────────────────────────

  getCompletions(absDir: string, partial: string): string[] {
    const dir = this.resolve(absDir);
    if (!dir || dir.type !== 'directory') return [];
    const lower = partial.toLowerCase();
    const results: string[] = [];
    for (const child of dir.children.values()) {
      if (child.name.toLowerCase().startsWith(lower)) {
        results.push(child.name);
      }
    }
    return results.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  // ─── Stats ───────────────────────────────────────────────────────

  getTotalSize(absPath: string): number {
    const entry = this.resolve(absPath);
    if (!entry) return 0;
    if (entry.type === 'file') return entry.size;
    let total = 0;
    for (const child of entry.children.values()) {
      total += this.getTotalSize(
        absPath.endsWith('\\') ? absPath + child.name : absPath + '\\' + child.name
      );
    }
    return total;
  }

  getFreeDiskSpace(): number {
    // Simulated: 50GB free
    return 53_687_091_200;
  }

  getVolumeSerialNumber(): string {
    return 'A4E2-1B3F';
  }
}
