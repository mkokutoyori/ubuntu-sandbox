/**
 * Kerberos crypto (RFC 4120 leaves actual encryption/key-derivation to
 * RFC 3961's etype profiles) — this project's established "simulated
 * crypto, real protocol shape" convention (`TlsRecordWire`, QUIC
 * `packetProtection.ts`, DNS `SimulatedTls.ts`) applies identically here:
 * real ASN.1 structures on the wire (`codec.ts`), digest-derived keys,
 * XOR keystream in place of AES-CTS-HMAC.
 */
import { simulatedDigest } from '@/network/dns/dnssec/Digest';

// RFC 3962's real etype number for AES256-CTS-HMAC-SHA1-96 — used here only
// as a realistic wire value, the actual cipher is simulated.
export const AES256_CTS_HMAC_SHA1_96 = 18;

/** RFC 4120 §5.2.7.2 / RFC 3961 §5 "string-to-key" — simulated as a digest over password+salt. */
export function stringToKey(password: string, salt: string): string {
  return simulatedDigest(`krb5-s2k|${salt}|${password}`);
}

function keystreamByte(key: string, usage: number, index: number): number {
  const position = usage * 131 + index;
  return (key.charCodeAt(position % key.length) + position) & 0xff;
}

/**
 * RFC 3961 §4 "key usage numbers" differentiate keys per encryption
 * context (e.g. PA-ENC-TIMESTAMP vs a ticket vs an AS-REP encrypted part)
 * so the same long-term key never protects two different message kinds
 * with the same keystream — folded into the keystream derivation here,
 * not a real derived subkey.
 */
export function encryptWithUsage(key: string, usage: number, plaintext: Uint8Array): Uint8Array {
  const out = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) out[i] = plaintext[i] ^ keystreamByte(key, usage, i);
  return out;
}

export function decryptWithUsage(key: string, usage: number, ciphertext: Uint8Array): Uint8Array {
  return encryptWithUsage(key, usage, ciphertext); // XOR is self-inverse
}

// RFC 4120 §7.5.1 — real key usage numbers, reused here for realism even
// though the encryption itself is simulated.
export const KU_PA_ENC_TIMESTAMP = 1;
export const KU_TICKET = 2;
export const KU_AS_REP_ENC_PART = 3;
export const KU_TGS_REQ_AUTHENTICATOR = 7;
export const KU_TGS_REP_ENC_PART = 8;
export const KU_AP_REQ_AUTHENTICATOR = 11;

let sessionKeyCounter = 0;

export function randomSessionKey(): string {
  sessionKeyCounter += 1;
  return simulatedDigest(`session-key|${sessionKeyCounter}|${Math.random()}`);
}
