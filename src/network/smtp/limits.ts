export interface SmtpProtocolLimits {
  readonly maxCommandLineBytes: number;
  readonly maxTextLineBytes: number;
  readonly minRecipientsBuffered: number;
  readonly idleTimeoutMs: Record<'initial' | 'mailCmd' | 'rcptCmd' | 'dataInit' | 'dataBlock' | 'dataTerm', number>;
}

export const DEFAULT_PROTOCOL_LIMITS: SmtpProtocolLimits = {
  maxCommandLineBytes: 512,
  maxTextLineBytes: 1000,
  minRecipientsBuffered: 100,
  idleTimeoutMs: {
    initial: 5 * 60_000,
    mailCmd: 5 * 60_000,
    rcptCmd: 5 * 60_000,
    dataInit: 2 * 60_000,
    dataBlock: 3 * 60_000,
    dataTerm: 10 * 60_000,
  },
};

export function commandLineByteLength(line: string): number {
  return new TextEncoder().encode(line).length + 2;
}

export function exceedsCommandLineLimit(line: string, limits: SmtpProtocolLimits = DEFAULT_PROTOCOL_LIMITS): boolean {
  return commandLineByteLength(line) > limits.maxCommandLineBytes;
}

export function exceedsTextLineLimit(line: string, limits: SmtpProtocolLimits = DEFAULT_PROTOCOL_LIMITS): boolean {
  return commandLineByteLength(line) > limits.maxTextLineBytes;
}
