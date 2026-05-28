/**
 * SftpSession — client-side SFTP facade built on top of SshSession.
 *
 * Replaces the legacy `protocols/sftp/SftpSession.ts`. The new session
 * negotiates SSH first (host key + auth) and only then opens the SFTP
 * channel; commands are routed through that channel.
 *
 * Reference: DESIGN-SSH-SFTP.md section 9.3 ; BRD-SSH-SFTP.md SFTP-01.
 */

import type { TcpConnector } from '@/network/core/TcpConnection';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type {
  ISshSftpChannel,
  SftpResponse,
} from '../channels/ISshChannel';
import type { ISshInteractionHandler } from '../session/ISshInteractionHandler';
import { isErr } from '../Result';
import type { ISshSession } from '../session/ISshSession';
import { SshSession } from '../session/SshSession';
import type { StrictHostKeyChecking } from '../SshConnectOptions';
import { SshConnectOptionsBuilder } from '../SshConnectOptions';
import {
  formatTransferProgress,
  formatLsLongEntry,
  expandTilde,
} from '../SshPureUtils';
import type { SftpDirEntry } from './ISftpFileSystem';

export interface SftpConnectOptions {
  readonly port?: number;
  readonly identityFiles?: readonly string[];
  readonly strictHostKeyChecking?: StrictHostKeyChecking;
  readonly password?: string;
}

export interface SftpSessionDeps {
  readonly tcpConnector: TcpConnector;
  readonly localVfs: VirtualFileSystem;
  readonly localUser: string;
  readonly localUid: number;
  readonly localGid: number;
  readonly localCwd: string;
  readonly knownHostsPath: string;
  readonly interactionHandler: ISshInteractionHandler;
  readonly homeDirectory: string;
}

export class SftpSession {
  private ssh: ISshSession;
  private channel: ISshSftpChannel | null = null;
  private localCwd: string;
  private remoteCwd = '/';
  private remoteUser = '';
  private remoteHost = '';

  constructor(private readonly deps: SftpSessionDeps) {
    this.localCwd = deps.localCwd;
    this.ssh = new SshSession({
      tcpConnector: deps.tcpConnector,
      vfs: deps.localVfs,
      localUser: deps.localUser,
      localUid: deps.localUid,
      localGid: deps.localGid,
      knownHostsPath: deps.knownHostsPath,
      interactionHandler: deps.interactionHandler,
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async connect(
    userAtHost: string,
    opts: SftpConnectOptions = {},
  ): Promise<string> {
    const { user, host } = parseUserAtHost(userAtHost, this.deps.localUser);
    this.remoteUser = user;
    this.remoteHost = host;

    const builder = SshConnectOptionsBuilder.create()
      .host(host)
      .user(user)
      .port(opts.port ?? 22)
      .strictHostKeyChecking(opts.strictHostKeyChecking ?? 'accept-new');
    for (const id of opts.identityFiles ?? []) builder.addIdentityFile(id);
    if (opts.password !== undefined) builder.password(opts.password);

    const result = await this.ssh.connect(builder.build());
    if (isErr(result)) return formatConnectError(user, host, result.error);

    const channelResult = this.ssh.openSftpChannel();
    if (!channelResult.ok) {
      this.ssh.disconnect();
      return `subsystem request failed on channel 0`;
    }
    this.channel = channelResult.value;
    // Initial cwd: ask the server for the home directory.
    const pwd = this.channel.sendRequest({ op: 'pwd' });
    if (pwd.ok && typeof pwd.cwd === 'string') this.remoteCwd = pwd.cwd;
    return `Connected to ${host}.`;
  }

  disconnect(): void {
    this.channel?.close();
    this.channel = null;
    this.ssh.disconnect();
  }

  isConnected(): boolean {
    return this.channel !== null && this.ssh.isConnected;
  }

  getPrompt(): string {
    return 'sftp> ';
  }

  // ── Remote navigation ────────────────────────────────────────────

  pwd(): string {
    return `Remote working directory: ${this.remoteCwd}`;
  }

  ls(args: readonly string[], flags: ReadonlySet<string>): string {
    if (!this.channel) return 'Not connected.';
    const target = this.expandRemote(args[0] ?? '.');
    const resp = this.channel.sendRequest({ op: 'ls', path: target });
    if (!resp.ok) {
      return `ls: cannot access '${args[0] ?? this.remoteCwd}': ${resp.error ?? 'No such file or directory'}`;
    }
    const entries = (resp.entries as readonly SftpDirEntry[]) ?? [];
    const filtered = flags.has('a')
      ? entries
      : entries.filter((e) => !e.name.startsWith('.'));
    if (flags.has('l')) {
      return filtered.map(formatLsLongEntry).join('\n');
    }
    if (flags.has('1')) return filtered.map((e) => e.name).join('\n');
    return filtered.map((e) => e.name).join('  ');
  }

  cd(path: string): string {
    if (!this.channel) return 'Not connected.';
    const target = this.expandRemote(path || '~');
    const resp = this.channel.sendRequest({ op: 'cd', path: target });
    if (!resp.ok) {
      const msg = String(resp.error ?? '');
      if (/not a directory/i.test(msg)) return `${path}: Not a directory`;
      if (/permission denied/i.test(msg)) return `Couldn't canonicalize: Permission denied`;
      return `Couldn't canonicalize: No such file or directory`;
    }
    if (typeof resp.cwd === 'string') this.remoteCwd = resp.cwd;
    return '';
  }

  // ── Local navigation ─────────────────────────────────────────────

  lpwd(): string {
    return `Local working directory: ${this.localCwd}`;
  }

  lls(args: readonly string[]): string {
    const path = args[0]
      ? this.deps.localVfs.normalizePath(this.expandLocal(args[0]), this.localCwd)
      : this.localCwd;
    const entries = this.deps.localVfs.listDirectory(path);
    if (!entries) return `lls: cannot access '${path}': No such file or directory`;
    return entries
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => e.name)
      .join('  ');
  }

  lcd(path: string): string {
    const abs = this.deps.localVfs.normalizePath(
      this.expandLocal(path),
      this.localCwd,
    );
    const inode = this.deps.localVfs.resolveInode(abs);
    if (!inode) return `Local directory not accessible: No such file or directory`;
    if (inode.type !== 'directory') return `${abs}: Not a directory`;
    this.localCwd = abs;
    return '';
  }

  lmkdir(path: string): string {
    const abs = this.deps.localVfs.normalizePath(
      this.expandLocal(path),
      this.localCwd,
    );
    const created = this.deps.localVfs.mkdir(
      abs,
      0o755,
      this.deps.localUid,
      this.deps.localGid,
    );
    return created
      ? ''
      : `Couldn't create local directory: ${abs}: File exists or parent missing`;
  }

  // ── Transfers ────────────────────────────────────────────────────

  get(remotePath: string, localPath?: string): string {
    if (!this.channel) return 'Not connected.';
    const remote = this.expandRemote(remotePath);
    const localBase = baseName(remotePath);
    const lines: string[] = [`Fetching ${remote} to ${localPath ?? localBase}`];

    const resp = this.channel.sendRequest({ op: 'get', path: remote });
    if (!resp.ok) {
      lines.push(`remote open("${remote}"): ${resp.error ?? 'No such file or directory'}`);
      return lines.join('\n');
    }
    const content = (resp.content as string) ?? '';
    const absLocal = localPath
      ? this.deps.localVfs.normalizePath(this.expandLocal(localPath), this.localCwd)
      : `${this.localCwd}/${localBase}`;
    this.deps.localVfs.writeFile(
      absLocal,
      content,
      this.deps.localUid,
      this.deps.localGid,
      0o022,
    );
    lines.push(formatTransferProgress(localBase, content.length));
    return lines.join('\n');
  }

  put(localPath: string, remotePath?: string): string {
    if (!this.channel) return 'Not connected.';
    const absLocal = this.deps.localVfs.normalizePath(
      this.expandLocal(localPath),
      this.localCwd,
    );
    const inode = this.deps.localVfs.resolveInode(absLocal);
    if (!inode) return `${absLocal}: No such file or directory`;
    if (inode.type !== 'file') return `${absLocal}: not a regular file`;
    const content = this.deps.localVfs.readFile(absLocal) ?? '';
    const localBase = baseName(absLocal);
    const remote = this.expandRemote(remotePath ?? `${this.remoteCwd}/${localBase}`);
    const lines = [`Uploading ${absLocal} to ${remote}`];
    const resp = this.channel.sendRequest({ op: 'put', path: remote, content });
    if (!resp.ok) {
      lines.push(`remote open("${remote}"): ${resp.error ?? 'Permission denied'}`);
      return lines.join('\n');
    }
    lines.push(formatTransferProgress(localBase, content.length));
    return lines.join('\n');
  }

  /**
   * BRD SSH-08-R3 / SFTP-12-R3: recursive download. Walks the remote
   * tree via SFTP `ls` (with attributes), mirrors directories locally,
   * then issues a flat `get` for each file. Returns concatenated output.
   */
  getRecursive(remotePath: string, localPath?: string): string {
    if (!this.channel) return 'Not connected.';
    const remote = this.expandRemote(remotePath);
    const localBase = baseName(remotePath);
    const localRoot = localPath
      ? this.deps.localVfs.normalizePath(this.expandLocal(localPath), this.localCwd)
      : `${this.localCwd}/${localBase}`;
    const lines: string[] = [];
    this.deps.localVfs.mkdir(localRoot, 0o755, this.deps.localUid, this.deps.localGid);
    this.walkDownload(remote, localRoot, lines);
    return lines.join('\n');
  }

  /**
   * BRD SSH-08-R3 / SFTP-12-R4: recursive upload. Walks the local tree
   * via the local VFS, mirrors directories on the remote, then issues a
   * flat `put` for each file.
   */
  putRecursive(localPath: string, remotePath?: string): string {
    if (!this.channel) return 'Not connected.';
    const absLocal = this.deps.localVfs.normalizePath(
      this.expandLocal(localPath),
      this.localCwd,
    );
    const inode = this.deps.localVfs.resolveInode(absLocal);
    if (!inode) return `${absLocal}: No such file or directory`;
    if (inode.type !== 'directory') {
      return this.put(localPath, remotePath);
    }
    const localBase = baseName(absLocal);
    const remoteRoot = this.expandRemote(remotePath ?? `${this.remoteCwd}/${localBase}`);
    this.channel.sendRequest({ op: 'mkdir', path: remoteRoot });
    const lines: string[] = [];
    this.walkUpload(absLocal, remoteRoot, lines);
    return lines.join('\n');
  }

  private walkDownload(remoteDir: string, localDir: string, lines: string[]): void {
    if (!this.channel) return;
    const ls = this.channel.sendRequest({ op: 'ls', path: remoteDir });
    if (!ls.ok) {
      lines.push(`${remoteDir}: ${ls.error ?? 'No such file or directory'}`);
      return;
    }
    const entries = (ls.entries as readonly SftpDirEntry[]) ?? [];
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const remoteChild = `${remoteDir.replace(/\/$/, '')}/${entry.name}`;
      const localChild = `${localDir.replace(/\/$/, '')}/${entry.name}`;
      if (entry.type === 'directory') {
        this.deps.localVfs.mkdir(
          localChild,
          entry.mode || 0o755,
          this.deps.localUid,
          this.deps.localGid,
        );
        this.walkDownload(remoteChild, localChild, lines);
      } else {
        const piece = this.get(remoteChild, localChild);
        lines.push(...piece.split('\n'));
      }
    }
  }

  private walkUpload(localDir: string, remoteDir: string, lines: string[]): void {
    if (!this.channel) return;
    const entries = this.deps.localVfs.listDirectory(localDir) ?? [];
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const localChild = `${localDir.replace(/\/$/, '')}/${entry.name}`;
      const remoteChild = `${remoteDir.replace(/\/$/, '')}/${entry.name}`;
      if (entry.inode.type === 'directory') {
        this.channel.sendRequest({ op: 'mkdir', path: remoteChild });
        this.walkUpload(localChild, remoteChild, lines);
      } else {
        const piece = this.put(localChild, remoteChild);
        lines.push(...piece.split('\n'));
      }
    }
  }

  // ── Remote file operations ───────────────────────────────────────

  mkdir(path: string): string {
    return this.simpleRemote('mkdir', { op: 'mkdir', path: this.expandRemote(path) }, (r) =>
      `Couldn't create directory: ${r.error ?? 'Failure'}`,
    );
  }

  rm(path: string): string {
    return this.simpleRemote('rm', { op: 'rm', path: this.expandRemote(path) }, (r) =>
      `Couldn't remove file: remove "${path}": ${r.error ?? 'Failure'}`,
    );
  }

  rmdir(path: string): string {
    return this.simpleRemote('rmdir', { op: 'rmdir', path: this.expandRemote(path) }, (r) =>
      `Couldn't remove directory: rmdir "${path}": ${r.error ?? 'Failure'}`,
    );
  }

  rename(oldPath: string, newPath: string): string {
    return this.simpleRemote(
      'rename',
      {
        op: 'rename',
        src: this.expandRemote(oldPath),
        dst: this.expandRemote(newPath),
      },
      (r) =>
        `Couldn't rename file: rename ${oldPath} ${newPath}: ${r.error ?? 'Failure'}`,
    );
  }

  chmod(modeOctal: string, path: string): string {
    const mode = Number.parseInt(modeOctal, 8);
    if (Number.isNaN(mode)) return `chmod: invalid mode '${modeOctal}'`;
    const remote = this.expandRemote(path);
    const resp = this.channel?.sendRequest({ op: 'chmod', path: remote, mode });
    if (!resp || !resp.ok) {
      return `Couldn't setstat on "${remote}": ${resp?.error ?? 'Failure'}`;
    }
    return `Changing mode on ${remote}`;
  }

  chown(uid: string, path: string): string {
    const numericUid = Number.parseInt(uid, 10);
    if (Number.isNaN(numericUid)) return `chown: invalid uid '${uid}'`;
    const remote = this.expandRemote(path);
    const resp = this.channel?.sendRequest({
      op: 'chown',
      path: remote,
      uid: numericUid,
      gid: numericUid,
    });
    if (!resp || !resp.ok) {
      return `Couldn't setstat on "${remote}": ${resp?.error ?? 'Failure'}`;
    }
    return `Changing owner on ${remote}`;
  }

  stat(path: string): string {
    if (!this.channel) return 'Not connected.';
    const remote = this.expandRemote(path);
    const resp = this.channel.sendRequest({ op: 'stat', path: remote });
    if (!resp.ok) return `${remote}: ${resp.error ?? 'No such file or directory'}`;
    const a = resp as unknown as {
      mode: number;
      uid: number;
      gid: number;
      size: number;
      mtime: number;
    };
    const mtime = new Date(a.mtime).toUTCString();
    return [
      `  File: ${remote}`,
      `  Size: ${a.size}`,
      `  Mode: 0${(a.mode & 0o7777).toString(8).padStart(4, '0')}   UID: ${a.uid}   GID: ${a.gid}`,
      `  Access: ${mtime}`,
      `  Modify: ${mtime}`,
    ].join('\n');
  }

  df(path: string | undefined, human: boolean): string {
    if (!this.channel) return 'Not connected.';
    const remote = path ? this.expandRemote(path) : this.remoteCwd;
    const resp = this.channel.sendRequest({ op: 'df', path: remote });
    if (!resp.ok) return `df: ${resp.error ?? 'Failure'}`;
    const a = resp as unknown as {
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
    };
    const fmt = human ? humanBytes : (n: number) => String(Math.round(n / 1024));
    const pct = Math.round((a.usedBytes / a.totalBytes) * 100);
    return [
      `        Size         Used        Avail       (root)    %Capacity`,
      `${fmt(a.totalBytes).padStart(12, ' ')} ${fmt(a.usedBytes).padStart(12, ' ')} ${fmt(a.availableBytes).padStart(12, ' ')} ${fmt(a.availableBytes).padStart(12, ' ')} ${(pct + '%').padStart(12, ' ')}`,
    ].join('\n');
  }

  version(): string {
    if (!this.channel) return 'Not connected.';
    const resp = this.channel.sendRequest({ op: 'version' });
    if (!resp.ok) return 'SFTP protocol version 3';
    return `SFTP protocol version ${(resp as { protocolVersion?: number }).protocolVersion ?? 3}`;
  }

  // ── helpers ──────────────────────────────────────────────────────

  private simpleRemote(
    _label: string,
    payload: Record<string, unknown>,
    onError: (resp: SftpResponse) => string,
  ): string {
    if (!this.channel) return 'Not connected.';
    const resp = this.channel.sendRequest(payload as never);
    return resp.ok ? '' : onError(resp);
  }

  private expandRemote(path: string): string {
    return expandTilde(path, `/home/${this.remoteUser}`);
  }

  private expandLocal(path: string): string {
    return expandTilde(path, this.deps.homeDirectory);
  }
}

// ── Pure helpers ───────────────────────────────────────────────────

function parseUserAtHost(
  userAtHost: string,
  defaultUser: string,
): { user: string; host: string } {
  const at = userAtHost.indexOf('@');
  if (at === -1) return { user: defaultUser, host: userAtHost };
  return { user: userAtHost.slice(0, at), host: userAtHost.slice(at + 1) };
}

function baseName(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? 'file';
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function formatConnectError(
  user: string,
  host: string,
  error: { kind: string; [k: string]: unknown },
): string {
  switch (error.kind) {
    case 'CONNECTION_REFUSED':
      return `ssh: connect to host ${host} port 22: No route to host`;
    case 'HOST_KEY_REJECTED':
      return `Host key verification failed.`;
    case 'HOST_KEY_CHANGED':
      return `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.`;
    case 'AUTH_FAILED':
      return `${user}@${host}: Permission denied (publickey,password).`;
    default:
      return `ssh: connection to ${host} failed`;
  }
}
