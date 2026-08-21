export interface ApplicationSignature {
  readonly name: string;
  readonly description: string;
  matches(payload: string): boolean;
}

const HTTP_REQUEST = /^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH|TRACE) \S+ HTTP\/1\.[01]/;
const HTTP_RESPONSE = /^HTTP\/1\.[01] \d{3}/;

export const APPLICATION_SIGNATURES: readonly ApplicationSignature[] = Object.freeze([
  {
    name: 'HTTP.BROWSER',
    description: 'HTTP request or response line.',
    matches: (payload) =>
      HTTP_REQUEST.test(payload) || HTTP_RESPONSE.test(payload),
  },
  {
    name: 'SSL',
    description: 'TLS record header.',
    matches: (payload) =>
      payload.charCodeAt(0) === 0x16 && payload.charCodeAt(1) === 0x03,
  },
  {
    name: 'SSH',
    description: 'SSH protocol version exchange.',
    matches: (payload) => payload.startsWith('SSH-'),
  },
  {
    name: 'FTP',
    description: 'FTP greeting or USER command.',
    matches: (payload) =>
      /^220[ -]/.test(payload) || /^USER /.test(payload),
  },
  {
    name: 'SMTP',
    description: 'SMTP greeting or EHLO command.',
    matches: (payload) =>
      /^220[ -]\S+ (ESMTP|SMTP)/i.test(payload) || /^(EHLO|HELO) /i.test(payload),
  },
]);

export const APPLICATION_NAMES: readonly string[] =
  Object.freeze(APPLICATION_SIGNATURES.map(signature => signature.name));

export function identifyApplication(payload: string): string | undefined {
  return APPLICATION_SIGNATURES.find(
    signature => signature.matches(payload))?.name;
}

export function knowsApplication(name: string): boolean {
  return APPLICATION_NAMES.includes(name.toUpperCase());
}
