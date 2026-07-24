import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import { SmtpServerSession, type SmtpServerConfig } from './SmtpServerSession';
import { decodeCommand, encodeReply, reply } from './replies';

export const SMTP_PORT = 25;
export const SMTP_SUBMISSION_PORT = 587;
export const SMTP_SUBMISSION_TLS_PORT = 465;

export class SmtpServer {
  private listener: TcpListener | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly config: SmtpServerConfig,
    private readonly port: number = SMTP_PORT,
  ) {}

  start(): void {
    this.listener = this.tcpStack.listen(this.port, { onAccept: (socket) => this.handleConnection(socket) });
  }

  stop(): void {
    if (!this.listener) return;
    this.tcpStack.closeListener(this.port);
    this.listener = null;
  }

  private handleConnection(socket: TcpSocket): void {
    const session = new SmtpServerSession(this.config, socket.remoteIp);
    let awaitingDataBody = false;

    socket.write(encodeReply(session.greeting()));

    const unsubscribe = socket.onData((data) => {
      const text = String(data);

      if (awaitingDataBody) {
        awaitingDataBody = false;
        socket.write(encodeReply(session.handleDataBody(text)));
        return;
      }

      const lines = text.split('\r\n').filter((l) => l.length > 0);
      if (lines.length === 0) {
        socket.write(encodeReply(reply(500, 'Syntax error, command unrecognized.')));
        return;
      }

      for (let i = 0; i < lines.length; i++) {
        if (i > 0 && !session.pipeliningNegotiated()) {
          socket.write(encodeReply(reply(503, 'Pipelining not negotiated; send one command at a time.')));
          continue;
        }
        const cmd = decodeCommand(lines[i]);
        if (!cmd) {
          socket.write(encodeReply(reply(500, 'Syntax error, command unrecognized.')));
          continue;
        }
        for (const r of session.handle(cmd)) {
          socket.write(encodeReply(r));
          if (r.code === 354) awaitingDataBody = true;
        }

        if (session.result === 'closed') {
          unsubscribe();
          socket.close();
          return;
        }
        if (awaitingDataBody) break;
      }
    });
  }
}
