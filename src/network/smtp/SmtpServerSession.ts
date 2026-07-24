/**
 * SMTP/ESMTP (RFC 5321 §2-4) — server-side control channel state machine
 * for one connection, mirroring `FtpServerSession.ts`'s shape: `handle()`
 * takes an `SmtpCommand` and returns the reply/replies to send back. The
 * `DATA` command is the one exception to the "one command in, one reply
 * out" rule real SMTP shares with FTP's transfer commands — once `DATA`
 * itself is accepted (`354`), the wire layer (`SmtpServer.ts`) switches
 * to body-collection mode and hands the whole raw blob to
 * `handleDataBody()` in one call, consistent with this simulator's
 * "one `TcpSocket` write == one logical unit" convention already
 * documented on `FtpServerSession.ts`.
 */
import type { SmtpCommand, SmtpReply, SmtpSessionState, MailEnvelope } from './types';
import { reply } from './replies';

export interface SmtpServerConfig {
  readonly hostname: string;
  /** RFC 5321 §4.5.1 objective — VRFY/EXPN are disabled (502) by default, like a hardened real server. */
  readonly verifyEnabled?: boolean;
}

const CRLF = '\r\n';

function parseAddressArgument(prefix: 'FROM' | 'TO', argument: string | undefined): string | null {
  if (!argument) return null;
  const re = new RegExp(`^${prefix}:<([^>]*)>`, 'i');
  const m = re.exec(argument.trim());
  return m ? m[1] : null;
}

export class SmtpServerSession {
  result: 'open' | 'closed' = 'open';
  heloDomain: string | null = null;

  private state: SmtpSessionState = 'connected';
  private envelopeFrom: string | null = null;
  private envelopeTo: string[] = [];
  /** Last completed transaction, for the wire layer / later phases (LDA, relay) to consume. */
  lastDelivered: { envelope: MailEnvelope; rawMessage: string } | null = null;

  constructor(private readonly config: SmtpServerConfig) {}

  greeting(): SmtpReply {
    return reply(220, `${this.config.hostname} Ubuntu Sandbox SMTP server ready.`);
  }

  currentState(): SmtpSessionState {
    return this.state;
  }

  handle(cmd: SmtpCommand): readonly SmtpReply[] {
    switch (cmd.verb) {
      case 'HELO': return [this.handleHelo(cmd)];
      case 'EHLO': return [this.handleEhlo(cmd)];
      case 'MAIL': return [this.handleMail(cmd)];
      case 'RCPT': return [this.handleRcpt(cmd)];
      case 'DATA': return [this.handleData()];
      case 'RSET': return [this.handleRset()];
      case 'NOOP': return [reply(250, 'OK')];
      case 'QUIT': {
        this.state = 'closed';
        this.result = 'closed';
        return [reply(221, `${this.config.hostname} closing connection`)];
      }
      case 'VRFY': return [this.handleVrfy(cmd)];
      case 'EXPN': return [this.handleVrfy(cmd)];
      case 'HELP': return [reply(214, 'Commands: HELO EHLO MAIL RCPT DATA RSET NOOP QUIT VRFY EXPN HELP')];
      default: return [reply(500, `Command not recognized: '${cmd.verb}'`)];
    }
  }

  private handleHelo(cmd: SmtpCommand): SmtpReply {
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    this.heloDomain = cmd.argument.trim();
    this.resetTransaction();
    this.state = 'greeted';
    return reply(250, `${this.config.hostname} Hello ${this.heloDomain}`);
  }

  private handleEhlo(cmd: SmtpCommand): SmtpReply {
    if (!cmd.argument) return reply(501, 'Syntax error in parameters.');
    this.heloDomain = cmd.argument.trim();
    this.resetTransaction();
    this.state = 'greeted';
    return reply(250, `${this.config.hostname} Hello ${this.heloDomain}`);
  }

  private handleMail(cmd: SmtpCommand): SmtpReply {
    if (this.state === 'connected') return reply(503, 'Send HELO/EHLO first.');
    if (this.state !== 'greeted') return reply(503, 'Mail transaction already in progress; send RSET first.');
    const from = parseAddressArgument('FROM', cmd.argument);
    if (from === null) return reply(501, 'Syntax error in MAIL command.');
    this.envelopeFrom = from;
    this.envelopeTo = [];
    this.state = 'mail-set';
    return reply(250, 'OK');
  }

  private handleRcpt(cmd: SmtpCommand): SmtpReply {
    if (this.state !== 'mail-set' && this.state !== 'rcpt-set') return reply(503, 'Need MAIL command first.');
    const to = parseAddressArgument('TO', cmd.argument);
    if (to === null) return reply(501, 'Syntax error in RCPT command.');
    this.envelopeTo.push(to);
    this.state = 'rcpt-set';
    return reply(250, 'OK');
  }

  private handleData(): SmtpReply {
    if (this.state !== 'rcpt-set') return reply(503, 'Need RCPT (recipient) first.');
    this.state = 'data';
    return reply(354, 'Start mail input; end with <CRLF>.<CRLF>');
  }

  /** Called by the wire layer once the whole raw DATA blob has been received. */
  handleDataBody(rawBlob: string): SmtpReply {
    if (this.state !== 'data') return reply(503, 'DATA not expected.');
    const lines = rawBlob.split(CRLF);
    const termIdx = lines.indexOf('.');
    const bodyLines = termIdx === -1 ? lines : lines.slice(0, termIdx);
    const rawMessage = bodyLines.join(CRLF);

    this.lastDelivered = {
      envelope: { from: this.envelopeFrom ?? '', to: [...this.envelopeTo] },
      rawMessage,
    };
    this.resetTransaction();
    this.state = 'greeted';
    return reply(250, 'OK: message accepted');
  }

  private handleRset(): SmtpReply {
    this.resetTransaction();
    this.state = this.heloDomain ? 'greeted' : 'connected';
    return reply(250, 'OK');
  }

  private handleVrfy(_cmd: SmtpCommand): SmtpReply {
    if (!this.config.verifyEnabled) return reply(502, 'VRFY/EXPN disabled for security reasons.');
    return reply(252, 'Cannot VRFY user, but will accept message and attempt delivery.');
  }

  private resetTransaction(): void {
    this.envelopeFrom = null;
    this.envelopeTo = [];
  }
}
