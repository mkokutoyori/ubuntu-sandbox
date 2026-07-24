import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { SmtpCommand, SmtpReply } from './types';
import { encodeCommand, decodeReply } from './replies';
import { stuffDotLines } from './envelope';
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

  sendDataBody(rawMessage: string): SmtpReply | null {
    if (!this.socket) return null;
    this.lastReply = null;
    const stuffed = stuffDotLines(rawMessage);
    const blob = stuffed.endsWith(CRLF) ? `${stuffed}.${CRLF}` : `${stuffed}${CRLF}.${CRLF}`;
    this.socket.write(blob);
    return this.lastReply;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
