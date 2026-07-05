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
 * streaming read/write primitive. `SYMLINK`/`READLINK` still reply
 * `SSH_FX_OP_UNSUPPORTED`: the dispatcher has no matching command yet
 * (P15).
 */
import { SftpCommandDispatcher } from './SftpCommandDispatcher';
import type { SftpCommandContext } from './ISftpCommand';
import type { ISftpFileSystem, SftpDirEntry, SftpFileAttrs } from './ISftpFileSystem';
import type { SshUserContext } from '../SshUserContext';
import { isOk } from '../Result';
import type { SshError } from '../Result';
import type { SftpWirePacket, SftpWireAttrs } from './SftpWireCodec';
import { SftpHandleTable } from './SftpHandleTable';

/** P16 raises the negotiated default to 6; P13-P15 stay at the dispatcher's current (v3-shaped) fidelity level. */
const SFTP_PROTOCOL_VERSION = 3;

/** draft-ietf-secsh-filexfer §6.3 `pflags` bits relevant here. */
const SSH_FXF = { READ: 0x01, WRITE: 0x02, APPEND: 0x04 } as const;

const SSH_FX = {
  OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4,
  BAD_MESSAGE: 5, NO_CONNECTION: 6, CONNECTION_LOST: 7, OP_UNSUPPORTED: 8,
} as const;

function attrsFrom(a: SftpFileAttrs): SftpWireAttrs {
  return { size: a.size, uid: a.uid, gid: a.gid, permissions: a.mode, mtime: Math.floor(a.mtime / 1000) };
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

function statusFromError(error: SshError): { code: number; message: string } {
  switch (error.kind) {
    case 'PERMISSION_DENIED': return { code: SSH_FX.PERMISSION_DENIED, message: 'Permission denied.' };
    case 'UNKNOWN_OP': return { code: SSH_FX.OP_UNSUPPORTED, message: `Unsupported operation: ${error.op}` };
    case 'IO_ERROR': return { code: /no such|not found/i.test(error.message) ? SSH_FX.NO_SUCH_FILE : SSH_FX.FAILURE, message: error.message };
    case 'INVALID_ARGUMENT': return { code: SSH_FX.BAD_MESSAGE, message: error.message };
    default: return { code: SSH_FX.FAILURE, message: 'Failure.' };
  }
}

export interface SftpWireSessionConfig {
  readonly vfs: ISftpFileSystem;
  readonly userCtx: SshUserContext;
  readonly rootPath?: string;
}

export class SftpWireSession {
  private readonly dispatcher = SftpCommandDispatcher.defaults();
  private readonly handles = new SftpHandleTable();
  private cwd: string;

  constructor(private readonly config: SftpWireSessionConfig) {
    this.cwd = config.rootPath ?? config.userCtx.homeDirectory;
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

  handle(pkt: SftpWirePacket): SftpWirePacket {
    switch (pkt.type) {
      case 'INIT':
        return { type: 'VERSION', version: SFTP_PROTOCOL_VERSION };

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
        const result = this.dispatcher.dispatch('rename', { src: pkt.oldPath, dst: pkt.newPath }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        return this.okStatus(pkt.requestId);
      }

      case 'OPENDIR': {
        const path = this.config.vfs.normalizePath(pkt.path, this.cwd);
        if (this.config.vfs.getEntryType(path) !== 'directory') {
          return this.status(pkt.requestId, SSH_FX.NO_SUCH_FILE, 'No such directory.');
        }
        const handle = this.handles.open({ kind: 'dir', path, drained: false });
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
          const handle = this.handles.open({ kind: 'file-write', path, buffer: initial });
          return { type: 'HANDLE', requestId: pkt.requestId, handle };
        }
        const result = this.dispatcher.dispatch('get', { path: pkt.filename }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        const handle = this.handles.open({ kind: 'file-read', path, content: (result.value as { content: string }).content });
        return { type: 'HANDLE', requestId: pkt.requestId, handle };
      }

      case 'READ': {
        const state = this.handles.get(pkt.handle);
        if (!state || state.kind !== 'file-read') return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        if (pkt.offset >= state.content.length) return this.status(pkt.requestId, SSH_FX.EOF, 'End of file.');
        const slice = state.content.slice(pkt.offset, pkt.offset + pkt.length);
        return { type: 'DATA', requestId: pkt.requestId, data: stringToBytes(slice) };
      }

      case 'WRITE': {
        const state = this.handles.get(pkt.handle);
        if (!state || state.kind !== 'file-write') return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        state.buffer = writeAt(state.buffer, pkt.offset, bytesToString(pkt.data));
        return this.okStatus(pkt.requestId);
      }

      case 'CLOSE': {
        const state = this.handles.get(pkt.handle);
        if (!state) return this.status(pkt.requestId, SSH_FX.FAILURE, 'Invalid handle.');
        this.handles.close(pkt.handle);
        if (state.kind === 'file-write') {
          const result = this.dispatcher.dispatch('put', { path: state.path, content: state.buffer }, this.ctx());
          if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        }
        return this.okStatus(pkt.requestId);
      }

      case 'FSTAT':
      case 'SETSTAT':
      case 'FSETSTAT':
      case 'READLINK':
      case 'SYMLINK':
        return this.status(pkt.requestId, SSH_FX.OP_UNSUPPORTED, 'Operation not yet supported by this server.');

      default:
        return this.status(0, SSH_FX.BAD_MESSAGE, 'Unexpected packet type.');
    }
  }
}
