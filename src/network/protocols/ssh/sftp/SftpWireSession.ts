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
import { SftpCommandDispatcher } from './SftpCommandDispatcher';
import type { SftpCommandContext } from './ISftpCommand';
import type { ISftpFileSystem, SftpDirEntry, SftpFileAttrs } from './ISftpFileSystem';
import type { SshUserContext } from '../SshUserContext';
import { isOk } from '../Result';
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
const SFTP_SERVER_MAX_VERSION = 6;
const SFTP_MIN_VERSION = 3;

/** draft-ietf-secsh-filexfer §6.3 `pflags` bits relevant here. */
const SSH_FXF = { READ: 0x01, WRITE: 0x02, APPEND: 0x04 } as const;

function attrsFrom(a: SftpFileAttrs): SftpWireAttrs {
  return {
    size: a.size, uid: a.uid, gid: a.gid, permissions: a.mode, mtime: Math.floor(a.mtime / 1000),
    entryType: a.type,
    acl: a.acl,
    extended: a.extended && Object.entries(a.extended).map(([name, value]) => ({ name, value })),
  };
}

function longnameOf(e: SftpDirEntry): string {
  const kind = e.type === 'directory' ? 'd' : e.type === 'symlink' ? 'l' : '-';
  const perm = (e.mode & 0o777).toString(8).padStart(3, '0');
  return `${kind}${perm} 1 ${e.uid} ${e.gid} ${e.size} ${new Date(e.mtime).toISOString()} ${e.name}`;
}

function stringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function bytesToString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** Overwrites/extends `buffer` at `offset` with `data`, zero-padding any gap — a simplified sparse write. */
function writeAt(buffer: string, offset: number, data: string): string {
  if (offset >= buffer.length) return buffer + '\x00'.repeat(offset - buffer.length) + data;
  const end = offset + data.length;
  const tail = end < buffer.length ? buffer.slice(end) : '';
  return buffer.slice(0, offset) + data + tail;
}

export interface SftpWireSessionConfig {
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
        return { type: 'VERSION', version: this.negotiatedVersion };

      case 'REALPATH': {
        const path = this.config.vfs.normalizePath(pkt.path, this.cwd);
        return { type: 'NAME', requestId: pkt.requestId, entries: [{ filename: path, longname: path, attrs: {} }] };
      }

      case 'LSTAT':
      case 'STAT': {
        const result = this.dispatcher.dispatch('stat', { path: pkt.path }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        return { type: 'ATTRS', requestId: pkt.requestId, attrs: attrsFrom(result.value as SftpFileAttrs) };
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
          entries: entries.map((e) => ({ filename: e.name, longname: longnameOf(e), attrs: attrsFrom(e) })),
        };
      }

      case 'OPEN': {
        const path = this.config.vfs.normalizePath(pkt.filename, this.cwd);
        if (pkt.pflags & SSH_FXF.WRITE) {
          let initial = '';
          if (pkt.pflags & SSH_FXF.APPEND) {
            const existing = this.config.vfs.readFile(path);
            if (existing.ok) initial = existing.value;
          }
          const handle = this.openHandle({ kind: 'file-write', path, buffer: initial });
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
        return { type: 'DATA', requestId: pkt.requestId, data: stringToBytes(slice) };
      }

      case 'WRITE': {
        const state = this.handles.get(pkt.handle);
        if (!state || state.kind !== 'file-write') return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        state.buffer = writeAt(state.buffer, pkt.offset, bytesToString(pkt.data));
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

      case 'FSTAT':
      case 'SETSTAT':
      case 'FSETSTAT':
        return this.status(pkt.requestId, SSH_FX.OP_UNSUPPORTED, 'Operation not yet supported by this server.');

      default:
        return this.status(0, SSH_FX.BAD_MESSAGE, 'Unexpected packet type.');
    }
  }
}
