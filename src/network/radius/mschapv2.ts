/**
 * MS-CHAPv2 over RADIUS (RFC 2759, carried as Microsoft VSAs per RFC 2548)
 * and its MPPE session-key derivation (RFC 3079).
 *
 * Built entirely on verified primitives: MD4 (RFC 1320, checked against the
 * official test vectors — see `md4.test.ts`), DES (FIPS 46-3, checked
 * against a canonical known-answer vector — see `des.test.ts`) and SHA1
 * (checked against the FIPS 180 vectors). The NT-Response challenge/response
 * math (§8.1-8.5) and the mutual-auth AuthenticatorResponse (§8.7) are
 * exercised end-to-end in `mschapv2.test.ts` (client/server agreement, wrong
 * password → mismatch). The MPPE key derivation (RFC 3079 §3.4-3.5) is
 * transcribed 1:1 from the RFC pseudocode but has no independent published
 * test vectors to check against — its tests are structural (deterministic,
 * correct length, Send ≠ Recv, client/server keys cross-swapped) rather than
 * byte-exact-verified, unlike the rest of this module.
 */
import { md4 } from '@/crypto/hash/md4';
import { sha1 } from '@/crypto/hash';
import { md5 } from '@/crypto/hash';
import { desEncryptBlock } from '@/crypto/cipher';
import { utf8ToBytes, bytesToHex, hexToBytes } from '@/crypto/encoding';

function utf16LeBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = (code >>> 8) & 0xff;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/** RFC 2759 §8.1 "NtPasswordHash": MD4 of the password in UTF-16LE. */
export function ntPasswordHash(password: string): Uint8Array {
  return md4(utf16LeBytes(password));
}

/** 7-byte key → 8-byte DES key with odd parity in bit 0 of each byte (RFC 2759 Appendix, standard DES-56→64 expansion). */
function expandDesKey(key7: Uint8Array): Uint8Array {
  const key8 = new Uint8Array(8);
  key8[0] = key7[0] & 0xfe;
  key8[1] = ((key7[0] << 7) | (key7[1] >> 1)) & 0xff;
  key8[2] = ((key7[1] << 6) | (key7[2] >> 2)) & 0xff;
  key8[3] = ((key7[2] << 5) | (key7[3] >> 3)) & 0xff;
  key8[4] = ((key7[3] << 4) | (key7[4] >> 4)) & 0xff;
  key8[5] = ((key7[4] << 3) | (key7[5] >> 5)) & 0xff;
  key8[6] = ((key7[5] << 2) | (key7[6] >> 6)) & 0xff;
  key8[7] = (key7[6] << 1) & 0xff;
  for (let i = 0; i < 8; i++) {
    let ones = 0;
    for (let b = 1; b < 8; b++) if ((key8[i] >> b) & 1) ones++;
    key8[i] = (key8[i] & 0xfe) | (ones % 2 === 0 ? 1 : 0);
  }
  return key8;
}

/** RFC 2759 §8.5 "ChallengeResponse": 8-byte challenge, DES-encrypted with 3 keys derived from the 16-byte password hash (zero-padded to 21) → 24-byte response. */
export function challengeResponse(challenge8: Uint8Array, passwordHash16: Uint8Array): Uint8Array {
  const padded = new Uint8Array(21);
  padded.set(passwordHash16);
  const out = new Uint8Array(24);
  out.set(desEncryptBlock(expandDesKey(padded.subarray(0, 7)), challenge8), 0);
  out.set(desEncryptBlock(expandDesKey(padded.subarray(7, 14)), challenge8), 8);
  out.set(desEncryptBlock(expandDesKey(padded.subarray(14, 21)), challenge8), 16);
  return out;
}

/** RFC 2759 §8.2 "ChallengeHash": SHA1(PeerChallenge + AuthenticatorChallenge + Username)[0:8]. Username is used as given — no NT domain-prefix stripping modeled. */
export function challengeHash(peerChallenge16: Uint8Array, authChallenge16: Uint8Array, username: string): Uint8Array {
  const digest = sha1(concat(peerChallenge16, authChallenge16, utf8ToBytes(username)));
  return digest.subarray(0, 8);
}

/** RFC 2759 §8.1 "GenerateNTResponse": the 24-byte NT-Response a peer sends for a given (AuthenticatorChallenge, PeerChallenge, username, password). */
export function generateNtResponse(
  authChallenge16: Uint8Array, peerChallenge16: Uint8Array, username: string, password: string,
): Uint8Array {
  const challenge = challengeHash(peerChallenge16, authChallenge16, username);
  return challengeResponse(challenge, ntPasswordHash(password));
}

const AUTH_RESPONSE_MAGIC1 = utf8ToBytes('Magic server to client signing constant');
const AUTH_RESPONSE_MAGIC2 = utf8ToBytes('Pad to make it do more than one iteration');

/** RFC 2759 §8.7 "GenerateAuthenticatorResponse": the server's proof that it too knows the password — returns `"S=<40 uppercase hex digits>"`. */
export function generateAuthenticatorResponse(
  password: string, ntResponse24: Uint8Array,
  peerChallenge16: Uint8Array, authChallenge16: Uint8Array, username: string,
): string {
  const passwordHashHash = md4(ntPasswordHash(password));
  const digest = sha1(concat(passwordHashHash, ntResponse24, AUTH_RESPONSE_MAGIC1));
  const challenge = challengeHash(peerChallenge16, authChallenge16, username);
  const finalDigest = sha1(concat(digest, challenge, AUTH_RESPONSE_MAGIC2));
  return `S=${bytesToHex(finalDigest).toUpperCase()}`;
}

// ─── MPPE session-key derivation (RFC 3079 §3.4-3.5) ──────────────────

const MASTER_KEY_MAGIC1 = utf8ToBytes('This is the MPPE Master Key');
/** RFC 3079 §3.4 "Magic2": on the client side this is the send key; on the server side, the receive key. */
const ASYM_START_MAGIC2 = utf8ToBytes(
  'On the client side, this is the send key; on the server side, it is the receive key.',
);
/** RFC 3079 §3.4 "Magic3": on the client side this is the receive key; on the server side, the send key. */
const ASYM_START_MAGIC3 = utf8ToBytes(
  'On the client side, this is the receive key; on the server side, it is the send key.',
);
const SHA_PAD1 = new Uint8Array(40);
const SHA_PAD2 = new Uint8Array(40).fill(0xf2);

/** RFC 3079 §3.4 "GetMasterKey". */
export function getMasterKey(ntPasswordHashHash16: Uint8Array, ntResponse24: Uint8Array): Uint8Array {
  return sha1(concat(ntPasswordHashHash16, ntResponse24, MASTER_KEY_MAGIC1)).subarray(0, 16);
}

/**
 * RFC 3079 §3.4 "GetAsymmetricStartKey" — `isServer` is the NAS/RADIUS-server
 * side of the exchange (the role this simulator's `RadiusServerAgent` plays):
 * from that perspective, `isSend` selects the key used to encrypt traffic
 * *from* the NAS *to* the peer (MS-MPPE-Send-Key) vs. the other direction
 * (MS-MPPE-Recv-Key). Per the RFC's own truth table: Magic3 when
 * (isSend, isServer) are both true or both false; Magic2 otherwise.
 */
export function getAsymmetricStartKey(masterKey16: Uint8Array, isSend: boolean, isServer: boolean): Uint8Array {
  const magic = isSend === isServer ? ASYM_START_MAGIC3 : ASYM_START_MAGIC2;
  return sha1(concat(masterKey16, SHA_PAD1, magic, SHA_PAD2)).subarray(0, 16);
}

/** Both 16-byte MPPE session keys a RADIUS server hands the NAS in an Access-Accept, from the NAS's perspective (`isServer = true`). */
export function deriveMppeKeys(ntPasswordHashHash16: Uint8Array, ntResponse24: Uint8Array): {
  masterKey: Uint8Array; sendKey: Uint8Array; recvKey: Uint8Array;
} {
  const masterKey = getMasterKey(ntPasswordHashHash16, ntResponse24);
  return {
    masterKey,
    sendKey: getAsymmetricStartKey(masterKey, true, true),
    recvKey: getAsymmetricStartKey(masterKey, false, true),
  };
}

// ─── RFC 2548 §2.4.3 — MS-MPPE-*-Key attribute encryption ─────────────

/** Encrypt a 16-byte MPPE session key for the MS-MPPE-Send-Key/Recv-Key VSA. Returns the wire value hex-encoded: 2-byte Salt (MSB forced to 1) + ciphertext. */
export function encryptMppeKey(key: Uint8Array, secret: string, requestAuthenticatorHex: string, salt: number): string {
  const saltBytes = Uint8Array.of(((salt >> 8) & 0xff) | 0x80, salt & 0xff);
  const plain = new Uint8Array(1 + key.length);
  plain[0] = key.length;
  plain.set(key, 1);
  const blockLen = Math.ceil(plain.length / 16) * 16;
  const padded = new Uint8Array(blockLen);
  padded.set(plain);

  const secretBytes = utf8ToBytes(secret);
  const authBytes = hexToBytes(requestAuthenticatorHex);
  const cipher = new Uint8Array(blockLen);
  for (let off = 0; off < blockLen; off += 16) {
    const b = off === 0
      ? md5(concat(secretBytes, authBytes, saltBytes))
      : md5(concat(secretBytes, cipher.subarray(off - 16, off)));
    for (let i = 0; i < 16; i++) cipher[off + i] = padded[off + i] ^ b[i];
  }
  return bytesToHex(saltBytes) + bytesToHex(cipher);
}

/** Inverse of `encryptMppeKey` — recovers the raw session key from a wire-format MS-MPPE-*-Key value. */
export function decryptMppeKey(wireHex: string, secret: string, requestAuthenticatorHex: string): Uint8Array {
  const wire = hexToBytes(wireHex);
  const saltBytes = wire.subarray(0, 2);
  const cipher = wire.subarray(2);
  const secretBytes = utf8ToBytes(secret);
  const authBytes = hexToBytes(requestAuthenticatorHex);
  const plain = new Uint8Array(cipher.length);
  for (let off = 0; off < cipher.length; off += 16) {
    const b = off === 0
      ? md5(concat(secretBytes, authBytes, saltBytes))
      : md5(concat(secretBytes, cipher.subarray(off - 16, off)));
    for (let i = 0; i < 16; i++) plain[off + i] = cipher[off + i] ^ b[i];
  }
  const keyLen = plain[0];
  return plain.subarray(1, 1 + keyLen);
}
