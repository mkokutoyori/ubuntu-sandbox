import type { GssTokenError } from './GssSecurityContext';

export const GSS_S_BAD_MECH = 0x00010000;
export const GSS_S_BAD_NAME = 0x00020000;
export const GSS_S_BAD_SIG = 0x00060000;
export const GSS_S_NO_CRED = 0x00070000;
export const GSS_S_NO_CONTEXT = 0x00080000;
export const GSS_S_DEFECTIVE_TOKEN = 0x00090000;
export const GSS_S_DEFECTIVE_CREDENTIAL = 0x000a0000;
export const GSS_S_CREDENTIALS_EXPIRED = 0x000b0000;
export const GSS_S_CONTEXT_EXPIRED = 0x000c0000;
export const GSS_S_FAILURE = 0x000d0000;

const MAJOR_TEXT: Readonly<Record<number, string>> = {
  [GSS_S_BAD_MECH]: 'An unsupported mechanism was requested',
  [GSS_S_BAD_NAME]: 'An invalid name was supplied',
  [GSS_S_BAD_SIG]: 'A token had an invalid Message Integrity Check (MIC)',
  [GSS_S_NO_CRED]: 'No credentials were supplied, or the credentials were unavailable or inaccessible',
  [GSS_S_NO_CONTEXT]: 'No context has been established',
  [GSS_S_DEFECTIVE_TOKEN]: 'Invalid token was supplied',
  [GSS_S_DEFECTIVE_CREDENTIAL]: 'Invalid credential was supplied',
  [GSS_S_CREDENTIALS_EXPIRED]: 'The referenced credential has expired',
  [GSS_S_CONTEXT_EXPIRED]: 'The referenced context has expired',
  [GSS_S_FAILURE]: 'Unspecified GSS failure.  Minor code may provide more information',
};

export interface GssFailure {
  readonly major: number;
  readonly minor: string;
}

export function gssFailure(major: number, minor: string): GssFailure {
  return { major, minor };
}

export function describeGssFailure(failure: GssFailure): string {
  return `${MAJOR_TEXT[failure.major] ?? 'Unknown error'} (${failure.minor})`;
}

export function gssFailureOfTokenError(error: GssTokenError): GssFailure {
  if (error.reason === 'defective-token') return gssFailure(GSS_S_DEFECTIVE_TOKEN, 'Token header is malformed or corrupt');
  return gssFailure(GSS_S_BAD_SIG, 'Decrypt integrity check failed');
}
