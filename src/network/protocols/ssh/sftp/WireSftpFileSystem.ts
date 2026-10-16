import { ok, err, type Result, type SshError } from '../Result';
import type { EntryType, ISftpFileSystem, SftpDirEntry, SftpFileAttrs } from './ISftpFileSystem';
import { SSH_FX } from './SftpStatusCodes';
import { entryTypeOfAttrs, type SftpWireAttrs } from './SftpWireCodec';
import {
  SFTP_OPEN, SftpWireClient, TRANSFER_CHUNK, statusText, type SftpDiagnostics, type SftpPacketChannel,
} from './client/SftpWireClient';

const PERMISSION_BITS = 0o7777;

const silent: SftpDiagnostics = { error: () => undefined, notice: () => undefined };

function failure(status: number): SshError {
  return status === SSH_FX.PERMISSION_DENIED
    ? { kind: 'PERMISSION_DENIED', path: '', operation: 'sftp' }
    : { kind: 'IO_ERROR', message: statusText(status) };
}

function fileAttrs(attrs: SftpWireAttrs): SftpFileAttrs {
  return {
    type: entryTypeOfAttrs(attrs) as EntryType,
    mode: (attrs.permissions ?? 0) & PERMISSION_BITS,
    uid: attrs.uid ?? 0,
    gid: attrs.gid ?? 0,
    size: attrs.size ?? 0,
    mtime: (attrs.mtime ?? 0) * 1000,
  };
}

export class WireSftpFileSystem implements ISftpFileSystem {
  private readonly client: SftpWireClient;

  constructor(channel: SftpPacketChannel) {
    this.client = new SftpWireClient(channel, silent);
  }

  normalizePath(path: string, cwd: string): string {
    if (path === '' || path === '.') return cwd;
    if (path.startsWith('/')) return path;
    return `${cwd.replace(/\/$/, '')}/${path}`;
  }

  initialCwd(): string | null {
    return this.client.realpath('.');
  }

  exists(path: string): boolean {
    return this.client.stat(path, true) !== null;
  }

  getEntryType(path: string): EntryType | null {
    const attrs = this.client.stat(path, true);
    return attrs === null ? null : (entryTypeOfAttrs(attrs) as EntryType);
  }

  readFile(path: string): Result<string> {
    const handle = this.client.open(path, SFTP_OPEN.READ, {}, 'remote');
    if (handle === null) return err(failure(this.lastStatus(path)));
    let content = '';
    for (;;) {
      const chunk = this.client.read(handle, content.length, TRANSFER_CHUNK);
      if (chunk.kind === 'data') {
        content += chunk.data;
        continue;
      }
      this.client.close(handle);
      return chunk.kind === 'eof' ? ok(content) : err(failure(chunk.status));
    }
  }

  private lastStatus(path: string): number {
    return this.client.stat(path, true) === null ? SSH_FX.NO_SUCH_FILE : SSH_FX.PERMISSION_DENIED;
  }

  listDirectory(path: string): Result<readonly SftpDirEntry[]> {
    const entries = this.client.readDirectory(path);
    if (entries === null) return err(failure(this.lastStatus(path)));
    return ok(entries.map((entry) => ({ name: entry.filename, ...fileAttrs(entry.attrs) })));
  }

  stat(path: string): Result<SftpFileAttrs> {
    const attrs = this.client.stat(path, true);
    return attrs === null ? err(failure(SSH_FX.NO_SUCH_FILE)) : ok(fileAttrs(attrs));
  }

  writeFile(path: string, content: string): Result<void> {
    const handle = this.client.open(path, SFTP_OPEN.WRITE | SFTP_OPEN.CREAT | SFTP_OPEN.TRUNC, {}, 'dest');
    if (handle === null) return err(failure(SSH_FX.PERMISSION_DENIED));
    let status: number = SSH_FX.OK;
    for (let offset = 0; offset < content.length && status === SSH_FX.OK; offset += TRANSFER_CHUNK) {
      status = this.client.write(handle, offset, content.slice(offset, offset + TRANSFER_CHUNK));
    }
    const closed = this.client.close(handle);
    if (status !== SSH_FX.OK) return err(failure(status));
    return closed ? ok(undefined) : err(failure(SSH_FX.FAILURE));
  }

  mkdir(path: string): Result<void> {
    return this.client.makeDirectory(path, {}, false) ? ok(undefined) : err(failure(SSH_FX.FAILURE));
  }

  deleteFile(path: string): Result<void> {
    return this.client.remove(path) ? ok(undefined) : err(failure(SSH_FX.FAILURE));
  }

  rmdir(path: string): Result<void> {
    return this.client.removeDirectory(path) ? ok(undefined) : err(failure(SSH_FX.FAILURE));
  }

  rename(src: string, dst: string): Result<void> {
    return this.client.rename(src, dst, true) ? ok(undefined) : err(failure(SSH_FX.FAILURE));
  }

  setPermissions(path: string, mode: number): Result<void> {
    return this.client.setAttributes(path, { permissions: mode }) ? ok(undefined) : err(failure(SSH_FX.FAILURE));
  }

  setOwner(path: string, uid: number, gid: number): Result<void> {
    return this.client.setAttributes(path, { uid, gid }) ? ok(undefined) : err(failure(SSH_FX.FAILURE));
  }
}
