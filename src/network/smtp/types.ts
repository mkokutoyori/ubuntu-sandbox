/**
 * SMTP/ESMTP (RFC 5321 §2-4) — core wire types. Same fidelity level as
 * the FTP control channel (`network/ftp/types.ts`): real command/reply
 * framing, one complete logical unit per `TcpSocket` `write()`/`onData()`
 * call (see `SmtpServer.ts`), no manual byte-stream reassembly needed.
 */

export interface SmtpCommand {
  readonly verb: string;
  readonly argument?: string;
}

export interface SmtpReply {
  readonly code: number;
  /** RFC 3463/5248 enhanced status code, e.g. '2.1.0'/'5.1.1' — added from P4 on. */
  readonly enhancedCode?: string;
  readonly lines: readonly string[];
}

/** RFC 5321 session state machine (§3.3) — connected, greeted (post EHLO/HELO), in-transaction, or closed. */
export type SmtpSessionState = 'connected' | 'greeted' | 'mail-set' | 'rcpt-set' | 'data' | 'closed';

/** RFC 5321 §2.3.1 — the envelope, distinct from the RFC 5322 message headers (§4.2 of the PRD). */
export interface MailEnvelope {
  readonly from: string;
  readonly to: readonly string[];
  readonly size?: number;
  readonly bodyType?: '7BIT' | '8BITMIME';
}

export interface MimeMessage {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}
