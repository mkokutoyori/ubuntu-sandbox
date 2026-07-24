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

export interface MailFromExtensionParams {
  readonly size?: number;
  readonly bodyType?: '7BIT' | '8BITMIME';
}

export function parseMailFromExtensionParams(argument: string | undefined): MailFromExtensionParams {
  if (!argument) return {};
  const sizeMatch = /\bSIZE=(\d+)\b/i.exec(argument);
  const bodyMatch = /\bBODY=(7BIT|8BITMIME)\b/i.exec(argument);
  return {
    size: sizeMatch ? parseInt(sizeMatch[1], 10) : undefined,
    bodyType: bodyMatch ? (bodyMatch[1].toUpperCase() as '7BIT' | '8BITMIME') : undefined,
  };
}

export function hasNonAsciiBytes(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) > 127) return true;
  }
  return false;
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
