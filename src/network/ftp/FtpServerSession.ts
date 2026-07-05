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
import type { TcpStack } from '@/network/tcp/TcpStack';
import type { ISftpFileSystem, SftpDirEntry } from '@/network/protocols/ssh/sftp/ISftpFileSystem';
import { ChrootedSftpFileSystem } from '@/network/protocols/ssh/sftp/ChrootedSftpFileSystem';
import type { FtpCommand, FtpReply, FtpTransferType, FtpFileStructure, FtpTransferMode } from './types';
import { reply } from './replies';
import {
  type FtpDataChannel, PassiveDataChannel, decodePortArgument, encodePortArgument, openDataConnection,
  allocatePassivePort, decodeEprtArgument, encodeEpsvReplyArgument,
} from './DataChannel';

export interface FtpServerConfig {
  /** username -> password. RFC 959 doesn't mandate a specific credential store; this mirrors the ad hoc user maps used elsewhere in this project's protocol tests (RADIUS, EAP-TTLS). */
  readonly users: ReadonlyMap<string, string>;
  readonly fs: ISftpFileSystem;
  /** Initial working directory; defaults to `/`. Ignored for a user with a chroot entry (§2.1.9 — the chroot's own root is always `/`). */
  readonly rootPath?: string;
  /** username -> confinement root, applied via `ChrootedSftpFileSystem` once login succeeds (§2.1.9, same principle as the SFTP side). */
  readonly chroots?: ReadonlyMap<string, string>;
}

type SessionState = 'awaiting-user' | 'awaiting-password' | 'authenticated' | 'closed';

function formatListLine(entry: SftpDirEntry): string {
  const kind = entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-';
  const perm = (entry.mode & 0o777).toString(8).padStart(3, '0');
  return `${kind}${perm} 1 ${entry.uid} ${entry.gid} ${entry.size} ${new Date(entry.mtime).toISOString()} ${entry.name}`;
}

export class FtpServerSession {
  result: 'open' | 'closed' = 'open';
  username: string | null = null;
  authenticated = false;
  transferType: FtpTransferType = 'A';
  fileStructure: FtpFileStructure = 'F';
  transferMode: FtpTransferMode = 'S';
  cwd: string;

  private state: SessionState = 'awaiting-user';
  private dataChannel: FtpDataChannel | null = null;
  private renameFrom: string | null = null;
  private fs: ISftpFileSystem;

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

  handle(cmd: FtpCommand): readonly FtpReply[] {
    switch (cmd.verb) {
      case 'USER': return [this.handleUser(cmd)];
      case 'PASS': return [this.handlePass(cmd)];
      case 'ACCT': return [this.handleAcct()];
      case 'TYPE': return [this.handleType(cmd)];
      case 'STRU': return [this.handleStru(cmd)];
      case 'MODE': return [this.handleMode(cmd)];
      case 'SYST': return [reply(215, 'UNIX Type: L8')];
      case 'NOOP': return [reply(200, 'NOOP command successful.')];
      case 'QUIT': {
        this.closeDataChannel();
        this.state = 'closed';
        this.result = 'closed';
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
    if (this.dataChannel?.mode === 'passive') this.dataChannel.close(this.tcpStack);
    this.dataChannel = null;
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
    if (code === 'S') {
      this.transferMode = 'S';
      return reply(200, 'Mode set to S.');
    }
    return reply(504, `Mode not implemented for parameter '${cmd.argument ?? ''}'.`);
  }

  private handlePort(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    const parsed = decodePortArgument(cmd.argument ?? '');
    if (!parsed) return reply(501, 'Syntax error in parameters.');
    this.closeDataChannel();
    this.dataChannel = { mode: 'active', address: parsed.address, port: parsed.port };
    return reply(200, 'PORT command successful.');
  }

  private handlePasv(): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    this.closeDataChannel();
    const channel = new PassiveDataChannel(allocatePassivePort(), this.tcpStack);
    this.dataChannel = channel;
    return reply(227, `Entering Passive Mode (${encodePortArgument(this.localIp, channel.port)}).`);
  }

  private handleEprt(cmd: FtpCommand): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    const parsed = decodeEprtArgument(cmd.argument ?? '');
    if (!parsed) return reply(501, 'Syntax error in parameters.');
    this.closeDataChannel();
    this.dataChannel = { mode: 'active', address: parsed.address, port: parsed.port };
    return reply(200, 'EPRT command successful.');
  }

  private handleEpsv(): FtpReply {
    const authFailure = this.requireAuth();
    if (authFailure) return authFailure;
    this.closeDataChannel();
    const channel = new PassiveDataChannel(allocatePassivePort(), this.tcpStack);
    this.dataChannel = channel;
    return reply(229, `Entering Extended Passive Mode ${encodeEpsvReplyArgument(channel.port)}.`);
  }

  private handleRetr(cmd: FtpCommand): readonly FtpReply[] {
    const authFailure = this.requireAuth();
    if (authFailure) return [authFailure];
    if (!cmd.argument) return [reply(501, 'Syntax error in parameters.')];
    const path = this.resolvePath(cmd.argument);
    const file = this.fs.readFile(path);
    if (!file.ok) return [reply(550, `${cmd.argument}: No such file or directory.`)];

    const socket = this.dataChannel ? openDataConnection(this.dataChannel, this.tcpStack) : null;
    if (!socket) return [reply(425, "Can't open data connection.")];
    socket.write(file.value);
    socket.close();
    this.closeDataChannel();
    return [reply(150, `Opening ${this.transferType === 'A' ? 'ASCII' : 'BINARY'} mode data connection for ${cmd.argument}.`), reply(226, 'Transfer complete.')];
  }

  private handleStor(cmd: FtpCommand, opts: { unique: boolean; append: boolean }): readonly FtpReply[] {
    const authFailure = this.requireAuth();
    if (authFailure) return [authFailure];
    if (!opts.unique && !cmd.argument) return [reply(501, 'Syntax error in parameters.')];

    let path = this.resolvePath(cmd.argument);
    if (opts.unique) {
      const base = cmd.argument ? this.resolvePath(cmd.argument) : this.resolvePath('STOU');
      path = base;
      let n = 1;
      while (this.fs.exists(path)) { path = `${base}.${n}`; n++; }
    }

    const socket = this.dataChannel ? openDataConnection(this.dataChannel, this.tcpStack) : null;
    if (!socket) return [reply(425, "Can't open data connection.")];

    let received = '';
    socket.onData((data) => { received += String(data); });
    socket.onClose(() => {
      this.closeDataChannel();
      if (opts.append) {
        const existing = this.fs.readFile(path);
        received = (existing.ok ? existing.value : '') + received;
      }
      const written = this.fs.writeFile(path, received);
      if (!written.ok) {
        this.onUnsolicitedReply(reply(550, `${cmd.argument ?? path}: Permission denied.`));
        return;
      }
      this.onUnsolicitedReply(reply(226, opts.unique ? `FILE: ${path}` : 'Transfer complete.'));
    });

    return [reply(150, `Opening ${this.transferType === 'A' ? 'ASCII' : 'BINARY'} mode data connection.`)];
  }

  private handleList(cmd: FtpCommand, format: 'long' | 'names'): readonly FtpReply[] {
    const authFailure = this.requireAuth();
    if (authFailure) return [authFailure];
    const path = this.resolvePath(cmd.argument);
    const listing = this.fs.listDirectory(path);
    if (!listing.ok) return [reply(450, `${cmd.argument ?? path}: No such file or directory.`)];

    const socket = this.dataChannel ? openDataConnection(this.dataChannel, this.tcpStack) : null;
    if (!socket) return [reply(425, "Can't open data connection.")];

    const entries = listing.value.filter((e) => e.name !== '.' && e.name !== '..');
    const lines = format === 'long' ? entries.map(formatListLine) : entries.map((e) => e.name);
    socket.write(lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '');
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
}
