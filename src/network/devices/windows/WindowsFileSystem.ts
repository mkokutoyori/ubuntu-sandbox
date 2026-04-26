/**
 * Windows Virtual File System for Windows device simulation.
 * Follows the same architectural pattern as linux/VirtualFileSystem.ts
 * but with Windows-specific semantics:
 *   - Drive letters (C:, D:, etc.)
 *   - Case-insensitive paths
 *   - Backslash path separators
 *   - Windows file attributes (archive, hidden, system, read-only)
 *   - NTFS-style ACLs (owner + access control entries)
 */

export type WinFileType = 'file' | 'directory';

/** Access Control Entry — one permission rule in a DACL */
export interface WinACE {
  principal: string;    // e.g. "BUILTIN\\Administrators", "User", "Guest"
  type: 'allow' | 'deny';
  permissions: string[];  // e.g. ['FullControl'], ['Read', 'Write']
}

export interface WinFSEntry {
  name: string;                         // original-case name
  type: WinFileType;
  content: string;                      // file content (empty for dirs)
  children: Map<string, WinFSEntry>;    // directory entries (key = lowercase name)
  size: number;
  mtime: Date;
  ctime: Date;
  attributes: Set<string>;             // 'archive' | 'hidden' | 'system' | 'readonly'
  owner: string;                        // owner principal (e.g. "BUILTIN\\Administrators")
  acl: WinACE[];                        // discretionary ACL
  aclProtected?: boolean;              // true = inheritance disabled, only explicit ACEs apply
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

    // Additional realistic Windows directories
    const extraDirs = [
      'C:\\Users\\User\\AppData\\Local\\Temp',
      'C:\\Users\\User\\AppData\\Local\\Microsoft',
      'C:\\Users\\User\\AppData\\Roaming\\Microsoft',
      'C:\\Users\\User\\Favorites',
      'C:\\Users\\User\\Contacts',
      'C:\\Users\\User\\Saved Games',
      'C:\\Users\\User\\Links',
      'C:\\Users\\User\\Searches',
      'C:\\Users\\User\\OneDrive',
      'C:\\Users\\User\\OneDrive\\Documents',
      'C:\\Users\\Default',
      'C:\\Windows\\System32\\config',
      'C:\\Windows\\System32\\WindowsPowerShell',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Windows\\System32\\wbem',
      'C:\\Windows\\Fonts',
      'C:\\Windows\\INF',
      'C:\\Windows\\Prefetch',
      'C:\\Windows\\Microsoft.NET',
      'C:\\Windows\\Microsoft.NET\\Framework64',
      'C:\\Windows\\WinSxS',
      'C:\\Windows\\Cursors',
      'C:\\Windows\\Help',
      'C:\\Windows\\Globalization',
      'C:\\Windows\\Boot',
      'C:\\Windows\\Panther',
      'C:\\Windows\\System32\\oobe',
      'C:\\Windows\\System32\\Tasks',
      'C:\\Program Files\\Common Files',
      'C:\\Program Files\\Internet Explorer',
      'C:\\Program Files\\Windows Defender',
      'C:\\Program Files\\Windows NT',
      'C:\\Program Files (x86)\\Common Files',
      'C:\\Program Files (x86)\\Internet Explorer',
    ];
    for (const dir of extraDirs) {
      this.mkdirp(dir);
    }

    // Realistic system files
    const systemFiles: Array<[string, string, number, string[]]> = [
      // [path, content, size, attributes]
      ['C:\\Windows\\System32\\cmd.exe', '', 289792, ['system']],
      ['C:\\Windows\\System32\\notepad.exe', '', 201216, ['system']],
      ['C:\\Windows\\System32\\calc.exe', '', 26112, ['system']],
      ['C:\\Windows\\System32\\mspaint.exe', '', 6656, ['system']],
      ['C:\\Windows\\System32\\taskmgr.exe', '', 368128, ['system']],
      ['C:\\Windows\\System32\\regedit.exe', '', 360448, ['system']],
      ['C:\\Windows\\System32\\explorer.exe', '', 4883944, ['system']],
      ['C:\\Windows\\System32\\mmc.exe', '', 147968, ['system']],
      ['C:\\Windows\\System32\\net.exe', '', 62464, ['system']],
      ['C:\\Windows\\System32\\ping.exe', '', 22528, ['system']],
      ['C:\\Windows\\System32\\ipconfig.exe', '', 26624, ['system']],
      ['C:\\Windows\\System32\\netsh.exe', '', 96768, ['system']],
      ['C:\\Windows\\System32\\tracert.exe', '', 13312, ['system']],
      ['C:\\Windows\\System32\\nslookup.exe', '', 80896, ['system']],
      ['C:\\Windows\\System32\\hostname.exe', '', 11264, ['system']],
      ['C:\\Windows\\System32\\shutdown.exe', '', 28672, ['system']],
      ['C:\\Windows\\System32\\where.exe', '', 22016, ['system']],
      ['C:\\Windows\\System32\\findstr.exe', '', 32256, ['system']],
      ['C:\\Windows\\System32\\attrib.exe', '', 15872, ['system']],
      ['C:\\Windows\\System32\\xcopy.exe', '', 51712, ['system']],
      ['C:\\Windows\\System32\\sfc.exe', '', 19456, ['system']],
      ['C:\\Windows\\System32\\dism.exe', '', 280064, ['system']],
      ['C:\\Windows\\System32\\wbem\\wmic.exe', '', 47104, ['system']],
      ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '', 452608, ['system']],
      ['C:\\Windows\\System32\\drivers\\etc\\hosts', '# Copyright (c) 1993-2009 Microsoft Corp.\n#\n# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.\n#\n# This file contains the mappings of IP addresses to host names. Each\n# entry should be kept on an individual line. The IP address should\n# be placed in the first column followed by the corresponding host name.\n# The IP address and the host name should be separated by at least one\n# space.\n#\n# For example:\n#\n#      102.54.94.97     rhino.acme.com          # source server\n#       38.25.63.10     x.acme.com              # x client host\n\n# localhost name resolution is handled within DNS itself.\n127.0.0.1       localhost\n::1             localhost\n', 824, []],
      ['C:\\Windows\\System32\\drivers\\etc\\networks', '# Copyright (c) 1993-2009 Microsoft Corp.\n#\n# This file contains network name/number mappings.\n#\nloopback        127\n', 407, []],
      ['C:\\Windows\\System32\\drivers\\etc\\protocol', '# Copyright (c) 1993-2009 Microsoft Corp.\n#\nicmp    1   ICMP\ntcp     6   TCP\nudp    17   UDP\n', 1795, []],
      ['C:\\Windows\\System32\\drivers\\etc\\services', '# Copyright (c) 1993-2009 Microsoft Corp.\n#\necho           7/tcp\nftp           21/tcp\nssh           22/tcp\ntelnet        23/tcp\nsmtp          25/tcp\ndns           53/tcp\nhttp          80/tcp\nhttps        443/tcp\n', 17463, []],
      ['C:\\Windows\\notepad.exe', '', 201216, ['system']],
      ['C:\\Windows\\explorer.exe', '', 4883944, ['system']],
      ['C:\\Windows\\regedit.exe', '', 360448, ['system']],
      ['C:\\Windows\\write.exe', '', 10752, ['system']],
      ['C:\\Windows\\win.ini', '; for 16-bit app support\n[fonts]\n[extensions]\n[mci extensions]\n[files]\n[Mail]\nMAPI=1\n', 92, ['hidden']],
      ['C:\\Windows\\System32\\config\\SYSTEM', '', 26214400, ['system', 'hidden']],
      ['C:\\Windows\\System32\\config\\SOFTWARE', '', 104857600, ['system', 'hidden']],
      ['C:\\Windows\\System32\\config\\SAM', '', 262144, ['system', 'hidden']],
      ['C:\\Windows\\System32\\config\\SECURITY', '', 262144, ['system', 'hidden']],
      // User files
      ['C:\\Users\\User\\Desktop\\desktop.ini', '[.ShellClassInfo]\nLocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21769\n', 282, ['system', 'hidden']],
      ['C:\\Users\\User\\Documents\\desktop.ini', '[.ShellClassInfo]\nLocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21770\n', 282, ['system', 'hidden']],
      ['C:\\Users\\User\\NTUSER.DAT', '', 3145728, ['system', 'hidden']],
      ['C:\\Users\\User\\ntuser.dat.LOG1', '', 524288, ['system', 'hidden']],
      ['C:\\Users\\User\\ntuser.ini', '', 20, ['system', 'hidden']],
      // Program Files
      ['C:\\Program Files\\desktop.ini', '[.ShellClassInfo]\nLocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21781\n', 174, ['system', 'hidden']],
      ['C:\\Program Files (x86)\\desktop.ini', '[.ShellClassInfo]\nLocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21781\n', 174, ['system', 'hidden']],
    ];

    for (const [path, content, size, attrs] of systemFiles) {
      // Ensure parent directory exists
      const lastSep = path.lastIndexOf('\\');
      if (lastSep > 2) {
        this.mkdirp(path.substring(0, lastSep));
      }
      this.createFile(path, content);
      const entry = this.resolve(path);
      if (entry) {
        entry.size = size;
        for (const attr of attrs) entry.attributes.add(attr);
      }
    }

    // Service and process binaries (matching WindowsServiceManager + WindowsProcessManager)
    const serviceBinaries: Array<[string, number]> = [
      // Core service host
      ['C:\\Windows\\System32\\svchost.exe', 51768],
      // Service-specific binaries
      ['C:\\Windows\\System32\\spoolsv.exe', 69632],
      ['C:\\Windows\\System32\\lsass.exe', 58880],
      ['C:\\Windows\\System32\\services.exe', 72192],
      ['C:\\Windows\\System32\\csrss.exe', 6144],
      ['C:\\Windows\\System32\\wininit.exe', 39936],
      ['C:\\Windows\\System32\\smss.exe', 107008],
      ['C:\\Windows\\System32\\winlogon.exe', 620544],
      ['C:\\Windows\\System32\\dwm.exe', 92672],
      ['C:\\Windows\\System32\\sihost.exe', 81920],
      ['C:\\Windows\\System32\\taskhostw.exe', 82944],
      ['C:\\Windows\\System32\\conhost.exe', 862208],
      ['C:\\Windows\\System32\\RuntimeBroker.exe', 126464],
      ['C:\\Windows\\System32\\fontdrvhost.exe', 45056],
      ['C:\\Windows\\System32\\ctfmon.exe', 20480],
      // System drivers (in drivers directory)
      ['C:\\Windows\\System32\\drivers\\tcpip.sys', 2437120],
      ['C:\\Windows\\System32\\drivers\\afd.sys', 562176],
      ['C:\\Windows\\System32\\drivers\\netbt.sys', 299008],
      // Networking tools already present but add sc.exe, tasklist, taskkill
      ['C:\\Windows\\System32\\sc.exe', 73728],
      ['C:\\Windows\\System32\\tasklist.exe', 79872],
      ['C:\\Windows\\System32\\taskkill.exe', 80384],
      ['C:\\Windows\\System32\\net1.exe', 196608],
    ];
    for (const [binPath, binSize] of serviceBinaries) {
      const lastSep = binPath.lastIndexOf('\\');
      if (lastSep > 2) this.mkdirp(binPath.substring(0, lastSep));
      if (!this.resolve(binPath)) {
        this.createFile(binPath, '');
        const entry = this.resolve(binPath);
        if (entry) {
          entry.size = binSize;
          entry.attributes.add('system');
        }
      }
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
      owner: 'BUILTIN\\Administrators',
      acl: [],
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

  /** Recursively delete a directory and all its contents. */
  deleteDirectory(absPath: string): { ok: boolean; error?: string } {
    const pair = this.resolveParent(absPath);
    if (!pair) return { ok: false, error: 'The system cannot find the path specified.' };
    const [parent, childName] = pair;
    const key = childName.toLowerCase();
    const existing = parent.children.get(key);
    if (!existing) return { ok: false, error: 'The system cannot find the path specified.' };
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

  tree(absPath: string, showFiles = false): string {
    const entry = this.resolve(absPath);
    if (!entry || entry.type !== 'directory') return 'Invalid path - ' + absPath;

    const lines: string[] = [absPath];
    this._tree(entry, '', lines, showFiles);
    return lines.join('\n');
  }

  private _tree(entry: WinFSEntry, prefix: string, lines: string[], showFiles: boolean): void {
    let children = Array.from(entry.children.values())
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    if (!showFiles) {
      children = children.filter(c => c.type === 'directory');
    }

    for (let i = 0; i < children.length; i++) {
      const isLast = i === children.length - 1;
      const connector = isLast ? '└───' : '├───';
      const extension = isLast ? '    ' : '│   ';
      lines.push(prefix + connector + children[i].name);
      if (children[i].type === 'directory') {
        this._tree(children[i], prefix + extension, lines, showFiles);
      }
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

  // ─── ACL Operations ─────────────────────────────────────────────

  getACL(absPath: string): WinACE[] {
    const entry = this.resolve(absPath);
    if (!entry) return [];
    return [...entry.acl];
  }

  getOwner(absPath: string): string {
    const entry = this.resolve(absPath);
    return entry?.owner ?? 'BUILTIN\\Administrators';
  }

  setOwner(absPath: string, owner: string): boolean {
    const entry = this.resolve(absPath);
    if (!entry) return false;
    entry.owner = owner;
    return true;
  }

  addACE(absPath: string, ace: WinACE): boolean {
    const entry = this.resolve(absPath);
    if (!entry) return false;
    // Remove existing ACE for same principal+type before adding
    entry.acl = entry.acl.filter(
      a => !(a.principal.toLowerCase() === ace.principal.toLowerCase() && a.type === ace.type)
    );
    entry.acl.push(ace);
    return true;
  }

  isAclProtected(absPath: string): boolean {
    const entry = this.resolve(absPath);
    return entry?.aclProtected === true;
  }

  removeACEs(absPath: string, principal: string): boolean {
    const entry = this.resolve(absPath);
    if (!entry) return false;
    const before = entry.acl.length;
    entry.acl = entry.acl.filter(a => a.principal.toLowerCase() !== principal.toLowerCase());
    return entry.acl.length !== before;
  }
}
