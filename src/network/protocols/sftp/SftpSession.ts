/**
 * SftpSession — client-side SSH File Transfer Protocol session.
 *
 * Transport: JSON-over-TCP on port 22.
 * All SFTP operations (auth, ls, cd, get, put, …) are encoded as JSON
 * request/response pairs sent over a TcpConnection.
 *
 * Because the simulator's cable delivery chain is synchronous, the server's
 * onData handler fires during conn.write(request), so sendRequest() can
 * collect the response synchronously before write() returns.
 *
 * connect() is the only async method because establishing the TCP connection
 * requires one ARP resolution (one microtask) followed by one SYN→SYN-ACK
 * roundtrip (also resolved as a microtask since delivery is synchronous).
 *
 * Standards:
 *   - draft-ietf-secsh-filexfer (SSH File Transfer Protocol)
 *   - Authentication based on RFC 4252 (SSH Auth)
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { TcpConnector, TcpConnection } from '@/network/core/TcpConnection';

export class SftpSession {
  private conn: TcpConnection | null = null;
  private remoteUser = '';
  private remoteCwd = '/';
  private localCwd: string;

  constructor(
    private readonly localVfs: VirtualFileSystem,
    private readonly tcpConnector: TcpConnector,
    initialLocalCwd: string,
    private readonly localUser: string,
  ) {
    this.localCwd = initialLocalCwd;
  }

  // ─── Connection ─────────────────────────────────────────────────────

  /**
   * Connect to a remote SFTP server.
   * @param userAtHost  "user@host" or bare "host" (uses localUser).
   * @param password    Password for authentication.
   * @returns  Empty string on success; human-readable error otherwise.
   */
  async connect(userAtHost: string, password: string): Promise<string> {
    const { user, host } = parseUserAtHost(userAtHost, this.localUser);

    const conn = await this.tcpConnector(host, 22);
    if (!conn) {
      return `ssh: connect to host ${host} port 22: No route to host`;
    }

    this.conn = conn;

    const authResp = this.sendRequest({ op: 'auth', user, password });
    if (!authResp.ok) {
      this.conn = null;
      return `${user}@${host}: Permission denied (publickey,password).`;
    }

    this.remoteUser = user;
    this.remoteCwd  = (authResp.cwd as string) ?? '/';
    return '';
  }

  disconnect(): void {
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
    this.remoteUser = '';
    this.remoteCwd  = '/';
  }

  isConnected(): boolean { return this.conn !== null; }
  getPrompt(): string    { return 'sftp> '; }

  // ─── Remote navigation ──────────────────────────────────────────────

  pwd(): string { return `Remote working directory: ${this.remoteCwd}`; }

  ls(args: string[]): string {
    if (!this.conn) return 'Not connected.';
    const req: Record<string, unknown> = { op: 'ls' };
    if (args[0]) req.path = args[0];
    const resp = this.sendRequest(req);
    if (!resp.ok) return `ls: cannot access '${args[0] ?? this.remoteCwd}': No such file or directory`;
    return (resp.entries as string[]).join('  ');
  }

  cd(path: string): string {
    if (!this.conn) return 'Not connected.';
    const resp = this.sendRequest({ op: 'cd', path });
    if (!resp.ok) {
      if (String(resp.error ?? '').includes('Not a directory')) return `${path}: Not a directory`;
      return `Couldn't canonicalize: No such file or directory`;
    }
    this.remoteCwd = resp.cwd as string;
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
    if (!this.conn) return 'Not connected.';

    const resp = this.sendRequest({ op: 'get', path: remotePath });
    if (!resp.ok) {
      const err = String(resp.error ?? '');
      if (err.includes('not a regular file')) return `${remotePath}: not a regular file`;
      return `File "${remotePath}" not found.  Ensure that the path and access permissions are correct.  No such file or directory`;
    }

    const content  = (resp.content as string) ?? '';
    const basename = baseName(remotePath);
    const absLocal = localPath
      ? this.localVfs.normalizePath(localPath, this.localCwd)
      : `${this.localCwd}/${basename}`;

    this.localVfs.writeFile(absLocal, content, 0, 0, 0o022);
    return formatTransferLine(basename, content.length);
  }

  // ─── Upload ─────────────────────────────────────────────────────────

  put(localPath: string, remotePath?: string): string {
    if (!this.conn) return 'Not connected.';

    const absLocal   = this.localVfs.normalizePath(localPath, this.localCwd);
    const localInode = this.localVfs.resolveInode(absLocal);
    if (!localInode)                    return `${absLocal}: No such file or directory`;
    if (localInode.type !== 'file')     return `${absLocal}: not a regular file`;

    const content   = this.localVfs.readFile(absLocal) ?? '';
    const basename  = baseName(absLocal);
    const absRemote = remotePath ?? `${this.remoteCwd}/${basename}`;

    const resp = this.sendRequest({ op: 'put', path: absRemote, content });
    if (!resp.ok) return `Couldn't write file: ${resp.error}`;
    return formatTransferLine(basename, content.length);
  }

  // ─── Remote file operations ─────────────────────────────────────────

  mkdir(path: string): string {
    if (!this.conn) return 'Not connected.';
    const resp = this.sendRequest({ op: 'mkdir', path });
    if (!resp.ok) return `Couldn't create directory: ${resp.error}`;
    return '';
  }

  rm(path: string): string {
    if (!this.conn) return 'Not connected.';
    const resp = this.sendRequest({ op: 'rm', path });
    if (!resp.ok) return `${path}: ${resp.error ?? 'Failed to remove'}`;
    return '';
  }

  rmdir(path: string): string {
    if (!this.conn) return 'Not connected.';
    const resp = this.sendRequest({ op: 'rmdir', path });
    if (!resp.ok) {
      const err = String(resp.error ?? '');
      if (err.includes('Not a directory'))    return `${path}: Not a directory`;
      if (err.includes('No such'))            return `${path}: No such file or directory`;
      return `Couldn't remove directory: ${resp.error}`;
    }
    return '';
  }

  rename(oldPath: string, newPath: string): string {
    if (!this.conn) return 'Not connected.';
    const resp = this.sendRequest({ op: 'rename', old: oldPath, new: newPath });
    if (!resp.ok) {
      if (String(resp.error ?? '').includes('No such')) return `${oldPath}: No such file or directory`;
      return `Couldn't rename file: operation failed`;
    }
    return '';
  }

  // ─── Private ────────────────────────────────────────────────────────

  /**
   * Send a JSON request and collect the synchronous response.
   *
   * Registers a one-shot onData handler BEFORE calling write() so it catches
   * the response that arrives synchronously during network delivery.
   */
  private sendRequest(req: object): Record<string, unknown> {
    if (!this.conn) return { ok: false, error: 'Not connected' };

    let resp: Record<string, unknown> | null = null;
    const off = this.conn.onData((data: string) => {
      try { resp = JSON.parse(data) as Record<string, unknown>; } catch {
        resp = { ok: false, error: 'parse error' };
      }
    });

    this.conn.write(JSON.stringify(req));
    off(); // unregister after the synchronous delivery

    return resp ?? { ok: false, error: 'No response from server' };
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

function baseName(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? 'file';
}

function formatTransferLine(name: string, bytes: number): string {
  const kb = (bytes / 1024).toFixed(1);
  return `${name}                                    100% ${bytes}   ${kb}KB/s   00:00`;
}
