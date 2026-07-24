import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { SmtpCommand, SmtpReply } from './types';
import { encodeCommand, decodeReply } from './replies';
import { stuffDotLines } from './envelope';
import { SMTP_PORT } from './SmtpServer';
import { type TlsClientConfig, TlsClientSession, stepHandshake, encryptText, decryptText, encodeFlight } from './starttls';

const CRLF = '\r\n';

export class SmtpClientSession {
  private socket: TcpSocket | null = null;
  private repliesBuffer: SmtpReply[] = [];

  private controlTls: TlsClientSession | null = null;
  private controlTlsHandshakePending = false;
  private controlClientSeq = 0;
  private controlServerSeq = 0;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly targetIp: string,
    private readonly localIp: string,
    private readonly port: number = SMTP_PORT,
    private readonly tlsConfig?: TlsClientConfig,
  ) {}

  connect(): SmtpReply | null {
    this.repliesBuffer = [];
    const socket = this.tcpStack.connect(this.targetIp, this.port, {
      onData: (data) => this.handleIncomingData(data),
    });
    if (!socket || socket.state !== 'established') return null;
    this.socket = socket;
    return this.repliesBuffer[0] ?? null;
  }

  private handleIncomingData(data: unknown): void {
    if (this.controlTlsHandshakePending && this.controlTls) {
      const flight = stepHandshake(this.controlTls, String(data));
      if (flight) this.socket!.write(flight);
      if (this.controlTls.result !== null) this.controlTlsHandshakePending = false;
      return;
    }
    if (this.controlTls?.result === 'success') {
      const { text, nextSeq } = decryptText(this.controlTls.serverApplicationTrafficSecret!, this.controlServerSeq, String(data));
      this.controlServerSeq = nextSeq;
      const r = decodeReply(text);
      if (r) this.repliesBuffer.push(r);
      return;
    }
    const r = decodeReply(String(data));
    if (r) this.repliesBuffer.push(r);
  }

  isTlsActive(): boolean {
    return this.controlTls?.result === 'success';
  }

  startTls(): SmtpReply | null {
    const r = this.sendCommand({ verb: 'STARTTLS' });
    if (r?.code !== 220 || !this.socket || !this.tlsConfig) return r;
    this.controlTls = new TlsClientSession(this.tlsConfig);
    this.controlTlsHandshakePending = true;
    this.socket.write(encodeFlight(this.controlTls.start()));
    return r;
  }

  sendCommand(cmd: SmtpCommand): SmtpReply | null {
    if (!this.socket) return null;
    const before = this.repliesBuffer.length;
    this.writeText(encodeCommand(cmd));
    return this.repliesBuffer[before] ?? null;
  }

  sendPipelined(cmds: readonly SmtpCommand[]): SmtpReply[] {
    if (!this.socket) return [];
    const before = this.repliesBuffer.length;
    const blob = cmds.map(encodeCommand).join('');
    this.writeText(blob);
    return this.repliesBuffer.slice(before);
  }

  sendDataBody(rawMessage: string): SmtpReply | null {
    if (!this.socket) return null;
    const before = this.repliesBuffer.length;
    const stuffed = stuffDotLines(rawMessage);
    const blob = stuffed.endsWith(CRLF) ? `${stuffed}.${CRLF}` : `${stuffed}${CRLF}.${CRLF}`;
    this.writeText(blob);
    return this.repliesBuffer[before] ?? null;
  }

  private writeText(text: string): void {
    if (this.controlTls?.result === 'success') {
      const { wire, nextSeq } = encryptText(this.controlTls.clientApplicationTrafficSecret!, this.controlClientSeq, text);
      this.controlClientSeq = nextSeq;
      this.socket!.write(wire);
    } else {
      this.socket!.write(text);
    }
  }

  allReplies(): readonly SmtpReply[] {
    return this.repliesBuffer;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
