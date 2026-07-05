/**
 * FTP (RFC 959 §3-5) — server-side control channel state machine for one
 * connection. `handle()` takes a `FtpCommand` and returns the reply
 * sequence to send back (almost always one reply; transfer commands send
 * a preliminary `1xx` before the final `2xx`/`4xx`/`5xx`, matching real
 * servers) — the wire glue (`FtpServer.ts`) writes each one as its own
 * message. Reuses `ISftpFileSystem` (`@/network/protocols/ssh/sftp`) for
 * all file access, exactly as `PRD-FTP-SFTP.md` §1.2 calls for, so this
 * server can be pointed at any of the adapters that interface already
 * has (Linux VFS, Windows, router flash, or a bare in-memory VFS).
 */
import type { TcpSocket, TcpStack } from '@/network/tcp/TcpStack';
import type { ISftpFileSystem, SftpDirEntry, SftpFileAttrs } from '@/network/protocols/ssh/sftp/ISftpFileSystem';
import { ChrootedSftpFileSystem } from '@/network/protocols/ssh/sftp/ChrootedSftpFileSystem';
import type { TlsServerConfig, TlsServerSession } from '@/network/tls/TlsServerSession';
import type { IEventBus } from '@/events/EventBus';
import type { FtpCommand, FtpReply, FtpTransferType, FtpFileStructure, FtpTransferMode } from './types';
import { reply } from './replies';
import {
  type FtpDataChannel, PassiveDataChannel, decodePortArgument, encodePortArgument, openDataConnection,
  allocatePassivePort, decodeEprtArgument, encodeEpsvReplyArgument,
} from './DataChannel';
import { encodeCompressedMode, decodeCompressedMode } from './compressedMode';
import { startServerHandshake, encryptText, decryptText } from './ftps';
import { randomFtpConnectionId } from './events';

export interface FtpServerConfig {
  /** username -> password. RFC 959 doesn't mandate a specific credential store; this mirrors the ad hoc user maps used elsewhere in this project's protocol tests (RADIUS, EAP-TTLS). */
  readonly users: ReadonlyMap<string, string>;
  readonly fs: ISftpFileSystem;
  /** Initial working directory; defaults to `/`. Ignored for a user with a chroot entry (§2.1.9 — the chroot's own root is always `/`). */
  readonly rootPath?: string;
  /** username -> confinement root, applied via `ChrootedSftpFileSystem` once login succeeds (§2.1.9, same principle as the SFTP side). */
  readonly chroots?: ReadonlyMap<string, string>;
  /**
   * RFC 2228/4217 — set to accept `AUTH TLS`. Absent means FTPS is simply
   * unsupported (`AUTH` replies `502`), same as a plain vsftpd without
   * `ssl_enable`. `PROT P` (RFC 4217 §4) reuses this same certificate for
   * each data channel's own TLS handshake — scoped to `PASV`/`EPSV` data
   * channels only (§2.1.7's non-objectifs): the FTP server is always the
   * TCP listener there, so it's naturally also the TLS server, with no
   * role ambiguity to resolve; `PORT`/`EPRT` + `PROT P` isn't wired up.
   */
  readonly ftps?: TlsServerConfig;
  /** §2.1.12 observability — publishes `ftp.*`/`ftps.*` events (`events.ts`) if set. */
  readonly eventBus?: IEventBus;
}

type SessionState = 'awaiting-user' | 'awaiting-password' | 'authenticated' | 'closed';

function formatListLine(entry: SftpDirEntry): string {
  const kind = entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-';
  const perm = (entry.mode & 0o777).toString(8).padStart(3, '0');
  return `${kind}${perm} 1 ${entry.uid} ${entry.gid} ${entry.size} ${new Date(entry.mtime).toISOString()} ${entry.name}`;
}

/** RFC 3659 §2.3 — `MDTM`/`MLST`'s `modify=` fact both use `YYYYMMDDHHMMSS` in UTC. */
function formatMdtm(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** RFC 3659 §7.5 — one `type=...;size=...;modify=...;` fact list per `MLST`/`MLSD` entry. */
function formatMlstFacts(attrs: Pick<SftpFileAttrs, 'type' | 'size' | 'mtime'>): string {
  const type = attrs.type === 'directory' ? 'dir' : 'file';
  return `type=${type};size=${attrs.size};modify=${formatMdtm(attrs.mtime)};`;
}

export class FtpServerSession {
  result: 'open' | 'closed' = 'open';
  username: string | null = null;
  authenticated = false;
  transferType: FtpTransferType = 'A';
  fileStructure: FtpFileStructure = 'F';
  transferMode: FtpTransferMode = 'S';
  cwd: string;

  /** RFC 2228 — set once `AUTH TLS`'s handshake actually completes (via `markControlProtected()`), not merely once it's requested. */
  controlProtected = false;
  /** RFC 4217 §4 — `PROT C` (data in the clear) or `PROT P` (data TLS-protected too); only meaningful once `controlProtected`. */
  dataProtectionLevel: 'C' | 'P' = 'C';

  private state: SessionState = 'awaiting-user';
  private dataChannel: FtpDataChannel | null = null;
  private renameFrom: string | null = null;
  private fs: ISftpFileSystem;
  /** Set by `REST`; consumed by the immediately following `RETR`/`STOR`-family command, whether it succeeds or not (RFC 3659 §5). */
  private restOffset: number | null = null;
  /** Set by `handleAuth()`; consumed once by the wire layer (`FtpServer.ts`) right after it writes the `234` reply in the clear. */
  private pendingTlsUpgrade = false;
  /** The current data channel's TLS session under `PROT P` (§2.1.7), set at `PASV`/`EPSV` accept time. */
  private dataTls: TlsServerSession | null = null;
  /** §2.1.12 — stable per-connection correlator for emitted events. */
  readonly connectionId = randomFtpConnectionId();

  constructor(
    private readonly config: FtpServerConfig,
    private readonly tcpStack: TcpStack,
    private readonly localIp: string,
    /**
     * `STOR`/`STOU`/`APPE` can only reply `226`/`550` once the client
     * finishes pushing bytes and closes the data connection — an event
     * that happens strictly after `handle()` has already returned its
     * preliminary `150`. This callback lets that later completion push
     * one more reply onto the control channel unprompted, the same way
     * `greeting()`'s banner is unprompted.
     */
    private readonly onUnsolicitedReply: (r: FtpReply) => void = () => {},
  ) {
    this.fs = config.fs;
    this.cwd = config.rootPath ?? '/';
  }

  /** The unprompted `220` banner a real server sends right after accepting the TCP connection. */
  greeting(): FtpReply {
    return reply(220, 'Ubuntu Sandbox FTP server ready.');
  }

  /** `FtpServer.ts` calls this right after writing the `234` reply in the clear, then starts the actual handshake. */
  consumeTlsUpgradeSignal(): boolean {
    const v = this.pendingTlsUpgrade;
    this.pendingTlsUpgrade = false;
    return v;
  }

  /** `FtpServer.ts` calls this once the control channel's TLS handshake actually completes. */
  markControlProtected(): void {
    this.controlProtected = true;
  }

  handle(cmd: FtpCommand): readonly FtpReply[] {
    this.config.eventBus?.publish({
      topic: 'ftp.command.received', payload: { connectionId: this.connectionId, verb: cmd.verb },
    });
    switch (cmd.verb) {
      case 'USER': return [this.handleUser(cmd)];
      case 'PASS': return [this.handlePass(cmd)];
      case 'ACCT': return [this.handleAcct()];
      case 'TYPE': return [this.handleType(cmd)];
      case 'STRU': return [this.handleStru(cmd)];
      case 'MODE': return [this.handleMode(cmd)];
      case 'AUTH': return [this.handleAuth(cmd)];
      case 'PBSZ': return [this.handlePbsz(cmd)];
      case 'PROT': return [this.handleProt(cmd)];
      case 'SYST': return [reply(215, 'UNIX Type: L8')];
      case 'NOOP': return [reply(200, 'NOOP command successful.')];
      case 'QUIT': {
        this.closeDataChannel();
        this.state = 'closed';
        this.result = 'closed';
        this.config.eventBus?.publish({
          topic: 'ftp.control.closed', payload: { connectionId: this.connectionId, reason: 'QUIT' },
        });
        return [reply(221, 'Goodbye.')];
      }
      case 'ABOR': return [reply(225, 'No transfer in progress.')];
      case 'PORT': return [this.handlePort(cmd)];
      case 'PASV': return [this.handlePasv()];
      case 'EPRT': return [this.handleEprt(cmd)];
      case 'EPSV': return [this.handleEpsv()];
      case 'RETR': return this.handleRetr(cmd);
      case 'STOR': return this.handleStor(cmd, { unique: false, append: false });
      case 'STOU': return this.handleStor(cmd, { unique: true, append: false });
      case 'APPE': return this.handleStor(cmd, { unique: false, append: true });
      case 'LIST': return this.handleList(cmd, 'long');
      case 'NLST': return this.handleList(cmd, 'names');
      case 'PWD': return [this.handlePwd()];
      case 'CWD': return [this.handleCwd(cmd)];
      case 'CDUP': return [this.handleCwd({ verb: 'CDUP', argument: '..' })];
      case 'MKD': return [this.handleMkd(cmd)];
      case 'RMD': return [this.handleRmd(cmd)];
      case 'DELE': return [this.handleDele(cmd)];
      case 'RNFR': return [this.handleRnfr(cmd)];
      case 'RNTO': return [this.handleRnto(cmd)];
      case 'FEAT': return [this.handleFeat()];
      case 'SIZE': return [this.handleSize(cmd)];
      case 'MDTM': return [this.handleMdtm(cmd)];
      case 'REST': return [this.handleRest(cmd)];
      case 'MLST': return [this.handleMlst(cmd)];
      case 'MLSD': return this.handleMlsd(cmd);
      default: return [reply(500, `'${cmd.verb}' not understood.`)];
    }
  }

  private requireAuth(): FtpReply | null {
    return this.authenticated ? null : reply(530, 'Please login with USER and PASS.');
  }

  private resolvePath(argument: string | undefined): string {
    return this.fs.normalizePath(argument ?? '', this.cwd);
  }

  private closeDataChannel(): void {
    if (!this.dataChannel) return;
    const mode = this.dataChannel.mode;
    if (this.dataChannel.mode === 'passive') this.dataChannel.close(this.tcpStack);
    this.dataChannel = null;
    this.dataTls = null;
    this.config.eventBus?.publish({ topic: 'ftp.data.closed', payload: { connectionId: this.connectionId, mode } });
  }

  private handleUser(cmd: FtpCommand): FtpReply {
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    this.username = cmd.argument;
    this.authenticated = false;
    this.state = 'awaiting-password';
    // Never reveal whether the username is actually known — same posture as a real server.
    return reply(331, `Password required for ${cmd.argument}.`);
  }

  private handlePass(cmd: FtpCommand): FtpReply {
    if (this.state !== 'awaiting-password') return reply(503, 'Login with USER first.');
    const expected = this.username !== null ? this.config.users.get(this.username) : undefined;
    if (expected === undefined || expected !== (cmd.argument ?? '')) {
      this.state = 'awaiting-user';
      this.authenticated = false;
      return reply(530, 'Login incorrect.');
    }
    this.state = 'authenticated';
    this.authenticated = true;
    const chrootDir = this.config.chroots?.get(this.username!);
    if (chrootDir !== undefined) {
      this.fs = new ChrootedSftpFileSystem(this.config.fs, chrootDir);
      this.cwd = '/';
    }
    this.config.eventBus?.publish({
      topic: 'ftp.control.authenticated', payload: { connectionId: this.connectionId, username: this.username! },
    });
    return reply(230, `User ${this.username} logged in.`);
  }

  private handleAcct(): FtpReply {
    return this.authenticated ? reply(230, 'ACCT command successful.') : reply(503, 'Login with USER/PASS first.');
  }

  private handleType(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    const code = (cmd.argument ?? '').trim().split(/\s+/)[0]?.toUpperCase();
    if (code === 'A' || code === 'I') {
      this.transferType = code;
      return reply(200, `Type set to ${code}.`);
    }
    return reply(504, `Type not implemented for parameter '${cmd.argument ?? ''}'.`);
  }

  private handleStru(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    const code = (cmd.argument ?? '').trim().toUpperCase();
    if (code === 'F') {
      this.fileStructure = 'F';
      return reply(200, 'Structure set to F.');
    }
    return reply(504, `Structure not implemented for parameter '${cmd.argument ?? ''}'.`);
  }

  private handleMode(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    const code = (cmd.argument ?? '').trim().toUpperCase();
    if (code === 'S' || code === 'C') {
      this.transferMode = code;
      return reply(200, `Mode set to ${code}.`);
    }
    return reply(504, `Mode not implemented for parameter '${cmd.argument ?? ''}'.`);
  }

  // RFC 2228/4217 — deliberately exempt from requireAuth(): AUTH TLS's whole
  // point is to protect the USER/PASS exchange itself, so it must be usable
  // before login, exactly like SYST/NOOP/FEAT.
  private handleAuth(cmd: FtpCommand): FtpReply {
    const mechanism = (cmd.argument ?? '').trim().toUpperCase();
    if (mechanism !== 'TLS') return reply(504, `Unsupported security mechanism '${cmd.argument ?? ''}'.`);
    if (!this.config.ftps) return reply(502, 'AUTH TLS not supported.');
    if (this.controlProtected) return reply(503, 'Control connection already protected.');
    this.pendingTlsUpgrade = true;
    return reply(234, 'AUTH TLS successful.');
  }

  private handlePbsz(cmd: FtpCommand): FtpReply {
    if (!this.controlProtected) return reply(503, 'PBSZ requires a protected control connection.');
    if ((cmd.argument ?? '').trim() !== '0') return reply(501, 'PBSZ only supports a size of 0.');
    return reply(200, 'PBSZ=0');
  }

  private handleProt(cmd: FtpCommand): FtpReply {
    if (!this.controlProtected) return reply(503, 'PROT requires a protected control connection.');
    const level = (cmd.argument ?? '').trim().toUpperCase();
    if (level !== 'C' && level !== 'P') return reply(504, `Unrecognized PROT type '${cmd.argument ?? ''}'.`);
    if (level === 'P' && !this.config.ftps) return reply(502, 'No TLS support for data channel protection.');
    this.dataProtectionLevel = level;
    return reply(200, `PROT ${level} successful.`);
  }

  private handlePort(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    const parsed = decodePortArgument(cmd.argument ?? '');
    if (!parsed) return reply(501, 'Syntax error in parameters.');
    this.closeDataChannel();
    this.dataChannel = { mode: 'active', address: parsed.address, port: parsed.port };
    this.emitDataOpened('active');
    return reply(200, 'PORT command successful.');
  }

  private handlePasv(): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    this.closeDataChannel();
    const channel = new PassiveDataChannel(allocatePassivePort(), this.tcpStack, (socket) => this.startDataTlsIfProtected(socket));
    this.dataChannel = channel;
    this.emitDataOpened('passive');
    return reply(227, `Entering Passive Mode (${encodePortArgument(this.localIp, channel.port)}).`);
  }

  private handleEprt(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    const parsed = decodeEprtArgument(cmd.argument ?? '');
    if (!parsed) return reply(501, 'Syntax error in parameters.');
    this.closeDataChannel();
    this.dataChannel = { mode: 'active', address: parsed.address, port: parsed.port };
    this.emitDataOpened('active');
    return reply(200, 'EPRT command successful.');
  }

  private handleEpsv(): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    this.closeDataChannel();
    const channel = new PassiveDataChannel(allocatePassivePort(), this.tcpStack, (socket) => this.startDataTlsIfProtected(socket));
    this.dataChannel = channel;
    this.emitDataOpened('passive');
    return reply(229, `Entering Extended Passive Mode ${encodeEpsvReplyArgument(channel.port)}.`);
  }

  private emitDataOpened(mode: 'active' | 'passive'): void {
    this.config.eventBus?.publish({ topic: 'ftp.data.opened', payload: { connectionId: this.connectionId, mode } });
  }

  private startDataTlsIfProtected(socket: TcpSocket): void {
    if (this.dataProtectionLevel !== 'P' || !this.config.ftps) return;
    this.dataTls = startServerHandshake(socket, this.config.ftps);
  }

  private handleRetr(cmd: FtpCommand): readonly FtpReply[] {
    const authFailure = this.requireAuth();
    if (authFailure) return [authFailure];
    const offset = this.consumeRestOffset();
    if (!cmd.argument) return [reply(501, 'Syntax error in parameters.')];
    const path = this.resolvePath(cmd.argument);
    const file = this.fs.readFile(path);
    if (!file.ok) return [reply(550, `${cmd.argument}: No such file or directory.`)];

    const socket = this.dataChannel ? openDataConnection(this.dataChannel, this.tcpStack) : null;
    if (!socket) {
      this.emitTransferFailed('RETR', path, "Can't open data connection.");
      return [reply(425, "Can't open data connection.")];
    }
    this.emitTransferStarted('RETR', path);
    const dataTls = this.dataTls;
    const outgoing = offset > 0 ? file.value.slice(offset) : file.value;
    socket.write(this.encryptForDataChannel(dataTls, this.transferMode === 'C' ? encodeCompressedMode(outgoing) : outgoing));
    socket.close();
    this.closeDataChannel();
    this.emitTransferCompleted('RETR', path, outgoing.length);
    return [reply(150, `Opening ${this.transferType === 'A' ? 'ASCII' : 'BINARY'} mode data connection for ${cmd.argument}.`), reply(226, 'Transfer complete.')];
  }

  private handleStor(cmd: FtpCommand, opts: { unique: boolean; append: boolean }): readonly FtpReply[] {
    const authFailure = this.requireAuth();
    if (authFailure) return [authFailure];
    const offset = this.consumeRestOffset();
    if (!opts.unique && !cmd.argument) return [reply(501, 'Syntax error in parameters.')];

    let path = this.resolvePath(cmd.argument);
    if (opts.unique) {
      const base = cmd.argument ? this.resolvePath(cmd.argument) : this.resolvePath('STOU');
      path = base;
      let n = 1;
      while (this.fs.exists(path)) { path = `${base}.${n}`; n++; }
    }

    const socket = this.dataChannel ? openDataConnection(this.dataChannel, this.tcpStack) : null;
    if (!socket) {
      this.emitTransferFailed('STOR', path, "Can't open data connection.");
      return [reply(425, "Can't open data connection.")];
    }
    this.emitTransferStarted('STOR', path);
    const dataTls = this.dataTls;

    let received = '';
    const seqRef = { seq: 0 };
    socket.onData((data) => {
      received += this.decryptForDataChannel(dataTls, seqRef, String(data));
    });
    socket.onClose(() => {
      this.closeDataChannel();
      if (this.transferMode === 'C') {
        const decoded = decodeCompressedMode(received);
        if (decoded === null) {
          this.emitTransferFailed('STOR', path, 'Malformed MODE C data.');
          this.onUnsolicitedReply(reply(550, 'Malformed MODE C data.'));
          return;
        }
        received = decoded;
      }
      if (offset > 0) {
        const existing = this.fs.readFile(path);
        received = (existing.ok ? existing.value.slice(0, offset) : '') + received;
      } else if (opts.append) {
        const existing = this.fs.readFile(path);
        received = (existing.ok ? existing.value : '') + received;
      }
      const written = this.fs.writeFile(path, received);
      if (!written.ok) {
        this.emitTransferFailed('STOR', path, 'Permission denied.');
        this.onUnsolicitedReply(reply(550, `${cmd.argument ?? path}: Permission denied.`));
        return;
      }
      this.emitTransferCompleted('STOR', path, received.length);
      this.onUnsolicitedReply(reply(226, opts.unique ? `FILE: ${path}` : 'Transfer complete.'));
    });

    return [reply(150, `Opening ${this.transferType === 'A' ? 'ASCII' : 'BINARY'} mode data connection.`)];
  }

  private emitTransferStarted(verb: string, path: string): void {
    this.config.eventBus?.publish({ topic: 'ftp.transfer.started', payload: { connectionId: this.connectionId, verb, path } });
  }

  private emitTransferCompleted(verb: string, path: string, bytes: number): void {
    this.config.eventBus?.publish({ topic: 'ftp.transfer.completed', payload: { connectionId: this.connectionId, verb, path, bytes } });
  }

  private emitTransferFailed(verb: string, path: string, reason: string): void {
    this.config.eventBus?.publish({ topic: 'ftp.transfer.failed', payload: { connectionId: this.connectionId, verb, path, reason } });
  }

  private handleList(cmd: FtpCommand, format: 'long' | 'names'): readonly FtpReply[] {
    const authFailure = this.requireAuth();
    if (authFailure) return [authFailure];
    const path = this.resolvePath(cmd.argument);
    const listing = this.fs.listDirectory(path);
    if (!listing.ok) return [reply(450, `${cmd.argument ?? path}: No such file or directory.`)];

    const socket = this.dataChannel ? openDataConnection(this.dataChannel, this.tcpStack) : null;
    if (!socket) return [reply(425, "Can't open data connection.")];
    const dataTls = this.dataTls;

    const entries = listing.value.filter((e) => e.name !== '.' && e.name !== '..');
    const lines = format === 'long' ? entries.map(formatListLine) : entries.map((e) => e.name);
    socket.write(this.encryptForDataChannel(dataTls, lines.length > 0 ? `${lines.join('\r\n')}\r\n` : ''));
    socket.close();
    this.closeDataChannel();
    return [reply(150, 'Here comes the directory listing.'), reply(226, 'Directory send OK.')];
  }

  private handlePwd(): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    return reply(257, `"${this.cwd}" is the current directory.`);
  }

  private handleCwd(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    const path = this.resolvePath(cmd.argument);
    if (this.fs.getEntryType(path) !== 'directory') return reply(550, `${cmd.argument}: No such file or directory.`);
    this.cwd = path;
    return reply(250, 'Directory successfully changed.');
  }

  private handleMkd(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    const path = this.resolvePath(cmd.argument);
    const result = this.fs.mkdir(path);
    if (!result.ok) return reply(550, `${cmd.argument}: Operation failed.`);
    return reply(257, `"${path}" created.`);
  }

  private handleRmd(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    const path = this.resolvePath(cmd.argument);
    const result = this.fs.rmdir(path);
    if (!result.ok) return reply(550, `${cmd.argument}: Operation failed.`);
    return reply(250, 'Directory removed.');
  }

  private handleDele(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    const path = this.resolvePath(cmd.argument);
    const result = this.fs.deleteFile(path);
    if (!result.ok) return reply(550, `${cmd.argument}: Operation failed.`);
    return reply(250, 'File deleted.');
  }

  private handleRnfr(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    const path = this.resolvePath(cmd.argument);
    if (this.fs.getEntryType(path) === null) return reply(550, `${cmd.argument}: No such file or directory.`);
    this.renameFrom = path;
    return reply(350, 'Requested file action pending further information.');
  }

  private handleRnto(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    if (!this.renameFrom) return reply(503, 'RNFR required first.');
    const src = this.renameFrom;
    this.renameFrom = null;
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    const dest = this.resolvePath(cmd.argument);
    const result = this.fs.rename(src, dest);
    if (!result.ok) return reply(550, 'Rename failed.');
    return reply(250, 'Rename successful.');
  }

  private handleFeat(): FtpReply {
    return reply(211, 'Extensions supported:', 'SIZE', 'MDTM', 'REST STREAM', 'MLST type*;size*;modify*;', 'EPRT', 'EPSV', 'END');
  }

  private handleSize(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    const path = this.resolvePath(cmd.argument);
    const stat = this.fs.stat(path);
    if (!stat.ok || stat.value.type !== 'file') return reply(550, `${cmd.argument}: No such file or directory.`);
    return reply(213, String(stat.value.size));
  }

  private handleMdtm(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    const path = this.resolvePath(cmd.argument);
    const stat = this.fs.stat(path);
    if (!stat.ok) return reply(550, `${cmd.argument}: No such file or directory.`);
    return reply(213, formatMdtm(stat.value.mtime));
  }

  private handleRest(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    const offset = parseInt(cmd.argument ?? '', 10);
    if (!cmd.argument || Number.isNaN(offset) || offset < 0) return reply(501, 'Syntax error in parameters.');
    this.restOffset = offset;
    return reply(350, `Restarting at ${offset}. Send STORE or RETRIEVE to initiate transfer.`);
  }

  private consumeRestOffset(): number {
    const offset = this.restOffset ?? 0;
    this.restOffset = null;
    return offset;
  }

  private handleMlst(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    const path = this.resolvePath(cmd.argument);
    const stat = this.fs.stat(path);
    if (!stat.ok) return reply(550, `${cmd.argument ?? path}: No such file or directory.`);
    return reply(250, `Listing ${path}`, ` ${formatMlstFacts(stat.value)} ${path}`, 'End');
  }

  private handleMlsd(cmd: FtpCommand): readonly FtpReply[] {
    const authFailure = this.requireAuth();
    if (authFailure) return [authFailure];
    const path = this.resolvePath(cmd.argument);
    const listing = this.fs.listDirectory(path);
    if (!listing.ok) return [reply(450, `${cmd.argument ?? path}: No such file or directory.`)];

    const socket = this.dataChannel ? openDataConnection(this.dataChannel, this.tcpStack) : null;
    if (!socket) return [reply(425, "Can't open data connection.")];
    const dataTls = this.dataTls;

    const entries = listing.value.filter((e) => e.name !== '.' && e.name !== '..');
    const lines = entries.map((e) => `${formatMlstFacts(e)} ${e.name}`);
    socket.write(this.encryptForDataChannel(dataTls, lines.length > 0 ? `${lines.join('\r\n')}\r\n` : ''));
    socket.close();
    this.closeDataChannel();
    return [reply(150, 'Here comes the directory listing.'), reply(226, 'Directory send OK.')];
  }

  private encryptForDataChannel(dataTls: TlsServerSession | null, content: string): string {
    if (dataTls?.result !== 'accept') return content;
    return encryptText(dataTls.serverApplicationTrafficSecret!, 0, content).wire;
  }

  private decryptForDataChannel(dataTls: TlsServerSession | null, seqRef: { seq: number }, raw: string): string {
    if (dataTls?.result !== 'accept') return raw;
    const { text, nextSeq } = decryptText(dataTls.clientApplicationTrafficSecret!, seqRef.seq, raw);
    seqRef.seq = nextSeq;
    return text;
  }
}
