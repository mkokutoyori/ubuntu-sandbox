import type { SmtpCommand, SmtpReply, SmtpSessionState, MailEnvelope, MimeMessage } from './types';
import { reply } from './replies';
import { parseMailFromArgument, parseRcptToArgument, buildEnvelope, unstuffDotLines, splitHeadersAndBody } from './envelope';

export interface SmtpServerConfig {
  readonly hostname: string;
  readonly verifyEnabled?: boolean;
}

const CRLF = '\r\n';

export class SmtpServerSession {
  result: 'open' | 'closed' = 'open';
  heloDomain: string | null = null;

  private state: SmtpSessionState = 'connected';
  private envelopeFrom: string | null = null;
  private envelopeTo: string[] = [];
  lastDelivered: { envelope: MailEnvelope; rawMessage: string; message: MimeMessage } | null = null;

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
    const from = parseMailFromArgument(cmd.argument);
    if (from === null) return reply(501, 'Syntax error in MAIL command.');
    this.envelopeFrom = from;
    this.envelopeTo = [];
    this.state = 'mail-set';
    return reply(250, 'OK');
  }

  private handleRcpt(cmd: SmtpCommand): SmtpReply {
    if (this.state !== 'mail-set' && this.state !== 'rcpt-set') return reply(503, 'Need MAIL command first.');
    const to = parseRcptToArgument(cmd.argument);
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

  handleDataBody(rawBlob: string): SmtpReply {
    if (this.state !== 'data') return reply(503, 'DATA not expected.');
    const lines = rawBlob.split(CRLF);
    const termIdx = lines.indexOf('.');
    const bodyLines = termIdx === -1 ? lines : lines.slice(0, termIdx);
    const rawMessage = unstuffDotLines(bodyLines.join(CRLF));

    this.lastDelivered = {
      envelope: buildEnvelope(this.envelopeFrom ?? '', this.envelopeTo),
      rawMessage,
      message: splitHeadersAndBody(rawMessage),
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
