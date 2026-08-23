/**
 * WireSftpFileSystem — ISftpFileSystem adapter backed by a real
 * ISshSftpChannel (SSH_FXP_* wire protocol over an authenticated
 * TcpConnection), instead of a direct in-memory VirtualFileSystem
 * reference.
 *
 * Audit 03, constat MAJEUR §4 / Top-10 #3: `scp`/`sftp` shell commands
 * used to resolve the remote endpoint straight to the target device's
 * own ISftpFileSystem object (VFS-to-VFS copy — no byte ever crossed
 * TcpSocket.send()/Port/Cable). This adapter closes that gap: every
 * method translates to a real SshSftpChannel.sendRequest() call, which
 * itself round-trips a real SSH_FXP_* packet over `conn.write()`/
 * `onData` — the exact machinery already used by the native SFTP
 * channel (SshChannelManager.openSftp()).
 *
 * `SshSftpChannel.sendRequest()` is synchronous (Cable delivery in this
 * simulator resolves within the same call stack — see
 * `SshSftpChannel.roundTrip()`), so this adapter can implement the
 * synchronous `ISftpFileSystem` contract unchanged; `ScpTransfer`/
 * `SftpInteractiveSession` need no changes at all.
 */
import type { ISshSftpChannel, SftpResponse } from '../channels/ISshChannel';
import { ok, err, type Result, type SshError } from '../Result';
import type { EntryType, ISftpFileSystem, SftpDirEntry, SftpFileAttrs } from './ISftpFileSystem';

function toError(resp: SftpResponse): SshError {
  return { kind: 'IO_ERROR', message: typeof resp.error === 'string' ? resp.error : 'Failure' };
}

export class WireSftpFileSystem implements ISftpFileSystem {
  constructor(private readonly channel: ISshSftpChannel) {}

  normalizePath(path: string, cwd: string): string {
    if (path === '' || path === '.') return cwd;
    if (path.startsWith('/')) return path;
    return `${cwd.replace(/\/$/, '')}/${path}`;
  }

  exists(path: string): boolean {
    return this.channel.sendRequest({ op: 'stat', path }).ok;
  }

  getEntryType(path: string): EntryType | null {
    const resp = this.channel.sendRequest({ op: 'stat', path });
    if (!resp.ok) return null;
    return (resp.type as EntryType | undefined) ?? 'file';
  }

  readFile(path: string): Result<string> {
    const resp = this.channel.sendRequest({ op: 'get', path });
    return resp.ok ? ok(String(resp.content ?? '')) : err(toError(resp));
  }

  listDirectory(path: string): Result<readonly SftpDirEntry[]> {
    const resp = this.channel.sendRequest({ op: 'ls', path });
    if (!resp.ok) return err(toError(resp));
    const entries = (resp.entries as Array<{
      name: string; type: string; mode: number; uid: number; gid: number; size: number; mtime: number;
    }>) ?? [];
    return ok(entries.map((e) => ({
      name: e.name,
      type: (e.type as EntryType) ?? 'file',
      mode: e.mode, uid: e.uid, gid: e.gid, size: e.size, mtime: e.mtime,
    })));
  }

  stat(path: string): Result<SftpFileAttrs> {
    const resp = this.channel.sendRequest({ op: 'stat', path });
    if (!resp.ok) return err(toError(resp));
    return ok({
      type: (resp.type as EntryType) ?? 'file',
      mode: Number(resp.mode ?? 0),
      uid: Number(resp.uid ?? 0),
      gid: Number(resp.gid ?? 0),
      size: Number(resp.size ?? 0),
      mtime: Number(resp.mtime ?? 0),
    });
  }

  writeFile(path: string, content: string): Result<void> {
    const resp = this.channel.sendRequest({ op: 'put', path, content });
    return resp.ok ? ok(undefined) : err(toError(resp));
  }

  mkdir(path: string): Result<void> {
    const resp = this.channel.sendRequest({ op: 'mkdir', path });
    return resp.ok ? ok(undefined) : err(toError(resp));
  }

  deleteFile(path: string): Result<void> {
    const resp = this.channel.sendRequest({ op: 'rm', path });
    return resp.ok ? ok(undefined) : err(toError(resp));
  }

  rmdir(path: string): Result<void> {
    const resp = this.channel.sendRequest({ op: 'rmdir', path });
    return resp.ok ? ok(undefined) : err(toError(resp));
  }

  rename(src: string, dst: string): Result<void> {
    const resp = this.channel.sendRequest({ op: 'rename', src, dst });
    return resp.ok ? ok(undefined) : err(toError(resp));
  }

  setPermissions(path: string, mode: number): Result<void> {
    const resp = this.channel.sendRequest({ op: 'chmod', path, mode });
    return resp.ok ? ok(undefined) : err(toError(resp));
  }

  setOwner(path: string, uid: number, gid: number): Result<void> {
    const resp = this.channel.sendRequest({ op: 'chown', path, uid, gid });
    return resp.ok ? ok(undefined) : err(toError(resp));
  }
}
