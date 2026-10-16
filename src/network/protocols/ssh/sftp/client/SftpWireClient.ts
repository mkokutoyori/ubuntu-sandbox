import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';
import type { ISshSftpChannel } from '../../channels/ISshChannel';
import { SshReader, SshWriter } from '../../wire/SshDataTypes';
import { SSH_FX } from '../SftpStatusCodes';
import type { SftpNameEntry, SftpWireAttrs, SftpWirePacket } from '../SftpWireCodec';

export const SFTP_OPEN = { READ: 0x01, WRITE: 0x02, APPEND: 0x04, CREAT: 0x08, TRUNC: 0x10, EXCL: 0x20 } as const;

export const SFTP_EXTENSION = {
  posixRename: 'posix-rename@openssh.com',
  statvfs: 'statvfs@openssh.com',
  fstatvfs: 'fstatvfs@openssh.com',
  hardlink: 'hardlink@openssh.com',
  fsync: 'fsync@openssh.com',
  lsetstat: 'lsetstat@openssh.com',
  limits: 'limits@openssh.com',
  expandPath: 'expand-path@openssh.com',
} as const;

export const TRANSFER_CHUNK = 32768;

const STATUS_TEXT: Readonly<Record<number, string>> = {
  [SSH_FX.OK]: 'No error',
  [SSH_FX.EOF]: 'End of file',
  [SSH_FX.NO_SUCH_FILE]: 'No such file or directory',
  [SSH_FX.PERMISSION_DENIED]: 'Permission denied',
  [SSH_FX.FAILURE]: 'Failure',
  [SSH_FX.BAD_MESSAGE]: 'Bad message',
  [SSH_FX.NO_CONNECTION]: 'No connection',
  [SSH_FX.CONNECTION_LOST]: 'Connection lost',
  [SSH_FX.OP_UNSUPPORTED]: 'Operation unsupported',
};

export function statusText(code: number): string {
  return STATUS_TEXT[code] ?? 'Unknown status';
}

export type SftpPacketChannel = Pick<ISshSftpChannel, 'exchange' | 'protocolVersion' | 'serverExtensions'> & {
  readonly remoteStderr?: string;
  readonly oversizedMessage?: number | null;
};

export class SftpProtocolFailure extends Error {}

export interface SftpDiagnostics {
  error(line: string): void;
  notice(line: string): void;
}

export interface SftpDirectoryEntry {
  readonly filename: string;
  readonly longname: string;
  readonly attrs: SftpWireAttrs;
}

export interface SftpFilesystemStats {
  readonly blockSize: number;
  readonly fragmentSize: number;
  readonly blocks: number;
  readonly freeBlocks: number;
  readonly availableBlocks: number;
  readonly files: number;
  readonly freeFiles: number;
  readonly availableFiles: number;
}

export type SftpRead =
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'eof' }
  | { readonly kind: 'failed'; readonly status: number };

export class SftpWireClient {
  private nextRequestId = 1;

  constructor(private readonly channel: SftpPacketChannel, private readonly diagnostics: SftpDiagnostics) {}

  get version(): number {
    return this.channel.protocolVersion;
  }

  supports(extension: string): boolean {
    return this.channel.serverExtensions.has(extension);
  }

  private exchange(packet: SftpWirePacket): SftpWirePacket {
    const reply = this.channel.exchange(packet);
    if (reply === null) {
      const oversized = this.channel.oversizedMessage ?? null;
      throw new SftpProtocolFailure(oversized === null
        ? 'Connection closed'
        : `Received message too long ${oversized}\nEnsure the remote shell produces no output for non-interactive sessions.`);
    }
    return reply;
  }

  private id(): number {
    return this.nextRequestId++;
  }

  private statusOf(reply: SftpWirePacket): number {
    if (reply.type !== 'STATUS') throw new SftpProtocolFailure(`Expected SSH2_FXP_STATUS(101) packet, got ${reply.type}`);
    return reply.code;
  }

  private statusOperation(packet: SftpWirePacket, failure: (status: number) => string): boolean {
    const status = this.statusOf(this.exchange(packet));
    if (status !== SSH_FX.OK) this.diagnostics.error(failure(status));
    return status === SSH_FX.OK;
  }

  realpath(path: string): string | null {
    const reply = this.exchange({ type: 'REALPATH', requestId: this.id(), path });
    if (reply.type === 'STATUS') {
      this.diagnostics.error(`realpath ${path}: ${reply.message === '' ? statusText(reply.code) : reply.message}`);
      return null;
    }
    if (reply.type !== 'NAME') throw new SftpProtocolFailure(`Expected SSH2_FXP_NAME(104) packet, got ${reply.type}`);
    return reply.entries[0].filename;
  }

  expandPath(path: string): string | null {
    if (!this.supports(SFTP_EXTENSION.expandPath)) return this.realpath(path);
    const reply = this.exchange({
      type: 'EXTENDED', requestId: this.id(), name: SFTP_EXTENSION.expandPath,
      data: new SshWriter().writeString(path).toBytes(),
    });
    if (reply.type === 'STATUS') {
      this.diagnostics.error(`expand ${path}: ${reply.message === '' ? statusText(reply.code) : reply.message}`);
      return null;
    }
    if (reply.type !== 'NAME') throw new SftpProtocolFailure(`Expected SSH2_FXP_NAME(104) packet, got ${reply.type}`);
    return reply.entries[0].filename;
  }

  private attributes(packet: SftpWirePacket, quiet: boolean): SftpWireAttrs | null {
    const reply = this.exchange(packet);
    if (reply.type === 'STATUS') {
      if (!quiet) this.diagnostics.error(`stat remote: ${statusText(reply.code)}`);
      return null;
    }
    if (reply.type !== 'ATTRS') throw new SftpProtocolFailure(`Expected SSH2_FXP_ATTRS(105) packet, got ${reply.type}`);
    return reply.attrs;
  }

  stat(path: string, quiet = false): SftpWireAttrs | null {
    return this.attributes({ type: 'STAT', requestId: this.id(), path }, quiet);
  }

  lstat(path: string, quiet = false): SftpWireAttrs | null {
    return this.attributes({ type: 'LSTAT', requestId: this.id(), path }, quiet);
  }

  open(path: string, flags: number, attrs: SftpWireAttrs, tag: 'remote' | 'dest'): string | null {
    const reply = this.exchange({ type: 'OPEN', requestId: this.id(), filename: path, pflags: flags, attrs });
    if (reply.type === 'STATUS') {
      this.diagnostics.error(`${tag} open "${path}": ${statusText(reply.code)}`);
      return null;
    }
    if (reply.type !== 'HANDLE') throw new SftpProtocolFailure(`Expected SSH2_FXP_HANDLE(102) packet, got ${reply.type}`);
    return reply.handle;
  }

  close(handle: string): boolean {
    return this.statusOperation({ type: 'CLOSE', requestId: this.id(), handle }, (status) => `close remote: ${statusText(status)}`);
  }

  read(handle: string, offset: number, length: number): SftpRead {
    const reply = this.exchange({ type: 'READ', requestId: this.id(), handle, offset, length });
    if (reply.type === 'DATA') return { kind: 'data', data: bytesToBinaryString(reply.data) };
    const status = this.statusOf(reply);
    return status === SSH_FX.EOF ? { kind: 'eof' } : { kind: 'failed', status };
  }

  write(handle: string, offset: number, data: string): number {
    return this.statusOf(this.exchange({
      type: 'WRITE', requestId: this.id(), handle, offset, data: binaryStringToBytes(data),
    }));
  }

  readDirectory(path: string): SftpDirectoryEntry[] | null {
    const opened = this.exchange({ type: 'OPENDIR', requestId: this.id(), path });
    if (opened.type === 'STATUS') {
      this.diagnostics.error(`remote readdir("${path}"): ${statusText(opened.code)}`);
      return null;
    }
    if (opened.type !== 'HANDLE') throw new SftpProtocolFailure(`Expected SSH2_FXP_HANDLE(102) packet, got ${opened.type}`);
    const entries: SftpDirectoryEntry[] = [];
    let failed = false;
    for (;;) {
      const reply = this.exchange({ type: 'READDIR', requestId: this.id(), handle: opened.handle });
      if (reply.type === 'STATUS') {
        if (reply.code !== SSH_FX.EOF) {
          this.diagnostics.error(`Couldn't read directory: ${statusText(reply.code)}`);
          failed = true;
        }
        break;
      }
      if (reply.type !== 'NAME') throw new SftpProtocolFailure(`Expected SSH2_FXP_NAME(104) packet, got ${reply.type}`);
      if (reply.entries.length === 0) break;
      for (const entry of reply.entries as readonly SftpNameEntry[]) {
        if (/[/]/.test(entry.filename)) {
          this.diagnostics.error(`Server sent suspect path "${entry.filename}" during readdir of "${path}"`);
        } else {
          entries.push(entry);
        }
      }
    }
    this.close(opened.handle);
    return failed ? null : entries;
  }

  remove(path: string): boolean {
    return this.statusOperation({ type: 'REMOVE', requestId: this.id(), filename: path },
      (status) => `remote delete ${path}: ${statusText(status)}`);
  }

  makeDirectory(path: string, attrs: SftpWireAttrs, report: boolean): boolean {
    const status = this.statusOf(this.exchange({ type: 'MKDIR', requestId: this.id(), path, attrs }));
    if (status !== SSH_FX.OK && report) this.diagnostics.error(`remote mkdir "${path}": ${statusText(status)}`);
    return status === SSH_FX.OK;
  }

  removeDirectory(path: string): boolean {
    return this.statusOperation({ type: 'RMDIR', requestId: this.id(), path },
      (status) => `remote rmdir "${path}": ${statusText(status)}`);
  }

  setAttributes(path: string, attrs: SftpWireAttrs): boolean {
    return this.statusOperation({ type: 'SETSTAT', requestId: this.id(), path, attrs },
      (status) => `remote setstat "${path}": ${statusText(status)}`);
  }

  setLinkAttributes(path: string, attrs: SftpWireAttrs): boolean {
    if (!this.supports(SFTP_EXTENSION.lsetstat)) {
      this.diagnostics.error('Server does not support lsetstat@openssh.com extension');
      return false;
    }
    const data = new SshWriter().writeString(path);
    return this.statusOperation({
      type: 'EXTENDED', requestId: this.id(), name: SFTP_EXTENSION.lsetstat,
      data: this.withAttributes(data, attrs),
    }, (status) => `remote lsetstat "${path}": ${statusText(status)}`);
  }

  private withAttributes(writer: SshWriter, attrs: SftpWireAttrs): Uint8Array {
    let flags = 0;
    if (attrs.size !== undefined) flags |= 0x01;
    if (attrs.uid !== undefined || attrs.gid !== undefined) flags |= 0x02;
    if (attrs.permissions !== undefined) flags |= 0x04;
    if (attrs.atime !== undefined || attrs.mtime !== undefined) flags |= 0x08;
    writer.writeUint32(flags);
    if (flags & 0x01) writer.writeUint64(attrs.size!);
    if (flags & 0x02) writer.writeUint32(attrs.uid ?? 0).writeUint32(attrs.gid ?? 0);
    if (flags & 0x04) writer.writeUint32(attrs.permissions!);
    if (flags & 0x08) writer.writeUint32(attrs.atime ?? attrs.mtime ?? 0).writeUint32(attrs.mtime ?? 0);
    return writer.toBytes();
  }

  setHandleAttributes(handle: string, attrs: SftpWireAttrs): boolean {
    return this.statusOperation({ type: 'FSETSTAT', requestId: this.id(), handle, attrs },
      (status) => `remote fsetstat: ${statusText(status)}`);
  }

  synchronize(handle: string): boolean {
    if (!this.supports(SFTP_EXTENSION.fsync)) return false;
    return this.statusOperation({
      type: 'EXTENDED', requestId: this.id(), name: SFTP_EXTENSION.fsync,
      data: new SshWriter().writeString(handle).toBytes(),
    }, (status) => `remote fsync: ${statusText(status)}`);
  }

  rename(oldPath: string, newPath: string, legacy: boolean): boolean {
    const failure = (status: number): string => `remote rename "${oldPath}" to "${newPath}": ${statusText(status)}`;
    if (this.supports(SFTP_EXTENSION.posixRename) && !legacy) {
      return this.statusOperation({
        type: 'EXTENDED', requestId: this.id(), name: SFTP_EXTENSION.posixRename,
        data: new SshWriter().writeString(oldPath).writeString(newPath).toBytes(),
      }, failure);
    }
    return this.statusOperation({ type: 'RENAME', requestId: this.id(), oldPath, newPath }, failure);
  }

  hardLink(oldPath: string, newPath: string): boolean {
    if (!this.supports(SFTP_EXTENSION.hardlink)) {
      this.diagnostics.error('Server does not support hardlink@openssh.com extension');
      return false;
    }
    return this.statusOperation({
      type: 'EXTENDED', requestId: this.id(), name: SFTP_EXTENSION.hardlink,
      data: new SshWriter().writeString(oldPath).writeString(newPath).toBytes(),
    }, (status) => `remote link "${oldPath}" to "${newPath}": ${statusText(status)}`);
  }

  symbolicLink(oldPath: string, newPath: string): boolean {
    if (this.version < 3) {
      this.diagnostics.error('This server does not support the symlink operation');
      return false;
    }
    return this.statusOperation({ type: 'SYMLINK', requestId: this.id(), linkpath: oldPath, targetpath: newPath },
      (status) => `remote symlink file "${oldPath}" to "${newPath}": ${statusText(status)}`);
  }

  filesystemStats(path: string): SftpFilesystemStats | null {
    if (!this.supports(SFTP_EXTENSION.statvfs)) {
      this.diagnostics.error('Server does not support statvfs@openssh.com extension');
      return null;
    }
    const reply = this.exchange({
      type: 'EXTENDED', requestId: this.id(), name: SFTP_EXTENSION.statvfs,
      data: new SshWriter().writeString(path).toBytes(),
    });
    if (reply.type === 'STATUS') {
      this.diagnostics.error(`remote statvfs: ${statusText(reply.code)}`);
      return null;
    }
    if (reply.type !== 'EXTENDED_REPLY') {
      throw new SftpProtocolFailure(`Expected SSH2_FXP_EXTENDED_REPLY(201) packet, got ${reply.type}`);
    }
    const fields = new SshReader(reply.data);
    const blockSize = fields.readUint64();
    const fragmentSize = fields.readUint64();
    const blocks = fields.readUint64();
    const freeBlocks = fields.readUint64();
    const availableBlocks = fields.readUint64();
    const files = fields.readUint64();
    const freeFiles = fields.readUint64();
    const availableFiles = fields.readUint64();
    return { blockSize, fragmentSize, blocks, freeBlocks, availableBlocks, files, freeFiles, availableFiles };
  }
}
