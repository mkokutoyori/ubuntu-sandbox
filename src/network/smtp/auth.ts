import { simulationNowMs } from '@/network/core/SystemClock';

import { MD5 } from '@/crypto/hash/md5';
import { hmacHex } from '@/crypto/mac/hmac';
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '@/crypto/encoding';

export type AuthMechanism = 'PLAIN' | 'LOGIN' | 'CRAM-MD5';

export interface AuthState {
  readonly authenticated: boolean;
  readonly mechanism?: AuthMechanism;
  readonly identity?: string;
}

export function toBase64(text: string): string {
  return bytesToBase64(utf8ToBytes(text));
}

export function fromBase64(b64: string): string | null {
  try {
    return bytesToUtf8(base64ToBytes(b64.trim()));
  } catch {
    return null;
  }
}

export interface PlainCredentials {
  readonly authzid: string;
  readonly authcid: string;
  readonly password: string;
}

export function decodePlainResponse(b64: string): PlainCredentials | null {
  const decoded = fromBase64(b64);
  if (decoded === null) return null;
  const parts = decoded.split('\0');
  if (parts.length !== 3) return null;
  return { authzid: parts[0], authcid: parts[1], password: parts[2] };
}

let challengeCounter = 0;

export function generateCramMd5Challenge(hostname: string): string {
  challengeCounter += 1;
  return `<${challengeCounter}.${simulationNowMs()}@${hostname}>`;
}

export function decodeCramMd5Response(response: string): { username: string; digest: string } | null {
  const decoded = fromBase64(response);
  if (decoded === null) return null;
  const spaceIdx = decoded.lastIndexOf(' ');
  if (spaceIdx === -1) return null;
  return { username: decoded.slice(0, spaceIdx), digest: decoded.slice(spaceIdx + 1) };
}

export function computeCramMd5Digest(challenge: string, password: string): string {
  return hmacHex(MD5, password, challenge);
}
