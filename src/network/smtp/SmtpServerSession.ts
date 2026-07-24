import type { SmtpCommand, SmtpReply, SmtpSessionState, MailEnvelope, MimeMessage } from './types';
import { reply, replyEnhanced, ENHANCED } from './replies';
import { parseMailFromArgument, parseRcptToArgument, buildEnvelope, unstuffDotLines, splitHeadersAndBody } from './envelope';
import { determineProtocolLabel, prependReceivedHeader } from './trace';
import { buildCapabilities, formatCapabilityLines, parseMailFromExtensionParams, hasNonAsciiBytes } from './extensions';
import {
  type AuthMechanism, toBase64, fromBase64, decodePlainResponse, generateCramMd5Challenge, decodeCramMd5Response, computeCramMd5Digest,
} from './auth';
import { buildSubmissionContext, formatSenderLine, insertSenderHeader } from './submission';

export interface SmtpServerConfig {
  readonly hostname: string;
  readonly verifyEnabled?: boolean;
  readonly allowPlainTextAuth?: boolean;
  readonly maxMessageSize?: number;
  readonly pipeliningEnabled?: boolean;
  readonly eightBitMimeEnabled?: boolean;
  readonly tlsSupported?: boolean;
  readonly users?: ReadonlyMap<string, string>;
  readonly authenticate?: (username: string, password: string) => boolean;
  readonly submissionMode?: boolean;
}

const CRLF = '\r\n';

export class SmtpServerSession {
  result: 'open' | 'closed' = 'open';
  heloDomain: string | null = null;

  private state: SmtpSessionState = 'connected';
  private envelopeFrom: string | null = null;
  private envelopeTo: string[] = [];
  private envelopeSize: number | undefined;
  private envelopeBodyType: '7BIT' | '8BITMIME' | undefined;
  private usedEhlo = false;
  private tlsActive = false;
  private authActive = false;
  private pendingTlsUpgrade = false;
  private authMechanismPending: AuthMechanism | null = null;
  private awaitingAuthContinuation = false;
  private authLoginUsername: string | null = null;
  private cramChallenge: string | null = null;
  authIdentity: string | null = null;
  authMechanism: AuthMechanism | null = null;
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
      case 'STARTTLS': return [this.handleStartTls(cmd)];
      case 'AUTH': return [this.handleAuth(cmd)];
      case 'HELP': return [reply(214, 'Commands: HELO EHLO MAIL RCPT DATA RSET NOOP QUIT VRFY EXPN STARTTLS AUTH HELP')];
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
    const caps = this.currentCapabilities();
    return reply(250, `${this.config.hostname} Hello ${this.heloDomain}`, ...formatCapabilityLines(caps));
  }

  private currentCapabilities() {
    return buildCapabilities({
      tlsActive: this.tlsActive,
      authActive: this.authActive,
      allowPlainAuth: this.config.allowPlainTextAuth ?? false,
      maxMessageSize: this.config.maxMessageSize,
      pipeliningEnabled: this.config.pipeliningEnabled ?? false,
      eightBitMimeEnabled: this.config.eightBitMimeEnabled ?? false,
    });
  }

  pipeliningNegotiated(): boolean {
    return this.usedEhlo && (this.config.pipeliningEnabled ?? false);
  }

  private handleMail(cmd: SmtpCommand): SmtpReply {
    if (this.state === 'connected') return replyEnhanced(503, ENHANCED.BAD_SEQUENCE, 'Send HELO/EHLO first.');
    if (this.state !== 'greeted') return replyEnhanced(503, ENHANCED.BAD_SEQUENCE, 'Mail transaction already in progress; send RSET first.');
    if (this.config.submissionMode && !this.authActive) {
      return replyEnhanced(530, ENHANCED.AUTH_REQUIRED, 'Authentication required for mail submission.');
    }
    const from = parseMailFromArgument(cmd.argument);
    if (from === null) return replyEnhanced(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Syntax error in MAIL command.');
    const ext = parseMailFromExtensionParams(cmd.argument);
    if (ext.size !== undefined && this.config.maxMessageSize !== undefined && ext.size > this.config.maxMessageSize) {
      return replyEnhanced(552, ENHANCED.MESSAGE_TOO_LARGE, 'Message size exceeds fixed maximum message size.');
    }
    this.envelopeFrom = from;
    this.envelopeTo = [];
    this.envelopeSize = ext.size;
    this.envelopeBodyType = ext.bodyType;
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

    const eightBitNegotiated = this.config.eightBitMimeEnabled ?? false;
    const bodyDeclared7Bit = this.envelopeBodyType === '7BIT' || (this.envelopeBodyType === undefined && !eightBitNegotiated);
    if (bodyDeclared7Bit && hasNonAsciiBytes(unstuffed)) {
      this.resetTransaction();
      this.state = 'greeted';
      return replyEnhanced(554, ENHANCED.CONTENT_7BIT_VIOLATION, 'Transaction failed: message contains 8-bit data but 7BIT was declared.');
    }

    let withSender = unstuffed;
    if (this.config.submissionMode && this.authActive && this.authIdentity) {
      const declaredFrom = splitHeadersAndBody(unstuffed).headers.get('From') ?? '';
      const ctx = buildSubmissionContext(this.authIdentity, declaredFrom);
      if (ctx.senderHeaderAdded) {
        withSender = insertSenderHeader(unstuffed, formatSenderLine(this.authIdentity, this.config.hostname));
      }
    }

    const rawMessage = prependReceivedHeader(withSender, {
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

  private handleStartTls(cmd: SmtpCommand): SmtpReply {
    if (cmd.argument) return replyEnhanced(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Syntax error (no parameters allowed).');
    if (!this.config.tlsSupported) return replyEnhanced(454, ENHANCED.SERVICE_NOT_AVAILABLE, 'TLS not available.');
    if (this.tlsActive) return replyEnhanced(503, ENHANCED.BAD_SEQUENCE, 'TLS already active.');
    this.pendingTlsUpgrade = true;
    return replyEnhanced(220, ENHANCED.SERVICE_READY, 'Ready to start TLS');
  }

  consumeTlsUpgradeSignal(): boolean {
    const v = this.pendingTlsUpgrade;
    this.pendingTlsUpgrade = false;
    return v;
  }

  markTlsActive(): void {
    this.tlsActive = true;
    this.usedEhlo = false;
    this.heloDomain = null;
    this.state = 'connected';
    this.resetTransaction();
  }

  isTlsActive(): boolean {
    return this.tlsActive;
  }

  isAwaitingAuthContinuation(): boolean {
    return this.awaitingAuthContinuation;
  }

  private handleAuth(cmd: SmtpCommand): SmtpReply {
    if (this.authActive) return replyEnhanced(503, ENHANCED.BAD_SEQUENCE, 'Already authenticated.');
    const [mechRaw, ...rest] = (cmd.argument ?? '').trim().split(/\s+/);
    const mechanism = mechRaw.toUpperCase();
    if (!this.currentCapabilities().authMechanisms.includes(mechanism as AuthMechanism)) {
      return replyEnhanced(503, ENHANCED.AUTH_REQUIRED, 'AUTH not available.');
    }
    const initialResponse = rest.join(' ') || undefined;
    if (mechanism === 'PLAIN') return this.startAuthPlain(initialResponse);
    if (mechanism === 'LOGIN') return this.startAuthLogin(initialResponse);
    if (mechanism === 'CRAM-MD5') return this.startAuthCramMd5();
    return replyEnhanced(504, ENHANCED.COMMAND_NOT_IMPLEMENTED, 'Unrecognized authentication type.');
  }

  private startAuthPlain(initialResponse: string | undefined): SmtpReply {
    if (initialResponse !== undefined) return this.finishAuthPlain(initialResponse);
    this.authMechanismPending = 'PLAIN';
    this.awaitingAuthContinuation = true;
    return reply(334, '');
  }

  private finishAuthPlain(b64: string): SmtpReply {
    this.authMechanismPending = null;
    this.awaitingAuthContinuation = false;
    const creds = decodePlainResponse(b64);
    if (!creds) return replyEnhanced(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Cannot decode response.');
    if (!this.checkCredentials(creds.authcid, creds.password)) return replyEnhanced(535, ENHANCED.AUTH_CREDENTIALS_INVALID, 'Authentication credentials invalid.');
    return this.completeAuth('PLAIN', creds.authcid);
  }

  private startAuthLogin(initialResponse: string | undefined): SmtpReply {
    this.authMechanismPending = 'LOGIN';
    this.awaitingAuthContinuation = true;
    if (initialResponse !== undefined) {
      const username = fromBase64(initialResponse);
      if (username === null) return this.abortAuth(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Cannot decode response.');
      this.authLoginUsername = username;
      return reply(334, toBase64('Password:'));
    }
    return reply(334, toBase64('Username:'));
  }

  private continueAuthLogin(line: string): SmtpReply {
    if (this.authLoginUsername === null) {
      const username = fromBase64(line);
      if (username === null) return this.abortAuth(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Cannot decode response.');
      this.authLoginUsername = username;
      return reply(334, toBase64('Password:'));
    }
    const username = this.authLoginUsername;
    const password = fromBase64(line);
    this.authMechanismPending = null;
    this.awaitingAuthContinuation = false;
    this.authLoginUsername = null;
    if (password === null) return replyEnhanced(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Cannot decode response.');
    if (!this.checkCredentials(username, password)) return replyEnhanced(535, ENHANCED.AUTH_CREDENTIALS_INVALID, 'Authentication credentials invalid.');
    return this.completeAuth('LOGIN', username);
  }

  private startAuthCramMd5(): SmtpReply {
    this.authMechanismPending = 'CRAM-MD5';
    this.awaitingAuthContinuation = true;
    this.cramChallenge = generateCramMd5Challenge(this.config.hostname);
    return reply(334, toBase64(this.cramChallenge));
  }

  private finishAuthCramMd5(line: string): SmtpReply {
    const challenge = this.cramChallenge!;
    this.authMechanismPending = null;
    this.awaitingAuthContinuation = false;
    this.cramChallenge = null;
    const decoded = decodeCramMd5Response(line);
    if (!decoded) return replyEnhanced(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Cannot decode response.');
    const password = this.config.users?.get(decoded.username) ?? null;
    if (password === null || computeCramMd5Digest(challenge, password) !== decoded.digest) {
      return replyEnhanced(535, ENHANCED.AUTH_CREDENTIALS_INVALID, 'Authentication credentials invalid.');
    }
    return this.completeAuth('CRAM-MD5', decoded.username);
  }

  handleAuthContinuation(line: string): SmtpReply {
    if (line.trim() === '*') return this.abortAuth(501, ENHANCED.SYNTAX_ERROR_ARGS, 'Authentication cancelled.');
    switch (this.authMechanismPending) {
      case 'PLAIN': return this.finishAuthPlain(line);
      case 'LOGIN': return this.continueAuthLogin(line);
      case 'CRAM-MD5': return this.finishAuthCramMd5(line);
      default: return this.abortAuth(503, ENHANCED.BAD_SEQUENCE, 'Unexpected input.');
    }
  }

  private abortAuth(code: number, enhancedCode: string, message: string): SmtpReply {
    this.authMechanismPending = null;
    this.awaitingAuthContinuation = false;
    this.authLoginUsername = null;
    this.cramChallenge = null;
    return replyEnhanced(code, enhancedCode, message);
  }

  private checkCredentials(username: string, password: string): boolean {
    if (this.config.authenticate) return this.config.authenticate(username, password);
    return this.config.users?.get(username) === password;
  }

  private completeAuth(mechanism: AuthMechanism, identity: string): SmtpReply {
    this.authActive = true;
    this.authIdentity = identity;
    this.authMechanism = mechanism;
    return replyEnhanced(235, ENHANCED.AUTH_SUCCEEDED, 'Authentication successful.');
  }

  private resetTransaction(): void {
    this.envelopeFrom = null;
    this.envelopeTo = [];
    this.envelopeSize = undefined;
    this.envelopeBodyType = undefined;
  }
}
