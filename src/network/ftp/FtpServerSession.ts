/**
 * FTP (RFC 959 §3-5) — server-side control channel state machine for one
 * connection. Deliberately transport-agnostic (`FtpCommand` in,
 * `FtpReply` out — no `TcpSocket` here), unit-testable the same way
 * `TlsServerSession`/`TlsClientSession` are: the wire glue
 * (`FtpServer.ts`) feeds it real socket data separately.
 */
import type { FtpCommand, FtpReply, FtpTransferType, FtpFileStructure, FtpTransferMode } from './types';
import { reply } from './replies';

export interface FtpServerConfig {
  /** username -> password. RFC 959 doesn't mandate a specific credential store; this mirrors the ad hoc user maps used elsewhere in this project's protocol tests (RADIUS, EAP-TTLS). */
  readonly users: ReadonlyMap<string, string>;
}

type SessionState = 'awaiting-user' | 'awaiting-password' | 'authenticated' | 'closed';

export class FtpServerSession {
  result: 'open' | 'closed' = 'open';
  username: string | null = null;
  authenticated = false;
  transferType: FtpTransferType = 'A';
  fileStructure: FtpFileStructure = 'F';
  transferMode: FtpTransferMode = 'S';

  private state: SessionState = 'awaiting-user';

  constructor(private readonly config: FtpServerConfig) {}

  /** The unprompted `220` banner a real server sends right after accepting the TCP connection. */
  greeting(): FtpReply {
    return reply(220, 'Ubuntu Sandbox FTP server ready.');
  }

  handle(cmd: FtpCommand): FtpReply {
    switch (cmd.verb) {
      case 'USER': return this.handleUser(cmd);
      case 'PASS': return this.handlePass(cmd);
      case 'ACCT': return this.handleAcct();
      case 'TYPE': return this.handleType(cmd);
      case 'STRU': return this.handleStru(cmd);
      case 'MODE': return this.handleMode(cmd);
      case 'SYST': return reply(215, 'UNIX Type: L8');
      case 'NOOP': return reply(200, 'NOOP command successful.');
      case 'QUIT': {
        this.state = 'closed';
        this.result = 'closed';
        return reply(221, 'Goodbye.');
      }
      case 'ABOR': return reply(225, 'No transfer in progress.');
      default: return reply(500, `'${cmd.verb}' not understood.`);
    }
  }

  private requireAuth(): FtpReply | null {
    return this.authenticated ? null : reply(530, 'Please login with USER and PASS.');
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
}
