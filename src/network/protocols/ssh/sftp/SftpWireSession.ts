import { simulationNowMs } from '@/network/core/SystemClock';

import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';
import { SftpCommandDispatcher } from './SftpCommandDispatcher';
import type { SftpCommandContext } from './ISftpCommand';
import type { ISftpFileSystem, SftpDirEntry, SftpFileAttrs } from './ISftpFileSystem';
import type { SshUserContext } from '../SshUserContext';
import { isOk } from '../Result';
import { SshReader, SshWriter } from '../wire/SshDataTypes';
import type { SshError } from '../Result';
import type { SftpWirePacket, SftpWireAttrs } from './SftpWireCodec';
import { SFTP_RENAME_FLAG } from './SftpWireCodec';
import { SftpHandleTable, type SftpHandleState } from './SftpHandleTable';
import { SSH_FX, statusFromError, statusMessage } from './SftpStatusCodes';
import type { IEventBus } from '@/events/EventBus';
import { randomSftpSessionId } from './events';
import {
  DEFAULT_SFTP_SERVER_OPTIONS, SFTP_WRITING_REQUESTS, logLevelAtLeast, requestPermitted,
  type SftpLogLevel, type SftpServerOptions,
} from './server/SftpServerOptions';

export const STATVFS_EXTENSION = 'statvfs@openssh.com';
export const STATVFS_BLOCK_SIZE = 4096;

const SFTP_SERVER_MAX_VERSION = 6;
const SFTP_MIN_VERSION = 3;
const SFTP_MAX_MESSAGE_LENGTH = 256 * 1024;
const MAX_ENTRIES_PER_REPLY = 100;
const MAX_OPEN_HANDLES = 1024;

const ADVERTISED_EXTENSIONS: ReadonlyArray<readonly [name: string, version: string, request: string]> = [
  ['posix-rename@openssh.com', '1', 'posix-rename'],
  [STATVFS_EXTENSION, '2', 'statvfs'],
  ['fstatvfs@openssh.com', '2', 'fstatvfs'],
  ['hardlink@openssh.com', '1', 'hardlink'],
  ['fsync@openssh.com', '1', 'fsync'],
  ['lsetstat@openssh.com', '1', 'lsetstat'],
  ['limits@openssh.com', '1', 'limits'],
  ['expand-path@openssh.com', '1', 'expand-path'],
];

const SSH_FXF = { READ: 0x01, WRITE: 0x02, APPEND: 0x04, CREAT: 0x08, TRUNC: 0x10, EXCL: 0x20 } as const;

const FILE_TYPE_BITS: Readonly<Record<SftpFileAttrs['type'], number>> = {
  file: 0o100000, directory: 0o040000, symlink: 0o120000,
};
const FILE_TYPE_MASK = 0o170000;
const PERMISSION_STRING = 'rwxrwxrwx';
const LISTING_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SIX_MONTHS_MS = 183 * 24 * 3600 * 1000;

function attrsFrom(a: SftpFileAttrs, version: number): SftpWireAttrs {
  const seconds = Math.floor(a.mtime / 1000);
  if (version < 4) {
    return { size: a.size, uid: a.uid, gid: a.gid, permissions: (a.mode & ~FILE_TYPE_MASK) | FILE_TYPE_BITS[a.type], atime: seconds, mtime: seconds };
  }
  return {
    size: a.size, uid: a.uid, gid: a.gid, permissions: a.mode, mtime: seconds,
    entryType: a.type,
    acl: a.acl,
    extended: a.extended && Object.entries(a.extended).map(([name, value]) => ({ name, value })),
  };
}

function listingTime(mtime: number, now: number): string {
  const when = new Date(mtime);
  const month = LISTING_MONTHS[when.getUTCMonth()];
  const day = String(when.getUTCDate()).padStart(2, ' ');
  if (Math.abs(now - mtime) < SIX_MONTHS_MS) {
    return `${month} ${day} ${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
  }
  return `${month} ${day}  ${when.getUTCFullYear()}`;
}

const NUMERIC_ACCOUNT_NAMES: SftpAccountNames = { user: String, group: String };

function longnameOf(e: SftpDirEntry, names: SftpAccountNames, now: number): string {
  const kind = e.type === 'directory' ? 'd' : e.type === 'symlink' ? 'l' : '-';
  const bits = [...PERMISSION_STRING].map((letter, i) => ((e.mode >> (8 - i)) & 1 ? letter : '-')).join('');
  const links = e.type === 'directory' ? 2 : 1;
  const user = names.user(e.uid);
  const group = names.group(e.gid);
  return `${kind}${bits} ${String(links).padStart(3, ' ')} ${user.padEnd(Math.max(user.length, 8), ' ')} ${group.padEnd(Math.max(group.length, 8), ' ')} ${String(e.size).padStart(8, ' ')} ${listingTime(e.mtime, now)} ${e.name}`;
}

function writeAt(buffer: string, offset: number, data: string): string {
  if (offset >= buffer.length) return buffer + '\x00'.repeat(offset - buffer.length) + data;
  const end = offset + data.length;
  const tail = end < buffer.length ? buffer.slice(end) : '';
  return buffer.slice(0, offset) + data + tail;
}

function openFlagsText(pflags: number): string {
  const names: string[] = [];
  if (pflags & SSH_FXF.READ) names.push('READ');
  if (pflags & SSH_FXF.WRITE) names.push('WRITE');
  if (pflags & SSH_FXF.APPEND) names.push('APPEND');
  if (pflags & SSH_FXF.CREAT) names.push('CREATE');
  if (pflags & SSH_FXF.TRUNC) names.push('TRUNCATE');
  if (pflags & SSH_FXF.EXCL) names.push('EXCL');
  return names.join(',');
}

export interface SftpAccountNames {
  user(uid: number): string;
  group(gid: number): string;
}

export type SftpServerLog = (level: SftpLogLevel, text: string) => void;

export interface SftpWireSessionConfig {
  readonly accountNames?: SftpAccountNames;
  readonly vfs: ISftpFileSystem;
  readonly userCtx: SshUserContext;
  readonly rootPath?: string;
  readonly eventBus?: IEventBus;
  readonly options?: SftpServerOptions;
  readonly log?: SftpServerLog;
  readonly clientAddress?: string;
}

const PACKET_REQUEST_NAMES: Readonly<Record<string, string>> = {
  CLOSE: 'close', READ: 'read', WRITE: 'write', LSTAT: 'lstat', FSTAT: 'fstat', SETSTAT: 'setstat',
  FSETSTAT: 'fsetstat', OPENDIR: 'opendir', READDIR: 'readdir', REMOVE: 'remove', MKDIR: 'mkdir', RMDIR: 'rmdir',
  REALPATH: 'realpath', STAT: 'stat', RENAME: 'rename', READLINK: 'readlink', SYMLINK: 'symlink', LINK: 'hardlink',
};

const EXTENSION_REQUEST_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  ADVERTISED_EXTENSIONS.map(([name, , request]) => [name, request]));

export class SftpWireSession {
  private readonly dispatcher = SftpCommandDispatcher.defaults();
  private readonly handles = new SftpHandleTable();
  private readonly sessionId = randomSftpSessionId();
  private readonly options: SftpServerOptions;
  private cwd: string;
  private negotiatedVersion = SFTP_MIN_VERSION;

  constructor(private readonly config: SftpWireSessionConfig) {
    this.options = config.options ?? DEFAULT_SFTP_SERVER_OPTIONS;
    this.cwd = this.options.startDirectory !== null && config.vfs.getEntryType(this.options.startDirectory) === 'directory'
      ? this.options.startDirectory
      : config.rootPath ?? config.userCtx.homeDirectory;
  }

  get version(): number {
    return this.negotiatedVersion;
  }

  begin(): void {
    this.logit(`session opened for local user ${this.config.userCtx.username} from [${this.config.clientAddress ?? 'UNKNOWN'}]`);
  }

  finish(): void {
    for (const [handle, state] of this.handles.entries()) {
      this.logClose(state, 'forced');
      this.handles.close(handle);
    }
    this.logit(`session closed for local user ${this.config.userCtx.username} from [${this.config.clientAddress ?? 'UNKNOWN'}]`);
  }

  private log(level: SftpLogLevel, text: string): void {
    if (this.config.log !== undefined && logLevelAtLeast(this.options.logLevel, level)) this.config.log(level, text);
  }

  private logit(text: string): void {
    this.log('INFO', text);
  }

  private verbose(text: string): void {
    this.log('VERBOSE', text);
  }

  private logClose(state: SftpHandleState, prefix: string | null): void {
    const lead = prefix === null ? '' : `${prefix} `;
    if (state.kind === 'dir') this.logit(`${lead}closedir "${state.name}"`);
    else {
      const read = state.kind === 'file-read' ? state.bytesRead : 0;
      const written = state.kind === 'file-write' ? state.bytesWritten : 0;
      this.logit(`${lead}close "${state.name}" bytes read ${read} written ${written}`);
    }
  }

  private longname(entry: SftpDirEntry): string {
    return longnameOf(entry, this.config.accountNames ?? NUMERIC_ACCOUNT_NAMES, simulationNowMs());
  }

  private ctx(): SftpCommandContext {
    return { vfs: this.config.vfs, userCtx: this.config.userCtx, cwd: this.cwd };
  }

  private creationMask(): number {
    return this.options.umask ?? 0o022;
  }

  private status(requestId: number, code: number): SftpWirePacket {
    if (code !== SSH_FX.OK && code !== SSH_FX.EOF) this.logit(`sent status ${statusMessage(code)}`);
    return { type: 'STATUS', requestId, code, message: statusMessage(code) };
  }

  private failure(requestId: number, error: SshError): SftpWirePacket {
    return this.status(requestId, statusFromError(error).code);
  }

  private okStatus(requestId: number): SftpWirePacket {
    return this.status(requestId, SSH_FX.OK);
  }

  private openHandle(state: SftpHandleState): string | null {
    if (this.handles.openCount >= MAX_OPEN_HANDLES) return null;
    const handle = this.handles.open(state);
    this.config.eventBus?.publish({
      topic: 'sftp.handle.opened',
      payload: { sessionId: this.sessionId, handle, kind: state.kind, path: state.path },
    });
    return handle;
  }

  private closeHandle(handle: string): void {
    this.handles.close(handle);
    this.config.eventBus?.publish({ topic: 'sftp.handle.closed', payload: { sessionId: this.sessionId, handle } });
  }

  private reportProgress(handle: string, bytesTransferred: number): void {
    this.config.eventBus?.publish({
      topic: 'sftp.transfer.progress',
      payload: { sessionId: this.sessionId, handle, bytesTransferred },
    });
  }

  handle(pkt: SftpWirePacket): SftpWirePacket {
    this.config.eventBus?.publish({
      topic: 'sftp.packet.received',
      payload: { sessionId: this.sessionId, packetType: pkt.type, requestId: 'requestId' in pkt ? pkt.requestId : undefined },
    });
    const reply = this.permitted(pkt) ? this.dispatchPacket(pkt) : this.refused(pkt);
    this.config.eventBus?.publish({
      topic: 'sftp.packet.sent',
      payload: { sessionId: this.sessionId, packetType: reply.type, requestId: 'requestId' in reply ? reply.requestId : undefined },
    });
    return reply;
  }

  private requestNameOf(pkt: SftpWirePacket): string | null {
    if (pkt.type === 'EXTENDED') return EXTENSION_REQUEST_NAMES[pkt.name] ?? null;
    if (pkt.type === 'OPEN') return 'open';
    return PACKET_REQUEST_NAMES[pkt.type] ?? null;
  }

  private permitted(pkt: SftpWirePacket): boolean {
    const name = this.requestNameOf(pkt);
    if (name === null || !('requestId' in pkt)) return true;
    const allowed = requestPermitted(this.options, name, SFTP_WRITING_REQUESTS.has(name));
    if (!allowed) {
      if (this.options.readOnly && SFTP_WRITING_REQUESTS.has(name)) this.verbose(`Refusing ${name} request in read-only mode`);
      else this.verbose(`Refusing denylisted ${name} request`);
    }
    return allowed;
  }

  private refused(pkt: SftpWirePacket): SftpWirePacket {
    return this.status('requestId' in pkt ? pkt.requestId : 0, SSH_FX.PERMISSION_DENIED);
  }

  private resolve(path: string): string {
    return this.config.vfs.normalizePath(path, this.cwd);
  }

  private resolvedRealPath(path: string): string | null {
    const target = this.resolve(path === '' ? '.' : path);
    if (target === '/' || this.config.vfs.exists(target)) return target;
    const parent = target.replace(/\/[^/]+\/?$/, '') || '/';
    return this.config.vfs.getEntryType(parent) === 'directory' ? target : null;
  }

  private dispatchPacket(pkt: SftpWirePacket): SftpWirePacket {
    switch (pkt.type) {
      case 'INIT':
        this.negotiatedVersion = Math.max(SFTP_MIN_VERSION, Math.min(pkt.version, SFTP_SERVER_MAX_VERSION));
        return {
          type: 'VERSION', version: this.negotiatedVersion,
          extensions: ADVERTISED_EXTENSIONS
            .filter(([, , request]) => requestPermitted(this.options, request, SFTP_WRITING_REQUESTS.has(request)))
            .map(([name, version]) => ({ name, data: version })),
        };

      case 'REALPATH': {
        const requested = pkt.path === '' ? '.' : pkt.path;
        this.verbose(`realpath "${requested}"`);
        const path = this.resolvedRealPath(requested);
        if (path === null) return this.status(pkt.requestId, SSH_FX.NO_SUCH_FILE);
        return { type: 'NAME', requestId: pkt.requestId, entries: [{ filename: path, longname: path, attrs: {} }] };
      }

      case 'LSTAT':
      case 'STAT': {
        this.verbose(`${pkt.type === 'LSTAT' ? 'l' : ''}stat name "${pkt.path}"`);
        const result = this.dispatcher.dispatch('stat', { path: pkt.path }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        return { type: 'ATTRS', requestId: pkt.requestId, attrs: attrsFrom(result.value as SftpFileAttrs, this.negotiatedVersion) };
      }

      case 'MKDIR': {
        const mode = pkt.attrs.permissions !== undefined ? pkt.attrs.permissions & 0o7777 : 0o777;
        this.logit(`mkdir name "${pkt.path}" mode 0${mode.toString(8)}`);
        const result = this.dispatcher.dispatch('mkdir', { path: pkt.path }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        this.dispatcher.dispatch('chmod', { path: pkt.path, mode: mode & ~this.creationMask() }, this.ctx());
        return this.okStatus(pkt.requestId);
      }

      case 'RMDIR': {
        this.logit(`rmdir name "${pkt.path}"`);
        const result = this.dispatcher.dispatch('rmdir', { path: pkt.path }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        return this.okStatus(pkt.requestId);
      }

      case 'REMOVE': {
        this.logit(`remove name "${pkt.filename}"`);
        const result = this.dispatcher.dispatch('rm', { path: pkt.filename }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        return this.okStatus(pkt.requestId);
      }

      case 'RENAME': {
        this.logit(`rename old "${pkt.oldPath}" new "${pkt.newPath}"`);
        const overwrite = pkt.flags !== undefined && (pkt.flags & SFTP_RENAME_FLAG.OVERWRITE) !== 0;
        const result = this.dispatcher.dispatch('rename', { src: pkt.oldPath, dst: pkt.newPath, overwrite }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        return this.okStatus(pkt.requestId);
      }

      case 'OPENDIR': {
        this.logit(`opendir "${pkt.path}"`);
        const path = this.resolve(pkt.path);
        if (this.config.vfs.getEntryType(path) !== 'directory') {
          return this.status(pkt.requestId, SSH_FX.NO_SUCH_FILE);
        }
        const listing = this.dispatcher.dispatch('ls', { path: pkt.path }, this.ctx());
        if (!isOk(listing)) return this.failure(pkt.requestId, listing.error as SshError);
        const children = (listing.value as { entries: readonly SftpDirEntry[] }).entries.filter((entry) => entry.name !== '.' && entry.name !== '..');
        const dot = this.config.vfs.stat(path);
        const parent = this.config.vfs.stat(path.replace(/\/[^/]+\/?$/, '') || '/');
        const own: SftpDirEntry[] = [];
        if (dot.ok) own.push({ name: '.', ...dot.value });
        if (parent.ok) own.push({ name: '..', ...parent.value });
        const handle = this.openHandle({ kind: 'dir', path, name: pkt.path, drained: false, pending: [...own, ...children] });
        if (handle === null) return this.status(pkt.requestId, SSH_FX.FAILURE);
        return { type: 'HANDLE', requestId: pkt.requestId, handle };
      }

      case 'READDIR': {
        const state = this.handles.get(pkt.handle);
        if (!state || state.kind !== 'dir') return this.status(pkt.requestId, SSH_FX.FAILURE);
        this.verbose(`readdir "${state.name}" (handle ${pkt.handle})`);
        if (state.pending.length === 0) return this.status(pkt.requestId, SSH_FX.EOF);
        const batch = state.pending.slice(0, MAX_ENTRIES_PER_REPLY);
        state.pending = state.pending.slice(batch.length);
        return {
          type: 'NAME', requestId: pkt.requestId,
          entries: batch.map((e) => ({ filename: e.name, longname: this.longname(e), attrs: attrsFrom(e, this.negotiatedVersion) })),
        };
      }

      case 'OPEN': return this.open(pkt);

      case 'READ': {
        const state = this.handles.get(pkt.handle);
        if (!state || state.kind !== 'file-read') return this.status(pkt.requestId, SSH_FX.FAILURE);
        if (pkt.offset >= state.content.length) return this.status(pkt.requestId, SSH_FX.EOF);
        const slice = state.content.slice(pkt.offset, pkt.offset + Math.min(pkt.length, SFTP_MAX_MESSAGE_LENGTH - 1024));
        state.bytesRead += slice.length;
        this.reportProgress(pkt.handle, slice.length);
        return { type: 'DATA', requestId: pkt.requestId, data: binaryStringToBytes(slice) };
      }

      case 'WRITE': {
        const state = this.handles.get(pkt.handle);
        if (!state || state.kind !== 'file-write') return this.status(pkt.requestId, SSH_FX.FAILURE);
        const data = bytesToBinaryString(pkt.data);
        state.buffer = state.append ? state.buffer + data : writeAt(state.buffer, pkt.offset, data);
        state.bytesWritten += data.length;
        this.reportProgress(pkt.handle, pkt.data.length);
        return this.okStatus(pkt.requestId);
      }

      case 'CLOSE': {
        const state = this.handles.get(pkt.handle);
        if (!state) return this.status(pkt.requestId, SSH_FX.FAILURE);
        this.logClose(state, null);
        this.closeHandle(pkt.handle);
        if (state.kind === 'file-write') {
          const result = this.dispatcher.dispatch('put', { path: state.path, content: state.buffer }, this.ctx());
          if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        }
        return this.okStatus(pkt.requestId);
      }

      case 'SYMLINK': {
        const target = pkt.linkpath;
        const link = pkt.targetpath;
        this.logit(`symlink old "${target}" new "${link}"`);
        const result = this.dispatcher.dispatch('symlink', { src: target, dst: link }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        return this.okStatus(pkt.requestId);
      }

      case 'READLINK': {
        this.verbose(`readlink "${pkt.path}"`);
        const result = this.dispatcher.dispatch('readlink', { path: pkt.path }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        const target = (result.value as { target: string }).target;
        return { type: 'NAME', requestId: pkt.requestId, entries: [{ filename: target, longname: target, attrs: {} }] };
      }

      case 'LINK': {
        this.logit(`hardlink old "${pkt.existingPath}" new "${pkt.newLinkPath}"`);
        const result = this.dispatcher.dispatch('hardlink', { src: pkt.existingPath, dst: pkt.newLinkPath }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        return this.okStatus(pkt.requestId);
      }

      case 'SETSTAT':
        return this.setAttributes(pkt.requestId, pkt.path, pkt.attrs);

      case 'EXTENDED': return this.extended(pkt);

      case 'FSTAT': {
        const state = this.handles.get(pkt.handle);
        if (!state) return this.status(pkt.requestId, SSH_FX.FAILURE);
        const result = this.dispatcher.dispatch('stat', { path: state.path }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        const attrs = result.value as SftpFileAttrs;
        const size = state.kind === 'file-write' ? state.buffer.length : attrs.size;
        return { type: 'ATTRS', requestId: pkt.requestId, attrs: attrsFrom({ ...attrs, size }, this.negotiatedVersion) };
      }

      case 'FSETSTAT': {
        const state = this.handles.get(pkt.handle);
        if (!state) return this.status(pkt.requestId, SSH_FX.FAILURE);
        return this.setAttributes(pkt.requestId, state.path, pkt.attrs);
      }

      default:
        return this.status(0, SSH_FX.BAD_MESSAGE);
    }
  }

  private open(pkt: Extract<SftpWirePacket, { type: 'OPEN' }>): SftpWirePacket {
    const mode = pkt.attrs.permissions !== undefined ? pkt.attrs.permissions : 0o666;
    this.logit(`open "${pkt.filename}" flags ${openFlagsText(pkt.pflags)} mode 0${mode.toString(8)}`);
    const writing = (pkt.pflags & SSH_FXF.WRITE) !== 0;
    if (this.options.readOnly && (writing || (pkt.pflags & (SSH_FXF.CREAT | SSH_FXF.TRUNC)) !== 0)) {
      this.verbose('Refusing open request in read-only mode');
      return this.status(pkt.requestId, SSH_FX.PERMISSION_DENIED);
    }
    const path = this.resolve(pkt.filename);
    if (writing) {
      const present = this.config.vfs.exists(path);
      if (!present && !(pkt.pflags & SSH_FXF.CREAT)) return this.status(pkt.requestId, SSH_FX.NO_SUCH_FILE);
      if (present && (pkt.pflags & SSH_FXF.CREAT) && (pkt.pflags & SSH_FXF.EXCL)) {
        return this.status(pkt.requestId, SSH_FX.FAILURE);
      }
      const existing = this.config.vfs.readFile(path);
      const keepsContent = present && existing.ok && !(pkt.pflags & SSH_FXF.TRUNC);
      const buffer = keepsContent ? existing.value : '';
      if (!keepsContent) {
        const created = this.dispatcher.dispatch('put', { path, content: buffer }, this.ctx());
        if (!isOk(created)) return this.failure(pkt.requestId, created.error as SshError);
        if (!present) {
          this.dispatcher.dispatch('chmod', { path, mode: (mode & 0o7777) & ~this.creationMask() }, this.ctx());
        }
      }
      const handle = this.openHandle({
        kind: 'file-write', path, name: pkt.filename, buffer, append: (pkt.pflags & SSH_FXF.APPEND) !== 0, bytesWritten: 0,
      });
      if (handle === null) return this.status(pkt.requestId, SSH_FX.FAILURE);
      return { type: 'HANDLE', requestId: pkt.requestId, handle };
    }
    const result = this.dispatcher.dispatch('get', { path: pkt.filename }, this.ctx());
    if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
    const handle = this.openHandle({
      kind: 'file-read', path, name: pkt.filename, content: (result.value as { content: string }).content, bytesRead: 0,
    });
    if (handle === null) return this.status(pkt.requestId, SSH_FX.FAILURE);
    return { type: 'HANDLE', requestId: pkt.requestId, handle };
  }

  private setAttributes(requestId: number, path: string, attrs: SftpWireAttrs): SftpWirePacket {
    let outcome: SftpWirePacket = this.okStatus(requestId);
    if (attrs.permissions !== undefined) {
      this.logit(`set "${path}" mode ${(attrs.permissions & 0o7777).toString(8).padStart(4, '0')}`);
      const result = this.dispatcher.dispatch('chmod', { path, mode: attrs.permissions & 0o7777 }, this.ctx());
      if (!isOk(result)) outcome = this.failure(requestId, result.error as SshError);
    }
    if (attrs.mtime !== undefined && this.config.vfs.setTimes !== undefined) {
      this.logit(`set "${path}" modtime ${attrs.mtime}`);
      const timed = this.config.vfs.setTimes(this.resolve(path), {
        atime: (attrs.atime ?? attrs.mtime) * 1000, mtime: attrs.mtime * 1000,
      });
      if (!isOk(timed)) outcome = this.failure(requestId, timed.error as SshError);
    }
    if (attrs.uid !== undefined && attrs.gid !== undefined) {
      this.logit(`set "${path}" owner ${attrs.uid} group ${attrs.gid}`);
      const result = this.dispatcher.dispatch('chown', { path, uid: attrs.uid, gid: attrs.gid }, this.ctx());
      if (!isOk(result)) outcome = this.failure(requestId, result.error as SshError);
    }
    return outcome;
  }

  private extended(pkt: Extract<SftpWirePacket, { type: 'EXTENDED' }>): SftpWirePacket {
    const request = EXTENSION_REQUEST_NAMES[pkt.name];
    if (request === undefined) return this.status(pkt.requestId, SSH_FX.OP_UNSUPPORTED);
    const fields = new SshReader(pkt.data);
    switch (request) {
      case 'statvfs':
      case 'fstatvfs': {
        const path = request === 'statvfs'
          ? fields.readString()
          : this.handles.get(fields.readString())?.path ?? null;
        if (path === null) return this.status(pkt.requestId, SSH_FX.FAILURE);
        const result = this.dispatcher.dispatch('df', { path }, this.ctx());
        if (!isOk(result)) return this.failure(pkt.requestId, result.error as SshError);
        const usage = result.value as { totalBytes: number; usedBytes: number; availableBytes: number };
        const blocks = Math.floor(usage.totalBytes / STATVFS_BLOCK_SIZE);
        const free = Math.floor((usage.totalBytes - usage.usedBytes) / STATVFS_BLOCK_SIZE);
        const available = Math.floor(usage.availableBytes / STATVFS_BLOCK_SIZE);
        const reply = new SshWriter();
        const readOnly = this.options.readOnly ? 1 : 0;
        for (const field of [STATVFS_BLOCK_SIZE, STATVFS_BLOCK_SIZE, blocks, free, available, 0, 0, 0, 0, readOnly, 255]) {
          reply.writeUint64(field);
        }
        return { type: 'EXTENDED_REPLY', requestId: pkt.requestId, data: reply.toBytes() };
      }
      case 'posix-rename': {
        const oldPath = fields.readString();
        const newPath = fields.readString();
        this.logit(`posix-rename old "${oldPath}" new "${newPath}"`);
        const result = this.dispatcher.dispatch('rename', { src: oldPath, dst: newPath, overwrite: true }, this.ctx());
        return isOk(result) ? this.okStatus(pkt.requestId) : this.failure(pkt.requestId, result.error as SshError);
      }
      case 'hardlink': {
        const oldPath = fields.readString();
        const newPath = fields.readString();
        this.logit(`hardlink old "${oldPath}" new "${newPath}"`);
        const result = this.dispatcher.dispatch('hardlink', { src: oldPath, dst: newPath }, this.ctx());
        return isOk(result) ? this.okStatus(pkt.requestId) : this.failure(pkt.requestId, result.error as SshError);
      }
      case 'fsync': {
        const handle = this.handles.get(fields.readString());
        this.verbose(`fsync "${handle?.path ?? ''}"`);
        return handle === undefined ? this.status(pkt.requestId, SSH_FX.FAILURE) : this.okStatus(pkt.requestId);
      }
      case 'lsetstat': {
        const path = fields.readString();
        const flags = fields.readUint32();
        const attrs: { permissions?: number; uid?: number; gid?: number; atime?: number; mtime?: number } = {};
        if (flags & 0x01) fields.readUint64();
        if (flags & 0x02) {
          attrs.uid = fields.readUint32();
          attrs.gid = fields.readUint32();
        }
        if (flags & 0x04) attrs.permissions = fields.readUint32();
        if (flags & 0x08) {
          attrs.atime = fields.readUint32();
          attrs.mtime = fields.readUint32();
        }
        return this.setAttributes(pkt.requestId, path, attrs);
      }
      case 'limits': {
        const reply = new SshWriter();
        for (const field of [SFTP_MAX_MESSAGE_LENGTH, SFTP_MAX_MESSAGE_LENGTH - 1024, SFTP_MAX_MESSAGE_LENGTH - 1024, MAX_OPEN_HANDLES]) {
          reply.writeUint64(field);
        }
        return { type: 'EXTENDED_REPLY', requestId: pkt.requestId, data: reply.toBytes() };
      }
      case 'expand-path': {
        const requested = fields.readString();
        const home = this.config.userCtx.homeDirectory;
        const expanded = requested === '~' ? home : requested.startsWith('~/') ? `${home}${requested.slice(1)}` : requested;
        const path = this.resolvedRealPath(expanded);
        if (path === null) return this.status(pkt.requestId, SSH_FX.NO_SUCH_FILE);
        return { type: 'NAME', requestId: pkt.requestId, entries: [{ filename: path, longname: path, attrs: {} }] };
      }
      default:
        return this.status(pkt.requestId, SSH_FX.OP_UNSUPPORTED);
    }
  }
}
