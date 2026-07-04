import { describe, it, expect } from 'vitest';
import {
  encodeEapPacket, decodeEapPacket, eapPacketToWireHex, eapPacketFromWireHex,
  computeEapMd5Response, verifyEapMd5Response,
  type EapPacket,
} from '@/network/radius/eap';

describe('EAP wire codec (RFC 3748 §4)', () => {
  it('round-trips an EAP-Request/Identity', () => {
    const eap: EapPacket = { type: 'eap', code: 'request', identifier: 1, eapType: 'identity', payload: '' };
    const decoded = decodeEapPacket(encodeEapPacket(eap));
    expect(decoded).toEqual(eap);
  });

  it('round-trips an EAP-Response/Identity carrying a username', () => {
    const eap: EapPacket = { type: 'eap', code: 'response', identifier: 1, eapType: 'identity', payload: 'alice' };
    const bytes = encodeEapPacket(eap);
    expect(bytes.length).toBe(4 + 1 + 'alice'.length);
    const decoded = decodeEapPacket(bytes);
    expect(decoded).toEqual(eap);
  });

  it('round-trips an EAP-Request/MD5-Challenge', () => {
    const eap: EapPacket = {
      type: 'eap', code: 'request', identifier: 7, eapType: 'md5-challenge',
      md5Challenge: 'aabbccddeeff00112233445566778899',
    };
    const decoded = decodeEapPacket(encodeEapPacket(eap));
    expect(decoded).toEqual(eap);
  });

  it('round-trips an EAP-Response/MD5-Challenge', () => {
    const eap: EapPacket = {
      type: 'eap', code: 'response', identifier: 7, eapType: 'md5-challenge',
      md5Response: '00112233445566778899aabbccddeeff'.slice(0, 32),
    };
    const decoded = decodeEapPacket(encodeEapPacket(eap));
    expect(decoded).toEqual(eap);
  });

  it('round-trips Success and Failure (no Type field)', () => {
    const success: EapPacket = { type: 'eap', code: 'success', identifier: 9 };
    const failure: EapPacket = { type: 'eap', code: 'failure', identifier: 9 };
    expect(encodeEapPacket(success).length).toBe(4);
    expect(decodeEapPacket(encodeEapPacket(success))).toEqual(success);
    expect(decodeEapPacket(encodeEapPacket(failure))).toEqual(failure);
  });

  it('exposes the exact byte layout for an Identity request', () => {
    const eap: EapPacket = { type: 'eap', code: 'request', identifier: 5, eapType: 'identity', payload: 'ab' };
    const bytes = encodeEapPacket(eap);
    expect(Array.from(bytes)).toEqual([1, 5, 0, 7, 1, 0x61, 0x62]); // Code=1 Id=5 Len=7 Type=1 'a' 'b'
  });

  it('hex convenience wrappers round-trip too', () => {
    const eap: EapPacket = { type: 'eap', code: 'request', identifier: 2, eapType: 'identity', payload: 'x' };
    const hex = eapPacketToWireHex(eap);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(eapPacketFromWireHex(hex)).toEqual(eap);
  });

  it('rejects a too-short buffer', () => {
    expect(decodeEapPacket(new Uint8Array(2))).toBeNull();
  });
});

describe('EAP-MD5 response (RFC 3748 §4.2 — same math as PPP CHAP)', () => {
  it('verifies a correctly computed response', () => {
    const response = computeEapMd5Response(3, 'wonderland', 'aabbccddeeff00112233445566778899');
    expect(verifyEapMd5Response(3, response, 'wonderland', 'aabbccddeeff00112233445566778899')).toBe(true);
  });

  it('fails verification under the wrong password', () => {
    const response = computeEapMd5Response(3, 'wonderland', 'aabbccddeeff00112233445566778899');
    expect(verifyEapMd5Response(3, response, 'wrong', 'aabbccddeeff00112233445566778899')).toBe(false);
  });

  it('fails verification under a different EAP identifier', () => {
    const response = computeEapMd5Response(3, 'wonderland', 'aabbccddeeff00112233445566778899');
    expect(verifyEapMd5Response(4, response, 'wonderland', 'aabbccddeeff00112233445566778899')).toBe(false);
  });
});
