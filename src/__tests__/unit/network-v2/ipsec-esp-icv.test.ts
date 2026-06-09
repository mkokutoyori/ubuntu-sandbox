/**
 * ESP ICV — the integrity check value computed/verified for ESP packets.
 *
 * computeEspIcv is a pure function over (SA crypto keys, ESP packet); it must
 * produce a real HMAC keyed by the SA's auth key, so that two peers sharing
 * KEYMAT compute the same value and tampering is detectable.
 */

import { describe, it, expect } from 'vitest';
import { computeEspIcv, espIcvMessage } from '@/network/ipsec/IPSecEngine';
import type { SACryptoKeys } from '@/network/ipsec/IPSecTypes';
import type { ESPPacket, IPv4Packet } from '@/network/core/types';
import { hmac, SHA256, hexToBytes, utf8ToBytes, bytesToHex } from '@/crypto';

function keys(algo: string, keyHex: string): SACryptoKeys {
  return {
    espEncAlgorithm: 'aes-cbc-256', espEncKey: 'ab'.repeat(16), espEncKeyLength: 256,
    espAuthAlgorithm: algo, espAuthKey: keyHex, espAuthKeyLength: keyHex.length * 4,
    ahAuthAlgorithm: 'none', ahAuthKey: '', ahAuthKeyLength: 0,
  };
}

function espPacket(): ESPPacket {
  const inner = {
    sourceIP: '10.0.0.1', destinationIP: '10.0.0.2',
    protocol: 6, identification: 4242, totalLength: 120,
  } as unknown as IPv4Packet;
  return { type: 'esp', spi: 0x1234, sequenceNumber: 7, innerPacket: inner };
}

describe('computeEspIcv', () => {
  const authKey = 'aa'.repeat(32); // 256-bit key

  it('is a real HMAC over the canonical message', () => {
    const esp = espPacket();
    const expected = bytesToHex(
      hmac(SHA256, hexToBytes(authKey), utf8ToBytes(espIcvMessage(esp))),
    );
    expect(computeEspIcv(keys('hmac-sha-256', authKey), esp)).toBe(expected);
  });

  it('peers with the same auth key produce the same ICV', () => {
    const esp = espPacket();
    expect(computeEspIcv(keys('hmac-sha-256', authKey), esp)).toBe(
      computeEspIcv(keys('hmac-sha-256', authKey), esp),
    );
  });

  it('a different auth key yields a different ICV (tamper/key mismatch)', () => {
    const esp = espPacket();
    expect(computeEspIcv(keys('hmac-sha-256', authKey), esp)).not.toBe(
      computeEspIcv(keys('hmac-sha-256', 'bb'.repeat(32)), esp),
    );
  });

  it('changes when the inner packet changes (integrity binding)', () => {
    const a = computeEspIcv(keys('hmac-sha-256', authKey), espPacket());
    const tampered = espPacket();
    (tampered.innerPacket as unknown as { destinationIP: string }).destinationIP = '10.0.0.99';
    expect(computeEspIcv(keys('hmac-sha-256', authKey), tampered)).not.toBe(a);
  });

  it('supports hmac-md5 and hmac-sha-1', () => {
    expect(computeEspIcv(keys('hmac-md5', 'cc'.repeat(16)), espPacket())).toMatch(/^[0-9a-f]{32}$/);
    expect(computeEspIcv(keys('hmac-sha-1', 'dd'.repeat(20)), espPacket())).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns undefined when there is no modelled integrity transform', () => {
    expect(computeEspIcv(keys('aes-gcm', ''), espPacket())).toBeUndefined();
    expect(computeEspIcv(keys('hmac-sha-512', 'ee'.repeat(64)), espPacket())).toBeUndefined();
  });
});
