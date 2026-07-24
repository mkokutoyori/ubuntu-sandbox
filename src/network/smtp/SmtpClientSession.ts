/**
 * SMTP/ESMTP (RFC 5321 §2-4) — client-side control channel, mirroring
 * `FtpClientSession.ts`'s pattern: the server sends an unprompted `220`
 * banner right after accept, so `connect()`'s `onData` handler is
 * registered before the SYN is sent and reused for every later
 * exchange; each `write()` resolves synchronously in this simulator, so
 * `lastReply` is always fresh by the time `sendCommand()` reads it back.
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { SmtpCommand, SmtpReply } from './types';
import { encodeCommand, decodeReply } from './replies';
import { SMTP_PORT } from './SmtpServer';

const CRLF = '\r\n';

export class SmtpClientSession {
  private socket: TcpSocket | null = null;
  private lastReply: SmtpReply | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly targetIp: string,
    private readonly localIp: string,
    private readonly port: number = SMTP_PORT,
  ) {}

  /** Opens the control connection and returns the server's unprompted `220` banner, or null on connection failure. */
  connect(): SmtpReply | null {
    this.lastReply = null;
    const socket = this.tcpStack.connect(this.targetIp, this.port, {
      onData: (data) => { this.lastReply = decodeReply(String(data)); },
    });
    if (!socket || socket.state !== 'established') return null;
    this.socket = socket;
    return this.lastReply;
  }

  sendCommand(cmd: SmtpCommand): SmtpReply | null {
    if (!this.socket) return null;
    this.lastReply = null;
    this.socket.write(encodeCommand(cmd));
    return this.lastReply;
  }

  /**
   * Sends the raw DATA blob (headers + blank line + body, dot-stuffed by
   * the caller — see `envelope.ts` from P2 on) terminated by the
   * required `<CRLF>.<CRLF>` sequence, and returns the final reply.
   * Only valid right after a `354` reply to `DATA`.
   */
  sendDataBody(rawMessage: string): SmtpReply | null {
    if (!this.socket) return null;
    this.lastReply = null;
    const blob = rawMessage.endsWith(CRLF) ? `${rawMessage}.${CRLF}` : `${rawMessage}${CRLF}.${CRLF}`;
    this.socket.write(blob);
    return this.lastReply;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
