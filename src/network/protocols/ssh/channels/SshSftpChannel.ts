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

import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';
import { AbstractSshChannel } from './AbstractSshChannel';
import type { ISshSftpChannel, SftpRequest, SftpResponse } from './ISshChannel';
import type { ConnectionChannel, SshConnection } from '../connection/SshConnection';
import { encodeStringPayload } from '../connection/ChannelPayloads';
import { SshReader, SshWriter } from '../wire/SshDataTypes';
import { encodeSftpWirePacket, decodeSftpWirePacket, entryTypeOfAttrs, type SftpWirePacket } from '../sftp/SftpWireCodec';
import { SSH_FX } from '../sftp/SftpStatusCodes';

const CLIENT_SFTP_VERSION = 3;
const READ_CHUNK_SIZE = 32768;
const WRITE_CHUNK_SIZE = 32768;
const PERMISSION_BITS = 0o7777;
const WRITE_CREATE_TRUNCATE = 0x02 | 0x08 | 0x10;
const STATVFS_EXTENSION = 'statvfs@openssh.com';
const SFTP_SUBSYSTEM = 'sftp';

export class SshSftpChannel
  extends AbstractSshChannel
  implements ISshSftpChannel
{
  readonly type = 'sftp' as const;

  private pendingWireReply: SftpWirePacket | null = null;
  private channel: ConnectionChannel | null = null;
  private inbound = new Uint8Array(0);
  private _remoteCwd = '.';
  private nextRequestId = 1;
  private negotiatedVersion = CLIENT_SFTP_VERSION;

  constructor(private readonly connection: SshConnection, channelId: number) {
    super(channelId, 'sftp');
  }

  protected handleOpen(): void {
    const channel = this.connection.beginOpen('session');
    this.channel = channel;
    channel.onData((bytes) => this.receive(bytes));
    channel.onRequest((request) => { request.reply(false); });
    channel.onClose(() => {
      this.channel = null;
      this.close();
    });
    channel.whenOpened((failure) => {
      if (failure !== null) {
        this.close();
        return;
      }
      void channel.request('subsystem', encodeStringPayload(SFTP_SUBSYSTEM), true).then((accepted) => {
        if (!accepted) this.close();
      });
      const version = this.roundTrip({ type: 'INIT', version: CLIENT_SFTP_VERSION });
      if (version?.type === 'VERSION') this.negotiatedVersion = version.version;
    });
  }

  protected handleClose(): void {
    this.channel?.close();
    this.channel = null;
    this.pendingWireReply = null;
    this.inbound = new Uint8Array(0);
  }

  private receive(bytes: Uint8Array): void {
    const merged = new Uint8Array(this.inbound.length + bytes.length);
    merged.set(this.inbound);
    merged.set(bytes, this.inbound.length);
    this.inbound = merged;
    while (this.inbound.length >= 4) {
      const length = ((this.inbound[0] << 24) | (this.inbound[1] << 16) | (this.inbound[2] << 8) | this.inbound[3]) >>> 0;
      if (this.inbound.length < 4 + length) return;
      const packet = decodeSftpWirePacket(this.inbound.subarray(0, 4 + length), this.negotiatedVersion);
      this.inbound = this.inbound.slice(4 + length);
      if (packet !== null) this.pendingWireReply = packet;
    }
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
      case 'df': return this.doDf(String(req.path ?? ''));
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
    if (entryTypeOfAttrs(reply.attrs) !== 'directory') return { ok: false, error: `${target}: Not a directory` };
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
          type: entryTypeOfAttrs(e.attrs),
          mode: (e.attrs.permissions ?? 0) & PERMISSION_BITS,
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
      content += bytesToBinaryString(readReply.data);
      offset += readReply.data.length;
      if (readReply.data.length < READ_CHUNK_SIZE) break; // short read — last chunk
    }
    this.roundTrip({ type: 'CLOSE', requestId: this.nextRequestId++, handle });
    return { ok: true, content };
  }

  private doPut(path: string, content: string): SftpResponse {
    const target = this.resolvePath(path);
    const openReply = this.roundTrip({ type: 'OPEN', requestId: this.nextRequestId++, filename: target, pflags: WRITE_CREATE_TRUNCATE, attrs: {} });
    if (!openReply || openReply.type !== 'HANDLE') {
      return { ok: false, error: openReply ? this.legacyError(openReply) : 'no response' };
    }
    const handle = openReply.handle;
    for (let offset = 0; offset < content.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = content.slice(offset, offset + WRITE_CHUNK_SIZE);
      this.roundTrip({ type: 'WRITE', requestId: this.nextRequestId++, handle, offset, data: binaryStringToBytes(chunk) });
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
      type: entryTypeOfAttrs(reply.attrs),
      mode: (reply.attrs.permissions ?? 0) & PERMISSION_BITS,
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
    this.channel?.write(encodeSftpWirePacket(pkt, this.negotiatedVersion));
    return this.pendingWireReply;
  }

  private doDf(path: string): SftpResponse {
    const reply = this.roundTrip({
      type: 'EXTENDED', requestId: this.nextRequestId++, name: STATVFS_EXTENSION,
      data: new SshWriter().writeString(this.resolvePath(path)).toBytes(),
    });
    if (!reply) return { ok: false, error: 'no response' };
    if (reply.type !== 'EXTENDED_REPLY') return { ok: false, error: reply.type === 'STATUS' ? this.legacyError(reply) : 'Failure' };
    const fields = new SshReader(reply.data);
    const blockSize = fields.readUint64();
    fields.readUint64();
    const blocks = fields.readUint64();
    const free = fields.readUint64();
    const available = fields.readUint64();
    return {
      ok: true,
      totalBytes: blocks * blockSize,
      usedBytes: (blocks - free) * blockSize,
      availableBytes: available * blockSize,
    };
  }
}
