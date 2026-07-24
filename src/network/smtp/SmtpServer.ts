import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import { type IScheduler, type TimerHandle, getDefaultScheduler } from '@/events/Scheduler';
import { SmtpServerSession, type SmtpServerConfig } from './SmtpServerSession';
import { decodeCommand, encodeReply, reply, replyEnhanced, ENHANCED } from './replies';
import { DEFAULT_PROTOCOL_LIMITS, exceedsCommandLineLimit, type SmtpProtocolLimits } from './limits';

export const SMTP_PORT = 25;
export const SMTP_SUBMISSION_PORT = 587;
export const SMTP_SUBMISSION_TLS_PORT = 465;

export class SmtpServer {
  private listener: TcpListener | null = null;
  private readonly limits: SmtpProtocolLimits;
  private readonly scheduler: IScheduler;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly config: SmtpServerConfig,
    private readonly port: number = SMTP_PORT,
    opts: { limits?: SmtpProtocolLimits; scheduler?: IScheduler } = {},
  ) {
    this.limits = opts.limits ?? DEFAULT_PROTOCOL_LIMITS;
    this.scheduler = opts.scheduler ?? getDefaultScheduler();
  }

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
    let idleTimer: TimerHandle | null = null;
    let unsubscribe: () => void = () => {};

    const clearIdle = (): void => {
      if (idleTimer !== null) {
        this.scheduler.clear(idleTimer);
        idleTimer = null;
      }
    };
    const armIdle = (): void => {
      clearIdle();
      const timeoutMs = awaitingDataBody ? this.limits.idleTimeoutMs.dataInit : this.limits.idleTimeoutMs.initial;
      idleTimer = this.scheduler.setTimeout(() => {
        socket.write(encodeReply(replyEnhanced(421, ENHANCED.SERVICE_NOT_AVAILABLE, 'Idle timeout; closing connection.')));
        unsubscribe();
        socket.close();
      }, timeoutMs);
    };

    socket.write(encodeReply(session.greeting()));
    armIdle();

    unsubscribe = socket.onData((data) => {
      clearIdle();
      const text = String(data);

      if (awaitingDataBody) {
        awaitingDataBody = false;
        socket.write(encodeReply(session.handleDataBody(text)));
        if (session.result !== 'closed') armIdle();
        return;
      }

      const lines = text.split('\r\n').filter((l) => l.length > 0);
      if (lines.length === 0) {
        socket.write(encodeReply(reply(500, 'Syntax error, command unrecognized.')));
        armIdle();
        return;
      }

      for (let i = 0; i < lines.length; i++) {
        if (i > 0 && !session.pipeliningNegotiated()) {
          socket.write(encodeReply(reply(503, 'Pipelining not negotiated; send one command at a time.')));
          continue;
        }
        if (exceedsCommandLineLimit(lines[i], this.limits)) {
          socket.write(encodeReply(replyEnhanced(500, ENHANCED.SYNTAX_ERROR_COMMAND, 'Line too long.')));
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
          clearIdle();
          unsubscribe();
          socket.close();
          return;
        }
        if (awaitingDataBody) break;
      }
      armIdle();
    });
  }
}
