import type { TcpStack, TcpSocket, TcpListener } from '@/network/tcp/TcpStack';
import { type IScheduler, type TimerHandle, getDefaultScheduler } from '@/events/Scheduler';
import { SmtpServerSession, type SmtpServerConfig } from './SmtpServerSession';
import { decodeCommand, encodeReply, reply, replyEnhanced, ENHANCED } from './replies';
import { DEFAULT_PROTOCOL_LIMITS, exceedsCommandLineLimit, type SmtpProtocolLimits } from './limits';
import { type TlsServerConfig, TlsServerSession, stepHandshake, encryptText, decryptText } from './starttls';
import type { SmtpReply } from './types';

export const SMTP_PORT = 25;
export const SMTP_SUBMISSION_PORT = 587;
export const SMTP_SUBMISSION_TLS_PORT = 465;

type ControlWireState = 'plaintext' | 'tls-handshake' | 'tls-established';

export type SmtpAcceptedMessage = NonNullable<SmtpServerSession['lastDelivered']>;

export interface SmtpServerOptions {
  readonly limits?: SmtpProtocolLimits;
  readonly scheduler?: IScheduler;
  readonly tls?: TlsServerConfig;
  /** RFC 8314 — smtps (port 465): the connection is TLS from the very first byte, no STARTTLS negotiation. */
  readonly implicitTls?: boolean;
  /** Called once a message has been fully accepted (DATA terminated with a 2xx), so a consumer can perform real local delivery/relay — the engine itself never writes to a mailbox (§ FTP/HTTP-style separation of protocol from LDA, docs/PRD-Exchange.md § 3). */
  readonly onMessageAccepted?: (delivered: SmtpAcceptedMessage) => void;
  /** Receive Connector source-IP restriction (docs/PRD-Exchange.md §4.4) — a connection from an IP this predicate rejects is closed before any protocol interaction, never gets a banner. */
  readonly remoteIpAllowed?: (ip: string) => boolean;
  /** Transport Rule categorizer stage (docs/PRD-Exchange.md §2.1 P6) — runs before the final DATA reply is written, so a policy rejection replaces the accept reply with a real `550`, never a silent post-accept drop. */
  readonly beforeMessageAccepted?: (delivered: SmtpAcceptedMessage) => { reject?: string } | undefined;
}

export class SmtpServer {
  private listener: TcpListener | null = null;
  private readonly limits: SmtpProtocolLimits;
  private readonly scheduler: IScheduler;
  private readonly tlsConfig?: TlsServerConfig;
  private readonly implicitTls: boolean;
  private readonly onMessageAccepted?: (delivered: SmtpAcceptedMessage) => void;
  private readonly remoteIpAllowed?: (ip: string) => boolean;
  private readonly beforeMessageAccepted?: (delivered: SmtpAcceptedMessage) => { reject?: string } | undefined;

  constructor(
    private readonly tcpStack: TcpStack,
    private readonly config: SmtpServerConfig,
    private readonly port: number = SMTP_PORT,
    opts: SmtpServerOptions = {},
  ) {
    this.limits = opts.limits ?? DEFAULT_PROTOCOL_LIMITS;
    this.scheduler = opts.scheduler ?? getDefaultScheduler();
    this.tlsConfig = opts.tls;
    this.implicitTls = opts.implicitTls ?? false;
    this.onMessageAccepted = opts.onMessageAccepted;
    this.remoteIpAllowed = opts.remoteIpAllowed;
    this.beforeMessageAccepted = opts.beforeMessageAccepted;
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
    if (this.remoteIpAllowed && !this.remoteIpAllowed(socket.remoteIp)) {
      socket.close();
      return;
    }
    const sessionConfig: SmtpServerConfig = {
      ...this.config,
      tlsSupported: !!this.tlsConfig,
      submissionMode: this.port === SMTP_SUBMISSION_PORT,
    };
    const session = new SmtpServerSession(sessionConfig, socket.remoteIp);
    this.config.eventBus?.publish({ topic: 'smtp.session.opened', payload: { connectionId: session.connectionId } });
    let awaitingDataBody = false;
    let idleTimer: TimerHandle | null = null;
    let unsubscribe: () => void = () => {};

    let wireState: ControlWireState = 'plaintext';
    let tls: TlsServerSession | null = null;
    let clientSeq = 0;
    let serverSeq = 0;

    const writeReply = (r: SmtpReply): void => {
      const text = encodeReply(r);
      if (wireState === 'tls-established' && tls) {
        const { wire, nextSeq } = encryptText(tls.serverApplicationTrafficSecret!, serverSeq, text);
        serverSeq = nextSeq;
        socket.write(wire);
      } else {
        socket.write(text);
      }
    };

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
        writeReply(replyEnhanced(421, ENHANCED.SERVICE_NOT_AVAILABLE, 'Idle timeout; closing connection.'));
        this.config.eventBus?.publish({ topic: 'smtp.session.closed', payload: { connectionId: session.connectionId } });
        unsubscribe();
        socket.close();
      }, timeoutMs);
    };

    let greetingSent = false;
    const sendGreeting = (): void => {
      if (greetingSent) return;
      greetingSent = true;
      writeReply(session.greeting());
    };

    if (this.implicitTls && this.tlsConfig) {
      tls = new TlsServerSession(this.tlsConfig);
      wireState = 'tls-handshake';
    } else {
      sendGreeting();
    }
    armIdle();

    unsubscribe = socket.onData((data) => {
      clearIdle();

      if (wireState === 'tls-handshake' && tls) {
        const flight = stepHandshake(tls, String(data));
        if (flight) socket.write(flight);
        if (tls.result === 'accept') {
          wireState = 'tls-established';
          session.markTlsActive();
          this.config.eventBus?.publish({
            topic: 'smtp.starttls.established',
            payload: { connectionId: session.connectionId, negotiatedCipherSuite: tls.negotiatedCipherSuite },
          });
          sendGreeting();
        } else if (tls.result === 'reject') {
          unsubscribe();
          socket.close();
          return;
        }
        armIdle();
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

      if (awaitingDataBody) {
        awaitingDataBody = false;
        const dataReply = session.handleDataBody(text);
        if (session.lastDelivered && this.beforeMessageAccepted) {
          const verdict = this.beforeMessageAccepted(session.lastDelivered);
          if (verdict?.reject) {
            writeReply(reply(550, verdict.reject));
            if (session.result !== 'closed') armIdle();
            return;
          }
        }
        writeReply(dataReply);
        if (session.lastDelivered) this.onMessageAccepted?.(session.lastDelivered);
        if (session.result !== 'closed') armIdle();
        return;
      }

      if (session.isAwaitingAuthContinuation()) {
        writeReply(session.handleAuthContinuation(text));
        armIdle();
        return;
      }

      const lines = text.split('\r\n').filter((l) => l.length > 0);
      if (lines.length === 0) {
        writeReply(reply(500, 'Syntax error, command unrecognized.'));
        armIdle();
        return;
      }

      for (let i = 0; i < lines.length; i++) {
        if (i > 0 && !session.pipeliningNegotiated()) {
          writeReply(reply(503, 'Pipelining not negotiated; send one command at a time.'));
          continue;
        }
        if (exceedsCommandLineLimit(lines[i], this.limits)) {
          writeReply(replyEnhanced(500, ENHANCED.SYNTAX_ERROR_COMMAND, 'Line too long.'));
          continue;
        }
        const cmd = decodeCommand(lines[i]);
        if (!cmd) {
          writeReply(reply(500, 'Syntax error, command unrecognized.'));
          continue;
        }
        for (const r of session.handle(cmd)) {
          writeReply(r);
          if (r.code === 354) awaitingDataBody = true;
        }

        if (session.consumeTlsUpgradeSignal() && this.tlsConfig) {
          tls = new TlsServerSession(this.tlsConfig);
          wireState = 'tls-handshake';
          break;
        }

        if (session.result === 'closed') {
          clearIdle();
          this.config.eventBus?.publish({ topic: 'smtp.session.closed', payload: { connectionId: session.connectionId } });
          unsubscribe();
          socket.close();
          return;
        }
        if (awaitingDataBody || session.isAwaitingAuthContinuation()) break;
      }
      armIdle();
    });
  }
}
