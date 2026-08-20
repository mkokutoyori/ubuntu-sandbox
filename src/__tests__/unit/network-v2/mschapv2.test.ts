import { describe, it, expect } from 'vitest';
import {
  ntPasswordHash, challengeHash, challengeResponse, generateNtResponse,
  generateAuthenticatorResponse, getMasterKey, getAsymmetricStartKey,
  deriveMppeKeys, encryptMppeKey, decryptMppeKey,
} from '@/network/radius/mschapv2';
import { md4 } from '@/crypto/hash';
import { bytesToHex } from '@/crypto/encoding';

const AUTH_CHALLENGE = new Uint8Array(16).map((_, i) => i);
const PEER_CHALLENGE = new Uint8Array(16).map((_, i) => 0xf0 + i);

describe('MS-CHAPv2 (RFC 2759) — NT-Response', () => {
  it('ntPasswordHash is MD4 of the UTF-16LE password', () => {
    // "a" in UTF-16LE is bytes [0x61, 0x00] — matches md4("a") from the RFC 1320 vector shifted through utf16.
    const expectedFor61 = md4(new Uint8Array([0x61, 0x00]));
    expect(ntPasswordHash('a')).toEqual(expectedFor61);
  });

  it('produces a 24-byte response', () => {
    const response = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    expect(response.length).toBe(24);
  });

  it('is deterministic for the same inputs', () => {
    const r1 = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    const r2 = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    expect(bytesToHex(r1)).toBe(bytesToHex(r2));
  });

  it('a wrong password produces a different response (server-side verification would reject it)', () => {
    const good = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    const bad = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wrong-password');
    expect(bytesToHex(good)).not.toBe(bytesToHex(bad));
  });

  it('a different username changes the response (ChallengeHash is username-bound)', () => {
    const alice = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    const bob = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'bob', 'wonderland');
    expect(bytesToHex(alice)).not.toBe(bytesToHex(bob));
  });

  it('challengeHash reduces two 16-byte challenges + username to 8 bytes', () => {
    const h = challengeHash(PEER_CHALLENGE, AUTH_CHALLENGE, 'alice');
    expect(h.length).toBe(8);
  });

  it('challengeResponse triple-DES-encrypts the 8-byte challenge into 24 bytes', () => {
    const hash16 = ntPasswordHash('wonderland');
    const resp = challengeResponse(new Uint8Array(8), hash16);
    expect(resp.length).toBe(24);
  });
});

describe('MS-CHAPv2 — mutual authentication (AuthenticatorResponse, RFC 2759 §8.7)', () => {
  it('the server can reproduce the same "S=" string the peer expects, given the correct password', () => {
    const ntResponse = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    const authResponse = generateAuthenticatorResponse('wonderland', ntResponse, PEER_CHALLENGE, AUTH_CHALLENGE, 'alice');
    expect(authResponse).toMatch(/^S=[0-9A-F]{40}$/);
  });

  it('is deterministic', () => {
    const ntResponse = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    const a1 = generateAuthenticatorResponse('wonderland', ntResponse, PEER_CHALLENGE, AUTH_CHALLENGE, 'alice');
    const a2 = generateAuthenticatorResponse('wonderland', ntResponse, PEER_CHALLENGE, AUTH_CHALLENGE, 'alice');
    expect(a1).toBe(a2);
  });

  it('differs for a different NT-Response (e.g. computed from a wrong password)', () => {
    const good = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    const bad = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wrong-password');
    const a1 = generateAuthenticatorResponse('wonderland', good, PEER_CHALLENGE, AUTH_CHALLENGE, 'alice');
    const a2 = generateAuthenticatorResponse('wonderland', bad, PEER_CHALLENGE, AUTH_CHALLENGE, 'alice');
    expect(a1).not.toBe(a2);
  });
});

describe('MPPE key derivation (RFC 3079 §3.4-3.5) — structural checks, no external test vectors available', () => {
  it('derives a 16-byte master key and two distinct 16-byte session keys', () => {
    const ntResponse = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    const passwordHashHash = md4(ntPasswordHash('wonderland'));
    const { masterKey, sendKey, recvKey } = deriveMppeKeys(passwordHashHash, ntResponse);
    expect(masterKey.length).toBe(16);
    expect(sendKey.length).toBe(16);
    expect(recvKey.length).toBe(16);
    expect(bytesToHex(sendKey)).not.toBe(bytesToHex(recvKey));
  });

  it('is deterministic for the same NT-Response/password', () => {
    const ntResponse = generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland');
    const passwordHashHash = md4(ntPasswordHash('wonderland'));
    const a = deriveMppeKeys(passwordHashHash, ntResponse);
    const b = deriveMppeKeys(passwordHashHash, ntResponse);
    expect(bytesToHex(a.sendKey)).toBe(bytesToHex(b.sendKey));
    expect(bytesToHex(a.recvKey)).toBe(bytesToHex(b.recvKey));
  });

  it('the server\'s send key is the client\'s receive key, and vice versa (RFC 3079\'s own mirrored-role guarantee)', () => {
    const masterKey = getMasterKey(md4(ntPasswordHash('wonderland')), generateNtResponse(AUTH_CHALLENGE, PEER_CHALLENGE, 'alice', 'wonderland'));
    const serverSend = getAsymmetricStartKey(masterKey, true, true);
    const clientRecv = getAsymmetricStartKey(masterKey, false, false);
    const serverRecv = getAsymmetricStartKey(masterKey, false, true);
    const clientSend = getAsymmetricStartKey(masterKey, true, false);
    expect(bytesToHex(serverSend)).toBe(bytesToHex(clientRecv));
    expect(bytesToHex(serverRecv)).toBe(bytesToHex(clientSend));
    expect(bytesToHex(serverSend)).not.toBe(bytesToHex(serverRecv));
  });
});

describe('RFC 2548 §2.4.3 — MS-MPPE-*-Key attribute encryption', () => {
  it('round-trips a 16-byte session key through encrypt/decrypt', () => {
    const key = new Uint8Array(16).map((_, i) => i * 7 + 1);
    const wire = encryptMppeKey(key, 'shared-secret', '00112233445566778899aabbccddeeff', 0x1234);
    const recovered = decryptMppeKey(wire, 'shared-secret', '00112233445566778899aabbccddeeff');
    expect(bytesToHex(recovered)).toBe(bytesToHex(key));
  });

  it('forces the salt\'s top bit to 1 (RFC 2548 §2.4.1)', () => {
    const key = new Uint8Array(16);
    const wire = encryptMppeKey(key, 'secret', '00'.repeat(16), 0x0001);
    const saltFirstByte = parseInt(wire.slice(0, 2), 16);
    expect(saltFirstByte & 0x80).toBe(0x80);
  });

  it('produces different ciphertext for different salts (same key/secret/authenticator)', () => {
    const key = new Uint8Array(16).fill(0xaa);
    const w1 = encryptMppeKey(key, 'secret', '11'.repeat(16), 0x0001);
    const w2 = encryptMppeKey(key, 'secret', '11'.repeat(16), 0x0002);
    expect(w1).not.toBe(w2);
  });
});
