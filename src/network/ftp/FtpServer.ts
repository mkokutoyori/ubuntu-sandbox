/**
 * FTP (RFC 959 §3-5) — TCP glue for the control channel server side.
 * Accepts connections on port 21 (or a caller-supplied port, for tests),
 * sends the unprompted `220` banner, then dispatches every subsequent
 * line to a per-connection `FtpServerSession`. Mirrors
 * `Http1ServerSession.ts`'s `TcpStack.listen()` pattern — extended here
 * with an unsolicited-reply channel so `STOR`/`STOU`/`APPE` can push
 * their final `226`/`550` once the data connection actually closes
 * (`FtpServerSession.ts`'s doc comment on `onUnsolicitedReply`).
 */
import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { FtpServerSession, type FtpServerConfig } from './FtpServerSession';
import type { FtpReply } from './types';
import { decodeCommand, encodeReply, reply } from './replies';
import { stepHandshake, encryptText, decryptText } from './ftps';

export const FTP_CONTROL_PORT = 21;

type ControlWireState = 'plaintext' | 'tls-handshake' | 'tls-established';

export class FtpServer {
  private listener: TcpListener | null = null;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly localIp: string,
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
    let wireState: ControlWireState = 'plaintext';
    let tls: TlsServerSession | null = null;
    let clientSeq = 0;
    let serverSeq = 0;

    const writeReply = (r: FtpReply): void => {
      const text = encodeReply(r);
      if (wireState === 'tls-established' && tls) {
        const { wire, nextSeq } = encryptText(tls.serverApplicationTrafficSecret!, serverSeq, text);
        serverSeq = nextSeq;
        socket.write(wire);
      } else {
        socket.write(text);
      }
    };

    const session = new FtpServerSession(this.config, this.tcpStack, this.localIp, writeReply);
    writeReply(session.greeting());

    const unsubscribe = socket.onData((data) => {
      if (wireState === 'tls-handshake' && tls) {
        const flight = stepHandshake(tls, String(data));
        if (flight) socket.write(flight);
        if (tls.result === 'accept') {
          wireState = 'tls-established';
          session.markControlProtected();
        } else if (tls.result === 'reject') {
          unsubscribe();
          socket.close();
        }
        return;
      }

      let text: string;
      if (wireState === 'tls-established' && tls) {
        const { text: decrypted, nextSeq } = decryptText(tls.clientApplicationTrafficSecret!, clientSeq, String(data));
        clientSeq = nextSeq;
        text = decrypted;
      } else {
        text = String(data);
      }

      const cmd = decodeCommand(text);
      if (!cmd) {
        writeReply(reply(500, 'Syntax error, command unrecognized.'));
        return;
      }
      for (const r of session.handle(cmd)) writeReply(r);

      if (session.consumeTlsUpgradeSignal() && this.config.ftps) {
        tls = new TlsServerSession(this.config.ftps);
        wireState = 'tls-handshake';
      }

      if (session.result === 'closed') {
        unsubscribe();
        socket.close();
      }
    });
  }
}
