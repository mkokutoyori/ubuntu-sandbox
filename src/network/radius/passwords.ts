/**
 * CHAP support for RADIUS (RFC 2865 §5.3, RFC 1994).
 *
 * PAP (User-Password encryption) stays in `types.ts` where it has lived since
 * before this module existed — moving it would only add churn. This file
 * holds what's new: the CHAP-Password/CHAP-Challenge value format and the
 * MD5(Identifier + Password + Challenge) computation both client and server
 * need.
 */
import { md5 } from '@/crypto/hash';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@/crypto/encoding';

/** MD5(CHAP-Identifier + Password + Challenge) — the raw 16-byte CHAP response. */
export function computeChapResponse(chapIdentifier: number, password: string, challenge: Uint8Array): Uint8Array {
  const passwordBytes = utf8ToBytes(password);
  const input = new Uint8Array(1 + passwordBytes.length + challenge.length);
  input[0] = chapIdentifier & 0xff;
  input.set(passwordBytes, 1);
  input.set(challenge, 1 + passwordBytes.length);
  return md5(input);
}

/** Build the 17-byte CHAP-Password attribute value: [Ident(1)] + [Response(16)], hex-encoded. */
export function buildChapPasswordHex(chapIdentifier: number, password: string, challenge: Uint8Array): string {
  const response = computeChapResponse(chapIdentifier, password, challenge);
  const out = new Uint8Array(1 + response.length);
  out[0] = chapIdentifier & 0xff;
  out.set(response, 1);
  return bytesToHex(out);
}

export interface ParsedChapPassword {
  chapIdentifier: number;
  response: Uint8Array;
}

/** Parse a hex-encoded CHAP-Password attribute value; null if malformed (not exactly 17 bytes). */
export function parseChapPasswordHex(hex: string): ParsedChapPassword | null {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 17) return null;
  return { chapIdentifier: bytes[0], response: bytes.subarray(1) };
}

/** Recompute the expected response and compare (non-short-circuiting). */
export function verifyChapResponse(
  chapIdentifier: number, response: Uint8Array, password: string, challenge: Uint8Array,
): boolean {
  const expected = computeChapResponse(chapIdentifier, password, challenge);
  if (expected.length !== response.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ response[i];
  return diff === 0;
}
