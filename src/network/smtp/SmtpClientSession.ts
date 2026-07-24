import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { SmtpCommand, SmtpReply } from './types';
import { encodeCommand, decodeReply } from './replies';
import { stuffDotLines } from './envelope';
import { SMTP_PORT } from './SmtpServer';

const CRLF = '\r\n';

export class SmtpClientSession {
  private socket: TcpSocket | null = null;
  private repliesBuffer: SmtpReply[] = [];

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly targetIp: string,
    private readonly localIp: string,
    private readonly port: number = SMTP_PORT,
  ) {}

  connect(): SmtpReply | null {
    this.repliesBuffer = [];
    const socket = this.tcpStack.connect(this.targetIp, this.port, {
      onData: (data) => {
        const r = decodeReply(String(data));
        if (r) this.repliesBuffer.push(r);
      },
    });
    if (!socket || socket.state !== 'established') return null;
    this.socket = socket;
    return this.repliesBuffer[0] ?? null;
  }

  sendCommand(cmd: SmtpCommand): SmtpReply | null {
    if (!this.socket) return null;
    const before = this.repliesBuffer.length;
    this.socket.write(encodeCommand(cmd));
    return this.repliesBuffer[before] ?? null;
  }

  sendPipelined(cmds: readonly SmtpCommand[]): SmtpReply[] {
    if (!this.socket) return [];
    const before = this.repliesBuffer.length;
    const blob = cmds.map(encodeCommand).join('');
    this.socket.write(blob);
    return this.repliesBuffer.slice(before);
  }

  sendDataBody(rawMessage: string): SmtpReply | null {
    if (!this.socket) return null;
    const before = this.repliesBuffer.length;
    const stuffed = stuffDotLines(rawMessage);
    const blob = stuffed.endsWith(CRLF) ? `${stuffed}.${CRLF}` : `${stuffed}${CRLF}.${CRLF}`;
    this.socket.write(blob);
    return this.repliesBuffer[before] ?? null;
  }

  allReplies(): readonly SmtpReply[] {
    return this.repliesBuffer;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
