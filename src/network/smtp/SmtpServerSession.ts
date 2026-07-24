import type { SmtpCommand, SmtpReply, SmtpSessionState, MailEnvelope, MimeMessage } from './types';
import { reply, replyEnhanced, ENHANCED } from './replies';
import { parseMailFromArgument, parseRcptToArgument, buildEnvelope, unstuffDotLines, splitHeadersAndBody } from './envelope';
import { determineProtocolLabel, prependReceivedHeader } from './trace';

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
  private usedEhlo = false;
  private tlsActive = false;
  private authActive = false;
  lastDelivered: { envelope: MailEnvelope; rawMessage: string; message: MimeMessage } | null = null;

  constructor(private readonly config: SmtpServerConfig, private readonly remoteIp: string = '0.0.0.0') {}

  greeting(): SmtpReply {
    return replyEnhanced(220, ENHANCED.SERVICE_READY, `${this.config.hostname} Ubuntu Sandbox SMTP server ready.`);
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
      case 'NOOP': return [replyEnhanced(250, ENHANCED.OK, 'OK')];
      case 'QUIT': {
        this.state = 'closed';
        this.result = 'closed';
        return [replyEnhanced(221, ENHANCED.CLOSING, `${this.config.hostname} closing connection`)];
      }
      case 'VRFY': return [this.handleVrfy(cmd)];
      case 'EXPN': return [this.handleVrfy(cmd)];
      case 'HELP': return [reply(214, 'Commands: HELO EHLO MAIL RCPT DATA RSET NOOP QUIT VRFY EXPN HELP')];
      default: return [replyEnhanced(500, ENHANCED.SYNTAX_ERROR_COMMAND, `Command not recognized: '${cmd.verb}'`)];
    }
  }

  private handleHelo(cmd: SmtpCommand): SmtpReply {
    if (!cmd.argument) return replyEnhanced(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Syntax error in parameters.');
    this.heloDomain = cmd.argument.trim();
    this.usedEhlo = false;
    this.resetTransaction();
    this.state = 'greeted';
    return replyEnhanced(250, ENHANCED.OK, `${this.config.hostname} Hello ${this.heloDomain}`);
  }

  private handleEhlo(cmd: SmtpCommand): SmtpReply {
    if (!cmd.argument) return replyEnhanced(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Syntax error in parameters.');
    this.heloDomain = cmd.argument.trim();
    this.usedEhlo = true;
    this.resetTransaction();
    this.state = 'greeted';
    return replyEnhanced(250, ENHANCED.OK, `${this.config.hostname} Hello ${this.heloDomain}`);
  }

  private handleMail(cmd: SmtpCommand): SmtpReply {
    if (this.state === 'connected') return replyEnhanced(503, ENHANCED.BAD_SEQUENCE, 'Send HELO/EHLO first.');
    if (this.state !== 'greeted') return replyEnhanced(503, ENHANCED.BAD_SEQUENCE, 'Mail transaction already in progress; send RSET first.');
    const from = parseMailFromArgument(cmd.argument);
    if (from === null) return replyEnhanced(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Syntax error in MAIL command.');
    this.envelopeFrom = from;
    this.envelopeTo = [];
    this.state = 'mail-set';
    return replyEnhanced(250, ENHANCED.SENDER_OK, 'Sender ok');
  }

  private handleRcpt(cmd: SmtpCommand): SmtpReply {
    if (this.state !== 'mail-set' && this.state !== 'rcpt-set') return replyEnhanced(503, ENHANCED.BAD_SEQUENCE, 'Need MAIL command first.');
    const to = parseRcptToArgument(cmd.argument);
    if (to === null) return replyEnhanced(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Syntax error in RCPT command.');
    this.envelopeTo.push(to);
    this.state = 'rcpt-set';
    return replyEnhanced(250, ENHANCED.DEST_VALID, 'Recipient ok');
  }

  private handleData(): SmtpReply {
    if (this.state !== 'rcpt-set') return replyEnhanced(503, ENHANCED.BAD_SEQUENCE, 'Need RCPT (recipient) first.');
    this.state = 'data';
    return replyEnhanced(354, ENHANCED.START_MAIL_INPUT, 'Start mail input; end with <CRLF>.<CRLF>');
  }

  handleDataBody(rawBlob: string): SmtpReply {
    if (this.state !== 'data') return replyEnhanced(503, ENHANCED.BAD_SEQUENCE, 'DATA not expected.');
    const lines = rawBlob.split(CRLF);
    const termIdx = lines.indexOf('.');
    const bodyLines = termIdx === -1 ? lines : lines.slice(0, termIdx);
    const unstuffed = unstuffDotLines(bodyLines.join(CRLF));
    const rawMessage = prependReceivedHeader(unstuffed, {
      fromHelo: this.heloDomain ?? 'unknown',
      fromIp: this.remoteIp,
      by: this.config.hostname,
      withProtocol: determineProtocolLabel(this.usedEhlo, this.tlsActive, this.authActive),
      timestamp: Date.now(),
    });

    this.lastDelivered = {
      envelope: buildEnvelope(this.envelopeFrom ?? '', this.envelopeTo),
      rawMessage,
      message: splitHeadersAndBody(rawMessage),
    };
    this.resetTransaction();
    this.state = 'greeted';
    return replyEnhanced(250, ENHANCED.MESSAGE_ACCEPTED, 'OK: message accepted');
  }

  private handleRset(): SmtpReply {
    this.resetTransaction();
    this.state = this.heloDomain ? 'greeted' : 'connected';
    return replyEnhanced(250, ENHANCED.OK, 'OK');
  }

  private handleVrfy(_cmd: SmtpCommand): SmtpReply {
    if (!this.config.verifyEnabled) return replyEnhanced(502, ENHANCED.COMMAND_NOT_IMPLEMENTED, 'VRFY/EXPN disabled for security reasons.');
    return replyEnhanced(252, ENHANCED.DEST_VALID, 'Cannot VRFY user, but will accept message and attempt delivery.');
  }

  private resetTransaction(): void {
    this.envelopeFrom = null;
    this.envelopeTo = [];
  }
}
