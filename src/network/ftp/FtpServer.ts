/**
 * FTP (RFC 959 §3-5) — TCP glue for the control channel server side.
 * Accepts connections on port 21 (or a caller-supplied port, for tests),
 * sends the unprompted `220` banner, then dispatches every subsequent
 * line to a per-connection `FtpServerSession`. Mirrors
 * `Http1ServerSession.ts`'s `TcpStack.listen()` pattern.
 */
import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import { FtpServerSession, type FtpServerConfig } from './FtpServerSession';
import { decodeCommand, encodeReply, reply } from './replies';

export const FTP_CONTROL_PORT = 21;

export class FtpServer {
  private listener: TcpListener | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly config: FtpServerConfig,
    private readonly port: number = FTP_CONTROL_PORT,
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
    const session = new FtpServerSession(this.config);
    socket.write(encodeReply(session.greeting()));

    const unsubscribe = socket.onData((data) => {
      const cmd = decodeCommand(String(data));
      if (!cmd) {
        socket.write(encodeReply(reply(500, 'Syntax error, command unrecognized.')));
        return;
      }
      const result = session.handle(cmd);
      socket.write(encodeReply(result));
      if (session.result === 'closed') {
        unsubscribe();
        socket.close();
      }
    });
  }
}
