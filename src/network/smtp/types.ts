export interface SmtpCommand {
  readonly verb: string;
  readonly argument?: string;
}

export interface SmtpReply {
  readonly code: number;
  readonly enhancedCode?: string;
  readonly lines: readonly string[];
}

export type SmtpSessionState = 'connected' | 'greeted' | 'mail-set' | 'rcpt-set' | 'data' | 'closed';

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

export interface EsmtpCapabilities {
  readonly size?: number;
  readonly eightBitMime: boolean;
  readonly pipelining: boolean;
  readonly enhancedStatusCodes: boolean;
  readonly startTls: boolean;
  readonly authMechanisms: readonly ('PLAIN' | 'LOGIN' | 'CRAM-MD5')[];
}
