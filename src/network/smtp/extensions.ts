import type { EsmtpCapabilities } from './types';

export interface CapabilityInputs {
  readonly tlsActive: boolean;
  readonly authActive: boolean;
  readonly allowPlainAuth: boolean;
  readonly maxMessageSize?: number;
  readonly pipeliningEnabled?: boolean;
  readonly eightBitMimeEnabled?: boolean;
}

export function buildCapabilities(opts: CapabilityInputs): EsmtpCapabilities {
  return {
    size: opts.maxMessageSize,
    eightBitMime: opts.eightBitMimeEnabled ?? false,
    pipelining: opts.pipeliningEnabled ?? false,
    enhancedStatusCodes: true,
    startTls: !opts.tlsActive,
    authMechanisms: (opts.tlsActive || opts.allowPlainAuth) ? ['PLAIN', 'LOGIN', 'CRAM-MD5'] : [],
  };
}

export function formatCapabilityLines(caps: EsmtpCapabilities): string[] {
  const lines: string[] = [];
  if (caps.size !== undefined) lines.push(`SIZE ${caps.size}`);
  if (caps.eightBitMime) lines.push('8BITMIME');
  if (caps.pipelining) lines.push('PIPELINING');
  if (caps.enhancedStatusCodes) lines.push('ENHANCEDSTATUSCODES');
  if (caps.startTls) lines.push('STARTTLS');
  if (caps.authMechanisms.length > 0) lines.push(`AUTH ${caps.authMechanisms.join(' ')}`);
  return lines;
}
