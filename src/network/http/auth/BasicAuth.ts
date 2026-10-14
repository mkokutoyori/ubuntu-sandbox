import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '@/crypto/encoding';
// RFC 7617 — HTTP Basic authentication.
export interface BasicChallenge {
  scheme: 'Basic';
  realm: string;
}

export interface BasicCredentials {
  username: string;
  password: string;
}

function toBase64(text: string): string {
  return bytesToBase64(utf8ToBytes(text));
}

function fromBase64(b64: string): string {
  return bytesToUtf8(base64ToBytes(b64));
}

export function buildBasicChallengeHeader(challenge: BasicChallenge): string {
  return `Basic realm="${challenge.realm}"`;
}

export function encodeBasicCredentials(username: string, password: string): string {
  return `Basic ${toBase64(`${username}:${password}`)}`;
}

export function parseBasicCredentials(authorizationHeader: string): BasicCredentials | null {
  const m = /^Basic\s+(\S+)$/i.exec(authorizationHeader.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = fromBase64(m[1]);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon === -1) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

export function verifyBasicCredentials(authorizationHeader: string, expectedUsername: string, expectedPassword: string): boolean {
  const creds = parseBasicCredentials(authorizationHeader);
  return creds !== null && creds.username === expectedUsername && creds.password === expectedPassword;
}
