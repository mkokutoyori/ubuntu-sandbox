/**
 * SftpWireSession — bridges the real `SSH_FXP_*` wire codec
 * (`SftpWireCodec.ts`) to the existing `SftpCommandDispatcher`/
 * `ISftpFileSystem`, without modifying either (PRD-FTP-SFTP.md
 * §2.1.14/P13's explicit boundary: "réutilise entièrement... seul
 * l'encodage change"). Only the stateless operations are wired here —
 * `OPEN`/`READ`/`WRITE`/`CLOSE`'s real handle semantics are P14's
 * deliverable (`SftpHandleTable.ts`); until then this session replies
 * `SSH_FX_OP_UNSUPPORTED` to them, a real (if minimal) SFTP status
 * rather than silence. `SYMLINK`/`READLINK` are P15's (the dispatcher
 * has no matching command yet), same treatment.
 */
import { SftpCommandDispatcher } from './SftpCommandDispatcher';
import type { SftpCommandContext } from './ISftpCommand';
import type { ISftpFileSystem, SftpDirEntry, SftpFileAttrs } from './ISftpFileSystem';
import type { SshUserContext } from '../SshUserContext';
import { isOk } from '../Result';
import type { SshError } from '../Result';
import type { SftpWirePacket, SftpWireAttrs } from './SftpWireCodec';

/** P16 raises the negotiated default to 6; P13 stays at the dispatcher's current (v3-shaped) fidelity level. */
const SFTP_PROTOCOL_VERSION = 3;

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
  private cwd: string;
  private readonly drainedReaddirHandles = new Set<string>();

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
        return { type: 'HANDLE', requestId: pkt.requestId, handle: path };
      }

      case 'READDIR': {
        if (this.drainedReaddirHandles.has(pkt.handle)) {
          return this.status(pkt.requestId, SSH_FX.EOF, 'End of file.');
        }
        const result = this.dispatcher.dispatch('ls', { path: pkt.handle }, this.ctx());
        if (!isOk(result)) { const s = statusFromError(result.error as SshError); return this.status(pkt.requestId, s.code, s.message); }
        this.drainedReaddirHandles.add(pkt.handle);
        const entries = (result.value as { entries: readonly SftpDirEntry[] }).entries;
        return {
          type: 'NAME', requestId: pkt.requestId,
          entries: entries.map((e) => ({ filename: e.name, longname: longnameOf(e), attrs: attrsFrom(e) })),
        };
      }

      case 'CLOSE':
        this.drainedReaddirHandles.delete(pkt.handle);
        return this.okStatus(pkt.requestId);

      case 'OPEN':
      case 'READ':
      case 'WRITE':
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
