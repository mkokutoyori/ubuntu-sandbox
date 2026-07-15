/**
 * SftpSession — client-side SFTP facade built on top of SshSession.
 *
 * Replaces the legacy `protocols/sftp/SftpSession.ts`. The new session
 * negotiates SSH first (host key + auth) and only then opens the SFTP
 * channel; commands are routed through that channel.
 *
 * Reference: DESIGN-SSH-SFTP.md section 9.3 ; BRD-SSH-SFTP.md SFTP-01.
 */

import type { TcpConnector } from '@/network/tcp/types';
import type { ISshLocalFs } from '../ISshLocalFs';
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
  readonly localVfs: ISshLocalFs;
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

  channelRequest(req: Parameters<ISshSftpChannel['sendRequest']>[0]): SftpResponse {
    if (!this.channel) return { ok: false, error: 'Not connected.' };
    return this.channel.sendRequest(req);
  }

  getRemoteCwdPath(): string { return this.remoteCwd; }
  setRemoteCwdPath(path: string): void { this.remoteCwd = path; }
  getRemoteUserName(): string { return this.remoteUser; }
  getLocalCwdPath(): string { return this.localCwd; }
  setLocalCwdPath(path: string): void { this.localCwd = path; }
  localFs(): ISshLocalFs { return this.deps.localVfs; }
  localOwner(): { uid: number; gid: number; user: string; home: string } {
    return { uid: this.deps.localUid, gid: this.deps.localGid, user: this.deps.localUser, home: this.deps.homeDirectory };
  }

  // ── Remote navigation ────────────────────────────────────────────

  // ── Local navigation ─────────────────────────────────────────────

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

  // ── helpers ──────────────────────────────────────────────────────

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
