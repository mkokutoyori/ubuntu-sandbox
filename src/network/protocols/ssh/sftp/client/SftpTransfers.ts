import type { SftpWireAttrs } from '../SftpWireCodec';
import { SSH_FX } from '../SftpStatusCodes';
import { scpProgressLine } from '../../scp/ScpProgress';
import { SFTP_OPEN, SftpWireClient, TRANSFER_CHUNK, statusText, type SftpDiagnostics } from './SftpWireClient';
import type { SftpLocalPort } from './SftpLocalPort';

const MAX_DIRECTORY_DEPTH = 256;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export const isDirectoryMode = (mode: number | undefined): boolean => mode !== undefined && (mode & S_IFMT) === S_IFDIR;
export const isRegularMode = (mode: number | undefined): boolean => mode !== undefined && (mode & S_IFMT) === S_IFREG;
export const isLinkMode = (mode: number | undefined): boolean => mode !== undefined && (mode & S_IFMT) === S_IFLNK;

export interface SftpTransferSettings {
  readonly showProgress: boolean;
  readonly limitKbps: number | null;
}

export interface SftpTransferOptions {
  readonly preserve: boolean;
  readonly resume: boolean;
  readonly fsync: boolean;
}

export function pathAppend(first: string, second: string): string {
  if (first === '') return second;
  if (first.endsWith('/')) return `${first}${second}`;
  return `${first}/${second}`;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  if (trimmed === '') return path.startsWith('/') ? '/' : '';
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

export class SftpTransfers {
  constructor(
    private readonly wire: SftpWireClient,
    private readonly local: SftpLocalPort,
    private readonly diagnostics: SftpDiagnostics,
    private readonly settings: SftpTransferSettings,
    private readonly meter: (line: string) => void,
    private readonly print: (line: string) => void,
  ) {}

  private progress(name: string, bytes: number): void {
    if (this.settings.showProgress && bytes > 0) this.meter(scpProgressLine(baseName(name), bytes, this.settings.limitKbps === null ? null : this.settings.limitKbps / 1024));
  }

  download(
    remotePath: string, localPath: string, known: SftpWireAttrs | null, options: SftpTransferOptions,
  ): boolean {
    const attrs = known ?? this.wire.stat(remotePath, false);
    if (attrs === null) return false;
    const mode = attrs.permissions !== undefined ? attrs.permissions & 0o777 : 0o666;
    if (attrs.permissions !== undefined && !isRegularMode(attrs.permissions)) {
      this.diagnostics.error(`download ${remotePath}: not a regular file`);
      return false;
    }
    const size = attrs.size ?? 0;
    const handle = this.wire.open(remotePath, SFTP_OPEN.READ, {}, 'remote');
    if (handle === null) return false;
    const creationMode = (mode | 0o200);
    let content = '';
    if (options.resume) {
      const existing = this.local.read(localPath);
      if ('content' in existing) {
        if (existing.content.length > size) {
          this.diagnostics.error(`Unable to resume download of "${localPath}": local file is larger than remote`);
          this.wire.close(handle);
          return false;
        }
        content = existing.content;
      }
    }
    const opened = this.local.write(localPath, content, creationMode);
    if (opened !== null) {
      this.diagnostics.error(`open local "${localPath}": ${opened}`);
      this.wire.close(handle);
      return false;
    }
    let readStatus: number = SSH_FX.OK;
    for (;;) {
      const chunk = this.wire.read(handle, content.length, TRANSFER_CHUNK);
      if (chunk.kind === 'data') {
        content += chunk.data;
        continue;
      }
      if (chunk.kind === 'failed') readStatus = chunk.status;
      break;
    }
    if (readStatus !== SSH_FX.OK) {
      this.diagnostics.error(`read remote "${remotePath}" : ${statusText(readStatus)}`);
      this.wire.close(handle);
      return false;
    }
    const closed = this.wire.close(handle);
    const written = this.local.write(localPath, content, creationMode);
    if (written !== null) {
      this.diagnostics.error(`write local "${localPath}": ${written}`);
      return false;
    }
    if (options.preserve) {
      const changed = this.local.setPermissions(localPath, mode);
      if (changed !== null) this.diagnostics.error(`local chmod "${localPath}": ${changed}`);
      if (attrs.mtime !== undefined) {
        const timed = this.local.setTimes(localPath, (attrs.atime ?? attrs.mtime) * 1000, attrs.mtime * 1000);
        if (timed !== null) this.diagnostics.error(`local set times "${localPath}": ${timed}`);
      }
    }
    if (size !== 0) this.progress(remotePath, content.length);
    return closed;
  }

  upload(localPath: string, remotePath: string, options: SftpTransferOptions): boolean {
    const stat = this.local.stat(localPath);
    if (typeof stat === 'string') {
      this.diagnostics.error(`open local "${localPath}": ${stat}`);
      return false;
    }
    if (stat.type !== 'file') {
      this.diagnostics.error(`local "${localPath}" is not a regular file`);
      return false;
    }
    const data = this.local.read(localPath);
    if ('failure' in data) {
      this.diagnostics.error(`open local "${localPath}": ${data.failure}`);
      return false;
    }
    const attrs: SftpWireAttrs = {
      permissions: stat.permissionBits & 0o777,
      ...(options.preserve ? { atime: Math.floor(stat.mtimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) } : {}),
    };
    let offset = 0;
    if (options.resume) {
      const existing = this.wire.stat(remotePath, false);
      if (existing === null) return false;
      if ((existing.size ?? 0) >= data.content.length) {
        this.diagnostics.error(`resume "${localPath}": destination file same size or larger`);
        return false;
      }
      offset = existing.size ?? 0;
    }
    const handle = this.wire.open(
      remotePath, SFTP_OPEN.WRITE | SFTP_OPEN.CREAT | (options.resume ? SFTP_OPEN.APPEND : SFTP_OPEN.TRUNC), attrs, 'dest',
    );
    if (handle === null) return false;
    let status: number = SSH_FX.OK;
    for (let at = offset; at < data.content.length && status === SSH_FX.OK; at += TRANSFER_CHUNK) {
      status = this.wire.write(handle, at, data.content.slice(at, at + TRANSFER_CHUNK));
    }
    let ok = true;
    if (status !== SSH_FX.OK) {
      this.diagnostics.error(`write remote "${remotePath}": ${statusText(status)}`);
      ok = false;
    }
    if (options.preserve) this.wire.setHandleAttributes(handle, attrs);
    if (options.fsync) this.wire.synchronize(handle);
    if (!this.wire.close(handle)) ok = false;
    if (ok) this.progress(localPath, data.content.length);
    return ok;
  }

  downloadDirectory(
    source: string, destination: string, announce: boolean, options: SftpTransferOptions,
  ): boolean {
    const canonical = this.wire.realpath(source);
    if (canonical === null) {
      this.diagnostics.error(`download "${source}": path canonicalization failed`);
      return false;
    }
    return this.downloadTree(canonical, destination, 0, null, announce, options);
  }

  private downloadTree(
    source: string, destination: string, depth: number, known: SftpWireAttrs | null, announce: boolean,
    options: SftpTransferOptions,
  ): boolean {
    if (depth >= MAX_DIRECTORY_DEPTH) {
      this.diagnostics.error(`Maximum directory depth exceeded: ${depth} levels`);
      return false;
    }
    const attrs = known ?? this.wire.lstat(source, false);
    if (attrs === null) {
      this.diagnostics.error(`stat remote "${source}" directory failed`);
      return false;
    }
    if (!isDirectoryMode(attrs.permissions)) {
      this.diagnostics.error(`"${source}" is not a directory`);
      return false;
    }
    if (announce) this.print(`Retrieving ${source}`);
    const mode = attrs.permissions !== undefined ? attrs.permissions & 0o1777 : 0o777;
    const temporaryMode = mode | 0o300;
    if (!this.local.exists(destination)) {
      const created = this.local.makeDirectory(destination);
      if (created !== null) {
        this.diagnostics.error(`mkdir ${destination}: ${created}`);
        return false;
      }
      this.local.setPermissions(destination, temporaryMode & ~this.local.umask);
    }
    const entries = this.wire.readDirectory(source);
    if (entries === null) {
      this.diagnostics.error(`remote readdir "${source}" failed`);
      return false;
    }
    let ok = true;
    for (const entry of entries) {
      const nextSource = pathAppend(source, entry.filename);
      const nextDestination = pathAppend(destination, entry.filename);
      if (isDirectoryMode(entry.attrs.permissions)) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (!this.downloadTree(nextSource, nextDestination, depth + 1, entry.attrs, announce, options)) ok = false;
      } else if (isRegularMode(entry.attrs.permissions)) {
        if (!this.download(nextSource, nextDestination, entry.attrs, options)) {
          this.diagnostics.error(`Download of file ${nextSource} to ${nextDestination} failed`);
          ok = false;
        }
      } else {
        this.diagnostics.notice(`download "${nextSource}": not a regular file`);
      }
    }
    if (options.preserve && attrs.mtime !== undefined) {
      const timed = this.local.setTimes(destination, (attrs.atime ?? attrs.mtime) * 1000, attrs.mtime * 1000);
      if (timed !== null) this.diagnostics.error(`local set times on "${destination}": ${timed}`);
    }
    if (mode !== temporaryMode) this.local.setPermissions(destination, mode & ~this.local.umask);
    return ok;
  }

  uploadDirectory(source: string, destination: string, announce: boolean, options: SftpTransferOptions): boolean {
    const canonical = this.wire.realpath(destination);
    if (canonical === null) {
      this.diagnostics.error(`upload "${destination}": path canonicalization failed`);
      return false;
    }
    return this.uploadTree(source, canonical, 0, announce, options);
  }

  private uploadTree(
    source: string, destination: string, depth: number, announce: boolean, options: SftpTransferOptions,
  ): boolean {
    if (depth >= MAX_DIRECTORY_DEPTH) {
      this.diagnostics.error(`Maximum directory depth exceeded: ${depth} levels`);
      return false;
    }
    const stat = this.local.stat(source);
    if (typeof stat === 'string') {
      this.diagnostics.error(`stat local "${source}": ${stat}`);
      return false;
    }
    if (stat.type !== 'directory') {
      this.diagnostics.error(`"${source}" is not a directory`);
      return false;
    }
    if (announce) this.print(`Entering ${source}`);
    const mode = stat.permissionBits & 0o1777;
    const attrs: SftpWireAttrs = {
      permissions: mode | 0o300,
      ...(options.preserve ? { atime: Math.floor(stat.mtimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) } : {}),
    };
    if (!this.wire.makeDirectory(destination, attrs, false)) {
      const existing = this.wire.stat(destination, false);
      if (existing === null) return false;
      if (!isDirectoryMode(existing.permissions)) {
        this.diagnostics.error(`"${destination}" exists but is not a directory`);
        return false;
      }
    }
    const names = this.local.listNames(source);
    if (names === null) {
      this.diagnostics.error(`local opendir "${source}": Permission denied`);
      return false;
    }
    let ok = true;
    for (const name of names) {
      const nextSource = pathAppend(source, name);
      const nextDestination = pathAppend(destination, name);
      const entry = this.local.stat(nextSource);
      if (typeof entry === 'string') {
        this.diagnostics.notice(`local lstat "${name}": ${entry}`);
        ok = false;
      } else if (entry.type === 'directory') {
        if (name === '.' || name === '..') continue;
        if (!this.uploadTree(nextSource, nextDestination, depth + 1, announce, options)) ok = false;
      } else if (entry.type === 'file') {
        if (!this.upload(nextSource, nextDestination, options)) {
          this.diagnostics.error(`upload "${nextSource}" to "${nextDestination}" failed`);
          ok = false;
        }
      } else {
        this.diagnostics.notice(`${name}: not a regular file`);
      }
    }
    this.wire.setAttributes(destination, { ...attrs, permissions: mode });
    return ok;
  }
}
