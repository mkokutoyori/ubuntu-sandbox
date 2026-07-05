/**
 * FTP (RFC 959 §3-5) — client-side control channel. Unlike HTTP (where
 * the client always speaks first, so `Http1ClientSession.ts` can
 * subscribe/write/unsubscribe per exchange), a real FTP server sends an
 * **unprompted** `220` banner the instant the connection is accepted —
 * before the client code that called `connect()` gets a chance to
 * subscribe afterward. `TcpStack.connect()`'s own `onData` option
 * registers the handler *before* the SYN is transmitted (this simulator
 * resolves the handshake, and any immediate unsolicited data, within
 * that same synchronous call), so the handler is set up once and reused
 * for every subsequent exchange — each `write()` still resolves
 * synchronously before returning, so `lastReply` is always fresh by the
 * time `sendCommand` reads it back.
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { FtpCommand, FtpReply } from './types';
import { encodeCommand, decodeReply } from './replies';
import { FTP_CONTROL_PORT } from './FtpServer';

export class FtpClientSession {
  private socket: TcpSocket | null = null;
  private lastReply: FtpReply | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly targetIp: string,
    private readonly port: number = FTP_CONTROL_PORT,
  ) {}

  /** Opens the control connection and returns the server's unprompted `220` banner, or null on connection failure. */
  connect(): FtpReply | null {
    this.lastReply = null;
    const socket = this.tcpStack.connect(this.targetIp, this.port, {
      onData: (data) => { this.lastReply = decodeReply(String(data)); },
    });
    if (!socket || socket.state !== 'established') return null;
    this.socket = socket;
    return this.lastReply;
  }

  /** Sends one command and returns the server's reply, or null if not connected / no reply arrived. */
  sendCommand(cmd: FtpCommand): FtpReply | null {
    if (!this.socket) return null;
    this.lastReply = null;
    this.socket.write(encodeCommand(cmd));
    return this.lastReply;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
