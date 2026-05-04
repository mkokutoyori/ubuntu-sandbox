/**
 * SftpSession — client-side SSH File Transfer Protocol session.
 *
 * Implements the core SFTP operations defined in draft-ietf-secsh-filexfer:
 *   SSH_FXP_OPENDIR / SSH_FXP_READDIR → ls / lls
 *   SSH_FXP_REALPATH                  → pwd / lpwd
 *   SSH_FXP_SETSTAT / SSH_FXP_RENAME  → rename
 *   SSH_FXP_REMOVE                    → rm
 *   SSH_FXP_RMDIR                     → rmdir
 *   SSH_FXP_MKDIR                     → mkdir
 *   SSH_FXP_READ  / SSH_FXP_WRITE     → get / put
 *
 * Authentication: delegates to ISftpUserAuth (RFC 4252 simulation).
 *
 * Cross-platform: the remote VFS is accessed through ISftpFileSystem so
 * both Linux (VirtualFileSystem) and Windows (WindowsFileSystem) servers
 * are supported.  The local VFS is always a Linux VirtualFileSystem
 * (the client is always a Linux machine).
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { SocketTable } from '@/network/core/SocketTable';
import type { ISftpServer, SftpServerResolver } from './ISftpServer';

export class SftpSession {
  private server: ISftpServer | null = null;
  private remoteUser = '';
  private remoteCwd = '/';
  private localCwd: string;
  private socketId: number | null = null;

  constructor(
    private readonly localVfs: VirtualFileSystem,
    private readonly socketTable: SocketTable,
    private readonly resolver: SftpServerResolver,
    initialLocalCwd: string,
    private readonly localIp: string,
    private readonly localUser: string,
  ) {
    this.localCwd = initialLocalCwd;
  }

  // ─── Connection ─────────────────────────────────────────────────────

  /**
   * Connect to a remote host.
   * @param userAtHost  "user@host" or bare "host" (uses localUser).
   * @param password    Password for authentication.
   * @returns  Empty string on success; human-readable error otherwise.
   */
  connect(userAtHost: string, password: string): string {
    const { user, host } = parseUserAtHost(userAtHost, this.localUser);
    const server = this.resolver(host);
    if (!server) {
      return `ssh: connect to host ${host} port 22: No route to host`;
    }

    if (!server.userMgr.checkPassword(user, password)) {
      return `${user}@${host}: Permission denied (publickey,password).`;
    }

    this.server     = server;
    this.remoteUser = user;
    this.remoteCwd  = server.userMgr.getHomeDirectory(user);

    const localPort = this.socketTable.allocateEphemeralPort();
    const entry     = this.socketTable.connect(
      'tcp', this.localIp, localPort, host, 22,
      undefined, 'sftp',
    );
    this.socketId = entry.id;
    return '';
  }

  disconnect(): void {
    if (this.socketId !== null) {
      this.socketTable.close(this.socketId);
      this.socketId = null;
    }
    this.server     = null;
    this.remoteUser = '';
    this.remoteCwd  = '/';
  }

  isConnected(): boolean { return this.server !== null; }
  getPrompt(): string    { return 'sftp> '; }

  // ─── Remote navigation ──────────────────────────────────────────────

  pwd(): string { return `Remote working directory: ${this.remoteCwd}`; }

  ls(args: string[]): string {
    if (!this.server) return 'Not connected.';
    const path = args[0]
      ? this.server.vfs.normalizePath(args[0], this.remoteCwd)
      : this.remoteCwd;
    const entries = this.server.vfs.listDirectory(path);
    if (!entries) return `ls: cannot access '${path}': No such file or directory`;
    return entries.map(e => e.name).join('  ');
  }

  cd(path: string): string {
    if (!this.server) return 'Not connected.';
    const abs  = this.server.vfs.normalizePath(path, this.remoteCwd);
    const type = this.server.vfs.getEntryType(abs);
    if (!type)              return `Couldn't canonicalize: No such file or directory`;
    if (type !== 'directory') return `${abs}: Not a directory`;
    this.remoteCwd = abs;
    return '';
  }

  // ─── Local navigation ───────────────────────────────────────────────

  lpwd(): string { return `Local working directory: ${this.localCwd}`; }

  lls(args: string[]): string {
    const path = args[0]
      ? this.localVfs.normalizePath(args[0], this.localCwd)
      : this.localCwd;
    const entries = this.localVfs.listDirectory(path);
    if (!entries) return `lls: cannot access '${path}': No such file or directory`;
    return entries
      .filter(e => e.name !== '.' && e.name !== '..')
      .map(e => e.name)
      .join('  ');
  }

  lcd(path: string): string {
    const abs   = this.localVfs.normalizePath(path, this.localCwd);
    const inode = this.localVfs.resolveInode(abs);
    if (!inode)                    return `Local directory not accessible: No such file or directory`;
    if (inode.type !== 'directory') return `${abs}: Not a directory`;
    this.localCwd = abs;
    return '';
  }

  // ─── Download ───────────────────────────────────────────────────────

  get(remotePath: string, localPath?: string): string {
    if (!this.server) return 'Not connected.';

    const absRemote = this.server.vfs.normalizePath(remotePath, this.remoteCwd);
    const remoteType = this.server.vfs.getEntryType(absRemote);
    if (!remoteType) {
      return `File "${absRemote}" not found.  Ensure that the path and access permissions are correct.  No such file or directory`;
    }
    if (remoteType !== 'file') return `${absRemote}: not a regular file`;

    const basename = baseName(absRemote);
    const absLocal  = localPath
      ? this.localVfs.normalizePath(localPath, this.localCwd)
      : `${this.localCwd}/${basename}`;

    const content = this.server.vfs.readFile(absRemote) ?? '';
    this.localVfs.writeFile(absLocal, content, 0, 0, 0o022);
    return formatTransferLine(basename, content.length);
  }

  // ─── Upload ─────────────────────────────────────────────────────────

  put(localPath: string, remotePath?: string): string {
    if (!this.server) return 'Not connected.';

    const absLocal   = this.localVfs.normalizePath(localPath, this.localCwd);
    const localInode = this.localVfs.resolveInode(absLocal);
    if (!localInode)                    return `${absLocal}: No such file or directory`;
    if (localInode.type !== 'file')     return `${absLocal}: not a regular file`;

    const basename  = baseName(absLocal);
    const absRemote = remotePath
      ? this.server.vfs.normalizePath(remotePath, this.remoteCwd)
      : `${this.remoteCwd}/${basename}`;

    const content = this.localVfs.readFile(absLocal) ?? '';
    this.server.vfs.writeFile(absRemote, content);
    return formatTransferLine(basename, content.length);
  }

  // ─── Remote file operations ─────────────────────────────────────────

  mkdir(path: string): string {
    if (!this.server) return 'Not connected.';
    const abs = this.server.vfs.normalizePath(path, this.remoteCwd);
    if (this.server.vfs.exists(abs)) return `Couldn't create directory: File exists`;
    this.server.vfs.mkdirp(abs);
    return '';
  }

  rm(path: string): string {
    if (!this.server) return 'Not connected.';
    const abs  = this.server.vfs.normalizePath(path, this.remoteCwd);
    const type = this.server.vfs.getEntryType(abs);
    if (!type) return `${abs}: No such file or directory`;
    const ok = this.server.vfs.deleteFile(abs);
    if (!ok)   return `Couldn't delete file: ${abs}`;
    return '';
  }

  rmdir(path: string): string {
    if (!this.server) return 'Not connected.';
    const abs  = this.server.vfs.normalizePath(path, this.remoteCwd);
    const type = this.server.vfs.getEntryType(abs);
    if (!type)              return `${abs}: No such file or directory`;
    if (type !== 'directory') return `${abs}: Not a directory`;
    const ok = this.server.vfs.rmdir(abs);
    if (!ok)   return `Couldn't remove directory: ${abs}`;
    return '';
  }

  rename(oldPath: string, newPath: string): string {
    if (!this.server) return 'Not connected.';
    const absOld = this.server.vfs.normalizePath(oldPath, this.remoteCwd);
    const absNew = this.server.vfs.normalizePath(newPath, this.remoteCwd);
    const type   = this.server.vfs.getEntryType(absOld);
    if (!type) return `${absOld}: No such file or directory`;
    const ok = this.server.vfs.rename(absOld, absNew);
    if (!ok)   return `Couldn't rename file: operation failed`;
    return '';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseUserAtHost(
  userAtHost: string,
  defaultUser: string,
): { user: string; host: string } {
  const atIdx = userAtHost.indexOf('@');
  if (atIdx === -1) return { user: defaultUser, host: userAtHost };
  return { user: userAtHost.slice(0, atIdx), host: userAtHost.slice(atIdx + 1) };
}

/** Last component of any path (POSIX or Windows). */
function baseName(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? 'file';
}

function formatTransferLine(name: string, bytes: number): string {
  const kb = (bytes / 1024).toFixed(1);
  return `${name}                                    100% ${bytes}   ${kb}KB/s   00:00`;
}
