/**
 * SftpWireSession — bridges the real `SSH_FXP_*` wire codec
 * (`SftpWireCodec.ts`) to the existing `SftpCommandDispatcher`/
 * `ISftpFileSystem`, without modifying either (PRD-FTP-SFTP.md
 * §2.1.14-15's explicit boundary: "réutilise entièrement... seul
 * l'encodage change"). `OPEN`/`OPENDIR` register a real handle in
 * `SftpHandleTable`; `READ`/`WRITE` operate on `(handle, offset,
 * length)` against it; `CLOSE` releases it (§2.1.15/P14) — the handle
 * is a logical cursor over the same atomic `get`/`put` commands the
 * dispatcher already exposes, since the underlying filesystem has no
 * streaming read/write primitive. `SYMLINK`/`READLINK` dispatch to the
 * dispatcher's new `symlink`/`readlink` commands (§2.1.15/P15), which
 * fall back to `SSH_FX_OP_UNSUPPORTED` on any `ISftpFileSystem` that
 * doesn't implement the optional `createSymlink`/`readSymlink`
 * capability. `LINK` (v6 hard link, §2.1.17/P16) dispatches the same
 * way to a `hardlink` command. `INIT` negotiates a real version
 * (floor 3, ceiling 6, §2.1.16-17/P15-P16) instead of a fixed constant;
 * `RENAME`'s v5+ `OVERWRITE` flag is honored (`ATOMIC`/`NATIVE` are
 * accepted but no-ops); `ATTRS` carries the v4-v6 `type`/`acl`/
 * `extended` fields whenever the backing `SftpFileAttrs` has them.
 * `FSTAT`/`SETSTAT`/`FSETSTAT` still reply `SSH_FX_OP_UNSUPPORTED` (no
 * matching dispatcher command exists yet). Every `handle()` call emits
 * `sftp.packet.received`/`sftp.packet.sent`; handle allocation/release
 * emits `sftp.handle.opened`/`sftp.handle.closed`; `READ`/`WRITE` emit
 * `sftp.transfer.progress` (§2.1.18/P17, `events.ts`/`observables.ts`),
 * via an optional `eventBus` — mirrors `network/ftp/`'s inline,
 * server-side-only emission (no timer-driven actor engine needed for a
 * synchronous request/response protocol).
 */
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
import { SSH_FX, statusFromError } from './SftpStatusCodes';
import type { IEventBus } from '@/events/EventBus';
import { randomSftpSessionId } from './events';

/**
 * §2.1.16-17/P15-P16 — this engine's negotiation ceiling. It proposes
 * (and accepts) up to version 6, the real target; version 3 is only
 * the interoperability floor for a peer offering nothing newer
 * (widespread OpenSSH), never a value the engine invents on its own.
 */
export const STATVFS_EXTENSION = 'statvfs@openssh.com';
export const STATVFS_BLOCK_SIZE = 4096;

const SFTP_SERVER_MAX_VERSION = 6;
const SFTP_MIN_VERSION = 3;

/** draft-ietf-secsh-filexfer §6.3 `pflags` bits relevant here. */
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
  return `${kind}${bits} ${String(links).padStart(3, ' ')} ${names.user(e.uid).padEnd(8, ' ')} ${names.group(e.gid).padEnd(8, ' ')} ${String(e.size).padStart(8, ' ')} ${listingTime(e.mtime, now)} ${e.name}`;
}

/** Overwrites/extends `buffer` at `offset` with `data`, zero-padding any gap — a simplified sparse write. */
function writeAt(buffer: string, offset: number, data: string): string {
  if (offset >= buffer.length) return buffer + '\x00'.repeat(offset - buffer.length) + data;
  const end = offset + data.length;
  const tail = end < buffer.length ? buffer.slice(end) : '';
  return buffer.slice(0, offset) + data + tail;
}

export interface SftpAccountNames {
  user(uid: number): string;
  group(gid: number): string;
}

export interface SftpWireSessionConfig {
  readonly accountNames?: SftpAccountNames;
  readonly vfs: ISftpFileSystem;
  readonly userCtx: SshUserContext;
  readonly rootPath?: string;
  readonly eventBus?: IEventBus;
}

export class SftpWireSession {
  private readonly dispatcher = SftpCommandDispatcher.defaults();
  private readonly handles = new SftpHandleTable();
  private readonly sessionId = randomSftpSessionId();
  private cwd: string;
  private negotiatedVersion = SFTP_MIN_VERSION;

  constructor(private readonly config: SftpWireSessionConfig) {
    this.cwd = config.rootPath ?? config.userCtx.homeDirectory;
  }

  /** The version this session settled on after `INIT`/`VERSION` (§2.1.16/P15) — floor 3, ceiling 6. */
  get version(): number {
    return this.negotiatedVersion;
  }

  private longname(entry: SftpDirEntry): string {
    return longnameOf(entry, this.config.accountNames ?? NUMERIC_ACCOUNT_NAMES, Date.now());
  }

  private ctx(): SftpCommandContext {
    return { vfs: this.config.vfs, userCtx: this.config.userCtx, cwd: this.cwd };
  }

  private status(requestId: number, code: number, message: string): SftpWirePacket {
    return { type: 'STATUS', requestId, code, message };
  }

  private okStatus(requestId: number): SftpWirePacket {
    return this.status(requestId, SSH_FX.OK, 'OK');
  }

  private openHandle(state: SftpHandleState): string {
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
    const reply = this.dispatchPacket(pkt);
    this.config.eventBus?.publish({
      topic: 'sftp.packet.sent',
      payload: { sessionId: this.sessionId, packetType: reply.type, requestId: 'requestId' in reply ? reply.requestId : undefined },
    });
    return reply;
  }

  private dispatchPacket(pkt: SftpWirePacket): SftpWirePacket {
    switch (pkt.type) {
      case 'INIT':
        this.negotiatedVersion = Math.max(SFTP_MIN_VERSION, Math.min(pkt.version, SFTP_SERVER_MAX_VERSION));
        return { type: 'VERSION', version: this.negotiatedVersion, extensions: [{ name: STATVFS_EXTENSION, data: '2' }] };

      case 'REALPATH': {
        const path = this.config.vfs.normalizePath(pkt.path, this.cwd);
        return { type: 'NAME', requestId: pkt.requestId, entries: [{ filename: path, longname: path, attrs: {} }] };
      }

      case 'LSTAT':
      case 'STAT': {
        const result = this.dispatcher.dispatch('stat', { path: pkt.path }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        return { type: 'ATTRS', requestId: pkt.requestId, attrs: attrsFrom(result.value as SftpFileAttrs, this.negotiatedVersion) };
      }

      case 'MKDIR': {
        const result = this.dispatcher.dispatch('mkdir', { path: pkt.path }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        return this.okStatus(pkt.requestId);
      }

      case 'RMDIR': {
        const result = this.dispatcher.dispatch('rmdir', { path: pkt.path }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        return this.okStatus(pkt.requestId);
      }

      case 'REMOVE': {
        const result = this.dispatcher.dispatch('rm', { path: pkt.filename }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        return this.okStatus(pkt.requestId);
      }

      case 'RENAME': {
        // v5+ OVERWRITE (§6.5); ATOMIC/NATIVE are accepted but no-ops (this simulator's rename is already atomic).
        const overwrite = pkt.flags !== undefined && (pkt.flags & SFTP_RENAME_FLAG.OVERWRITE) !== 0;
        const result = this.dispatcher.dispatch('rename', { src: pkt.oldPath, dst: pkt.newPath, overwrite }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        return this.okStatus(pkt.requestId);
      }

      case 'OPENDIR': {
        const path = this.config.vfs.normalizePath(pkt.path, this.cwd);
        if (this.config.vfs.getEntryType(path) !== 'directory') {
          return this.status(pkt.requestId, SSH_FX.NO_SUCH_FILE, 'No such directory.');
        }
        const handle = this.openHandle({ kind: 'dir', path, drained: false });
        return { type: 'HANDLE', requestId: pkt.requestId, handle };
      }

      case 'READDIR': {
        const state = this.handles.get(pkt.handle);
        if (!state || state.kind !== 'dir') return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        if (state.drained) return this.status(pkt.requestId, SSH_FX.EOF, 'End of file.');
        const result = this.dispatcher.dispatch('ls', { path: state.path }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        state.drained = true;
        const entries = (result.value as { entries: readonly SftpDirEntry[] }).entries;
        return {
          type: 'NAME', requestId: pkt.requestId,
          entries: entries.map((e) => ({ filename: e.name, longname: this.longname(e), attrs: attrsFrom(e, this.negotiatedVersion) })),
        };
      }

      case 'OPEN': {
        const path = this.config.vfs.normalizePath(pkt.filename, this.cwd);
        if (pkt.pflags & SSH_FXF.WRITE) {
          const existing = this.config.vfs.readFile(path);
          const present = this.config.vfs.exists(path);
          if (!present && !(pkt.pflags & SSH_FXF.CREAT)) return this.status(pkt.requestId, SSH_FX.NO_SUCH_FILE, 'No such file.');
          if (present && (pkt.pflags & SSH_FXF.CREAT) && (pkt.pflags & SSH_FXF.EXCL)) {
            return this.status(pkt.requestId, SSH_FX.FAILURE, 'File exists.');
          }
          const keepsContent = present && existing.ok && !(pkt.pflags & SSH_FXF.TRUNC);
          const buffer = keepsContent ? existing.value : '';
          if (!keepsContent) {
            const created = this.dispatcher.dispatch('put', { path, content: buffer }, this.ctx());
            if (!isOk(created)) { const s = statusFromError(created.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
          }
          const handle = this.openHandle({ kind: 'file-write', path, buffer });
          return { type: 'HANDLE', requestId: pkt.requestId, handle };
        }
        const result = this.dispatcher.dispatch('get', { path: pkt.filename }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        const handle = this.openHandle({ kind: 'file-read', path, content: (result.value as { content: string }).content });
        return { type: 'HANDLE', requestId: pkt.requestId, handle };
      }

      case 'READ': {
        const state = this.handles.get(pkt.handle);
        if (!state || state.kind !== 'file-read') return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        if (pkt.offset >= state.content.length) return this.status(pkt.requestId, SSH_FX.EOF, 'End of file.');
        const slice = state.content.slice(pkt.offset, pkt.offset + pkt.length);
        this.reportProgress(pkt.handle, slice.length);
        return { type: 'DATA', requestId: pkt.requestId, data: binaryStringToBytes(slice) };
      }

      case 'WRITE': {
        const state = this.handles.get(pkt.handle);
        if (!state || state.kind !== 'file-write') return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        state.buffer = writeAt(state.buffer, pkt.offset, bytesToBinaryString(pkt.data));
        this.reportProgress(pkt.handle, pkt.data.length);
        return this.okStatus(pkt.requestId);
      }

      case 'CLOSE': {
        const state = this.handles.get(pkt.handle);
        if (!state) return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        this.closeHandle(pkt.handle);
        if (state.kind === 'file-write') {
          const result = this.dispatcher.dispatch('put', { path: state.path, content: state.buffer }, this.ctx());
          if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        }
        return this.okStatus(pkt.requestId);
      }

      case 'SYMLINK': {
        const result = this.dispatcher.dispatch('symlink', { src: pkt.targetpath, dst: pkt.linkpath }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        return this.okStatus(pkt.requestId);
      }

      case 'READLINK': {
        const result = this.dispatcher.dispatch('readlink', { path: pkt.path }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        const target = (result.value as { target: string }).target;
        return { type: 'NAME', requestId: pkt.requestId, entries: [{ filename: target, longname: target, attrs: {} }] };
      }

      case 'LINK': {
        const result = this.dispatcher.dispatch('hardlink', { src: pkt.existingPath, dst: pkt.newLinkPath }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        return this.okStatus(pkt.requestId);
      }

      case 'SETSTAT': {
        // §2.1.20/P19 — real chmod/chown backing for the SETSTAT attribute flags a client actually sends.
        if (pkt.attrs.permissions !== undefined) {
          const result = this.dispatcher.dispatch('chmod', { path: pkt.path, mode: pkt.attrs.permissions & 0o7777 }, this.ctx());
          if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        }
        if (pkt.attrs.uid !== undefined && pkt.attrs.gid !== undefined) {
          const result = this.dispatcher.dispatch('chown', { path: pkt.path, uid: pkt.attrs.uid, gid: pkt.attrs.gid }, this.ctx());
          if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        }
        return this.okStatus(pkt.requestId);
      }

      case 'EXTENDED': {
        if (pkt.name !== STATVFS_EXTENSION) return this.status(pkt.requestId, SSH_FX.OP_UNSUPPORTED, 'Unsupported extension.');
        const path = new SshReader(pkt.data).readString();
        const result = this.dispatcher.dispatch('df', { path }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        const usage = result.value as { totalBytes: number; usedBytes: number; availableBytes: number };
        const blocks = Math.floor(usage.totalBytes / STATVFS_BLOCK_SIZE);
        const free = Math.floor((usage.totalBytes - usage.usedBytes) / STATVFS_BLOCK_SIZE);
        const available = Math.floor(usage.availableBytes / STATVFS_BLOCK_SIZE);
        const reply = new SshWriter();
        for (const field of [STATVFS_BLOCK_SIZE, STATVFS_BLOCK_SIZE, blocks, free, available, 0, 0, 0, 0, 0, 255]) {
          reply.writeUint64(field);
        }
        return { type: 'EXTENDED_REPLY', requestId: pkt.requestId, data: reply.toBytes() };
      }

      case 'FSTAT': {
        const state = this.handles.get(pkt.handle);
        if (!state) return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        const result = this.dispatcher.dispatch('stat', { path: state.path }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        const attrs = result.value as SftpFileAttrs;
        const size = state.kind === 'file-write' ? state.buffer.length : attrs.size;
        return { type: 'ATTRS', requestId: pkt.requestId, attrs: attrsFrom({ ...attrs, size }, this.negotiatedVersion) };
      }

      case 'FSETSTAT': {
        const state = this.handles.get(pkt.handle);
        if (!state) return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        return this.dispatchPacket({ type: 'SETSTAT', requestId: pkt.requestId, path: state.path, attrs: pkt.attrs });
      }

      default:
        return this.status(0, SSH_FX.BAD_MESSAGE, 'Unexpected packet type.');
    }
  }
}
