import { utf8ToBytes, bytesToUtf8, base64ToBytes, bytesToBase64 } from '@/crypto/encoding';

export const ENC_PREFIX = 'ENC ';

const OBFUSCATION_KEY = utf8ToBytes('FortiOS-simulated-secret');

function mask(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index++) {
    out[index] = bytes[index] ^ OBFUSCATION_KEY[index % OBFUSCATION_KEY.length];
  }
  return out;
}

export function encodeSecret(clear: string): string {
  return bytesToBase64(mask(utf8ToBytes(clear)));
}

export function decodeSecret(encoded: string): string | null {
  try {
    return bytesToUtf8(mask(base64ToBytes(encoded.trim())));
  } catch {
    return null;
  }
}

export function isEncodedSecret(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function clearOf(value: string): string {
  if (!isEncodedSecret(value)) return value;
  return decodeSecret(value.slice(ENC_PREFIX.length)) ?? value;
}
