/**
 * Windows Virtual Filesystem
 * Simulates a Windows filesystem with common directories and files
 */

import { WindowsFileNode, WindowsUser, FileAttributes } from './types';

export class WindowsFileSystem {
  drives: Map<string, WindowsFileNode>;
  users: Map<string, WindowsUser>;
  currentDrive: string = 'C:';

  constructor() {
    this.drives = new Map();
    this.users = new Map();
    this.initializeUsers();
    this.initializeFileSystem();
  }

  private defaultAttributes(): FileAttributes {
    return {
      readonly: false,
      hidden: false,
      system: false,
      archive: true,
    };
  }

  private systemAttributes(): FileAttributes {
    return {
      readonly: true,
      hidden: true,
      system: true,
      archive: false,
    };
  }

  private hiddenAttributes(): FileAttributes {
    return {
      readonly: false,
      hidden: true,
      system: false,
      archive: true,
    };
  }

  private createDir(name: string, attributes?: Partial<FileAttributes>): WindowsFileNode {
    return {
      name,
      type: 'directory',
      children: new Map(),
      attributes: { ...this.defaultAttributes(), ...attributes },
      size: 0,
      modified: new Date(),
      created: new Date(),
      accessed: new Date(),
    };
  }

  private createFile(name: string, content = '', attributes?: Partial<FileAttributes>): WindowsFileNode {
    return {
      name,
      type: 'file',
      content,
      attributes: { ...this.defaultAttributes(), ...attributes },
      size: content.length,
      modified: new Date(),
      created: new Date(),
      accessed: new Date(),
    };
  }

  private initializeUsers(): void {
    const users: WindowsUser[] = [
      {
        username: 'Administrator',
        fullName: 'Administrator',
        isAdmin: true,
        groups: ['Administrators', 'Users'],
        homeDir: 'C:\\Users\\Administrator',
        sid: 'S-1-5-21-0-0-0-500',
      },
      {
        username: 'User',
        fullName: 'Local User',
        isAdmin: false,
        groups: ['Users'],
        homeDir: 'C:\\Users\\User',
        sid: 'S-1-5-21-0-0-0-1001',
      },
      {
        username: 'SYSTEM',
        fullName: 'Local System',
        isAdmin: true,
        groups: ['SYSTEM'],
        homeDir: 'C:\\Windows\\System32\\config\\systemprofile',
        sid: 'S-1-5-18',
      },
    ];

    users.forEach(user => this.users.set(user.username.toLowerCase(), user));
  }

  private initializeFileSystem(): void {
    // Create C: drive
    const cDrive = this.createDir('C:');

    // Windows directory
    const windows = this.createDir('Windows', this.systemAttributes());

    const system32 = this.createDir('System32', this.systemAttributes());
    const drivers = this.createDir('drivers', this.systemAttributes());
    const etc = this.createDir('etc');
    etc.children!.set('hosts', this.createFile('hosts',
      '# Copyright (c) 1993-2009 Microsoft Corp.\r\n#\r\n# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.\r\n#\r\n# localhost name resolution is handled within DNS itself.\r\n#\t127.0.0.1       localhost\r\n#\t::1             localhost\r\n127.0.0.1       localhost\r\n'));
    drivers.children!.set('etc', etc);
    system32.children!.set('drivers', drivers);

    // System32 executables (simulated)
    const sysExes = ['cmd.exe', 'powershell.exe', 'notepad.exe', 'taskmgr.exe', 'regedit.exe',
                     'mmc.exe', 'control.exe', 'explorer.exe', 'calc.exe', 'mspaint.exe',
                     'ipconfig.exe', 'ping.exe', 'netstat.exe', 'tracert.exe', 'nslookup.exe',
                     'systeminfo.exe', 'tasklist.exe', 'taskkill.exe', 'shutdown.exe', 'net.exe',
                     'xcopy.exe', 'robocopy.exe', 'attrib.exe', 'findstr.exe', 'where.exe'];
    sysExes.forEach(exe => {
      system32.children!.set(exe, this.createFile(exe, '[PE Executable]', this.systemAttributes()));
    });

    // Config directory
    const config = this.createDir('config', this.systemAttributes());
    config.children!.set('SAM', this.createFile('SAM', '[Registry Hive]', this.systemAttributes()));
    config.children!.set('SYSTEM', this.createFile('SYSTEM', '[Registry Hive]', this.systemAttributes()));
    config.children!.set('SOFTWARE', this.createFile('SOFTWARE', '[Registry Hive]', this.systemAttributes()));
    system32.children!.set('config', config);

    windows.children!.set('System32', system32);
    windows.children!.set('SysWOW64', this.createDir('SysWOW64', this.systemAttributes()));
    windows.children!.set('Temp', this.createDir('Temp'));
    windows.children!.set('Fonts', this.createDir('Fonts', this.systemAttributes()));
    windows.children!.set('INF', this.createDir('INF', this.systemAttributes()));
    windows.children!.set('Help', this.createDir('Help'));
    windows.children!.set('Logs', this.createDir('Logs'));

    // Prefetch
    const prefetch = this.createDir('Prefetch', { hidden: true });
    windows.children!.set('Prefetch', prefetch);

    // explorer.exe
    windows.children!.set('explorer.exe', this.createFile('explorer.exe', '[PE Executable]', this.systemAttributes()));

    cDrive.children!.set('Windows', windows);

    // Program Files
    const programFiles = this.createDir('Program Files');
    const commonFiles = this.createDir('Common Files');
    programFiles.children!.set('Common Files', commonFiles);
    programFiles.children!.set('Internet Explorer', this.createDir('Internet Explorer'));
    programFiles.children!.set('Windows Defender', this.createDir('Windows Defender'));
    programFiles.children!.set('Windows NT', this.createDir('Windows NT'));

    const windowsPowerShell = this.createDir('WindowsPowerShell');
    const modules = this.createDir('Modules');
    windowsPowerShell.children!.set('Modules', modules);
    programFiles.children!.set('WindowsPowerShell', windowsPowerShell);

    cDrive.children!.set('Program Files', programFiles);
    cDrive.children!.set('Program Files (x86)', this.createDir('Program Files (x86)'));

    // Users directory
    const usersDir = this.createDir('Users');

    // Default user profile template
    const defaultProfile = this.createDir('Default', this.hiddenAttributes());
    usersDir.children!.set('Default', defaultProfile);

    // Public folder
    const publicDir = this.createDir('Public');
    publicDir.children!.set('Documents', this.createDir('Documents'));
    publicDir.children!.set('Downloads', this.createDir('Downloads'));
    publicDir.children!.set('Music', this.createDir('Music'));
    publicDir.children!.set('Pictures', this.createDir('Pictures'));
    publicDir.children!.set('Videos', this.createDir('Videos'));
    publicDir.children!.set('Desktop', this.createDir('Desktop'));
    usersDir.children!.set('Public', publicDir);

    // User profile
    const userProfile = this.createUserProfile('User');
    usersDir.children!.set('User', userProfile);

    // Administrator profile
    const adminProfile = this.createUserProfile('Administrator');
    usersDir.children!.set('Administrator', adminProfile);

    cDrive.children!.set('Users', usersDir);

    // ProgramData
    const programData = this.createDir('ProgramData', this.hiddenAttributes());
    programData.children!.set('Microsoft', this.createDir('Microsoft'));
    programData.children!.set('Package Cache', this.createDir('Package Cache'));
    cDrive.children!.set('ProgramData', programData);

    // Temp
    cDrive.children!.set('Temp', this.createDir('Temp'));

    // Root files
    cDrive.children!.set('pagefile.sys', this.createFile('pagefile.sys', '[System File]', { ...this.systemAttributes(), hidden: true }));
    cDrive.children!.set('hiberfil.sys', this.createFile('hiberfil.sys', '[System File]', { ...this.systemAttributes(), hidden: true }));

    this.drives.set('C:', cDrive);

    // Create D: drive (optional data drive)
    const dDrive = this.createDir('D:');
    dDrive.children!.set('Data', this.createDir('Data'));
    dDrive.children!.set('Backup', this.createDir('Backup'));
    this.drives.set('D:', dDrive);
  }

  private createUserProfile(username: string): WindowsFileNode {
    const profile = this.createDir(username);

    // Standard Windows user folders
    profile.children!.set('Desktop', this.createDir('Desktop'));
    profile.children!.set('Documents', this.createDir('Documents'));
    profile.children!.set('Downloads', this.createDir('Downloads'));
    profile.children!.set('Music', this.createDir('Music'));
    profile.children!.set('Pictures', this.createDir('Pictures'));
    profile.children!.set('Videos', this.createDir('Videos'));
    profile.children!.set('Favorites', this.createDir('Favorites'));
    profile.children!.set('Contacts', this.createDir('Contacts'));
    profile.children!.set('Links', this.createDir('Links'));
    profile.children!.set('Saved Games', this.createDir('Saved Games'));
    profile.children!.set('Searches', this.createDir('Searches'));

    // AppData
    const appData = this.createDir('AppData', this.hiddenAttributes());
    appData.children!.set('Local', this.createDir('Local'));
    appData.children!.set('LocalLow', this.createDir('LocalLow'));
    appData.children!.set('Roaming', this.createDir('Roaming'));

    const localTemp = appData.children!.get('Local')!;
    localTemp.children!.set('Temp', this.createDir('Temp'));
    localTemp.children!.set('Microsoft', this.createDir('Microsoft'));

    profile.children!.set('AppData', appData);

    // NTUSER.DAT
    profile.children!.set('NTUSER.DAT', this.createFile('NTUSER.DAT', '[Registry Hive]', this.hiddenAttributes()));

    // Welcome file
    const welcomeContent = `Welcome to Windows Terminal Simulator!\r\n\r\nThis is a virtual Windows environment.\r\nTry some commands:\r\n  - dir, cd, type\r\n  - copy, move, del\r\n  - ipconfig, ping\r\n  - cls, help\r\n\r\nType 'powershell' to enter PowerShell mode!\r\n`;
    profile.children!.get('Documents')!.children!.set('welcome.txt', this.createFile('welcome.txt', welcomeContent));

    return profile;
  }

  // Path resolution - handles Windows paths like C:\Users\User
  resolvePath(path: string, currentPath: string): string {
    // Handle empty path
    if (!path) return currentPath;

    // Normalize slashes
    path = path.replace(/\//g, '\\');
    currentPath = currentPath.replace(/\//g, '\\');

    // Handle drive letter
    if (path.match(/^[A-Za-z]:/)) {
      return this.normalizePath(path);
    }

    // Handle root of current drive
    if (path === '\\') {
      const drive = currentPath.match(/^[A-Za-z]:/)?.[0] || 'C:';
      return drive + '\\';
    }

    // Handle relative path
    if (path.startsWith('\\')) {
      const drive = currentPath.match(/^[A-Za-z]:/)?.[0] || 'C:';
      return this.normalizePath(drive + path);
    }

    return this.normalizePath(currentPath + '\\' + path);
  }

  normalizePath(path: string): string {
    // Normalize slashes
    path = path.replace(/\//g, '\\');

    // Extract drive
    const driveMatch = path.match(/^([A-Za-z]:)/);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : 'C:';
    const rest = driveMatch ? path.slice(2) : path;

    // Split and process
    const parts = rest.split('\\').filter(p => p !== '' && p !== '.');
    const result: string[] = [];

    for (const part of parts) {
      if (part === '..') {
        result.pop();
      } else {
        result.push(part);
      }
    }

    if (result.length === 0) {
      return drive + '\\';
    }

    return drive + '\\' + result.join('\\');
  }

  // Get node at path
  getNode(path: string): WindowsFileNode | null {
    path = this.normalizePath(path);

    const driveMatch = path.match(/^([A-Za-z]:)/);
    if (!driveMatch) return null;

    const drive = driveMatch[1].toUpperCase();
    const driveNode = this.drives.get(drive);
    if (!driveNode) return null;

    // Root of drive
    if (path === drive || path === drive + '\\') {
      return driveNode;
    }

    // Navigate path
    const parts = path.slice(3).split('\\').filter(p => p);
    let current = driveNode;

    for (const part of parts) {
      if (current.type !== 'directory' || !current.children) {
        return null;
      }

      // Case-insensitive search (Windows behavior)
      let found: WindowsFileNode | null = null;
      current.children.forEach((node, name) => {
        if (name.toLowerCase() === part.toLowerCase()) {
          found = node;
        }
      });

      if (!found) return null;
      current = found;
    }

    return current;
  }

  // Create file or directory
  createNode(path: string, type: 'file' | 'directory', content = ''): boolean {
    path = this.normalizePath(path);

    const lastSlash = path.lastIndexOf('\\');
    const parentPath = lastSlash > 2 ? path.substring(0, lastSlash) : path.substring(0, 3);
    const name = path.substring(lastSlash + 1);

    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;

    // Check if already exists (case-insensitive)
    let exists = false;
    parent.children!.forEach((_, n) => {
      if (n.toLowerCase() === name.toLowerCase()) exists = true;
    });
    if (exists) return false;

    if (type === 'directory') {
      parent.children!.set(name, this.createDir(name));
    } else {
      parent.children!.set(name, this.createFile(name, content));
    }

    return true;
  }

  // Delete node
  deleteNode(path: string, recursive = false): boolean {
    path = this.normalizePath(path);

    // Can't delete drive root
    if (path.match(/^[A-Za-z]:\\?$/)) return false;

    const lastSlash = path.lastIndexOf('\\');
    const parentPath = lastSlash > 2 ? path.substring(0, lastSlash) : path.substring(0, 3);
    const name = path.substring(lastSlash + 1);

    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;

    // Find actual name (case-insensitive)
    let actualName: string | null = null;
    parent.children!.forEach((_, n) => {
      if (n.toLowerCase() === name.toLowerCase()) actualName = n;
    });

    if (!actualName) return false;

    const node = parent.children!.get(actualName)!;

    // Check if directory has contents
    if (node.type === 'directory' && node.children!.size > 0 && !recursive) {
      return false;
    }

    parent.children!.delete(actualName);
    return true;
  }

  // Update file content
  updateFile(path: string, content: string): boolean {
    const node = this.getNode(path);
    if (!node || node.type !== 'file') return false;

    if (node.attributes.readonly) return false;

    node.content = content;
    node.size = content.length;
    node.modified = new Date();
    return true;
  }

  // Copy node
  copyNode(src: string, dest: string): boolean {
    const srcNode = this.getNode(src);
    if (!srcNode) return false;

    dest = this.normalizePath(dest);
    const lastSlash = dest.lastIndexOf('\\');
    const parentPath = lastSlash > 2 ? dest.substring(0, lastSlash) : dest.substring(0, 3);
    const destName = dest.substring(lastSlash + 1);

    const destParent = this.getNode(parentPath);
    if (!destParent || destParent.type !== 'directory') return false;

    const copy = this.deepCopyNode(srcNode, destName);
    destParent.children!.set(destName, copy);
    return true;
  }

  private deepCopyNode(node: WindowsFileNode, newName: string): WindowsFileNode {
    if (node.type === 'file') {
      return this.createFile(newName, node.content || '', { ...node.attributes });
    }

    const copy = this.createDir(newName, { ...node.attributes });
    if (node.children) {
      node.children.forEach((child, name) => {
        copy.children!.set(name, this.deepCopyNode(child, name));
      });
    }
    return copy;
  }

  // Move/rename node
  moveNode(src: string, dest: string): boolean {
    src = this.normalizePath(src);
    dest = this.normalizePath(dest);

    const srcLastSlash = src.lastIndexOf('\\');
    const srcParentPath = srcLastSlash > 2 ? src.substring(0, srcLastSlash) : src.substring(0, 3);
    const srcName = src.substring(srcLastSlash + 1);

    const srcParent = this.getNode(srcParentPath);
    if (!srcParent || srcParent.type !== 'directory') return false;

    // Find actual source name (case-insensitive)
    let actualSrcName: string | null = null;
    srcParent.children!.forEach((_, n) => {
      if (n.toLowerCase() === srcName.toLowerCase()) actualSrcName = n;
    });

    if (!actualSrcName) return false;

    const node = srcParent.children!.get(actualSrcName)!;

    const destLastSlash = dest.lastIndexOf('\\');
    const destParentPath = destLastSlash > 2 ? dest.substring(0, destLastSlash) : dest.substring(0, 3);
    const destName = dest.substring(destLastSlash + 1);

    const destParent = this.getNode(destParentPath);
    if (!destParent || destParent.type !== 'directory') return false;

    // Remove from source
    srcParent.children!.delete(actualSrcName);

    // Add to destination
    node.name = destName;
    destParent.children!.set(destName, node);

    return true;
  }

  // List directory contents
  listDirectory(path: string): WindowsFileNode[] | null {
    const node = this.getNode(path);
    if (!node || node.type !== 'directory') return null;

    return Array.from(node.children!.values());
  }

  // Get user
  getUser(username: string): WindowsUser | undefined {
    return this.users.get(username.toLowerCase());
  }

  // Check if path exists
  exists(path: string): boolean {
    return this.getNode(path) !== null;
  }

  // Get available drives
  getDrives(): string[] {
    return Array.from(this.drives.keys());
  }
}

// Singleton instance
export const windowsFileSystem = new WindowsFileSystem();
