/**
 * SshSftpChannel — real SSH_FXP_* wire protocol over a binary-framed SFTP
 * sub-channel (PRD-FTP-SFTP.md §2.1.20/P19).
 *
 * Public surface (`sendRequest({op, ...}): {ok, ...}`) is unchanged from
 * before this migration — `SftpSession.ts`/`SshCopyId.ts` don't know or
 * care that, underneath, every op now round-trips through a real
 * `SSH_FXP_INIT`/`OPEN`/`READ`/`WRITE`/`CLOSE`/`LSTAT`/`STAT`/`SETSTAT`/
 * `MKDIR`/`RMDIR`/`REMOVE`/`RENAME`/`REALPATH`/`OPENDIR`/`READDIR`
 * exchange instead of one atomic JSON `{op, path, ...}` call. Real SFTP
 * has no server-side "current directory" concept — the client tracks it
 * and always sends resolved (client-side) paths — so this class, not the
 * server, now owns `remoteCwd` and resolves relative paths before
 * encoding a wire packet, exactly like a real sftp client does via its
 * own `REALPATH`-seeded cwd.
 *
 * Framing: `SftpChannelFraming.ts`'s single leading `\0` byte distinguishes
 * a real wire packet from the JSON `{op, ...}` control messages the rest
 * of the shared `TcpConnection` still uses for auth/shell/exec — see that
 * module's doc comment for why the two can never collide.
 *
 * `df` (disk-usage) has no representation in draft-ietf-secsh-filexfer at
 * any version — it's this simulator's own fabrication (`SftpDfCommand`),
 * not a real SFTP feature — so it deliberately keeps going out over the
 * legacy JSON envelope instead of inventing a bespoke `SSH_FXP_EXTENDED`
 * pair for a single already-synthetic op.
 *
 * Reference: DESIGN-SSH-SFTP.md section 7.
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import { AbstractSshChannel } from './AbstractSshChannel';
import type {
  ISshSftpChannel,
  SftpRequest,
  SftpResponse,
} from './ISshChannel';
import {
  encodeSftpChannelFrame,
  decodeSftpChannelFrame,
  isSftpChannelFrame,
} from './SftpChannelFraming';
import {
  encodeSftpWirePacket,
  decodeSftpWirePacket,
  type SftpWirePacket,
} from '../sftp/SftpWireCodec';
import { SSH_FX } from '../sftp/SftpStatusCodes';

/** Real OpenSSH sftp clients propose v3 by default too — matches this project's own pre-existing "SFTP protocol version 3" expectation while still being a genuine negotiation (§2.1.16/P15-P16 lets the server go higher for a peer that asks). */
const CLIENT_SFTP_VERSION = 3;
const READ_CHUNK_SIZE = 32768;
const WRITE_CHUNK_SIZE = 32768;

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

export class SshSftpChannel
  extends AbstractSshChannel
  implements ISshSftpChannel
{
  readonly type = 'sftp' as const;

  private pendingWireReply: SftpWirePacket | null = null;
  private pendingJsonReply: SftpResponse | null = null;
  private offConn: (() => void) | null = null;
  private _remoteCwd = '.';
  private nextRequestId = 1;
  private negotiatedVersion = CLIENT_SFTP_VERSION;

  constructor(conn: TcpConnection, channelId: number) {
    super(conn, channelId, 'sftp');
  }

  protected handleOpen(): void {
    this.offConn = this.conn.onData((data) => {
      if (isSftpChannelFrame(data)) {
        const { channelId, wireBytes } = decodeSftpChannelFrame(data);
        if (channelId === this.channelId) this.pendingWireReply = decodeSftpWirePacket(wireBytes);
        return;
      }
      try {
        this.pendingJsonReply = JSON.parse(data) as SftpResponse;
      } catch {
        this.pendingJsonReply = { ok: false, error: 'malformed response' };
      }
    });
    const version = this.roundTrip({ type: 'INIT', version: CLIENT_SFTP_VERSION });
    if (version?.type === 'VERSION') this.negotiatedVersion = version.version;
  }

  protected handleClose(): void {
    this.offConn?.();
    this.offConn = null;
    this.pendingWireReply = null;
    this.pendingJsonReply = null;
  }

  sendRequest(req: SftpRequest): SftpResponse {
    if (!this._isOpen) return { ok: false, error: 'channel not open' };
    switch (req.op) {
      case 'pwd': return this.doPwd();
      case 'cd': return this.doCd(String(req.path ?? ''));
      case 'ls': return this.doLs(String(req.path ?? '.'));
      case 'get': return this.doGet(String(req.path ?? ''));
      case 'put': return this.doPut(String(req.path ?? ''), String(req.content ?? ''));
      case 'mkdir': return this.doStatusOp({ type: 'MKDIR', requestId: this.nextRequestId++, path: this.resolvePath(String(req.path ?? '')), attrs: {} });
      case 'rm': return this.doStatusOp({ type: 'REMOVE', requestId: this.nextRequestId++, filename: this.resolvePath(String(req.path ?? '')) });
      case 'rmdir': return this.doStatusOp({ type: 'RMDIR', requestId: this.nextRequestId++, path: this.resolvePath(String(req.path ?? '')) });
      case 'rename': return this.doStatusOp({
        type: 'RENAME', requestId: this.nextRequestId++,
        oldPath: this.resolvePath(String(req.src ?? '')), newPath: this.resolvePath(String(req.dst ?? '')),
      });
      case 'chmod': return this.doStatusOp({
        type: 'SETSTAT', requestId: this.nextRequestId++,
        path: this.resolvePath(String(req.path ?? '')), attrs: { permissions: Number(req.mode) },
      });
      case 'chown': return this.doStatusOp({
        type: 'SETSTAT', requestId: this.nextRequestId++,
        path: this.resolvePath(String(req.path ?? '')), attrs: { uid: Number(req.uid), gid: Number(req.gid) },
      });
      case 'stat': return this.doStat(String(req.path ?? ''));
      case 'version': return { ok: true, protocolVersion: this.negotiatedVersion };
      case 'df': return this.legacyJsonRequest(req);
      default: return { ok: false, error: `unsupported op: ${req.op}` };
    }
  }

  get remoteCwd(): string {
    return this._remoteCwd;
  }

  // ── op translation ──────────────────────────────────────────────

  private doPwd(): SftpResponse {
    const reply = this.roundTrip({ type: 'REALPATH', requestId: this.nextRequestId++, path: this._remoteCwd });
    if (!reply || reply.type !== 'NAME') return { ok: false, error: reply ? this.legacyError(reply) : 'no response' };
    const cwd = reply.entries[0]?.filename ?? this._remoteCwd;
    this._remoteCwd = cwd;
    return { ok: true, cwd };
  }

  private doCd(path: string): SftpResponse {
    const target = this.resolvePath(path);
    const reply = this.roundTrip({ type: 'LSTAT', requestId: this.nextRequestId++, path: target });
    if (!reply) return { ok: false, error: 'no response' };
    if (reply.type === 'STATUS') return { ok: false, error: this.legacyError(reply) };
    if (reply.type !== 'ATTRS') return { ok: false, error: 'Failure' };
    if (reply.attrs.entryType !== 'directory') return { ok: false, error: `${target}: Not a directory` };
    this._remoteCwd = target;
    return { ok: true, cwd: target };
  }

  private doLs(path: string): SftpResponse {
    const target = this.resolvePath(path);
    const openReply = this.roundTrip({ type: 'OPENDIR', requestId: this.nextRequestId++, path: target });
    if (!openReply || openReply.type !== 'HANDLE') {
      return { ok: false, error: openReply ? this.legacyError(openReply) : 'no response' };
    }
    const handle = openReply.handle;
    const entries: Array<{ name: string; type: string; mode: number; uid: number; gid: number; size: number; mtime: number }> = [];
    for (;;) {
      const readReply = this.roundTrip({ type: 'READDIR', requestId: this.nextRequestId++, handle });
      if (!readReply || readReply.type !== 'NAME') break; // STATUS (EOF or error) or no response — either way, done listing
      for (const e of readReply.entries) {
        entries.push({
          name: e.filename,
          type: e.attrs.entryType ?? 'file',
          mode: e.attrs.permissions ?? 0,
          uid: e.attrs.uid ?? 0,
          gid: e.attrs.gid ?? 0,
          size: e.attrs.size ?? 0,
          mtime: (e.attrs.mtime ?? 0) * 1000,
        });
      }
    }
    this.roundTrip({ type: 'CLOSE', requestId: this.nextRequestId++, handle });
    return { ok: true, entries };
  }

  private doGet(path: string): SftpResponse {
    const target = this.resolvePath(path);
    const openReply = this.roundTrip({ type: 'OPEN', requestId: this.nextRequestId++, filename: target, pflags: 0x01, attrs: {} });
    if (!openReply || openReply.type !== 'HANDLE') {
      return { ok: false, error: openReply ? this.legacyError(openReply) : 'no response' };
    }
    const handle = openReply.handle;
    let content = '';
    let offset = 0;
    for (;;) {
      const readReply = this.roundTrip({ type: 'READ', requestId: this.nextRequestId++, handle, offset, length: READ_CHUNK_SIZE });
      if (!readReply || readReply.type !== 'DATA') break; // STATUS (EOF/error) or no response — done reading
      content += bytesToString(readReply.data);
      offset += readReply.data.length;
      if (readReply.data.length < READ_CHUNK_SIZE) break; // short read — last chunk
    }
    this.roundTrip({ type: 'CLOSE', requestId: this.nextRequestId++, handle });
    return { ok: true, content };
  }

  private doPut(path: string, content: string): SftpResponse {
    const target = this.resolvePath(path);
    const openReply = this.roundTrip({ type: 'OPEN', requestId: this.nextRequestId++, filename: target, pflags: 0x02, attrs: {} });
    if (!openReply || openReply.type !== 'HANDLE') {
      return { ok: false, error: openReply ? this.legacyError(openReply) : 'no response' };
    }
    const handle = openReply.handle;
    for (let offset = 0; offset < content.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = content.slice(offset, offset + WRITE_CHUNK_SIZE);
      this.roundTrip({ type: 'WRITE', requestId: this.nextRequestId++, handle, offset, data: stringToBytes(chunk) });
    }
    const closeReply = this.roundTrip({ type: 'CLOSE', requestId: this.nextRequestId++, handle });
    if (closeReply && closeReply.type === 'STATUS' && closeReply.code !== SSH_FX.OK) {
      return { ok: false, error: this.legacyError(closeReply) };
    }
    return { ok: true };
  }

  private doStat(path: string): SftpResponse {
    const target = this.resolvePath(path);
    const reply = this.roundTrip({ type: 'STAT', requestId: this.nextRequestId++, path: target });
    if (!reply || reply.type !== 'ATTRS') return { ok: false, error: reply ? this.legacyError(reply) : 'no response' };
    return {
      ok: true,
      type: reply.attrs.entryType,
      mode: reply.attrs.permissions ?? 0,
      uid: reply.attrs.uid ?? 0,
      gid: reply.attrs.gid ?? 0,
      size: reply.attrs.size ?? 0,
      mtime: (reply.attrs.mtime ?? 0) * 1000,
    };
  }

  private doStatusOp(pkt: SftpWirePacket): SftpResponse {
    const reply = this.roundTrip(pkt);
    if (!reply) return { ok: false, error: 'no response' };
    if (reply.type !== 'STATUS') return { ok: true };
    if (reply.code === SSH_FX.OK) return { ok: true };
    return { ok: false, error: this.legacyError(reply) };
  }

  // ── helpers ──────────────────────────────────────────────────────

  private resolvePath(path: string): string {
    if (path === '' || path === '.') return this._remoteCwd;
    if (path.startsWith('/')) return path;
    return `${this._remoteCwd.replace(/\/$/, '')}/${path}`;
  }

  /** Legacy-shaped error text so `SftpSession.ts`'s substring-sniffing (e.g. `/permission denied/i` on `cd`) keeps working unchanged. */
  private legacyError(reply: SftpWirePacket): string {
    if (reply.type !== 'STATUS') return 'Failure';
    switch (reply.code) {
      case SSH_FX.NO_SUCH_FILE: return 'No such file or directory';
      case SSH_FX.PERMISSION_DENIED: return 'Permission denied';
      case SSH_FX.OP_UNSUPPORTED: return 'Unknown SFTP op';
      case SSH_FX.BAD_MESSAGE: return reply.message;
      default: return 'Failure';
    }
  }

  private roundTrip(pkt: SftpWirePacket): SftpWirePacket | null {
    this.pendingWireReply = null;
    this.conn.write(encodeSftpChannelFrame(this.channelId, encodeSftpWirePacket(pkt)));
    return this.pendingWireReply;
  }

  private legacyJsonRequest(req: SftpRequest): SftpResponse {
    if (!this._isOpen) return { ok: false, error: 'channel not open' };
    this.pendingJsonReply = null;
    this.conn.write(JSON.stringify({ ...req, channelId: this.channelId }));
    return this.pendingJsonReply ?? { ok: false, error: 'no response' };
  }
}
